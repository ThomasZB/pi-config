/**
 * Session Recall & Cache-Aware Micro-Compaction Extension (`session_recall`)
 *
 * Brings Claude Code's 5-layer context hygiene + pi-vcc (`#seq` recall) + pi-smart-compact
 * (cross-session continuity) to Pi while strictly protecting Prompt Cache hit rates:
 *
 * 1. Post-Compaction Recall (Current Session):
 *    - Automatically detects when the active session has been compacted (`/compact` or auto-compact).
 *    - Injects a deterministic, memoized index of pre-compaction user turns (`#1..#N`) into the
 *      system prompt so the LLM knows what raw logs, prompts, and tool outputs exist before `<summary>`.
 *    - Allows the LLM to search (`action: "search"`) or read (`action: "read"`) exact pre-compaction
 *      or micro-compacted messages and tool outputs on demand.
 *
 * 2. Cross-Session Continuity (Same Project / `cwd`):
 *    - Indexes the most recent previous sessions in the same project directory.
 *    - When you open a new window and say "继续之前的工作" ("continue our previous work") or ask about
 *      something done in an earlier session, the LLM uses `session_recall` (`session_id: "previous"`
 *      or `scope: "project"`) to read or search past sessions.
 *
 * 3. Cache-Aware Micro-Compaction (Claude Code `maybeTimeBasedMicrocompact` + `clear_at_least`):
 *    - While Prompt Cache is HOT (idle gap < `cacheTtlMinutes`, default 6 min) and old tool output
 *      bloat is below `clearAtLeastTokens` (default 30,000 tokens), ZERO historical messages are
 *      modified — preserving 100% prefix cache hits.
 *    - When the user returns after an idle gap >= `cacheTtlMinutes` (default 6 min, when the 5-min
 *      server-side prompt cache has already expired anyway) OR when old tool outputs
 *      accumulate >= `clearAtLeastTokens`, large old tool outputs (`bash`, `read`, `grep`, `codemode`,
 *      `web_fetch`, old images, etc.) older than `keepRecentToolSteps` (default 6 steps) are
 *      batch-compacted into `[Head 10 lines + Tail 8 lines + #seq recall ref]`.
 *    - Persisted via a `custom` session entry (`session_recall_microcompact`) and applied in `context`
 *      BEFORE the LLM request so `assistant.usage.totalTokens` in the footer always reflects the true
 *      API token count (without triggering Pi's `context_edit` `chars/4` estimator fallback glitch).
 *
 * Commands:
 * - `/recall` or `/recall status`  Show recall & micro-compaction status and saved tokens
 * - `/recall ttl <minutes>`        Set cache expiry idle threshold in minutes (default: 6)
 * - `/recall compact`              Manually run micro-compaction on old oversized tool outputs now
 * - `/recall on` / `/recall off`   Enable or disable automatic cache-aware micro-compaction
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	type SessionEntry,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface IndexedEntry {
	/** 1-based sequence number within the session branch */
	seq: number;
	id: string;
	type: string;
	role: string;
	timestamp: string;
	/** Whether this entry was compacted away (before `firstKeptEntryId`) */
	compacted: boolean;
	/** Tool name if assistant toolCall or toolResult */
	toolName?: string;
	/** Full extracted plain text (always raw, ignoring micro-compaction) */
	text: string;
	lineCount: number;
	charCount: number;
	preview: string;
}

interface ParsedBranchInfo {
	sessionId: string;
	sessionFile?: string;
	hasCompaction: boolean;
	latestCompactionId?: string;
	compactionCount: number;
	firstKeptSeq?: number;
	entries: IndexedEntry[];
	compactedEntries: IndexedEntry[];
	microCompactedIds: Set<string>;
}

interface RecentSessionSummary {
	id: string;
	filePath: string;
	modified: Date;
	messageCount: number;
	name?: string;
	firstUserPreview: string;
	lastUserPreview: string;
	lastAssistantPreview: string;
}

export interface MicroCompactionConfig {
	/** Master switch (default: true) */
	enabled: boolean;
	/**
	 * Idle gap in minutes before Time-Based Micro-Compaction triggers (default: 6 minutes).
	 * Since standard provider prompt cache TTL is 5 minutes, any gap >= 6 minutes means the
	 * server cache has already expired and will be rewritten anyway — making cleanup 100% free!
	 */
	cacheTtlMinutes: number;
	/**
	 * Number of most recent assistant/tool steps whose tool outputs are always kept intact (default: 6).
	 * Much more accurate than counting user messages when a single user prompt triggers 20+ tool calls.
	 */
	keepRecentToolSteps: number;
	/** Minimum character length of a single toolResult to be eligible for micro-compaction (default: 3000) */
	minToolResultChars: number;
	/**
	 * Minimum estimated tokens to clear when triggering while cache is still hot (default: 30000).
	 * Prevents small incremental edits from invalidating a hot cache.
	 */
	clearAtLeastTokens: number;
}

interface PinnedMicroEdit {
	entryId: string;
	toolCallId: string;
	toolName: string;
	seq: number;
	savedChars: number;
	replacementText: string;
}

interface PersistedMicroCompactData {
	edits: PinnedMicroEdit[];
}

const DEFAULT_MC_CONFIG: MicroCompactionConfig = {
	enabled: true,
	cacheTtlMinutes: 6,
	keepRecentToolSteps: 6,
	minToolResultChars: 3000,
	clearAtLeastTokens: 30000,
};

const CUSTOM_MICROCOMPACT_TYPE = "session_recall_microcompact";
const MAX_READ_CHARS_DEFAULT = 8000;
const MAX_READ_CHARS_LIMIT = 24000;
const HEAD_KEEP_LINES = 10;
const TAIL_KEEP_LINES = 8;
const MICRO_COMPACTED_SENTINEL = "[Micro-compacted toolResult";
const ESTIMATED_IMAGE_TOKENS = 2000;

/**
 * Memoized system prompt appendix keyed by `${sessionId}:${latestCompactionId ?? "none"}`.
 * Guarantees `systemPrompt` is 100% byte-for-byte identical across turns so prefix cache never invalidates.
 */
const promptAppendixCache = new Map<string, string>();

/**
 * Pinned micro-compaction edits for the active session, keyed by `toolCallId`.
 * Once an edit is triggered (after cache TTL expiry or threshold), it is persisted in a
 * `custom` entry (`session_recall_microcompact`) and applied deterministically in `pi.on("context")`.
 */
const pinnedEditsByCallId = new Map<string, PinnedMicroEdit>();
let hydratedSessionKey = "";

function readSettingsFile(filePath: string): Record<string, any> | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	try {
		const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function updateSettingsFile(
	filePath: string,
	updater: (data: Record<string, any>) => void,
): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		let data: Record<string, any> = {};
		if (fs.existsSync(filePath)) {
			try {
				const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
				const parsed = JSON.parse(raw);
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
					data = parsed;
				}
			} catch {
				// ignore malformed
			}
		}
		updater(data);
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		await fs.promises.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	});
}

