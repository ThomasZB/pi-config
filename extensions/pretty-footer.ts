/**
 * Pretty Footer Extension
 *
 * Replaces the monochrome default footer with a multi-colored 2-line status bar:
 * - Line 1: 📁 cwd   git-branch  [extension statuses]          (provider) ◆ model • ✦ thinking
 * - Line 2: CTX [▰▰▰▰▱▱▱▱▱▱▱▱] 32.5% (65.0k/200k)      ↑12.4k  ↓3.1k  ⚡R45.0k (78%)  $0.042  4 turns
 *
 * Commands:
 * - /footer: Toggle between the pretty footer and Pi's default footer
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type SessionEntry,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface CachedStats {
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	latestCacheHitRate?: number;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string, home?: string): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const isInsideHome = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!isInsideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function getThinkingColor(level: string): ThemeColor {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax";
		default:
			return "thinkingOff";
	}
}

function getContextColor(percent: number): ThemeColor {
	if (percent >= 85) return "error";
	if (percent >= 65) return "warning";
	if (percent >= 40) return "mdLink";
	return "success";
}

function renderProgressBar(theme: Theme, percent: number | null, barWidth: number = 12): string {
	const safePercent = percent === null ? 0 : Math.max(0, Math.min(100, percent));
	const filledCount = percent === null ? 0 : Math.round((safePercent / 100) * barWidth);
	const emptyCount = Math.max(0, barWidth - filledCount);
	const barColor = getContextColor(safePercent);

	const filled = filledCount > 0 ? theme.fg(barColor, "▰".repeat(filledCount)) : "";
	const empty = emptyCount > 0 ? theme.fg("borderMuted", "▱".repeat(emptyCount)) : "";
	return `${filled}${empty}`;
}

function alignLeftRight(left: string, right: string, width: number, minGap: number = 2): string {
	const leftW = visibleWidth(left);
	const rightW = visibleWidth(right);

	if (leftW + minGap + rightW <= width) {
		const pad = " ".repeat(width - leftW - rightW);
		return left + pad + right;
	}

	// If right fits when left is truncated or vice-versa: prioritize left, then truncate right
	if (leftW >= width) {
		return truncateToWidth(left, width, "…");
	}

	const availableForRight = width - leftW - minGap;
	if (availableForRight > 4) {
		const truncatedRight = truncateToWidth(right, availableForRight, "…");
		const pad = " ".repeat(Math.max(1, width - leftW - visibleWidth(truncatedRight)));
		return left + pad + truncatedRight;
	}

	return truncateToWidth(left, width, "…");
}

function estimateTextTokens(text: string): number {
	if (!text) return 0;
	let asciiChars = 0;
	let nonAsciiChars = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) <= 0x7f) {
			asciiChars++;
		} else {
			nonAsciiChars++;
		}
	}
	// Mixed English/Code (~4 chars/token) + CJK/Unicode (~1.5 chars/token)
	return Math.ceil(asciiChars / 4 + nonAsciiChars / 1.5);
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") {
			parts.push(b.text);
		} else if (b.type === "thinking" && typeof b.thinking === "string") {
			parts.push(b.thinking);
		} else if (b.type === "toolCall") {
			parts.push(`${String(b.name ?? "")}:${JSON.stringify(b.arguments ?? {})}`);
		} else if (b.type === "image") {
			parts.push("x".repeat(4800));
		}
	}
	return parts.join("\n");
}

interface ContextConsumerItem {
	label: string;
	tokens: number;
	category: "system" | "tools" | "messages" | "toolResults";
}

interface ContextBreakdown {
	modelLabel: string;
	contextWindow: number;
	usedTokens: number;
	isCalibrated: boolean;
	systemTokens: number;
	memoryAndRulesTokens: number;
	toolSchemaTokens: number;
	activeToolCount: number;
	messageTokens: number;
	userTurnCount: number;
	assistantTurnCount: number;
	compactionSummaryTokens: number;
	toolResultTokens: number;
	toolResultCount: number;
	microCompactedCount: number;
	microCompactedSavedTokens: number;
	reserveTokens: number;
	freeTokens: number;
	topConsumers: ContextConsumerItem[];
}

function computeContextBreakdown(pi: ExtensionAPI, ctx: ExtensionContext): ContextBreakdown {
	const usage = ctx.getContextUsage();
	const model = ctx.model;
	const modelLabel = model ? `${model.provider}/${model.id}` : "no-model";
	const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 200_000;

	// 1. System prompt & injected sections
	const sysPrompt = ctx.getSystemPrompt() || "";
	const rawSystemTotal = estimateTextTokens(sysPrompt);
	let rawMemoryAndRules = 0;
	for (const tag of ["persistent_memory", "project_session_continuity", "claude_rules"]) {
		const match = sysPrompt.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
		if (match?.[1]) {
			rawMemoryAndRules += estimateTextTokens(match[1]);
		}
	}
	const rawBaseSystem = Math.max(0, rawSystemTotal - rawMemoryAndRules);

	// 2. Active tool schemas
	const activeNames = new Set(pi.getActiveTools());
	const activeTools = pi.getAllTools().filter((t) => activeNames.has(t.name));
	let rawToolSchemas = 0;
	for (const tool of activeTools) {
		const schemaStr = `${tool.name}\n${tool.description ?? ""}\n${JSON.stringify(tool.parameters ?? {})}`;
		rawToolSchemas += estimateTextTokens(schemaStr);
	}

	// 3. Projected conversation messages & tool results
	const allEntries = ctx.sessionManager.getEntries();
	const seqById = new Map<string, number>();
	allEntries.forEach((entry, idx) => {
		seqById.set(entry.id, idx + 1);
	});

	const projection = ctx.sessionManager.buildSessionProjection();
	let rawMessages = 0;
	let rawCompactionSummary = 0;
	let rawToolResults = 0;
	let userTurnCount = 0;
	let assistantTurnCount = 0;
	let toolResultCount = 0;
	let microCompactedCount = 0;
	let rawMicroCompactedSaved = 0;

	const rawConsumers: ContextConsumerItem[] = [];

	for (const projEntry of projection.entries) {
		const src: SessionEntry = projEntry.sourceEntry;
		const seq = seqById.get(src.id);
		const seqPrefix = seq ? `#${seq} ` : "";

		if (src.type === "compaction") {
			const summaryTok = estimateTextTokens(src.summary || "");
			rawCompactionSummary += summaryTok;
			rawMessages += summaryTok;
			if (summaryTok > 100) {
				rawConsumers.push({
					label: `${seqPrefix}Compaction summary`,
					tokens: summaryTok,
					category: "messages",
				});
			}
			continue;
		}

		for (const msg of projEntry.messages) {
			const m = msg as unknown as Record<string, unknown>;
			const role = String(m.role ?? "");
			const text = extractContentText(m.content);
			const tok = estimateTextTokens(text);

			if (role === "toolResult") {
				rawToolResults += tok;
				toolResultCount++;
				const toolName = String(m.toolName ?? "tool");

				// Check if this toolResult was micro-compacted compared to sourceEntry
				if (src.type === "message" && src.message.role === "toolResult") {
					const origText = extractContentText(src.message.content);
					const origTok = estimateTextTokens(origText);
					if (origTok > tok + 50) {
						microCompactedCount++;
						rawMicroCompactedSaved += origTok - tok;
					}
				}

				rawConsumers.push({
					label: `${seqPrefix}toolResult(${toolName})`,
					tokens: tok,
					category: "toolResults",
				});
			} else if (role === "user") {
				userTurnCount++;
				rawMessages += tok;
				const preview = text.replace(/\s+/g, " ").trim().slice(0, 32);
				rawConsumers.push({
					label: `${seqPrefix}user "${preview}${text.length > 32 ? "…" : ""}"`,
					tokens: tok,
					category: "messages",
				});
			} else if (role === "assistant") {
				assistantTurnCount++;
				rawMessages += tok;
				rawConsumers.push({
					label: `${seqPrefix}assistant response`,
					tokens: tok,
					category: "messages",
				});
			} else if (role !== "system") {
				rawMessages += tok;
			}
		}
	}

	const rawTotal = rawBaseSystem + rawMemoryAndRules + rawToolSchemas + rawMessages + rawToolResults;
	const hasActualTokens = typeof usage?.tokens === "number" && usage.tokens > 0;
	const usedTokens = hasActualTokens ? usage.tokens! : rawTotal;
	const scale = hasActualTokens && rawTotal > 0 ? usedTokens / rawTotal : 1;

	const systemTokens = Math.round((rawBaseSystem + rawMemoryAndRules) * scale);
	const memoryAndRulesTokens = Math.round(rawMemoryAndRules * scale);
	const toolSchemaTokens = Math.round(rawToolSchemas * scale);
	const messageTokens = Math.round(rawMessages * scale);
	const compactionSummaryTokens = Math.round(rawCompactionSummary * scale);
	const toolResultTokens = Math.max(
		0,
		usedTokens - systemTokens - toolSchemaTokens - messageTokens,
	);
	const microCompactedSavedTokens = Math.round(rawMicroCompactedSaved * scale);

	const reserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	const freeTokens = Math.max(0, contextWindow - usedTokens);

	const topConsumers = rawConsumers
		.map((c) => ({ ...c, tokens: Math.round(c.tokens * scale) }))
		.filter((c) => c.tokens > 0)
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, 5);

	return {
		modelLabel,
		contextWindow,
		usedTokens,
		isCalibrated: hasActualTokens,
		systemTokens,
		memoryAndRulesTokens,
		toolSchemaTokens,
		activeToolCount: activeTools.length,
		messageTokens,
		userTurnCount,
		assistantTurnCount,
		compactionSummaryTokens,
		toolResultTokens,
		toolResultCount,
		microCompactedCount,
		microCompactedSavedTokens,
		reserveTokens,
		freeTokens,
		topConsumers,
	};
}

function renderSegmentedContextBar(
	theme: Theme,
	bd: ContextBreakdown,
	barWidth: number,
): string {
	const total = Math.max(1, bd.contextWindow);
	const segments: Array<{ tokens: number; color: ThemeColor; char: string }> = [
		{ tokens: bd.systemTokens, color: "mdLink", char: "█" },
		{ tokens: bd.toolSchemaTokens, color: "accent", char: "█" },
		{ tokens: bd.messageTokens, color: "success", char: "█" },
		{ tokens: bd.toolResultTokens, color: "warning", char: "█" },
		{ tokens: Math.min(bd.freeTokens, bd.reserveTokens), color: "borderMuted", char: "▒" },
	];

	let usedCells = 0;
	const parts: string[] = [];

	for (const seg of segments) {
		if (seg.tokens <= 0) continue;
		const exactCells = (seg.tokens / total) * barWidth;
		const cells = seg.tokens > 0 ? Math.max(1, Math.round(exactCells)) : 0;
		const clamped = Math.min(cells, Math.max(0, barWidth - usedCells));
		if (clamped > 0) {
			parts.push(theme.fg(seg.color, seg.char.repeat(clamped)));
			usedCells += clamped;
		}
	}

	const remainingCells = Math.max(0, barWidth - usedCells);
	if (remainingCells > 0) {
		parts.push(theme.fg("dim", "░".repeat(remainingCells)));
	}

	return `${theme.fg("borderMuted", "[")}${parts.join("")}${theme.fg("borderMuted", "]")}`;
}

export default function prettyFooterExtension(pi: ExtensionAPI) {
	let enabled = true;
	let cachedStats: CachedStats | undefined;

	function computeStats(ctx: ExtensionContext): CachedStats {
		const sm = ctx.sessionManager;
		const sessionId = sm.getSessionId();
		const leafId = sm.getLeafId();
		const entries = sm.getEntries();
		const entryCount = entries.length;

		if (
			cachedStats &&
			cachedStats.sessionId === sessionId &&
			cachedStats.leafId === leafId &&
			cachedStats.entryCount === entryCount
		) {
			return cachedStats;
		}

		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let cost = 0;
		let turns = 0;
		let latestCacheHitRate: number | undefined;

		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const m = entry.message as AssistantMessage;
				turns += 1;
				if (m.usage) {
					input += m.usage.input || 0;
					output += m.usage.output || 0;
					cacheRead += m.usage.cacheRead || 0;
					cacheWrite += m.usage.cacheWrite || 0;
					cost += m.usage.cost?.total || 0;

					const promptTokens = (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
					if (promptTokens > 0) {
						latestCacheHitRate = ((m.usage.cacheRead || 0) / promptTokens) * 100;
					}
				}
			}
		}

		cachedStats = {
			sessionId,
			leafId,
			entryCount,
			input,
			output,
			cacheRead,
			cacheWrite,
			cost,
			turns,
			latestCacheHitRate,
		};
		return cachedStats;
	}

	function createFooterComponent(ctx: ExtensionContext, tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) {
		const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsubBranch,
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return [];

				const sepDot = theme.fg("borderMuted", " · ");

				// ─── LINE 1: Location, Git Branch, Statuses (Left) | Model & Thinking (Right) ───
				const cwdText = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
				const leftParts: string[] = [theme.fg("mdLink", `📁 ${cwdText}`)];

				const branch = footerData.getGitBranch();
				if (branch) {
					leftParts.push(theme.fg("success", ` ${branch}`));
				}

				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) {
					leftParts.push(theme.fg("warning", `🏷 ${sessionName}`));
				}

				const extStatuses = footerData.getExtensionStatuses();
				if (extStatuses.size > 0) {
					const statusItems = Array.from(extStatuses.entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatusText(text))
						.filter(Boolean);
					if (statusItems.length > 0) {
						leftParts.push(statusItems.join(" "));
					}
				}

				const line1Left = leftParts.join(sepDot);

				const model = ctx.model;
				const modelId = model?.id || "no-model";
				const providerPrefix =
					footerData.getAvailableProviderCount() > 1 && model?.provider
						? theme.fg("muted", `${model.provider}/`)
						: "";
				const modelBadge = `${theme.fg("accent", "◆")} ${providerPrefix}${theme.bold(theme.fg("accent", modelId))}`;

				const thinkingLevel = pi.getThinkingLevel() || "off";
				const thinkingColor = getThinkingColor(thinkingLevel);
				const thinkingBadge = model?.reasoning
					? `${sepDot}${theme.fg(thinkingColor, `✦ ${thinkingLevel}`)}`
					: "";

				const line1Right = `${modelBadge}${thinkingBadge}`;
				const line1 = alignLeftRight(line1Left, line1Right, width);

				// ─── LINE 2: Context Progress Bar (Left) | Token, Cache & Cost Stats (Right) ───
				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
				const contextPercent = contextUsage?.percent ?? null;
				const contextTokens =
					contextUsage?.tokens ??
					(contextPercent !== null && contextWindow > 0
						? Math.round((contextPercent / 100) * contextWindow)
						: null);

				const barWidth = width >= 100 ? 14 : width >= 75 ? 10 : 6;
				const bar = renderProgressBar(theme, contextPercent, barWidth);
				const pctColor = getContextColor(contextPercent ?? 0);
				const pctStr =
					contextPercent !== null
						? theme.bold(theme.fg(pctColor, `${contextPercent.toFixed(1)}%`))
						: theme.fg("muted", "0.0%");

				const windowStr =
					contextWindow > 0
						? theme.fg(
								"muted",
								`(${contextTokens !== null ? formatTokens(contextTokens) : "0"}/${formatTokens(contextWindow)})`,
							)
						: "";

				const line2Left = [
					theme.fg("muted", "CTX"),
					bar,
					pctStr,
					windowStr,
				]
					.filter(Boolean)
					.join(" ");

				const stats = computeStats(ctx);
				const metricParts: string[] = [];

				metricParts.push(
					`${theme.fg("success", "↑")}${theme.fg("text", formatTokens(stats.input))} ${theme.fg("accent", "↓")}${theme.fg("text", formatTokens(stats.output))}`,
				);

				if (stats.cacheRead > 0 || stats.cacheWrite > 0) {
					const hitStr =
						stats.latestCacheHitRate !== undefined
							? theme.fg("success", ` ${stats.latestCacheHitRate.toFixed(0)}%`)
							: "";
					metricParts.push(
						`${theme.fg("warning", "⚡")}${theme.fg("muted", `R${formatTokens(stats.cacheRead)}`)}${hitStr}`,
					);
				}

				if (stats.cost > 0) {
					metricParts.push(theme.fg("warning", `$${stats.cost.toFixed(3)}`));
				}

				if (stats.turns > 0) {
					metricParts.push(theme.fg("muted", `${stats.turns} turn${stats.turns > 1 ? "s" : ""}`));
				}

				const line2Right = metricParts.join(sepDot);
				const line2 = alignLeftRight(line2Left, line2Right, width);

				return [line1, line2];
			},
		};
	}

	const applyFooter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (enabled) {
			ctx.ui.setFooter((tui, theme, footerData) => createFooterComponent(ctx, tui, theme, footerData));
		} else {
			ctx.ui.setFooter(undefined);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		applyFooter(ctx);
	});

	pi.registerCommand("footer", {
		description: "Toggle between the colorful progress-bar footer and Pi's default footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			applyFooter(ctx);
			ctx.ui.notify(enabled ? "Pretty footer enabled" : "Default footer restored", "info");
		},
	});

	pi.registerCommand("context", {
		description: "查看当前会话上下文 Token 占用拆解 (System / Tools / Messages / Tool Outputs / 微压缩节省)",
		handler: async (_args, ctx) => {
			const bd = computeContextBreakdown(pi, ctx);
			const stats = computeStats(ctx);
			const pct = bd.contextWindow > 0 ? (bd.usedTokens / bd.contextWindow) * 100 : 0;

			const formatRow = (
				theme: Theme,
				dotColor: ThemeColor,
				dotChar: string,
				title: string,
				tokens: number,
				detail: string,
			) => {
				const rowPct = bd.contextWindow > 0 ? ((tokens / bd.contextWindow) * 100).toFixed(1) : "0.0";
				const dot = theme.fg(dotColor, dotChar);
				const nameCol = title.padEnd(18);
				const tokCol = formatTokens(tokens).padStart(7);
				const pctCol = `(${rowPct.padStart(4)}%)`;
				return `  ${dot} ${theme.fg("text", nameCol)} ${theme.bold(tokCol)} ${theme.fg("muted", pctCol)}  ${theme.fg("dim", detail)}`;
			};

			const buildLines = (theme: Theme, width: number): string[] => {
				const barWidth = Math.max(20, Math.min(48, width - 10));
				const pctColor = getContextColor(pct);
				const calibTag = bd.isCalibrated ? "API 精确校准" : "本地估算";
				const cacheTag =
					stats.latestCacheHitRate !== undefined
						? ` · ⚡ Cache 命中 ${stats.latestCacheHitRate.toFixed(0)}%`
						: "";
				const costTag = stats.cost > 0 ? ` · $${stats.cost.toFixed(3)}` : "";

				const lines: string[] = [
					truncateToWidth(
						`${theme.bold(theme.fg("accent", "📊 Context Usage"))} ${theme.fg("muted", "—")} ${theme.fg("text", bd.modelLabel)}`,
						width,
					),
					truncateToWidth(
						`  ${theme.bold(theme.fg(pctColor, `${formatTokens(bd.usedTokens)} / ${formatTokens(bd.contextWindow)} tokens (${pct.toFixed(1)}%)`))}  ${theme.fg("dim", `[${calibTag}${cacheTag}${costTag}]`)}`,
						width,
					),
					`  ${renderSegmentedContextBar(theme, bd, barWidth)}`,
					"",
					truncateToWidth(
						formatRow(
							theme,
							"mdLink",
							"█",
							"System & Memory",
							bd.systemTokens,
							bd.memoryAndRulesTokens > 0
								? `含记忆/规则/连续性 ~${formatTokens(bd.memoryAndRulesTokens)}`
								: "base system prompt",
						),
						width,
					),
					truncateToWidth(
						formatRow(
							theme,
							"accent",
							"█",
							"Tool Definitions",
							bd.toolSchemaTokens,
							`${bd.activeToolCount} active tools`,
						),
						width,
					),
					truncateToWidth(
						formatRow(
							theme,
							"success",
							"█",
							"Messages",
							bd.messageTokens,
							`${bd.userTurnCount} user, ${bd.assistantTurnCount} assistant${bd.compactionSummaryTokens > 0 ? ` (含摘要 ~${formatTokens(bd.compactionSummaryTokens)})` : ""}`,
						),
						width,
					),
					truncateToWidth(
						formatRow(
							theme,
							"warning",
							"█",
							"Tool Outputs",
							bd.toolResultTokens,
							`${bd.toolResultCount} results${bd.microCompactedSavedTokens > 0 ? ` (⚡ 微压缩已省 ~${formatTokens(bd.microCompactedSavedTokens)}, ${bd.microCompactedCount} 项)` : ""}`,
						),
						width,
					),
					truncateToWidth(
						formatRow(
							theme,
							"borderMuted",
							"▒",
							"Autocompact Buffer",
							Math.min(bd.freeTokens, bd.reserveTokens),
							`触发自动压缩预留水位 (${formatTokens(bd.reserveTokens)})`,
						),
						width,
					),
					truncateToWidth(
						formatRow(
							theme,
							"dim",
							"░",
							"Free Space",
							Math.max(0, bd.freeTokens - bd.reserveTokens),
							`距离自动压缩还剩 ~${formatTokens(Math.max(0, bd.freeTokens - bd.reserveTokens))}`,
						),
						width,
					),
				];

				if (bd.topConsumers.length > 0) {
					lines.push("");
					lines.push(truncateToWidth(`  ${theme.bold(theme.fg("muted", "Top Context Consumers (当前最占空间的项):"))}`, width));
					bd.topConsumers.forEach((item, idx) => {
						const itemPct = bd.contextWindow > 0 ? ((item.tokens / bd.contextWindow) * 100).toFixed(1) : "0.0";
						const color: ThemeColor = item.category === "toolResults" ? "warning" : "success";
						lines.push(
							truncateToWidth(
								`    ${theme.fg("dim", `${idx + 1}.`)} ${theme.fg(color, formatTokens(item.tokens).padStart(6))} ${theme.fg("dim", `(${itemPct}%)`)}  ${theme.fg("text", item.label)}`,
								width,
							),
						);
					});
				}

				return lines;
			};

			if (ctx.mode === "tui") {
				await ctx.ui.custom<void>((_tui, theme, keybindings, done) => ({
					render(width: number) {
						return [
							...buildLines(theme, width),
							"",
							truncateToWidth(`  ${theme.fg("dim", "按 Enter / Esc / Space 关闭面板")}`, width),
						];
					},
					handleInput(data: string) {
						if (
							keybindings.matches(data, "tui.select.confirm") ||
							keybindings.matches(data, "tui.select.cancel") ||
							data === " " ||
							data === "q"
						) {
							done();
						}
					},
					invalidate() {},
				}));
			} else {
				const dummyTheme = {
					fg: (_c: ThemeColor, t: string) => t,
					bold: (t: string) => t,
				} as unknown as Theme;
				ctx.ui.notify(buildLines(dummyTheme, 100).join("\n"), "info");
			}
		},
	});
}
