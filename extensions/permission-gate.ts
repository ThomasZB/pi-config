/**
 * Permission Gate Extension (with Claude Code-style Auto Mode Classifier)
 *
 * How it works:
 * 1. Routine commands (ls, git commit, npm test, etc.) pass immediately with 0ms latency.
 * 2. Catastrophic commands (e.g. `rm -rf /`, `rm -rf ~`, `rm -rf .git`) always require manual confirmation.
 * 3. Potentially risky commands (`rm -rf <dir>`, `git reset --hard`, `git push --force`, `sudo`, etc.)
 *    are reviewed by the configured Fast Model (`/fast-model`) using recent user messages and `cwd`:
 *    - If the command is scoped to the project/temp dir and matches the user's intent → Auto-approved!
 *    - If the command is destructive beyond user intent or targets external system paths → Prompts the user.
 *
 * Commands:
 * - `/auto-mode` [on|off|status] — Toggle or inspect Auto Mode classifier review
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type Message, type Model, uuidv7 } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionEntry,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Commands that match these patterns trigger a safety review.
 */
const RISKY_PATTERNS: readonly RegExp[] = [
	/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force)\b/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+[^\n;]*(-f|--force)| branch\s+-D)\b/i,
	/\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh)\b/i,
	/\b(mkfs|dd\s+if=)\b/i,
];

/**
 * Catastrophic patterns that Auto Mode will NEVER auto-approve (always prompt or block).
 */
const HARD_ASK_PATTERNS: readonly RegExp[] = [
	/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force)\s+(\/|~|\$HOME|\$\{HOME\}|\.\.|\.\.\/|\.git(\/|$))(\s|$|;|\|)/i,
	/\bsudo\s+rm\b/i,
	/\b(mkfs|dd\s+if=[^\n]*of=\/dev\/)\b/i,
];

interface RawSettings {
	autoMode?: boolean | { enabled?: boolean };
	fastModel?: string | string[];
	fast?: { model?: string | string[] };
	compactionModel?: string | string[];
	compaction?: { model?: string | string[] };
	[key: string]: unknown;
}

function readJsonSettings(filePath: string): RawSettings | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	try {
		const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as RawSettings)
			: undefined;
	} catch {
		return undefined;
	}
}

function isAutoModeEnabled(cwd: string): boolean {
	if (process.env.PI_AUTO_MODE === "0" || process.env.PI_AUTO_MODE === "false") return false;
	if (process.env.PI_AUTO_MODE === "1" || process.env.PI_AUTO_MODE === "true") return true;

	const projectSettings = readJsonSettings(path.join(cwd, ".pi", "settings.json"));
	const globalSettings = readJsonSettings(path.join(getAgentDir(), "settings.json"));

	for (const settings of [projectSettings, globalSettings]) {
		if (!settings || settings.autoMode === undefined) continue;
		if (typeof settings.autoMode === "boolean") return settings.autoMode;
		if (typeof settings.autoMode === "object" && settings.autoMode !== null) {
			if (typeof settings.autoMode.enabled === "boolean") return settings.autoMode.enabled;
		}
	}
	return true; // Enabled by default
}

function parseModelCandidates(value: unknown): string[] {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed || trimmed === "default" || trimmed === "off" || trimmed === "none" || trimmed === "auto") {
			return [];
		}
		return trimmed
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	if (Array.isArray(value)) {
		return value
			.filter((item): item is string => typeof item === "string")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	return [];
}

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase() as ThinkingLevel;
	return VALID_THINKING_LEVELS.includes(normalized) ? normalized : undefined;
}

