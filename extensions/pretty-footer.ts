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
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
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
}