function resolveMicroCompactionConfig(cwd: string): MicroCompactionConfig {
	const projectSettings = readSettingsFile(path.join(cwd, ".pi", "settings.json"));
	const globalSettings = readSettingsFile(path.join(getAgentDir(), "settings.json"));

	const pMc = projectSettings?.microCompaction ?? {};
	const gMc = globalSettings?.microCompaction ?? {};

	const envTtl = process.env.PI_CACHE_TTL_MINUTES ? Number(process.env.PI_CACHE_TTL_MINUTES) : undefined;

	const enabled =
		typeof pMc.enabled === "boolean"
			? pMc.enabled
			: typeof gMc.enabled === "boolean"
				? gMc.enabled
				: DEFAULT_MC_CONFIG.enabled;

	const rawTtl =
		(typeof envTtl === "number" && !Number.isNaN(envTtl) ? envTtl : undefined) ??
		(typeof pMc.cacheTtlMinutes === "number" ? pMc.cacheTtlMinutes : undefined) ??
		(typeof gMc.cacheTtlMinutes === "number" ? gMc.cacheTtlMinutes : undefined) ??
		DEFAULT_MC_CONFIG.cacheTtlMinutes;

	const keepRecentToolSteps =
		typeof pMc.keepRecentToolSteps === "number"
			? pMc.keepRecentToolSteps
			: typeof gMc.keepRecentToolSteps === "number"
				? gMc.keepRecentToolSteps
				: DEFAULT_MC_CONFIG.keepRecentToolSteps;

	const minToolResultChars =
		typeof pMc.minToolResultChars === "number"
			? pMc.minToolResultChars
			: typeof gMc.minToolResultChars === "number"
				? gMc.minToolResultChars
				: DEFAULT_MC_CONFIG.minToolResultChars;

	const clearAtLeastTokens =
		typeof pMc.clearAtLeastTokens === "number"
			? pMc.clearAtLeastTokens
			: typeof gMc.clearAtLeastTokens === "number"
				? gMc.clearAtLeastTokens
				: DEFAULT_MC_CONFIG.clearAtLeastTokens;

	return {
		enabled,
		cacheTtlMinutes: Math.max(0, rawTtl),
		keepRecentToolSteps: Math.max(2, keepRecentToolSteps),
		minToolResultChars: Math.max(1000, minToolResultChars),
		clearAtLeastTokens: Math.max(2000, clearAtLeastTokens),
	};
}

function singleLinePreview(text: string, maxLen = 120): string {
	const cleaned = text
		.replace(/\r?\n+/g, " ↵ ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return "(empty)";
	return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function extractEntryContent(entry: SessionEntry): {
	role: string;
	toolName?: string;
	text: string;
} {
	if (entry.type === "message") {
		const msg = (entry as any).message;
		if (!msg || typeof msg !== "object") {
			return { role: "unknown", text: "" };
		}
		const role = String(msg.role ?? "unknown");
		const toolName = msg.toolName ? String(msg.toolName) : undefined;

		// Guardrail 1: Never index `session_recall` toolResults into recallable history
		// to prevent recursive "recall-of-recall" bloat.
		if (role === "toolResult" && toolName === "session_recall") {
			return { role, toolName, text: "" };
		}

		const content = msg.content;

		if (typeof content === "string") {
			return { role, toolName, text: content };
		}

		if (Array.isArray(content)) {
			const parts: string[] = [];
			const toolCalls: string[] = [];
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				if (block.type === "text" && typeof block.text === "string") {
					parts.push(block.text);
				} else if (block.type === "image") {
					parts.push(`[image: ${block.mimeType ?? "image"}]`);
				} else if (block.type === "toolCall") {
					const name = block.name ?? "tool";
					if (name === "session_recall") continue;
					let argsPreview = "";
					if (block.arguments && typeof block.arguments === "object") {
						const a = block.arguments as Record<string, unknown>;
						const keyArg = a.command ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.action ?? "";
						if (keyArg) {
							argsPreview = `(${singleLinePreview(String(keyArg), 60)})`;
						}
					}
					toolCalls.push(`[toolCall: ${name}${argsPreview}]`);
				}
			}
			const combined = [...parts, ...(toolCalls.length > 0 ? [toolCalls.join(" ")] : [])]
				.filter(Boolean)
				.join("\n");
			return { role, toolName, text: combined };
		}

		return { role, toolName, text: "" };
	}

	if (entry.type === "compaction") {
		const summary = String((entry as any).summary ?? "");
		return {
			role: "compaction_summary",
			text: summary,
		};
	}

	if (entry.type === "branch_summary") {
		const summary = String((entry as any).summary ?? "");
		return {
			role: "branch_summary",
			text: summary,
		};
	}

	if (entry.type === "custom_message") {
		const rawContent = (entry as any).content;
		const text =
			typeof rawContent === "string"
				? rawContent
				: Array.isArray(rawContent)
					? rawContent
							.filter((b: any) => b?.type === "text" && typeof b.text === "string")
							.map((b: any) => b.text)
							.join("\n")
					: "";
		return {
			role: `custom:${String((entry as any).customType ?? "message")}`,
			text,
		};
	}

	return { role: entry.type, text: "" };
}

/**
 * Restore any persisted micro-compaction edits from the current session branch so
 * resumed sessions or post-reload sessions keep the exact same pinned edits.
 */
function ensureHydratedFromBranch(branch: SessionEntry[], sessionId: string): void {
	let latestCompactionId = "none";
	for (const e of branch) {
		if (e.type === "compaction") {
			latestCompactionId = e.id;
		}
	}
	const key = `${sessionId}:${latestCompactionId}`;
	if (hydratedSessionKey === key) return;
	hydratedSessionKey = key;
	pinnedEditsByCallId.clear();

	let startIdx = 0;
	for (let i = 0; i < branch.length; i++) {
		const e = branch[i]!;
		if (e.type === "compaction") {
			startIdx = i + 1;
			const firstKeptId = (e as any).firstKeptEntryId;
			if (firstKeptId) {
				const found = branch.findIndex((b, idx) => idx <= i && b.id === firstKeptId);
				if (found >= 0) startIdx = found;
			}
		}
	}

	for (let i = startIdx; i < branch.length; i++) {
		const e = branch[i]!;
		if (e.type === "custom" && (e as any).customType === CUSTOM_MICROCOMPACT_TYPE) {
			const data = (e as any).data as PersistedMicroCompactData | undefined;
			if (data && Array.isArray(data.edits)) {
				for (const edit of data.edits) {
					if (edit && typeof edit.toolCallId === "string" && typeof edit.replacementText === "string") {
						pinnedEditsByCallId.set(edit.toolCallId, edit);
					}
				}
			}
		}
	}
}

function indexBranchEntries(
	branch: SessionEntry[],
	sessionId: string,
	sessionFile?: string,
): ParsedBranchInfo {
	ensureHydratedFromBranch(branch, sessionId);

	let latestCompactionIdx = -1;
	let latestCompactionId: string | undefined;
	let compactionCount = 0;
	let firstKeptEntryId: string | undefined;
	const microCompactedIds = new Set<string>();

	for (const edit of pinnedEditsByCallId.values()) {
		microCompactedIds.add(edit.entryId);
	}

	for (let i = 0; i < branch.length; i++) {
		const e = branch[i]!;
		if (e.type === "compaction") {
			latestCompactionIdx = i;
			latestCompactionId = e.id;
			compactionCount++;
			firstKeptEntryId = (e as any).firstKeptEntryId;
		} else if (e.type === "context_edit" && typeof (e as any).targetId === "string") {
			microCompactedIds.add((e as any).targetId);
		}
	}

	let compactedBoundaryIdx = -1;
	if (latestCompactionIdx >= 0) {
		compactedBoundaryIdx = latestCompactionIdx;
		if (firstKeptEntryId) {
			const foundIdx = branch.findIndex(
				(e, idx) => idx <= latestCompactionIdx && e.id === firstKeptEntryId,
			);
			if (foundIdx >= 0) {
				compactedBoundaryIdx = foundIdx;
			}
		}
	}

	const entries: IndexedEntry[] = [];
	let seq = 0;
	let firstKeptSeq: number | undefined;

	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i]!;
		if (
			entry.type !== "message" &&
			entry.type !== "compaction" &&
			entry.type !== "branch_summary" &&
			entry.type !== "custom_message"
		) {
			continue;
		}

		const { role, toolName, text } = extractEntryContent(entry);
		if (!text.trim() && role !== "compaction_summary") {
			continue;
		}

		seq++;
		const isCompacted = compactedBoundaryIdx >= 0 && i < compactedBoundaryIdx;
		if (!isCompacted && firstKeptSeq === undefined && compactedBoundaryIdx >= 0) {
			firstKeptSeq = seq;
		}

		const lines = text.split(/\r?\n/);
		entries.push({
			seq,
			id: entry.id,
			type: entry.type,
			role,
			timestamp: entry.timestamp ?? "",
			compacted: isCompacted,
			toolName,
			text,
			lineCount: lines.length,
			charCount: text.length,
			preview: singleLinePreview(text, 120),
		});
	}

	return {
		sessionId,
		sessionFile,
		hasCompaction: latestCompactionIdx >= 0,
		latestCompactionId,
		compactionCount,
		firstKeptSeq,
		entries,
		compactedEntries: entries.filter((e) => e.compacted),
		microCompactedIds,
	};
}