function findCandidateModel(ctx: ExtensionContext, spec: string): Model<Api> | undefined {
	let modelSpec = spec.trim();
	const colonIndex = modelSpec.lastIndexOf(":");
	if (colonIndex > 0 && parseThinkingLevel(modelSpec.slice(colonIndex + 1))) {
		modelSpec = modelSpec.slice(0, colonIndex);
	}

	const available = ctx.modelRegistry.getAvailable();
	const allModels = ctx.modelRegistry.getAll();

	const slashIndex = modelSpec.indexOf("/");
	if (slashIndex > 0) {
		const provider = modelSpec.slice(0, slashIndex).trim();
		const modelId = modelSpec.slice(slashIndex + 1).trim();
		const exact = ctx.modelRegistry.find(provider, modelId);
		if (exact) return exact;

		const lowerProvider = provider.toLowerCase();
		const lowerId = modelId.toLowerCase();
		const ciMatch =
			available.find(
				(m) => m.provider.toLowerCase() === lowerProvider && m.id.toLowerCase() === lowerId,
			) ??
			allModels.find(
				(m) => m.provider.toLowerCase() === lowerProvider && m.id.toLowerCase() === lowerId,
			);
		if (ciMatch) return ciMatch;
	}

	const lowerSpec = modelSpec.toLowerCase();
	return (
		available.find((m) => m.id.toLowerCase() === lowerSpec) ??
		allModels.find((m) => m.id.toLowerCase() === lowerSpec) ??
		available.find(
			(m) =>
				m.id.toLowerCase().includes(lowerSpec) ||
				`${m.provider}/${m.id}`.toLowerCase().includes(lowerSpec),
		)
	);
}

async function resolveClassifierModel(ctx: ExtensionContext): Promise<Model<Api> | undefined> {
	const projectSettings = readJsonSettings(path.join(ctx.cwd, ".pi", "settings.json"));
	const globalSettings = readJsonSettings(path.join(getAgentDir(), "settings.json"));

	const candidates = [
		...parseModelCandidates(process.env.PI_FAST_MODEL ?? process.env.PI_COMPACTION_MODEL),
		...parseModelCandidates(
			projectSettings?.fast?.model ??
				projectSettings?.fastModel ??
				projectSettings?.compaction?.model ??
				projectSettings?.compactionModel,
		),
		...parseModelCandidates(
			globalSettings?.fast?.model ??
				globalSettings?.fastModel ??
				globalSettings?.compaction?.model ??
				globalSettings?.compactionModel,
		),
	];

	for (const candidate of candidates) {
		const found = findCandidateModel(ctx, candidate);
		if (!found) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(found);
		if (!auth.ok) continue;
		return auth.baseUrl ? { ...found, baseUrl: auth.baseUrl } : found;
	}

	if (ctx.model) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (auth.ok) {
			return auth.baseUrl ? { ...ctx.model, baseUrl: auth.baseUrl } : ctx.model;
		}
	}
	return undefined;
}

function getRecentUserContext(entries: SessionEntry[], maxCount = 3): string {
	const userTexts: string[] = [];
	for (let i = entries.length - 1; i >= 0 && userTexts.length < maxCount; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n")
					: "";
		if (text.trim()) {
			userTexts.unshift(text.trim().slice(0, 500));
		}
	}
	return userTexts.length > 0 ? userTexts.map((t, idx) => `[User #${idx + 1}]: ${t}`).join("\n") : "(none)";
}

const CLASSIFIER_SYSTEM_PROMPT = `You are a security classifier for an AI coding assistant's Auto Mode (equivalent to Claude Code Auto Mode).
Evaluate whether a shell command should be AUTO-APPROVED (ALLOW) or require human confirmation (ASK).

Rules:
1. ALLOW if the command operates strictly inside the current project working directory (or /tmp) to delete build artifacts, redundant directories, temp files, or perform git actions that align with the user's recent instructions.
2. ALLOW if the user's message explicitly asked to clean up, delete, reset, or force-push the target.
3. ASK if the command deletes files outside the project directory (e.g., ~, /, parent dirs), uses sudo for system changes, pipes untrusted remote scripts to sh/bash, force-pushes to main/master without user request, or risks irreversible loss of unrequested user work.

Reply with EXACTLY one line in this format:
ALLOW: <concise reason in Chinese, under 25 chars>
or
ASK: <concise risk reason in Chinese, under 35 chars>`;

async function classifyCommand(
	ctx: ExtensionContext,
	command: string,
	signal?: AbortSignal,
): Promise<{ decision: "allow" | "ask"; reason: string; modelLabel?: string }> {
	const model = await resolveClassifierModel(ctx);
	if (!model) {
		return { decision: "ask", reason: "未找到可用审核模型" };
	}

	const recentUserContext = getRecentUserContext(ctx.sessionManager.getBranch());
	const userPrompt = [
		`Working Directory (cwd): ${ctx.cwd}`,
		`Recent User Messages:\n${recentUserContext}`,
		`Command to evaluate:\n${command}`,
	].join("\n\n");

	const timeoutController = new AbortController();
	const timeoutId = setTimeout(() => timeoutController.abort(), 8000);
	const onExternalAbort = () => timeoutController.abort();
	signal?.addEventListener("abort", onExternalAbort, { once: true });

	try {
		const message: Message = {
			role: "user",
			content: [{ type: "text", text: userPrompt }],
			timestamp: Date.now(),
		};

		const response = await ctx.modelRegistry.complete(
			model,
			{ systemPrompt: CLASSIFIER_SYSTEM_PROMPT, messages: [message] },
			{
				signal: timeoutController.signal,
				maxTokens: 80,
				cacheRetention: "none",
				sessionId: uuidv7(),
			},
		);

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		const firstLine = text.split("\n")[0]?.trim() ?? "";
		const modelLabel = `${model.provider}/${model.id}`;

		if (/^ALLOW\s*:/i.test(firstLine)) {
			const reason = firstLine.replace(/^ALLOW\s*:\s*/i, "").trim() || "符合当前任务上下文";
			return { decision: "allow", reason, modelLabel };
		}
		if (/^ASK\s*:/i.test(firstLine)) {
			const reason = firstLine.replace(/^ASK\s*:\s*/i, "").trim() || "潜在高风险操作";
			return { decision: "ask", reason, modelLabel };
		}
		return { decision: "ask", reason: firstLine || "无法确认安全性", modelLabel };
	} catch {
		return { decision: "ask", reason: "自动审核超时或失败，转为人工确认" };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onExternalAbort);
	}
}

export default function permissionGateExtension(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;

		const command = String(event.input.command ?? "");
		if (!command.trim()) return undefined;

		const isRisky = RISKY_PATTERNS.some((p) => p.test(command));
		if (!isRisky) return undefined;

		const isHardAsk = HARD_ASK_PATTERNS.some((p) => p.test(command));
		let askReason = "触及系统或核心仓库高危边界";

		if (!isHardAsk && isAutoModeEnabled(ctx.cwd)) {
			const review = await classifyCommand(ctx, command);
			if (review.decision === "allow") {
				if (ctx.hasUI) {
					ctx.ui.notify(`🛡️ Auto-mode 已放行 (${review.reason})`, "info");
				}
				return undefined;
			}
			askReason = review.reason;
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Dangerous command blocked by permission-gate (${askReason})`,
			};
		}

		const choice = await ctx.ui.select(
			`⚠️ 敏感命令确认 (${askReason}):\n\n  ${command}\n\n是否允许执行？`,
			["允许 (Yes)", "拒绝 (No)"],
		);

		if (choice !== "允许 (Yes)") {
			return { block: true, reason: "Blocked by user" };
		}

		return undefined;
	});

	pi.registerCommand("auto-mode", {
		description: "查看或切换敏感命令 Auto Mode (由轻量模型自动审核放行项目内安全操作)",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trim().toLowerCase();
			return [
				{ value: "status", label: "status — 查看当前 Auto Mode 状态" },
				{ value: "on", label: "on — 开启轻量模型自动审核 (默认)" },
				{ value: "off", label: "off — 关闭自动审核，所有敏感命令均弹窗确认" },
			].filter((item) => item.value.startsWith(trimmed));
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			const settingsPath = path.join(getAgentDir(), "settings.json");

			if (sub === "on" || sub === "off") {
				const enabled = sub === "on";
				await withFileMutationQueue(settingsPath, async () => {
					const data = readJsonSettings(settingsPath) ?? {};
					data.autoMode = enabled;
					await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
					await fs.promises.writeFile(settingsPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
				});
				ctx.ui.notify(
					enabled
						? "🛡️ Auto Mode 已开启：项目内符合意图的敏感命令将由轻量模型自动审核放行"
						: "🔒 Auto Mode 已关闭：所有敏感命令均需手动弹窗确认",
					"info",
				);
				return;
			}

			const enabled = isAutoModeEnabled(ctx.cwd);
			const model = await resolveClassifierModel(ctx);
			const modelStr = model ? `${model.provider}/${model.id}` : "未找到可用模型";
			ctx.ui.notify(
				`🛡️ Auto Mode 状态: ${enabled ? "✅ 已开启" : "🔒 已关闭"} | 审核模型: ${modelStr}`,
				"info",
			);
		},
	});
}