function getCurrentSessionBranchInfo(ctx: ExtensionContext): ParsedBranchInfo {
	const sm = ctx.sessionManager;
	const branch = sm.getBranch();
	return indexBranchEntries(branch, sm.getSessionId(), sm.getSessionFile());
}

/**
 * Build a head+tail micro-compacted replacement with a `#seq` reference so the LLM
 * still sees the beginning and end of the output and knows how to recall the middle if needed.
 */
function buildMicroCompactedText(
	seq: number,
	entryId: string,
	toolName: string,
	rawText: string,
	hasImage: boolean,
): string {
	if (hasImage && rawText.length < 1500) {
		return [
			`${MICRO_COMPACTED_SENTINEL}(${toolName}) — #${seq} (id:${entryId}, image + ${rawText.length} chars). Base64 image payload was micro-compacted after cache expiry to save context; re-read the image file if you need to inspect it again.]`,
			rawText ? `--- Note ---\n${rawText}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}

	const lines = rawText.split(/\r?\n/);
	const totalLines = lines.length;
	const totalChars = rawText.length;
	const imgNote = hasImage ? " + image" : "";

	const header = `${MICRO_COMPACTED_SENTINEL}(${toolName}) — #${seq} (id:${entryId}, ${totalLines} lines, ${totalChars.toLocaleString()} chars${imgNote}). Full verbatim output is preserved; call session_recall({ action: "read", seq: ${seq} }) if you need the omitted middle content.]`;

	if (totalLines <= HEAD_KEEP_LINES + TAIL_KEEP_LINES + 4) {
		const headSlice = rawText.slice(0, 900);
		const tailSlice = rawText.slice(-600);
		const omittedChars = Math.max(0, totalChars - headSlice.length - tailSlice.length);
		return [
			header,
			"--- Head ---",
			headSlice,
			`... [${omittedChars.toLocaleString()} chars micro-compacted to save context] ...`,
			"--- Tail ---",
			tailSlice,
		].join("\n");
	}

	const headLines = lines.slice(0, HEAD_KEEP_LINES).join("\n").slice(0, 1200);
	const tailLines = lines.slice(-TAIL_KEEP_LINES).join("\n").slice(-900);
	const omittedLines = Math.max(1, totalLines - HEAD_KEEP_LINES - TAIL_KEEP_LINES);

	return [
		header,
		`--- Head (first ${HEAD_KEEP_LINES} lines) ---`,
		headLines,
		`... [${omittedLines} lines micro-compacted to save context] ...`,
		`--- Tail (last ${TAIL_KEEP_LINES} lines) ---`,
		tailLines,
	].join("\n");
}

/**
 * Evaluate and stage Cache-Aware Micro-Compaction candidates.
 *
 * Triggers ONLY when:
 * 1. `force === true` (user ran `/recall compact`), OR
 * 2. Idle time since last assistant message >= `config.cacheTtlMinutes` (server cache expired anyway -> FREE cleanup!), OR
 * 3. Total savable tokens in old tool steps (>= `keepRecentToolSteps` ago) >= `config.clearAtLeastTokens`.
 */
function evaluateAndStageMicroCompaction(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: MicroCompactionConfig,
	mode: "turn_start" | "mid_turn" | "manual" = "turn_start",
): {
	triggered: boolean;
	reason?: string;
	count: number;
	savedChars: number;
	savedTokensApprox: number;
	gapMinutes: number;
} {
	const force = mode === "manual";
	if (!config.enabled && !force) {
		return { triggered: false, count: 0, savedChars: 0, savedTokensApprox: 0, gapMinutes: 0 };
	}

	const branch = ctx.sessionManager.getBranch();
	const parsed = indexBranchEntries(branch, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
	const seqById = new Map<string, number>();
	for (const item of parsed.entries) {
		seqById.set(item.id, item.seq);
	}

	// Find active boundary (after latest compaction)
	let startIdx = 0;
	for (let i = 0; i < branch.length; i++) {
		const e = branch[i]!;
		if (e.type === "compaction") {
			startIdx = i + 1;
			const firstKeptId = (e as any).firstKeptEntryId;
			if (firstKeptId) {
				const found = branch.findIndex((b, idx) => idx <= i && b.id === firstKeptId);
				if (found >= 0) startIdx = found;
			}
		}
	}

	// Measure idle gap since the last assistant message on the branch
	let lastAssistantTimestampMs = 0;
	for (let i = branch.length - 1; i >= startIdx; i--) {
		const e = branch[i]!;
		if (e.type === "message" && (e as any).message?.role === "assistant") {
			const msgTs = (e as any).message?.timestamp;
			const entryTs = e.timestamp ? new Date(e.timestamp).getTime() : 0;
			const ts = typeof msgTs === "number" && msgTs > 0 ? msgTs : entryTs;
			if (ts > 0) {
				lastAssistantTimestampMs = ts;
				break;
			}
		}
	}

	const gapMinutes =
		lastAssistantTimestampMs > 0 ? (Date.now() - lastAssistantTimestampMs) / 60000 : 0;

	// Count how many assistant steps and user turns occur AFTER each branch index.
	const assistantStepsAfter = new Array<number>(branch.length).fill(0);
	const userTurnsAfter = new Array<number>(branch.length).fill(0);
	let seenAssistantSteps = 0;
	let seenUserTurns = mode === "turn_start" ? 1 : 0;
	for (let i = branch.length - 1; i >= startIdx; i--) {
		assistantStepsAfter[i] = seenAssistantSteps;
		userTurnsAfter[i] = seenUserTurns;
		const e = branch[i]!;
		if (e.type === "message") {
			const role = (e as any).message?.role;
			if (role === "assistant") seenAssistantSteps++;
			else if (role === "user") seenUserTurns++;
		}
	}

	const candidates: PinnedMicroEdit[] = [];
	let totalSavableChars = 0;
	let totalSavableImageTokens = 0;

	for (let i = startIdx; i < branch.length; i++) {
		// Tool results from previous completed user turns only need 1 assistant step after them;
		// tool results inside the currently executing turn keep `keepRecentToolSteps` (6) intact.
		const minStepsToKeep =
			force || userTurnsAfter[i]! > 0 ? 1 : config.keepRecentToolSteps;
		if (assistantStepsAfter[i]! < minStepsToKeep) {
			continue;
		}

		const e = branch[i]!;
		if (e.type !== "message") continue;
		if (parsed.microCompactedIds.has(e.id)) continue;

		const msg = (e as any).message;
		if (!msg || msg.role !== "toolResult" || msg.isError) continue;
		const toolCallId = String(msg.toolCallId ?? "");
		const toolName = String(msg.toolName ?? "tool");
		if (!toolCallId || pinnedEditsByCallId.has(toolCallId)) continue;

		if (toolName === "memory" || toolName === "todo") continue;

		const rawText = Array.isArray(msg.content)
			? msg.content
					.filter((c: any) => c?.type === "text" && typeof c.text === "string")
					.map((c: any) => c.text)
					.join("\n")
			: typeof msg.content === "string"
				? msg.content
				: "";

		const hasImage =
			Array.isArray(msg.content) && msg.content.some((c: any) => c?.type === "image");

		if (rawText.startsWith(MICRO_COMPACTED_SENTINEL)) continue;
		if (!hasImage && rawText.length < config.minToolResultChars) continue;

		const seq = seqById.get(e.id) ?? i + 1;
		const replacementText = buildMicroCompactedText(seq, e.id, toolName, rawText, hasImage);
		const savedChars = Math.max(0, rawText.length - replacementText.length);
		if (!hasImage && savedChars < 800) continue;

		candidates.push({
			entryId: e.id,
			toolCallId,
			toolName,
			seq,
			savedChars,
			replacementText,
		});
		totalSavableChars += savedChars;
		if (hasImage) {
			totalSavableImageTokens += ESTIMATED_IMAGE_TOKENS;
		}
	}

	if (candidates.length === 0) {
		return { triggered: false, count: 0, savedChars: 0, savedTokensApprox: 0, gapMinutes };
	}

	// Code/JSON/CJK averages ~3.2 chars per token in real BPE tokenizers
	const estimatedSavableTokens =
		Math.round(totalSavableChars / 3.2) + totalSavableImageTokens;
	const cacheExpiredTrigger =
		mode === "turn_start" && config.cacheTtlMinutes > 0 && gapMinutes >= config.cacheTtlMinutes;
	const requiredTokens =
		mode === "mid_turn" ? config.clearAtLeastTokens * 2 : config.clearAtLeastTokens;
	const thresholdTrigger = estimatedSavableTokens >= requiredTokens;

	if (!force && !cacheExpiredTrigger && !thresholdTrigger) {
		return { triggered: false, count: 0, savedChars: 0, savedTokensApprox: 0, gapMinutes };
	}

	for (const c of candidates) {
		pinnedEditsByCallId.set(c.toolCallId, c);
	}

	// Persist in a `custom` entry (`session_recall_microcompact`) so:
	// 1. It survives `/reload` and `--continue` / `/resume`
	// 2. Unlike `context_edit` appended at `agent_before_settle`, a `custom` entry does NOT
	//    invalidate `usageEntryIndex` in Pi's `estimateProjectedContextTokens()`, so the footer
	//    ALWAYS displays the real LLM API `usage.totalTokens` without jumping to `chars/4` (100k) and back!
	pi.appendEntry<PersistedMicroCompactData>(CUSTOM_MICROCOMPACT_TYPE, {
		edits: candidates,
	});

	const reason = force
		? "manual"
		: cacheExpiredTrigger
			? `cache_ttl_expired (${gapMinutes.toFixed(1)}m >= ${config.cacheTtlMinutes}m)`
			: `threshold_exceeded (~${estimatedSavableTokens.toLocaleString()} tokens >= ${config.clearAtLeastTokens.toLocaleString()})`;

	return {
		triggered: true,
		reason,
		count: candidates.length,
		savedChars: totalSavableChars,
		savedTokensApprox: estimatedSavableTokens,
		gapMinutes,
	};
}

/**
 * Fast inspection of recent project session `.jsonl` files in the current session directory.
 */
function listRecentProjectSessions(
	ctx: ExtensionContext,
	limit = 10,
	excludeCurrent = true,
): RecentSessionSummary[] {
	const sm = ctx.sessionManager;
	const sessionDir = sm.getSessionDir();
	const currentSessionId = sm.getSessionId();
	const currentSessionFile = sm.getSessionFile();

	if (!sessionDir || !fs.existsSync(sessionDir)) {
		return [];
	}

	let files: Array<{ filePath: string; mtimeMs: number }> = [];
	try {
		files = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => {
				const filePath = path.join(sessionDir, f);
				try {
					const st = fs.statSync(filePath);
					return { filePath, mtimeMs: st.mtimeMs };
				} catch {
					return null;
				}
			})
			.filter((x): x is { filePath: string; mtimeMs: number } => x !== null)
			.sort((a, b) => b.mtimeMs - a.mtimeMs);
	} catch {
		return [];
	}

	const results: RecentSessionSummary[] = [];
	for (const { filePath, mtimeMs } of files) {
		if (results.length >= limit) break;
		if (excludeCurrent && currentSessionFile && path.resolve(filePath) === path.resolve(currentSessionFile)) {
			continue;
		}

		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const lines = raw.split(/\r?\n/).filter(Boolean);
			if (lines.length <= 1) continue;

			const header = JSON.parse(lines[0]!);
			if (header?.type !== "session") continue;
			const id = String(header.id ?? path.basename(filePath, ".jsonl"));
			if (excludeCurrent && id === currentSessionId) continue;

			let messageCount = 0;
			let name: string | undefined;
			let firstUserPreview = "";
			let lastUserPreview = "";
			let lastAssistantPreview = "";

			for (let i = 1; i < lines.length; i++) {
				let entry: any;
				try {
					entry = JSON.parse(lines[i]!);
				} catch {
					continue;
				}
				if (entry.type === "session_info" && entry.name) {
					name = String(entry.name).trim() || undefined;
				}
				if (entry.type !== "message" || !entry.message) continue;
				const role = entry.message.role;
				if (role !== "user" && role !== "assistant") continue;

				const { text } = extractEntryContent(entry as SessionEntry);
				if (!text.trim()) continue;
				messageCount++;

				if (role === "user") {
					if (!firstUserPreview) {
						firstUserPreview = singleLinePreview(text, 110);
					}
					lastUserPreview = singleLinePreview(text, 110);
				} else if (role === "assistant") {
					lastAssistantPreview = singleLinePreview(text, 120);
				}
			}

			if (messageCount === 0) continue;

			results.push({
				id,
				filePath,
				modified: new Date(mtimeMs),
				messageCount,
				name,
				firstUserPreview: firstUserPreview || "(no user prompt)",
				lastUserPreview: lastUserPreview || firstUserPreview || "(no user prompt)",
				lastAssistantPreview: lastAssistantPreview || "(no assistant reply)",
			});
		} catch {
			continue;
		}
	}

	return results;
}

function loadTargetSessionBranch(
	ctx: ExtensionContext,
	sessionIdOrAlias?: string,
): { info?: ParsedBranchInfo; error?: string } {
	if (
		!sessionIdOrAlias ||
		sessionIdOrAlias === "current" ||
		sessionIdOrAlias === ctx.sessionManager.getSessionId()
	) {
		return { info: getCurrentSessionBranchInfo(ctx) };
	}

	const recent = listRecentProjectSessions(ctx, 50, false);
	const currentId = ctx.sessionManager.getSessionId();
	const nonCurrent = recent.filter((s) => s.id !== currentId);

	let targetSummary: RecentSessionSummary | undefined;
	const normalized = sessionIdOrAlias.trim().toLowerCase();

	if (normalized === "previous" || normalized === "latest" || normalized === "last") {
		targetSummary = nonCurrent[0];
		if (!targetSummary) {
			return { error: "同项目下没有找到更早的历史会话。" };
		}
	} else {
		targetSummary =
			recent.find((s) => s.id.toLowerCase() === normalized) ??
			recent.find((s) => s.id.toLowerCase().startsWith(normalized)) ??
			recent.find((s) => path.basename(s.filePath).toLowerCase().includes(normalized));
	}

	if (!targetSummary) {
		return {
			error: `未找到会话 "${sessionIdOrAlias}"。请先使用 action: "list_sessions" 查看可用会话 ID。`,
		};
	}

	try {
		const sm = SessionManager.open(targetSummary.filePath, ctx.sessionManager.getSessionDir(), ctx.cwd);
		const branch = sm.getBranch();
		return {
			info: indexBranchEntries(branch, targetSummary.id, targetSummary.filePath),
		};
	} catch (err) {
		return {
			error: `读取历史会话失败: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

function formatRoleLabel(entry: IndexedEntry): string {
	if (entry.role === "toolResult") {
		return entry.toolName ? `toolResult(${entry.toolName})` : "toolResult";
	}
	return entry.role;
}

function formatStaticTime(date: Date): string {
	return date.toISOString().slice(0, 16).replace("T", " ");
}

function formatRelativeTime(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const diffMin = Math.max(0, Math.floor(diffMs / 60000));
	if (diffMin < 1) return "刚刚";
	if (diffMin < 60) return `${diffMin} 分钟前`;
	const diffHours = Math.floor(diffMin / 60);
	if (diffHours < 24) return `${diffHours} 小时前`;
	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays} 天前 (${date.toISOString().slice(0, 10)})`;
}

function buildRecallSignature(params: Record<string, unknown>): string {
	return JSON.stringify({
		action: params.action ?? "read",
		scope: params.scope ?? "",
		session_id: params.session_id ?? "current",
		query: params.query ?? "",
		seq: params.seq ?? "",
		start_seq: params.start_seq ?? "",
		end_seq: params.end_seq ?? "",
		entry_id: params.entry_id ?? "",
		offset: params.offset ?? 0,
	});
}

function hasIdenticalRecallInActiveBranch(
	ctx: ExtensionContext,
	currentToolCallId: string,
	targetSig: string,
): boolean {
	const branch = ctx.sessionManager.getBranch();
	let startIdx = 0;
	for (let i = 0; i < branch.length; i++) {
		const e = branch[i]!;
		if (e.type === "compaction") {
			startIdx = i + 1;
			const firstKeptId = (e as any).firstKeptEntryId;
			if (firstKeptId) {
				const found = branch.findIndex((b, idx) => idx <= i && b.id === firstKeptId);
				if (found >= 0) startIdx = found;
			}
		}
	}

	const matchingCallIds = new Set<string>();
	for (let i = startIdx; i < branch.length; i++) {
		const e = branch[i]!;
		if (e.type !== "message") continue;
		const msg = (e as any).message;
		if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (
					block?.type === "toolCall" &&
					block.name === "session_recall" &&
					typeof block.id === "string" &&
					block.id !== currentToolCallId
				) {
					const sig = buildRecallSignature((block.arguments ?? {}) as Record<string, unknown>);
					if (sig === targetSig) {
						matchingCallIds.add(block.id);
					}
				}
			}
		} else if (
			msg?.role === "toolResult" &&
			msg.toolName === "session_recall" &&
			!msg.isError &&
			typeof msg.toolCallId === "string" &&
			matchingCallIds.has(msg.toolCallId)
		) {
			return true;
		}
	}
	return false;
}

export default function sessionRecallExtension(pi: ExtensionAPI): void {
	// 1. Register the `session_recall` tool for the LLM
	pi.registerTool({
		name: "session_recall",
		label: "Session Recall",
		description:
			"Recall or search raw conversation history that was compacted away or micro-compacted in the current session, or inspect/search previous sessions in the same project directory. " +
			"Use this tool ONLY when: (1) the user asks about specific details, logs, numbers, errors, or code from earlier in the conversation that were omitted from <summary> or micro-compacted tool outputs; " +
			"or (2) the user says 'continue previous work' / references a past conversation in the same project. " +
			"Do NOT call this tool repeatedly for the same entry once retrieved.",
		promptSnippet:
			"Search or read compacted/micro-compacted history from the current session or previous sessions in the same project",
		promptGuidelines: [
			"When the current session has been compacted (or an older tool output shows `[Micro-compacted toolResult ... #seq]`) and you need the exact original lines, call `session_recall` (`action: \"read\"`, `seq: N` or `action: \"search\"`) instead of guessing.",
			"When starting a new session and the user asks to continue previous work or references an earlier session in this project, call `session_recall` with `session_id: \"previous\"` (or `action: \"list_sessions\"` / `action: \"search\"` with `scope: \"project\"`).",
			"To save context tokens, prefer `action: \"search\"` first to pinpoint the `#seq` number, then `action: \"read\"` only that specific `#seq`. Never re-read the same `#seq` if its content is already in active context.",
		],
		parameters: Type.Object({
			action: StringEnum(["outline", "search", "read", "list_sessions"] as const, {
				description:
					"Operation: 'outline' (list message timeline #1..#N), 'search' (keyword/regex search across messages), 'read' (read full raw text of message #seq), or 'list_sessions' (list recent sessions in this project)",
			}),
			scope: Type.Optional(
				StringEnum(["compacted", "current", "project"] as const, {
					description:
						"Search/outline scope: 'compacted' (only compacted-away entries in current session), 'current' (entire current session), or 'project' (across all sessions in this project directory). Default: 'compacted' if current session is compacted, otherwise 'current'.",
				}),
			),
			session_id: Type.Optional(
				Type.String({
					description:
						"Target session ID (or prefix), or 'previous' for the most recent previous session in this project. Defaults to 'current'.",
				}),
			),
			query: Type.Optional(
				Type.String({
					description: "Search keyword or regular expression (required for action='search').",
				}),
			),
			seq: Type.Optional(
				Type.Number({
					description: "1-based message sequence number (#seq) to read (for action='read').",
				}),
			),
			start_seq: Type.Optional(
				Type.Number({
					description: "Start message sequence number (#seq, inclusive) for range read or outline.",
				}),
			),
			end_seq: Type.Optional(
				Type.Number({
					description: "End message sequence number (#seq, inclusive) for range read or outline.",
				}),
			),
			entry_id: Type.Optional(
				Type.String({
					description: "Specific entry ID to read (alternative to seq for action='read').",
				}),
			),
			offset: Type.Optional(
				Type.Number({
					description: "Character offset when reading a very large single message (default: 0).",
				}),
			),
			max_chars: Type.Optional(
				Type.Number({
					description: `Maximum characters to return for action='read' (default: ${MAX_READ_CHARS_DEFAULT}, max: ${MAX_READ_CHARS_LIMIT}).`,
				}),
			),
		}),

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action;
			const callSig = buildRecallSignature(params as Record<string, unknown>);

			if (hasIdenticalRecallInActiveBranch(ctx, toolCallId, callSig)) {
				return {
					content: [
						{
							type: "text",
							text: `[Already recalled in active context: identical session_recall(${action}) result is already present in an earlier toolResult above. Use that existing content directly.]`,
						},
					],
					details: { action, deduplicated: true },
				};
			}

			// ── Action 1: list_sessions ──────────────────────────────────────────
			if (action === "list_sessions") {
				const currentInfo = getCurrentSessionBranchInfo(ctx);
				const sessions = listRecentProjectSessions(ctx, 15, true);
				const lines: string[] = [];

				lines.push(
					`Current Session: ${currentInfo.sessionId} (${currentInfo.entries.length} entries, compacted: ${currentInfo.compactedEntries.length}, micro-compacted tools: ${currentInfo.microCompactedIds.size})`,
				);
				if (sessions.length === 0) {
					lines.push("\nNo other historical sessions found in this project directory.");
				} else {
					lines.push(`\nRecent Historical Sessions in Project (${ctx.cwd}):`);
					sessions.forEach((s, idx) => {
						const tag = idx === 0 ? " [previous / latest]" : "";
						const title = s.name ? ` "${s.name}"` : "";
						lines.push(
							`\n${idx + 1}. Session ID: ${s.id}${tag}${title} (${formatRelativeTime(s.modified)}, ${s.messageCount} msgs)`,
						);
						lines.push(`   - First user prompt: ${s.firstUserPreview}`);
						if (s.lastUserPreview !== s.firstUserPreview) {
							lines.push(`   - Last user prompt : ${s.lastUserPreview}`);
						}
						lines.push(`   - Last assistant   : ${s.lastAssistantPreview}`);
					});
					lines.push(
						`\nTip: Call session_recall with action="outline" or action="read" and session_id="previous" (or a Session ID prefix) to inspect a session.`,
					);
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { action, count: sessions.length },
				};
			}

			// ── Action 2: outline ────────────────────────────────────────────────
			if (action === "outline") {
				const target = loadTargetSessionBranch(ctx, params.session_id);
				if (target.error || !target.info) {
					return {
						content: [{ type: "text", text: target.error ?? "Failed to load session." }],
						details: { action, error: true },
					};
				}

				const info = target.info;
				const isExternalSession =
					Boolean(params.session_id) &&
					params.session_id !== "current" &&
					info.sessionId !== ctx.sessionManager.getSessionId();

				const effectiveScope =
					params.scope ??
					(isExternalSession ? "current" : info.compactedEntries.length > 0 ? "compacted" : "current");

				let sourceEntries =
					effectiveScope === "compacted" && info.compactedEntries.length > 0
						? info.compactedEntries
						: info.entries;

				if (params.start_seq !== undefined || params.end_seq !== undefined) {
					const start = params.start_seq ?? 1;
					const end = params.end_seq ?? Number.MAX_SAFE_INTEGER;
					sourceEntries = info.entries.filter((e) => e.seq >= start && e.seq <= end);
				}

				const lines: string[] = [];
				lines.push(
					`Session ${info.sessionId} Outline (showing ${sourceEntries.length} of ${info.entries.length} entries, compacted: ${info.compactedEntries.length}):`,
				);

				for (const e of sourceEntries) {
					const stateBadge = e.compacted
						? "[compacted]"
						: info.microCompactedIds.has(e.id)
							? "[micro-compacted]"
							: "[active]";
					const timeShort = e.timestamp ? e.timestamp.slice(11, 19) : "";
					lines.push(
						`#${e.seq} (id:${e.id}) ${stateBadge} ${timeShort} [${formatRoleLabel(e)}] (${e.lineCount}L, ${e.charCount}c): ${e.preview}`,
					);
				}

				lines.push(
					`\nTip: Use session_recall({ action: "read", session_id: "${info.sessionId}", seq: N }) or start_seq/end_seq to read full content.`,
				);

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { action, sessionId: info.sessionId, count: sourceEntries.length },
				};
			}

			// ── Action 3: search ─────────────────────────────────────────────────
			if (action === "search") {
				const rawQuery = (params.query ?? "").trim();
				if (!rawQuery) {
					return {
						content: [{ type: "text", text: "Error: 'query' parameter is required for action='search'." }],
						details: { action, error: true },
					};
				}

				let regex: RegExp;
				try {
					regex = new RegExp(rawQuery, "i");
				} catch {
					const escaped = rawQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					regex = new RegExp(escaped, "i");
				}

				if (params.scope === "project" && !params.session_id) {
					const currentInfo = getCurrentSessionBranchInfo(ctx);
					const recentSessions = listRecentProjectSessions(ctx, 20, true);
					const matches: string[] = [];

					const searchInSession = (info: ParsedBranchInfo, label: string) => {
						for (const e of info.entries) {
							if (!regex.test(e.text)) continue;
							const matchedLines = e.text
								.split(/\r?\n/)
								.filter((l) => regex.test(l))
								.slice(0, 3)
								.map((l) => `      > ${singleLinePreview(l, 140)}`);
							matches.push(
								`- [${label}] #${e.seq} (id:${e.id}) [${formatRoleLabel(e)}] (${e.lineCount}L, ${e.charCount}c):\n${matchedLines.join("\n")}`,
							);
							if (matches.length >= 30) break;
						}
					};

					searchInSession(currentInfo, `current:${currentInfo.sessionId.slice(0, 8)}`);
					for (const s of recentSessions) {
						if (matches.length >= 30) break;
						const loaded = loadTargetSessionBranch(ctx, s.id);
						if (loaded.info) {
							searchInSession(
								loaded.info,
								`session:${s.id.slice(0, 8)} (${formatStaticTime(s.modified)})`,
							);
						}
					}

					const out =
						matches.length > 0
							? `Found ${matches.length} matching entries across project sessions for /${rawQuery}/i:\n\n${matches.join("\n\n")}`
							: `No matches found for "${rawQuery}" across project sessions.`;
					return {
						content: [{ type: "text", text: out }],
						details: { action, query: rawQuery, matches: matches.length },
					};
				}

				const target = loadTargetSessionBranch(ctx, params.session_id);
				if (target.error || !target.info) {
					return {
						content: [{ type: "text", text: target.error ?? "Failed to load session." }],
						details: { action, error: true },
					};
				}

				const info = target.info;
				const searchPool =
					params.scope === "compacted" && info.compactedEntries.length > 0
						? info.compactedEntries
						: info.entries;

				const matches: string[] = [];
				for (const e of searchPool) {
					if (!regex.test(e.text)) continue;
					const lines = e.text.split(/\r?\n/);
					const snippets: string[] = [];
					for (let i = 0; i < lines.length; i++) {
						if (regex.test(lines[i]!)) {
							snippets.push(`    L${i + 1}: ${singleLinePreview(lines[i]!, 150)}`);
							if (snippets.length >= 5) break;
						}
					}
					const badge = e.compacted
						? "[compacted]"
						: info.microCompactedIds.has(e.id)
							? "[micro-compacted]"
							: "[active]";
					matches.push(
						`#${e.seq} (id:${e.id}) ${badge} [${formatRoleLabel(e)}] (${e.lineCount}L, ${e.charCount}c):\n${snippets.join("\n")}`,
					);
					if (matches.length >= 25) break;
				}

				if (matches.length === 0 && searchPool !== info.entries) {
					for (const e of info.entries) {
						if (!regex.test(e.text)) continue;
						matches.push(
							`#${e.seq} (id:${e.id}) [active] [${formatRoleLabel(e)}]: ${e.preview}`,
						);
					}
				}

				const out =
					matches.length > 0
						? `Search results in session ${info.sessionId} for /${rawQuery}/i (${matches.length} matches):\n\n${matches.join("\n\n")}\n\nTip: Call session_recall({ action: "read", session_id: "${info.sessionId}", seq: N }) to read the full message.`
						: `No matches found for "${rawQuery}" in session ${info.sessionId}.`;

				return {
					content: [{ type: "text", text: out }],
					details: { action, query: rawQuery, matches: matches.length },
				};
			}

			// ── Action 4: read ───────────────────────────────────────────────────
			const target = loadTargetSessionBranch(ctx, params.session_id);
			if (target.error || !target.info) {
				return {
					content: [{ type: "text", text: target.error ?? "Failed to load session." }],
					details: { action: "read", error: true },
				};
			}

			const info = target.info;
			let selected: IndexedEntry[] = [];

			if (params.entry_id) {
				const byId = info.entries.find((e) => e.id === params.entry_id);
				if (byId) selected = [byId];
			} else if (params.seq !== undefined) {
				const bySeq = info.entries.find((e) => e.seq === params.seq);
				if (bySeq) selected = [bySeq];
			} else if (params.start_seq !== undefined || params.end_seq !== undefined) {
				const start = params.start_seq ?? 1;
				const end = params.end_seq ?? start + 4;
				selected = info.entries.filter((e) => e.seq >= start && e.seq <= end);
			} else {
				selected = info.entries.slice(-6);
			}

			if (selected.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No matching entry found in session ${info.sessionId} (valid seq range: #1..#${info.entries.length}).`,
						},
					],
					details: { action: "read", count: 0 },
				};
			}

			const maxChars = Math.min(
				MAX_READ_CHARS_LIMIT,
				Math.max(1000, params.max_chars ?? MAX_READ_CHARS_DEFAULT),
			);
			const offset = Math.max(0, params.offset ?? 0);

			const blocks: string[] = [];
			let usedChars = 0;

			for (const e of selected) {
				const stateTag = e.compacted
					? "[compacted]"
					: info.microCompactedIds.has(e.id)
						? "[micro-compacted-raw]"
						: "[active]";
				const header = `=== #${e.seq} (id:${e.id}) [${formatRoleLabel(e)}] ${stateTag} (${e.lineCount} lines, ${e.charCount} chars) ===`;
				const body = offset > 0 && selected.length === 1 ? e.text.slice(offset) : e.text;
				const remaining = maxChars - usedChars;
				if (remaining <= 0) {
					blocks.push(`... (remaining entries omitted due to max_chars=${maxChars} limit)`);
					break;
				}
				if (body.length > remaining) {
					const slice = body.slice(0, remaining);
					const nextOffset = offset + remaining;
					blocks.push(
						`${header}\n${slice}\n\n[... truncated at ${remaining} chars. Call session_recall({ action: "read", session_id: "${info.sessionId}", seq: ${e.seq}, offset: ${nextOffset} }) for more]`,
					);
					usedChars += remaining;
					break;
				}
				blocks.push(`${header}\n${body}`);
				usedChars += body.length;
			}

			return {
				content: [{ type: "text", text: blocks.join("\n\n") }],
				details: {
					action: "read",
					sessionId: info.sessionId,
					count: selected.length,
				},
			};
		},

		renderCall(args, theme) {
			const action = args.action ?? "recall";
			const detail =
				args.query
					? `"${args.query}"`
					: args.seq !== undefined
						? `#${args.seq}`
						: args.start_seq !== undefined
							? `#${args.start_seq}..#${args.end_seq ?? ""}`
							: args.session_id ?? args.scope ?? "";
			return new Text(
				theme.fg("toolTitle", theme.bold("session_recall ")) +
					theme.fg("accent", action) +
					(detail ? ` ${theme.fg("muted", String(detail))}` : ""),
				0,
				0,
			);
		},
	});

	// 2. Apply pinned micro-compaction edits in `context` BEFORE the LLM request is sent.
	//    Because these edits are applied before the LLM call (and persisted via a `custom` entry
	//    rather than a post-turn `context_edit`), the LLM's `assistant.usage.totalTokens` in the
	//    footer is always the 100% accurate real API token count and never bounces!
	pi.on("context", async (event, ctx) => {
		ensureHydratedFromBranch(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId());
		// Emergency mid-turn circuit breaker: only triggers if a single turn accumulates >= 2x threshold (60k tokens)
		const mcConfig = resolveMicroCompactionConfig(ctx.cwd);
		evaluateAndStageMicroCompaction(pi, ctx, mcConfig, "mid_turn");
		if (pinnedEditsByCallId.size === 0) return;

		const messages = event.messages;
		if (!Array.isArray(messages) || messages.length === 0) return;

		let modified = false;
		const nextMessages = messages.map((msg) => {
			const m = msg as any;
			if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") return msg;
			const edit = pinnedEditsByCallId.get(m.toolCallId);
			if (!edit) return msg;

			const currentText = Array.isArray(m.content)
				? m.content.find((c: any) => c?.type === "text")?.text ?? ""
				: "";
			const hasImg = Array.isArray(m.content) && m.content.some((c: any) => c?.type === "image");
			if (currentText.startsWith(MICRO_COMPACTED_SENTINEL) && !hasImg) {
				return msg;
			}

			modified = true;
			return {
				...m,
				content: [{ type: "text", text: edit.replacementText }],
			};
		});

		if (!modified) return;
		return { messages: nextMessages };
	});

	// 3. Prompt-Cache Safe `before_agent_start`:
	//    - Evaluates Cache-Aware Micro-Compaction (Time-Based >= cacheTtlMinutes OR Threshold >= clearAtLeastTokens)
	//    - Injects memoized `<compacted_history_recall>` and `<project_session_continuity>` into systemPrompt
	pi.on("before_agent_start", async (event, ctx) => {
		const mcConfig = resolveMicroCompactionConfig(ctx.cwd);
		const mcResult = evaluateAndStageMicroCompaction(pi, ctx, mcConfig, "turn_start");
		if (mcResult.triggered) {
			ctx.ui.notify(
				`🧹 已自动微压缩 ${mcResult.count} 条旧工具输出 (预计节省 ~${mcResult.savedTokensApprox.toLocaleString()} tokens，触发原因: ${mcResult.reason}，原文可通过 session_recall 无损查阅)`,
				"info",
			);
		}

		// Step B: Memoized System Prompt appendix (100% static per sessionId + compactionId)
		const currentInfo = getCurrentSessionBranchInfo(ctx);
		const cacheKey = `${currentInfo.sessionId}:${currentInfo.latestCompactionId ?? "none"}`;

		let appendix = promptAppendixCache.get(cacheKey);
		if (appendix === undefined) {
			const extraSections: string[] = [];

			if (currentInfo.compactedEntries.length > 0) {
				const userTurns = currentInfo.compactedEntries.filter((e) => e.role === "user");
				const turnLines = userTurns.slice(-15).map((u) => {
					return `  - #${u.seq} (id:${u.id}, ${u.lineCount}L/${u.charCount}c): ${u.preview}`;
				});

				extraSections.push(
					[
						"<compacted_history_recall>",
						`This session has been compacted. ${currentInfo.compactedEntries.length} earlier entries (#1..#${currentInfo.compactedEntries[currentInfo.compactedEntries.length - 1]!.seq}) were summarized into <summary>, but their FULL verbatim text (including pasted logs, code, and tool outputs) is still preserved and retrievable via the \`session_recall\` tool.`,
						userTurns.length > 0
							? `Compacted user turns index:\n${turnLines.join("\n")}`
							: "",
						"IMPORTANT: If the user asks about specific details, log lines, metrics, error messages, or code from earlier turns that are missing or abbreviated in <summary>, DO NOT guess — call `session_recall` (`action: \"search\"` or `action: \"read\"`) once to inspect the exact original entries.",
						"</compacted_history_recall>",
					]
						.filter(Boolean)
						.join("\n"),
				);
			}

			const recentSessions = listRecentProjectSessions(ctx, 3, true);
			if (recentSessions.length > 0) {
				const sessionLines = recentSessions.map((s, idx) => {
					const tag = idx === 0 ? " [previous]" : "";
					return `  - Session ${s.id}${tag} (${formatStaticTime(s.modified)}, ${s.messageCount} msgs) | First: ${s.firstUserPreview} | Last: ${s.lastUserPreview}`;
				});

				extraSections.push(
					[
						"<project_session_continuity>",
						`Recent sessions in this project directory (${ctx.cwd}):`,
						sessionLines.join("\n"),
						"If the user asks to 'continue previous work' (继续之前的工作) or references a past conversation in this project without providing details, call `session_recall` with `session_id: \"previous\"` (`action: \"read\"` or `action: \"outline\"`) or `action: \"search\"` (`scope: \"project\"`) to retrieve the context from the previous session.",
						"</project_session_continuity>",
					].join("\n"),
				);
			}

			appendix = extraSections.join("\n\n");
			promptAppendixCache.set(cacheKey, appendix);
		}

		if (!appendix) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${appendix}`,
		};
	});

	pi.on("session_tree", async () => {
		promptAppendixCache.clear();
		pinnedEditsByCallId.clear();
		hydratedSessionKey = "";
	});
	pi.on("session_start", async () => {
		promptAppendixCache.clear();
		pinnedEditsByCallId.clear();
		hydratedSessionKey = "";
	});

	// 4. Register `/recall` command for status, custom TTL configuration, and manual micro-compaction
	pi.registerCommand("recall", {
		description:
			"查看历史回溯与微压缩状态，或设置缓存过期微压缩时间 (/recall [status | ttl <分钟> | compact | on | off])",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "status", label: "status — 查看当前回溯索引与微压缩配置状态" },
				{ value: "ttl 6", label: "ttl 6 — 设置空闲 6 分钟（缓存过期后）自动微压缩旧工具输出 (默认)" },
				{ value: "ttl 10", label: "ttl 10 — 设置空闲 10 分钟自动微压缩旧工具输出" },
				{ value: "ttl 30", label: "ttl 30 — 设置空闲 30 分钟自动微压缩旧工具输出" },
				{ value: "compact", label: "compact — 立即手动微压缩早期超大工具输出" },
				{ value: "on", label: "on — 开启自动缓存感知微压缩" },
				{ value: "off", label: "off — 关闭自动缓存感知微压缩" },
			];
			const trimmed = prefix.trim().toLowerCase();
			return items.filter((i) => i.value.startsWith(trimmed));
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const globalSettingsPath = path.join(getAgentDir(), "settings.json");
			const config = resolveMicroCompactionConfig(ctx.cwd);

			// `/recall ttl <minutes>`
			if (raw.toLowerCase().startsWith("ttl")) {
				const numStr = raw.slice(3).trim();
				const minutes = Number(numStr);
				if (!numStr || Number.isNaN(minutes) || minutes < 0) {
					ctx.ui.notify(
						`当前缓存过期微压缩时间: ${config.cacheTtlMinutes} 分钟（用法: /recall ttl <分钟>，如 /recall ttl 6）`,
						"info",
					);
					return;
				}
				await updateSettingsFile(globalSettingsPath, (data) => {
					const mc = typeof data.microCompaction === "object" && data.microCompaction ? data.microCompaction : {};
					mc.cacheTtlMinutes = minutes;
					data.microCompaction = mc;
				});
				ctx.ui.notify(
					minutes === 0
						? "✅ 已设置 cacheTtlMinutes = 0（关闭按空闲时间触发，仅在旧工具输出累计超 30k tokens 时触发）"
						: `✅ 已将缓存过期微压缩时间设为 ${minutes} 分钟（空闲超过 ${minutes} 分钟发消息时自动清理旧大工具输出）`,
					"info",
				);
				return;
			}

			// `/recall on` / `/recall off`
			if (raw.toLowerCase() === "on" || raw.toLowerCase() === "off") {
				const nextEnabled = raw.toLowerCase() === "on";
				await updateSettingsFile(globalSettingsPath, (data) => {
					const mc = typeof data.microCompaction === "object" && data.microCompaction ? data.microCompaction : {};
					mc.enabled = nextEnabled;
					data.microCompaction = mc;
				});
				ctx.ui.notify(
					nextEnabled
						? `✅ 已开启自动缓存感知微压缩 (默认空闲 TTL: ${config.cacheTtlMinutes} 分钟)`
						: "⏸️ 已关闭自动缓存感知微压缩",
					"info",
				);
				return;
			}

			// `/recall compact`
			if (raw.toLowerCase() === "compact") {
				const res = evaluateAndStageMicroCompaction(pi, ctx, config, "manual");
				if (!res.triggered) {
					ctx.ui.notify("当前没有需要微压缩的超大旧工具输出（上下文已处于精简状态）", "info");
				} else {
					ctx.ui.notify(
						`🧹 已手动微压缩 ${res.count} 条旧工具输出，预计释放 ~${res.savedTokensApprox.toLocaleString()} tokens（下一轮请求自动生效，原文仍可通过 session_recall 查阅）`,
						"info",
					);
				}
				return;
			}

			// Default: `/recall` or `/recall status`
			const current = getCurrentSessionBranchInfo(ctx);
			const recent = listRecentProjectSessions(ctx, 5, true);
			const totalMicroCount = current.microCompactedIds.size;
			let savedCharsSum = 0;
			for (const edit of pinnedEditsByCallId.values()) {
				savedCharsSum += edit.savedChars;
			}
			const approxSavedTokens = Math.round(savedCharsSum / 3.2);

			const compactMsg =
				current.compactedEntries.length > 0
					? `已压缩归档: ${current.compactedEntries.length} 条 (#1..#${current.compactedEntries[current.compactedEntries.length - 1]!.seq})`
					: `会话记录: ${current.entries.length} 条 (未触发全量压缩)`;

			const mcMsg = `微压缩: ${config.enabled ? `开启 (TTL=${config.cacheTtlMinutes}min, 步距=${config.keepRecentToolSteps}, 阈值=${(config.clearAtLeastTokens / 1000).toFixed(0)}k)` : "关闭"} · 已瘦身 ${totalMicroCount} 条旧工具输出${approxSavedTokens > 0 ? ` (~${approxSavedTokens.toLocaleString()} tokens)` : ""}`;

			const recentMsg =
				recent.length > 0
					? `同项目历史会话: ${recent.length} 个 (最近: ${formatRelativeTime(recent[0]!.modified)})`
					: "同项目暂无其他会话";

			ctx.ui.notify(`📚 ${compactMsg} ｜ 🧹 ${mcMsg} ｜ 🗂️ ${recentMsg}`, "info");
		},
	});
}
