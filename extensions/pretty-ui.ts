/**
 * Pretty UI Extension
 *
 * 1. Prompt Arrow Editor (`❯ `) with Hover & Breathing Border:
 *    - Dynamic colored prompt indicator (`❯ `) in front of the input editor:
 *      - Normal prompt: `❯ ` (accent color)
 *      - Slash command (`/plan`, `/reload`): `❯ ` (warning color)
 *      - Shell command (`!ls`, `!!pwd`): `❯ ` (bashMode color)
 *      - Multiline continuation: `· ` (muted color)
 *    - Hovering over the input box highlights the border and prompt arrow (`✦ ❯ `)
 *    - While the agent is thinking/running commands, the input border and prompt gently breathe in Truecolor RGB!
 *
 * 2. Rich Markdown Rendering (No raw `###`, ```` ``` ````, or `- ` markers):
 *    - Headings: `◆ H1`, `▎ H2`, `▸ H3`, `• H4` with clean typography
 *    - Code blocks: Framed code cards (`╭─ lang ───`, `│ code`, `╰──────────`)
 *    - Lists & tasks: `•` / `◦` / `▪` bullets and `☑` / `☐` task checkboxes
 *    - Highlighted inline bold (`**text**`) and code spans (`` `code` ``)
 *
 * 3. Claude-Style Compact Thinking + Breathing Light & Hover:
 *    - While streaming thinking: shows a live RGB breathing orb & wave (`◉ 思考中 ••• <最新一行>`)
 *    - Intermediate thinking before tool calls: automatically folds away (0 lines) once tool execution starts
 *    - Final answer thinking: collapses into a single clickable line (`▸ 💭 已思考 (N 行)`), lights up on mouse hover!
 *
 * 4. Claude-Style Consecutive Command Grouping + Breathing Light & Hover:
 *    - Single command: 1-line summary when done, lights up on hover (`▶ ... [ ✦ 点击展开输出 ]`)
 *    - Consecutive commands (2+ tools in a row):
 *      - Running: RGB breathing progress bar `▰▰▱` + live elapsed timer + currently executing command
 *      - Done: 2-line summary card, lights up on mouse hover (`▶ ... [ ✦ 点击展开全部 N 步历史 ]`)
 *      - Expanded history: each step row individually highlights when hovered (`├─ 2. ▶ ... [ ✦ 点击查看详情 ]`)!
 */

import { homedir } from "node:os";
import {
	AssistantMessageComponent,
	type BashToolDetails,
	CompactionSummaryMessageComponent,
	CustomEditor,
	type EditToolDetails,
	type ExtensionAPI,
	formatReadLineRange,
	getMarkdownTheme,
	InteractiveMode,
	type KeybindingsManager,
	type ReadToolDetails,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type EditorTheme,
	Markdown,
	type MouseEvent,
	ScrollView,
	Spacer,
	sliceByColumn,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const PROMPT_PREFIX_WIDTH = 2;
const GLOBAL_STATE_KEY = Symbol.for("pretty-ui:globalState");

type Rgb = [number, number, number];

interface GlobalPrettyState {
	theme?: Theme;
	tui?: TUI;
	lastInteractiveMode?: any;
	activeEditor?: ArrowPromptEditor;
	keepFullHistory?: boolean;
	hoverTarget: any;
	hoverSubRow: number;
	lastMoveScreenKey: string;
	targetClaimedOnMove: boolean;
	agentBusy: boolean;
	lastActiveRenderAt: number;
	animTimer?: ReturnType<typeof setInterval>;
}

function getGlobalState(): GlobalPrettyState {
	const g = globalThis as any;
	if (!g[GLOBAL_STATE_KEY]) {
		g[GLOBAL_STATE_KEY] = {
			theme: undefined,
			tui: undefined,
			lastInteractiveMode: undefined,
			keepFullHistory: true,
			hoverTarget: null,
			hoverSubRow: -1,
			lastMoveScreenKey: "",
			targetClaimedOnMove: false,
			agentBusy: false,
			lastActiveRenderAt: 0,
			animTimer: undefined,
		} satisfies GlobalPrettyState;
	}
	if (g[GLOBAL_STATE_KEY].keepFullHistory === undefined) {
		g[GLOBAL_STATE_KEY].keepFullHistory = true;
	}
	return g[GLOBAL_STATE_KEY];
}

function setActiveTheme(t: Theme): void {
	getGlobalState().theme = t;
}

function getActiveTheme(): Theme | undefined {
	return getGlobalState().theme;
}

function setActiveTui(tui?: TUI): void {
	if (tui) {
		getGlobalState().tui = tui;
	}
}

// ============================================================================
// Truecolor RGB Breathing & Hover Animation Engine
// ============================================================================
const COLOR_PURPLE: Rgb = [187, 154, 247]; // #bb9af7
const COLOR_CYAN: Rgb = [125, 207, 255]; // #7dcfff
const COLOR_BLUE: Rgb = [122, 162, 247]; // #7aa2f7
const COLOR_TEAL: Rgb = [115, 218, 202]; // #73daca
const COLOR_AMBER: Rgb = [255, 158, 100]; // #ff9e64
const COLOR_MUTED_BORDER: Rgb = [59, 66, 97]; // #3b4261
const COLOR_DIM_SLATE: Rgb = [86, 95, 137]; // #565f89

function rgbFg([r, g, b]: Rgb, text: string): string {
	return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m${text}\x1b[39m`;
}

function lerpRgb(c1: Rgb, c2: Rgb, t: number): Rgb {
	const clamped = Math.max(0, Math.min(1, t));
	return [
		c1[0] + (c2[0] - c1[0]) * clamped,
		c1[1] + (c2[1] - c1[1]) * clamped,
		c1[2] + (c2[2] - c1[2]) * clamped,
	];
}

function breathePhase(speed = 3.2, offset = 0): number {
	const nowSec = Date.now() / 1000;
	return (Math.sin(nowSec * speed + offset) + 1) / 2;
}

function breatheText(text: string, c1: Rgb, c2: Rgb, speed = 3.2, offset = 0): string {
	return rgbFg(lerpRgb(c1, c2, breathePhase(speed, offset)), text);
}

/**
 * Renders a 3-dot or 3-bar phase-shifted RGB wave (`●•·` or `▰▰▰`) that ripples smoothly.
 */
function renderBreathingWave(c1: Rgb, c2: Rgb, glyphs: [string, string, string] = ["●", "●", "●"]): string {
	const d0 = breatheText(glyphs[0], c1, c2, 4.2, 0);
	const d1 = breatheText(glyphs[1], c1, c2, 4.2, -1.1);
	const d2 = breatheText(glyphs[2], c1, c2, 4.2, -2.2);
	return `${d0}${d1}${d2}`;
}

function renderBreathingOrb(c1: Rgb, c2: Rgb): string {
	const p = breathePhase(3.8, 0);
	const glyph = p > 0.65 ? "◉" : p > 0.3 ? "◎" : "◈";
	return rgbFg(lerpRgb(c1, c2, p), glyph);
}

function markAnimationActive(): void {
	const st = getGlobalState();
	st.lastActiveRenderAt = Date.now();
	ensureAnimTimer();
}

function ensureAnimTimer(): void {
	const st = getGlobalState();
	if (st.animTimer) return;
	st.animTimer = setInterval(() => {
		const now = Date.now();
		// Keep running while agentBusy is true or an active streaming/tool render happened within the last 600ms
		if (!st.agentBusy && now - st.lastActiveRenderAt > 600) {
			clearInterval(st.animTimer);
			st.animTimer = undefined;
			return;
		}
		st.tui?.requestRender();
	}, 85);
	st.animTimer.unref?.();
}

function stopAnimTimerIfIdle(): void {
	const st = getGlobalState();
	st.agentBusy = false;
	st.lastActiveRenderAt = 0;
	if (st.animTimer) {
		clearInterval(st.animTimer);
		st.animTimer = undefined;
	}
	st.tui?.requestRender();
}

function claimHover(target: any, subRow = 0): boolean {
	const st = getGlobalState();
	st.targetClaimedOnMove = true;
	if (st.hoverTarget !== target || st.hoverSubRow !== subRow) {
		st.hoverTarget = target;
		st.hoverSubRow = subRow;
		return true;
	}
	return false;
}

function isHovered(target: any, subRow?: number): boolean {
	const st = getGlobalState();
	if (st.hoverTarget !== target) return false;
	if (subRow === undefined) return true;
	return st.hoverSubRow === subRow;
}

// Safe styling helpers that use the active Theme if available, or getMarkdownTheme() fallback
const fg = (color: any, text: string): string => {
	const t = getActiveTheme();
	if (t) {
		try {
			return t.fg(color, text);
		} catch {
			// fall through
		}
	}
	try {
		const md = getMarkdownTheme();
		switch (color) {
			case "accent":
			case "mdLink":
				return md.link(text);
			case "warning":
			case "bashMode":
			case "mdHeading":
				return md.heading(text);
			case "success":
			case "toolDiffAdded":
				return md.codeBlock(text);
			case "error":
			case "toolDiffRemoved":
				return `\x1b[38;2;247;118;142m${text}\x1b[39m`;
			case "toolTitle":
			case "mdCode":
				return md.code(text);
			case "dim":
			case "borderMuted":
				return md.codeBlockBorder(text);
			default:
				return md.quote(text);
		}
	} catch {
		return text;
	}
};

const bold = (text: string): string => {
	const t = getActiveTheme();
	if (t) return t.bold(text);
	try {
		return getMarkdownTheme().bold(text);
	} catch {
		return `\x1b[1m${text}\x1b[22m`;
	}
};

const italic = (text: string): string => {
	const t = getActiveTheme();
	if (t) return t.italic(text);
	try {
		return getMarkdownTheme().italic(text);
	} catch {
		return `\x1b[3m${text}\x1b[23m`;
	}
};

function shortenPath(filePath: string): string {
	if (!filePath) return "";
	const home = homedir();
	if (filePath.startsWith(home)) {
		return `~${filePath.slice(home.length)}`;
	}
	return filePath;
}

function formatDuration(durationMs?: number): string {
	if (durationMs === undefined || durationMs < 50) return "";
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function extractText(result?: { content?: Array<{ type: string; text?: string }> }): string {
	if (!result?.content) return "";
	const block = result.content.find((c) => c.type === "text");
	return block?.text ?? "";
}

// ============================================================================
// 1. Rich Markdown Patch (clean headings, framed code blocks, bullets & bold)
// ============================================================================
const ORIG_RENDER_TOKEN_KEY = Symbol.for("pretty-ui:origRenderToken");
const ORIG_RENDER_LIST_KEY = Symbol.for("pretty-ui:origRenderList");
const ORIG_RENDER_INLINE_KEY = Symbol.for("pretty-ui:origRenderInline");

let prettyMarkdownEnabled = true;
let compactToolsEnabled = true;

function installRichMarkdownRenderer(): void {
	const proto = Markdown.prototype as any;

	if (!proto[ORIG_RENDER_TOKEN_KEY]) {
		proto[ORIG_RENDER_TOKEN_KEY] = proto.renderToken;
	}
	if (!proto[ORIG_RENDER_LIST_KEY]) {
		proto[ORIG_RENDER_LIST_KEY] = proto.renderList;
	}
	if (!proto[ORIG_RENDER_INLINE_KEY]) {
		proto[ORIG_RENDER_INLINE_KEY] = proto.renderInlineTokens;
	}

	const origRenderToken = proto[ORIG_RENDER_TOKEN_KEY];
	const origRenderList = proto[ORIG_RENDER_LIST_KEY];
	const origRenderInline = proto[ORIG_RENDER_INLINE_KEY];

	proto.renderInlineTokens = function (tokens: any[], styleContext?: any): string {
		if (!prettyMarkdownEnabled || !Array.isArray(tokens)) {
			return origRenderInline.call(this, tokens, styleContext);
		}
		const isCustomContext = styleContext !== undefined;
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { stylePrefix } = resolvedStyleContext;

		let result = "";
		for (const token of tokens) {
			if (token.type === "strong" && !isCustomContext) {
				const boldStyleFn = (t: string) => this.theme.heading(this.theme.bold(t));
				const inner = this.renderInlineTokens(token.tokens || [], {
					applyText: boldStyleFn,
					stylePrefix: this.getStylePrefix(boldStyleFn),
				});
				result += boldStyleFn(inner) + stylePrefix;
			} else if (token.type === "codespan") {
				result += this.theme.bold(this.theme.code(token.text)) + stylePrefix;
			} else {
				result += origRenderInline.call(this, [token], resolvedStyleContext);
			}
		}
		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}
		return result;
	};

	proto.renderToken = function (token: any, width: number, nextTokenType?: string, styleContext?: any): string[] {
		if (!prettyMarkdownEnabled) {
			return origRenderToken.call(this, token, width, nextTokenType, styleContext);
		}

		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const depth: number = token.depth || 1;
				const headingStyleFn =
					depth === 1
						? (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)))
						: (text: string) => this.theme.heading(this.theme.bold(text));

				const headingStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};
				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);

				let badge = "";
				if (depth === 1) {
					badge = this.theme.heading(this.theme.bold("◆ "));
				} else if (depth === 2) {
					badge = this.theme.heading(this.theme.bold("▎ "));
				} else if (depth === 3) {
					badge = this.theme.listBullet(this.theme.bold("▸ "));
				} else {
					badge = this.theme.listBullet("• ");
				}

				lines.push(`${badge}${headingText}`);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push("");
				}
				return lines;
			}

			case "code": {
				const lang = (token.lang || "").trim();
				const boxWidth = Math.max(16, Math.min(width, 76));
				const borderStyle = (s: string) => this.theme.codeBlockBorder(s);

				if (lang) {
					const label = ` ${lang} `;
					const dashCount = Math.max(2, boxWidth - 3 - visibleWidth(label));
					lines.push(
						`${borderStyle("╭─")}${this.theme.code(this.theme.bold(label))}${borderStyle("─".repeat(dashCount))}`,
					);
				} else {
					lines.push(borderStyle(`╭${"─".repeat(Math.max(2, boxWidth - 1))}`));
				}

				const codeInnerWidth = Math.max(1, width - 3);
				const rawCodeLines: string[] = this.theme.highlightCode
					? this.theme.highlightCode(token.text, token.lang)
					: String(token.text ?? "")
							.split("\n")
							.map((l: string) => this.theme.codeBlock(l));

				const leftBar = borderStyle("│ ");
				for (const hlLine of rawCodeLines) {
					const wrapped = wrapTextWithAnsi(hlLine, codeInnerWidth);
					if (wrapped.length === 0) {
						lines.push(leftBar);
					} else {
						for (const wLine of wrapped) {
							lines.push(`${leftBar}${wLine}`);
						}
					}
				}

				lines.push(borderStyle(`╰${"─".repeat(Math.max(2, boxWidth - 1))}`));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push("");
				}
				return lines;
			}

			case "hr": {
				lines.push(this.theme.hr("┄".repeat(Math.min(width, 64))));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push("");
				}
				return lines;
			}

			case "blockquote": {
				const rendered: string[] = origRenderToken.call(this, token, width, nextTokenType, styleContext);
				const oldBorder = this.theme.quoteBorder("│ ");
				const newBorder = this.theme.quoteBorder("▎ ");
				return rendered.map((l) => (l.startsWith(oldBorder) ? newBorder + l.slice(oldBorder.length) : l));
			}

			default:
				return origRenderToken.call(this, token, width, nextTokenType, styleContext);
		}
	};

	proto.renderList = function (token: any, depth: number, width: number, styleContext?: any): string[] {
		if (!prettyMarkdownEnabled) {
			return origRenderList.call(this, token, depth, width, styleContext);
		}

		const lines: string[] = [];
		const indent = "  ".repeat(depth);
		const startNumber = typeof token.start === "number" ? token.start : 1;
		const bullets = ["• ", "◦ ", "▪ "];

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const isLastItem = i === token.items.length - 1;

			let markerFormatted: string;
			let markerPlainWidth: number;

			if (item.task) {
				if (item.checked) {
					markerFormatted = this.theme.codeBlock("☑ ");
					markerPlainWidth = 2;
				} else {
					markerFormatted = this.theme.codeBlockBorder("☐ ");
					markerPlainWidth = 2;
				}
			} else if (token.ordered) {
				const numStr = `${startNumber + i}. `;
				markerFormatted = this.theme.listBullet(this.theme.bold(numStr));
				markerPlainWidth = visibleWidth(numStr);
			} else {
				const bulletChar = bullets[Math.min(depth, bullets.length - 1)]!;
				markerFormatted = this.theme.listBullet(bulletChar);
				markerPlainWidth = visibleWidth(bulletChar);
			}

			const firstPrefix = indent + markerFormatted;
			const continuationPrefix = indent + " ".repeat(markerPlainWidth);
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;

			for (const itemToken of item.tokens) {
				if (itemToken.type === "list") {
					lines.push(...this.renderList(itemToken, depth + 1, width, styleContext));
					renderedAnyLine = true;
					continue;
				}
				const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
				for (const line of itemLines) {
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						lines.push(linePrefix + wrappedLine);
						renderedAnyLine = true;
					}
				}
			}

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
			}
			if (token.loose && !isLastItem) {
				lines.push("");
			}
		}

		return lines;
	};
}

// ============================================================================
// 2. Claude-Style Compact Thinking + Breathing Light & Hover
// ============================================================================
const ORIG_ASSISTANT_UPDATE_KEY = Symbol.for("pretty-ui:origAssistantUpdate");
const ORIG_ASSISTANT_SET_HIDE_KEY = Symbol.for("pretty-ui:origAssistantSetHide");

function hasVisibleAssistantText(msg: any): boolean {
	if (!msg || !Array.isArray(msg.content)) return false;
	if (msg.content.some((c: any) => c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0)) {
		return true;
	}
	const hasTools = msg.content.some((c: any) => c.type === "toolCall");
	if (msg.stopReason === "length") return true;
	if (!hasTools && (msg.stopReason === "aborted" || msg.stopReason === "error")) return true;
	return false;
}

function isAssistantShowingAnything(comp: any): boolean {
	if (!comp || !comp.lastMessage) return false;
	if (hasVisibleAssistantText(comp.lastMessage)) return true;
	if (comp.__forceExpandThinking) return true;
	if (comp.thinkingVisibilityOverrides && comp.thinkingVisibilityOverrides.size > 0) {
		for (const val of comp.thinkingVisibilityOverrides.values()) {
			if (val === false) return true;
		}
	}
	const hasTools = comp.lastMessage.content?.some((c: any) => c.type === "toolCall");
	if (comp.isStreaming && !hasTools) {
		const hasThinking = comp.lastMessage.content?.some(
			(c: any) => c.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim().length > 0,
		);
		if (hasThinking) return true;
	}
	return false;
}

class InteractiveThinkingBlock implements Component {
	private host: any;
	private runIndex: number;
	private fullThinking: string;
	private lineCount: number;
	private lastLine: string;
	private hasTextAfter: boolean;
	private hasTools: boolean;

	constructor(
		host: any,
		runIndex: number,
		fullThinking: string,
		lineCount: number,
		lastLine: string,
		hasTextAfter: boolean,
		hasTools: boolean,
	) {
		this.host = host;
		this.runIndex = runIndex;
		this.fullThinking = fullThinking;
		this.lineCount = lineCount;
		this.lastLine = lastLine;
		this.hasTextAfter = hasTextAfter;
		this.hasTools = hasTools;
	}

	private isHidden(): boolean {
		const defaultHidden = !this.host.__forceExpandThinking;
		return this.host.thinkingVisibilityOverrides?.get(this.runIndex) ?? defaultHidden;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const pad = " ".repeat(this.host.outputPad ?? 1);
		const hidden = this.isHidden();
		const hovered = isHovered(this.host, this.runIndex);

		// 1. Live streaming thinking with breathing RGB orb & wave
		if (this.host.isStreaming && !this.hasTextAfter && !this.hasTools && hidden) {
			markAnimationActive();
			const orb = renderBreathingOrb(COLOR_PURPLE, COLOR_CYAN);
			const wave = renderBreathingWave(COLOR_PURPLE, COLOR_CYAN, ["•", "•", "•"]);
			const label = breatheText("思考中", COLOR_PURPLE, COLOR_CYAN, 3.2, 0);
			const snippet = truncateToWidth(this.lastLine.replace(/^#+\s*/, ""), Math.max(20, width - 24), "…");
			return [`${pad}${orb} ${bold(label)} ${wave} ${italic(fg("thinkingText", snippet))}`];
		}

		// 2. Collapsed thinking summary (reacts to mouse hover!)
		if (hidden) {
			if (hovered) {
				const chevron = rgbFg(COLOR_CYAN, bold("▶"));
				const title = rgbFg(COLOR_PURPLE, bold(`💭 已思考 (${this.lineCount} 行)`));
				const badge = rgbFg(COLOR_CYAN, bold("[ ✦ 点击展开推理过程 ]"));
				return [`${pad}${chevron} ${title}  ${badge}`];
			}
			return [
				`${pad}${fg("borderMuted", "▸")} ${fg("muted", "💭 已思考")} ${fg("dim", `(${this.lineCount} 行 · 点击或 Ctrl+T 展开)`)}`,
			];
		}

		// 3. Expanded thinking block (reacts to mouse hover on header!)
		const header = hovered
			? `${pad}${rgbFg(COLOR_CYAN, bold("▼"))} ${rgbFg(COLOR_PURPLE, bold(`💭 思考过程 (${this.lineCount} 行)`))}  ${rgbFg(COLOR_AMBER, bold("[ ✦ 点击收起 ]"))}`
			: `${pad}${fg("accent", "▾")} ${fg("muted", "💭 思考过程")} ${fg("dim", `(${this.lineCount} 行 · 点击收起)`)}`;

		const lines = [header];
		const bodyPrefix = `${pad}  ${hovered ? rgbFg(COLOR_PURPLE, "▎") : fg("borderMuted", "▎")} `;
		const innerWidth = Math.max(12, width - visibleWidth(bodyPrefix));
		for (const rawLine of this.fullThinking.split("\n")) {
			const wrapped = wrapTextWithAnsi(italic(fg("thinkingText", rawLine)), innerWidth);
			if (wrapped.length === 0) {
				lines.push(bodyPrefix);
			} else {
				for (const w of wrapped) {
					lines.push(`${bodyPrefix}${w}`);
				}
			}
		}
		return lines;
	}

	handleMouse(event: MouseEvent) {
		if (event.type === "move") {
			const changed = claimHover(this.host, this.runIndex);
			return { handled: true, render: changed };
		}
		if (event.type === "click" && event.button === "left") {
			const hidden = this.isHidden();
			this.host.thinkingVisibilityOverrides.set(this.runIndex, !hidden);
			if (this.host.lastMessage) {
				this.host.updateContent(this.host.lastMessage, this.host.isStreaming);
			}
			return { handled: true, render: true };
		}
		return undefined;
	}
}

function installCompactThinkingRenderer(): void {
	const proto = AssistantMessageComponent.prototype as any;

	if (!proto[ORIG_ASSISTANT_UPDATE_KEY]) {
		proto[ORIG_ASSISTANT_UPDATE_KEY] = proto.updateContent;
	}
	if (!proto[ORIG_ASSISTANT_SET_HIDE_KEY]) {
		proto[ORIG_ASSISTANT_SET_HIDE_KEY] = proto.setHideThinkingBlock;
	}

	const origUpdateContent = proto[ORIG_ASSISTANT_UPDATE_KEY];
	const origSetHideThinkingBlock = proto[ORIG_ASSISTANT_SET_HIDE_KEY];

	proto.setHideThinkingBlock = function (hide: boolean) {
		if (!compactToolsEnabled) {
			return origSetHideThinkingBlock.call(this, hide);
		}
		this.__forceExpandThinking = !this.__forceExpandThinking;
		this.thinkingVisibilityOverrides?.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage, this.isStreaming);
		}
	};

	proto.updateContent = function (message: any, isStreaming = this.isStreaming) {
		if (!compactToolsEnabled) {
			return origUpdateContent.call(this, message, isStreaming);
		}

		this.lastMessage = message;
		this.isStreaming = isStreaming;
		this.contentContainer.clear();

		if (!message || !Array.isArray(message.content)) {
			return;
		}

		const hasTools = message.content.some((c: any) => c.type === "toolCall");
		this.hasToolCalls = hasTools;
		const hasText = message.content.some((c: any) => c.type === "text" && c.text?.trim());

		let addedTopSpacer = false;
		const ensureTopSpacer = () => {
			if (!addedTopSpacer) {
				this.contentContainer.addChild(new Spacer(1));
				addedTopSpacer = true;
			}
		};

		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				ensureTopSpacer();
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: undefined,
					}),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const tc = message.content[i];
					if (tc.type !== "thinking") break;
					const t = tc.thinking?.trim();
					if (t) thinkingBlocks.push(t);
				}
				i--;
				if (thinkingBlocks.length === 0) continue;

				const runIndex = thinkingRunIndex++;
				const defaultHidden = !this.__forceExpandThinking;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? defaultHidden;

				const fullThinking = thinkingBlocks.join("\n\n");
				const allLines = fullThinking
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean);
				const lineCount = allLines.length;
				const lastLine = allLines[allLines.length - 1] ?? "";

				const hasTextAfter = message.content
					.slice(i + 1)
					.some((c: any) => c.type === "text" && c.text?.trim());

				// Intermediate tool-calling thought folds to 0 lines once toolCall starts
				if (!hasText && (hasTools || !this.isStreaming) && hidden) {
					continue;
				}

				ensureTopSpacer();
				this.contentContainer.addChild(
					new InteractiveThinkingBlock(
						this,
						runIndex,
						fullThinking,
						lineCount,
						lastLine,
						hasTextAfter,
						hasTools,
					),
				);

				if (hasTextAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		if (message.stopReason === "length") {
			ensureTopSpacer();
			this.contentContainer.addChild(
				new Text(fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasTools) {
			if (message.stopReason === "aborted") {
				ensureTopSpacer();
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Text(fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				ensureTopSpacer();
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Text(fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	};
}

// ============================================================================
// 3. Claude-Style Consecutive Tool Grouping + Breathing Light & Hover
// ============================================================================
const ORIG_CONTAINER_ADD_KEY = Symbol.for("pretty-ui:origContainerAdd");
const ORIG_CONTAINER_RENDER_KEY = Symbol.for("pretty-ui:origContainerRender");
const ORIG_CONTAINER_MOUSE_KEY = Symbol.for("pretty-ui:origContainerMouse");
const ORIG_TOOL_RENDER_KEY = Symbol.for("pretty-ui:origToolRender");
const ORIG_TOOL_MOUSE_KEY = Symbol.for("pretty-ui:origToolMouse");
const ORIG_TOOL_SET_EXPANDED_KEY = Symbol.for("pretty-ui:origToolSetExpanded");
const ORIG_TOOL_MARK_START_KEY = Symbol.for("pretty-ui:origToolMarkStart");

function getConsecutiveToolGroup(toolComp: any): any[] {
	const parent = toolComp.__parentContainer;
	if (!parent || !Array.isArray(parent.children)) {
		return [toolComp];
	}

	const children: any[] = parent.children;
	const myIdx = children.indexOf(toolComp);
	if (myIdx === -1) {
		return [toolComp];
	}

	const isTransparentIntermediate = (c: any): boolean => {
		if (c instanceof ToolExecutionComponent) return true;
		if (c instanceof AssistantMessageComponent) {
			return !isAssistantShowingAnything(c);
		}
		return false;
	};

	let startIdx = myIdx;
	while (startIdx > 0 && isTransparentIntermediate(children[startIdx - 1])) {
		startIdx--;
	}

	let endIdx = myIdx;
	while (endIdx + 1 < children.length && isTransparentIntermediate(children[endIdx + 1])) {
		endIdx++;
	}

	const group: any[] = [];
	for (let i = startIdx; i <= endIdx; i++) {
		if (children[i] instanceof ToolExecutionComponent && !children[i].hideComponent) {
			group.push(children[i]);
		}
	}

	return group.length > 0 ? group : [toolComp];
}

function isToolGroupStillActiveInTurn(lastTool: any): boolean {
	const st = getGlobalState();
	if (!st.agentBusy) return false;
	const parent = lastTool?.__parentContainer;
	if (!parent || !Array.isArray(parent.children)) return false;
	const idx = parent.children.indexOf(lastTool);
	if (idx === -1) return false;
	for (let i = idx + 1; i < parent.children.length; i++) {
		const child = parent.children[i];
		if (child instanceof ToolExecutionComponent && !child.hideComponent) {
			return false;
		}
		if (child instanceof AssistantMessageComponent) {
			const msg = (child as any).lastMessage;
			const hasText =
				Array.isArray(msg?.content) && msg.content.some((c: any) => c.type === "text" && c.text?.trim());
			if (hasText) return false;
		}
	}
	return true;
}

function summarizeGroupCounts(group: any[]): string {
	const counts = new Map<string, number>();
	for (const t of group) {
		const name = String(t.toolName || "tool");
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const parts: string[] = [];
	for (const [name, count] of counts.entries()) {
		parts.push(count > 1 ? `${name} ×${count}` : name);
	}
	return parts.join(", ");
}

function formatSingleToolLine(
	toolComp: any,
	maxWidth: number,
	opts: { showChevron?: boolean; expanded?: boolean; hovered?: boolean; pulseFront?: boolean } = {},
): string {
	const toolName = String(toolComp.toolName || "tool");
	const args = toolComp.args || {};
	const result = toolComp.result;
	const isPartial = Boolean(toolComp.isPartial);
	const isError = Boolean(result?.isError);
	const hovered = Boolean(opts.hovered);
	const pulseFront = Boolean(opts.pulseFront) || isPartial;

	let durationMs = !isPartial ? result?.durationMs : undefined;
	if (isPartial && toolComp.__startedAt) {
		durationMs = Date.now() - toolComp.__startedAt;
	}
	const durStr = formatDuration(durationMs);

	const chevron = opts.showChevron
		? opts.expanded
			? hovered
				? `${rgbFg(COLOR_CYAN, bold("▼"))} `
				: `${fg("accent", "▾")} `
			: hovered
				? `${rgbFg(COLOR_CYAN, bold("▶"))} `
				: `${fg("borderMuted", "▸")} `
		: "";

	const statusIcon = pulseFront
		? `${renderBreathingWave(COLOR_AMBER, COLOR_CYAN, ["▰", "▰", "▰"])} ${renderBreathingOrb(COLOR_AMBER, COLOR_CYAN)}${!isPartial && !isError ? ` ${fg("success", "✓")}` : ""}`
		: isError
			? fg("error", "✗")
			: fg("success", "✓");

	let callDesc = "";
	let resultDesc = "";

	if (toolName === "bash" || toolName === "powershell") {
		const rawCmd = String(args?.command ?? "…")
			.replace(/\r?\n/g, " ↵ ")
			.trim();
		const cmdShort = truncateToWidth(rawCmd, Math.max(20, Math.min(52, maxWidth - 34)), "…");
		const cmdStyled = hovered ? rgbFg(COLOR_CYAN, bold(cmdShort)) : fg("toolTitle", cmdShort);
		callDesc = `${fg("bashMode", bold("$"))} ${cmdStyled}`;

		const out = extractText(result).trim();
		const lines = out ? out.split("\n") : [];
		if (isPartial) {
			const lastLine = lines.filter(Boolean).pop() ?? "";
			const wave = renderBreathingWave(COLOR_AMBER, COLOR_CYAN, ["•", "•", "•"]);
			resultDesc = lastLine
				? `${wave} ${fg("dim", truncateToWidth(lastLine.trim(), 28, "…"))}`
				: `${breatheText("Running", COLOR_AMBER, COLOR_CYAN, 3.6)} ${wave}`;
		} else if (isError) {
			resultDesc = fg("error", `Failed (${lines.length} lines)`);
		} else if (lines.length === 0 || out === "(no output)") {
			resultDesc = fg("dim", "done");
		} else if (lines.length === 1 && visibleWidth(lines[0]!) <= 36) {
			resultDesc = fg("muted", lines[0]!.trim());
		} else {
			resultDesc = fg("muted", `${lines.length} lines`);
		}
	} else if (toolName === "read") {
		const p = shortenPath(String(args?.path ?? ""));
		const range = formatReadLineRange(args?.offset, args?.limit);
		const pathStyled = hovered ? rgbFg(COLOR_CYAN, bold(p)) : fg("accent", p);
		callDesc = `${fg("mdLink", "📖")} ${fg("toolTitle", bold("read"))} ${pathStyled}${range ? fg("warning", range) : ""}`;

		if (isPartial) {
			resultDesc = `${breatheText("Reading", COLOR_CYAN, COLOR_PURPLE, 3.6)} ${renderBreathingWave(COLOR_CYAN, COLOR_PURPLE, ["•", "•", "•"])}`;
		} else if (isError) {
			const errLine = extractText(result).split("\n")[0] || "Read failed";
			resultDesc = fg("error", truncateToWidth(errLine, 36, "…"));
		} else if (result?.content?.some((c: any) => c.type === "image")) {
			resultDesc = fg("muted", "image");
		} else {
			const out = extractText(result);
			const lineCount = out ? out.split("\n").length : 0;
			const details = result?.details as ReadToolDetails | undefined;
			const trunc = details?.truncation?.truncated ? `/${details.truncation.totalLines}` : "";
			resultDesc = fg("muted", `${lineCount}${trunc} lines`);
		}
	} else if (toolName === "edit") {
		const p = shortenPath(String(args?.path ?? ""));
		const pathStyled = hovered ? rgbFg(COLOR_CYAN, bold(p)) : fg("accent", p);
		callDesc = `${fg("warning", "✏️ ")} ${fg("toolTitle", bold("edit"))} ${pathStyled}`;

		if (isPartial) {
			resultDesc = `${breatheText("Applying", COLOR_AMBER, COLOR_CYAN, 3.6)} ${renderBreathingWave(COLOR_AMBER, COLOR_CYAN, ["•", "•", "•"])}`;
		} else if (isError) {
			const errLine = extractText(result).split("\n")[0] || "Edit failed";
			resultDesc = fg("error", truncateToWidth(errLine, 36, "…"));
		} else {
			const details = result?.details as EditToolDetails | undefined;
			if (details?.diff) {
				let added = 0;
				let removed = 0;
				for (const l of details.diff.split("\n")) {
					if (l.startsWith("+") && !l.startsWith("+++")) added++;
					if (l.startsWith("-") && !l.startsWith("---")) removed++;
				}
				resultDesc = `${fg("toolDiffAdded", `+${added}`)} ${fg("dim", "/")} ${fg("toolDiffRemoved", `-${removed}`)}`;
			} else {
				resultDesc = fg("muted", "applied");
			}
		}
	} else if (toolName === "write") {
		const p = shortenPath(String(args?.path ?? ""));
		const lineCount = typeof args?.content === "string" ? args.content.split("\n").length : 0;
		const pathStyled = hovered ? rgbFg(COLOR_CYAN, bold(p)) : fg("accent", p);
		callDesc = `${fg("success", "📝")} ${fg("toolTitle", bold("write"))} ${pathStyled}`;
		if (isPartial) {
			resultDesc = `${breatheText("Writing", COLOR_TEAL, COLOR_CYAN, 3.6)} ${renderBreathingWave(COLOR_TEAL, COLOR_CYAN, ["•", "•", "•"])}`;
		} else if (isError) {
			resultDesc = fg("error", "Write failed");
		} else {
			resultDesc = fg("muted", lineCount > 0 ? `${lineCount} lines` : "written");
		}
	} else if (toolName === "web_search") {
		const q = truncateToWidth(String(args?.query ?? ""), 48, "…");
		const qStyled = hovered ? rgbFg(COLOR_CYAN, bold(`"${q}"`)) : fg("accent", `"${q}"`);
		callDesc = `${fg("mdLink", "🌐")} ${fg("toolTitle", bold("web_search"))} ${qStyled}`;
		if (isPartial) {
			resultDesc = `${breatheText("Searching", COLOR_CYAN, COLOR_PURPLE, 3.6)} ${renderBreathingWave(COLOR_CYAN, COLOR_PURPLE, ["•", "•", "•"])}`;
		} else if (isError) {
			resultDesc = fg("error", "Search failed");
		} else {
			const count = result?.details?.resultCount;
			resultDesc = fg("muted", typeof count === "number" ? `${count} results` : "done");
		}
	} else if (toolName === "web_fetch") {
		const u = truncateToWidth(String(args?.url ?? ""), 52, "…");
		const uStyled = hovered ? rgbFg(COLOR_CYAN, bold(u)) : fg("mdLink", u);
		callDesc = `${fg("mdLink", "🔗")} ${fg("toolTitle", bold("web_fetch"))} ${uStyled}`;
		if (isPartial) {
			resultDesc = `${breatheText("Fetching", COLOR_CYAN, COLOR_PURPLE, 3.6)} ${renderBreathingWave(COLOR_CYAN, COLOR_PURPLE, ["•", "•", "•"])}`;
		} else if (isError) {
			resultDesc = fg("error", "Fetch failed");
		} else {
			const chars = result?.details?.charCount;
			resultDesc = fg("muted", typeof chars === "number" ? `${(chars / 1024).toFixed(1)}KB` : "done");
		}
	} else if (toolName === "grep") {
		const pat = truncateToWidth(String(args?.pattern ?? ""), 36, "…");
		const p = args?.path ? ` ${fg("dim", shortenPath(String(args.path)))}` : "";
		callDesc = `${fg("accent", "🔍")} ${fg("toolTitle", bold("grep"))} ${fg("accent", `"${pat}"`)}${p}`;
		if (isPartial) {
			resultDesc = `${breatheText("Searching", COLOR_CYAN, COLOR_PURPLE, 3.6)} ${renderBreathingWave(COLOR_CYAN, COLOR_PURPLE, ["•", "•", "•"])}`;
		} else if (isError) {
			resultDesc = fg("error", "Failed");
		} else {
			const out = extractText(result).trim();
			const lines = out ? out.split("\n") : [];
			resultDesc = fg("muted", out === "No matches found" ? "0 matches" : `${lines.length} lines`);
		}
	} else if (toolName === "find" || toolName === "ls") {
		const pat = args?.pattern ? `"${truncateToWidth(String(args.pattern), 32, "…")}"` : "";
		const p = args?.path ? shortenPath(String(args.path)) : ".";
		callDesc = `${fg("accent", "📂")} ${fg("toolTitle", bold(toolName))} ${fg("accent", pat || p)}`;
		if (isPartial) {
			resultDesc = `${breatheText("Scanning", COLOR_CYAN, COLOR_PURPLE, 3.6)} ${renderBreathingWave(COLOR_CYAN, COLOR_PURPLE, ["•", "•", "•"])}`;
		} else if (isError) {
			resultDesc = fg("error", "Failed");
		} else {
			const out = extractText(result).trim();
			const lines = out ? out.split("\n") : [];
			resultDesc = fg("muted", `${lines.length} items`);
		}
	} else if (toolName === "codemode") {
		const codeStr = String(args?.code ?? "");
		const innerCounts = new Map<string, number>();
		for (const m of codeStr.matchAll(/\btools\.([a-zA-Z0-9_]+)\s*\(/g)) {
			const name = m[1]!;
			innerCounts.set(name, (innerCounts.get(name) ?? 0) + 1);
		}
		const innerSummary =
			innerCounts.size > 0
				? Array.from(innerCounts.entries())
						.map(([k, v]) => (v > 1 ? `${k} ×${v}` : k))
						.join(", ")
				: "JS sandbox";
		callDesc = `${fg("warning", "⚡")} ${fg("toolTitle", bold("codemode"))} ${fg("accent", `(${innerSummary})`)}`;
		if (isPartial) {
			resultDesc = `${breatheText("Executing script", COLOR_AMBER, COLOR_CYAN, 3.6)} ${renderBreathingWave(COLOR_AMBER, COLOR_CYAN, ["•", "•", "•"])}`;
		} else if (isError) {
			resultDesc = fg("error", "Script failed");
		} else {
			const out = extractText(result).trim();
			const lines = out ? out.split("\n") : [];
			resultDesc = fg("muted", `${lines.length} lines`);
		}
	} else if (toolName === "session_recall") {
		const action = String(args?.action ?? "recall");
		const target = args?.query
			? `"${truncateToWidth(String(args.query), 32, "…")}"`
			: args?.seq !== undefined
				? `#${args.seq}`
				: args?.start_seq !== undefined
					? `#${args.start_seq}..#${args.end_seq ?? ""}`
					: args?.session_id
						? String(args.session_id).slice(0, 12)
						: String(args?.scope ?? "");
		callDesc = `${fg("accent", "📚")} ${fg("toolTitle", bold("session_recall"))} ${fg("accent", action)}${target ? ` ${fg("muted", target)}` : ""}`;
		if (isPartial) {
			resultDesc = `${breatheText("Recalling", COLOR_CYAN, COLOR_PURPLE, 3.6)} ${renderBreathingWave(COLOR_CYAN, COLOR_PURPLE, ["•", "•", "•"])}`;
		} else if (isError) {
			resultDesc = fg("error", "Failed");
		} else {
			const out = extractText(result).trim();
			const lines = out ? out.split("\n") : [];
			resultDesc = fg("muted", `${lines.length} lines`);
		}
	} else {
		const argPreview =
			args?.path
				? shortenPath(String(args.path))
				: args?.pattern
					? String(args.pattern)
					: args?.action
						? String(args.action)
						: args?.task
							? truncateToWidth(String(args.task), 36, "…")
							: "";
		callDesc = `${fg("accent", "🔧")} ${fg("toolTitle", bold(toolName))}${argPreview ? ` ${fg("accent", argPreview)}` : ""}`;
		if (isPartial) {
			resultDesc = `${breatheText("Running", COLOR_CYAN, COLOR_PURPLE, 3.6)} ${renderBreathingWave(COLOR_CYAN, COLOR_PURPLE, ["•", "•", "•"])}`;
		} else if (isError) {
			resultDesc = fg("error", "Failed");
		} else {
			const out = extractText(result).trim();
			const lines = out ? out.split("\n") : [];
			resultDesc = lines.length > 0 ? fg("muted", `${lines.length} lines`) : fg("dim", "done");
		}
	}

	const durPart = durStr ? ` ${fg("dim", `· ${durStr}`)}` : "";
	return `${chevron}${statusIcon} ${callDesc} ${fg("dim", "·")} ${resultDesc}${durPart}`;
}

function renderToolExpandedDetails(toolComp: any, width: number, indentPrefix: string): string[] {
	const lines: string[] = [];
	const toolName = String(toolComp.toolName || "tool");
	const args = toolComp.args || {};
	const result = toolComp.result;
	const innerWidth = Math.max(10, width - visibleWidth(indentPrefix));

	if (toolName === "bash" || toolName === "powershell") {
		const rawCmd = String(args?.command ?? "").trim();
		if (rawCmd.includes("\n") || rawCmd.length > 50) {
			for (const cmdLine of rawCmd.split("\n")) {
				for (const w of wrapTextWithAnsi(`${fg("bashMode", "$")} ${fg("toolTitle", cmdLine)}`, innerWidth)) {
					lines.push(`${indentPrefix}${w}`);
				}
			}
		}
	}

	if (toolName === "edit" && result?.details?.diff) {
		const diffLines: string[] = String(result.details.diff).split("\n");
		const maxLines = 60;
		for (const dLine of diffLines.slice(0, maxLines)) {
			let styled: string;
			if (dLine.startsWith("+") && !dLine.startsWith("+++")) {
				styled = fg("toolDiffAdded", dLine);
			} else if (dLine.startsWith("-") && !dLine.startsWith("---")) {
				styled = fg("toolDiffRemoved", dLine);
			} else {
				styled = fg("toolDiffContext", dLine);
			}
			for (const w of wrapTextWithAnsi(styled, innerWidth)) {
				lines.push(`${indentPrefix}${w}`);
			}
		}
		if (diffLines.length > maxLines) {
			lines.push(`${indentPrefix}${fg("dim", `… (${diffLines.length - maxLines} more diff lines)`)}`);
		}
		return lines;
	}

	const textOut = extractText(result).trim();
	if (!textOut) {
		if (!toolComp.isPartial) {
			lines.push(`${indentPrefix}${fg("dim", "(no output)")}`);
		}
		return lines;
	}

	const outLines = textOut.split("\n");
	const maxLines = 50;
	const colorKey = result?.isError ? "error" : "toolOutput";
	for (const oLine of outLines.slice(0, maxLines)) {
		for (const w of wrapTextWithAnsi(fg(colorKey, oLine), innerWidth)) {
			lines.push(`${indentPrefix}${w}`);
		}
	}
	if (outLines.length > maxLines) {
		lines.push(`${indentPrefix}${fg("dim", `… (${outLines.length - maxLines} more lines)`)}`);
	}
	return lines;
}

function installGroupedToolRenderer(): void {
	const containerProto = Container.prototype as any;
	if (!containerProto[ORIG_CONTAINER_ADD_KEY]) {
		containerProto[ORIG_CONTAINER_ADD_KEY] = containerProto.addChild;
	}
	if (!containerProto[ORIG_CONTAINER_RENDER_KEY]) {
		containerProto[ORIG_CONTAINER_RENDER_KEY] = containerProto.render;
	}
	if (!containerProto[ORIG_CONTAINER_MOUSE_KEY]) {
		containerProto[ORIG_CONTAINER_MOUSE_KEY] = containerProto.handleMouse;
	}

	const origAddChild = containerProto[ORIG_CONTAINER_ADD_KEY];
	const origContainerRender = containerProto[ORIG_CONTAINER_RENDER_KEY];
	const origContainerMouse = containerProto[ORIG_CONTAINER_MOUSE_KEY];

	containerProto.addChild = function (component: any) {
		if (
			!(this instanceof ToolExecutionComponent) &&
			!(this instanceof AssistantMessageComponent) &&
			(component instanceof ToolExecutionComponent || component instanceof AssistantMessageComponent)
		) {
			component.__parentContainer = this;
		}
		return origAddChild.call(this, component);
	};

	containerProto.render = function (width: number) {
		if (
			!(this instanceof ToolExecutionComponent) &&
			!(this instanceof AssistantMessageComponent) &&
			Array.isArray(this.children)
		) {
			for (const child of this.children) {
				if (child instanceof ToolExecutionComponent || child instanceof AssistantMessageComponent) {
					child.__parentContainer = this;
				}
			}
		}
		return origContainerRender.call(this, width);
	};

	containerProto.handleMouse = function (event: MouseEvent) {
		const st = getGlobalState();
		if (event.type === "move") {
			const moveKey = `${event.screenX},${event.screenY}`;
			if (st.lastMoveScreenKey !== moveKey) {
				st.lastMoveScreenKey = moveKey;
				st.targetClaimedOnMove = false;
			}
		}

		const result = origContainerMouse.call(this, event);

		// If a mouse move hit non-interactive space in any outer container, clear hover state immediately
		if (
			event.type === "move" &&
			!result &&
			!st.targetClaimedOnMove &&
			st.hoverTarget !== null &&
			!(this instanceof ToolExecutionComponent) &&
			!(this instanceof AssistantMessageComponent)
		) {
			st.hoverTarget = null;
			st.hoverSubRow = -1;
			return { handled: true, render: true };
		}

		return result;
	};

	// Also clear hover when moving into empty ScrollView viewport space below the messages
	const scrollProto = ScrollView.prototype as any;
	scrollProto.handleMouse = function (event: MouseEvent) {
		const st = getGlobalState();
		if (event.type === "move" && st.hoverTarget !== null && !st.targetClaimedOnMove) {
			st.hoverTarget = null;
			st.hoverSubRow = -1;
			return { handled: true, render: true };
		}
		return undefined;
	};

	const toolProto = ToolExecutionComponent.prototype as any;
	if (!toolProto[ORIG_TOOL_RENDER_KEY]) {
		toolProto[ORIG_TOOL_RENDER_KEY] = toolProto.render;
	}
	if (!toolProto[ORIG_TOOL_MOUSE_KEY]) {
		toolProto[ORIG_TOOL_MOUSE_KEY] = toolProto.handleMouse;
	}
	if (!toolProto[ORIG_TOOL_SET_EXPANDED_KEY]) {
		toolProto[ORIG_TOOL_SET_EXPANDED_KEY] = toolProto.setExpanded;
	}
	if (!toolProto[ORIG_TOOL_MARK_START_KEY]) {
		toolProto[ORIG_TOOL_MARK_START_KEY] = toolProto.markExecutionStarted;
	}

	const origToolRender = toolProto[ORIG_TOOL_RENDER_KEY];
	const origToolMouse = toolProto[ORIG_TOOL_MOUSE_KEY];
	const origToolSetExpanded = toolProto[ORIG_TOOL_SET_EXPANDED_KEY];
	const origToolMarkStart = toolProto[ORIG_TOOL_MARK_START_KEY];

	toolProto.markExecutionStarted = function () {
		this.__startedAt = Date.now();
		setActiveTui(this.ui);
		markAnimationActive();
		return origToolMarkStart.call(this);
	};

	toolProto.setExpanded = function (expanded: boolean) {
		const wasInChat = Boolean(this.__parentContainer);
		this.__itemExpanded = expanded;
		if (wasInChat) {
			const group = getConsecutiveToolGroup(this);
			if (group[0]) {
				group[0].__groupExpanded = expanded;
			}
		}
		return origToolSetExpanded.call(this, expanded);
	};

	toolProto.render = function (width: number): string[] {
		if (!compactToolsEnabled) {
			return origToolRender.call(this, width);
		}
		if (this.hideComponent) {
			return [];
		}

		setActiveTui(this.ui);
		if (this.isPartial) {
			if (!this.__startedAt) this.__startedAt = Date.now();
			markAnimationActive();
		}

		const pad = " ".repeat(this.outputPad ?? 1);
		const group = getConsecutiveToolGroup(this);
		const total = group.length;
		const myIndex = group.indexOf(this);
		const hovered = isHovered(this);
		const hoverRow = getGlobalState().hoverSubRow;

		// Case 1: Single tool execution (total === 1)
		if (total <= 1) {
			if (!this.__startedAt) this.__startedAt = Date.now();
			const activeInTurn = Boolean(this.isPartial) || isToolGroupStillActiveInTurn(this);
			if (activeInTurn) {
				markAnimationActive();
			}

			const isExpanded = Boolean(this.__itemExpanded);
			const lines: string[] = [""];
			const mainLine = formatSingleToolLine(this, width - visibleWidth(pad), {
				showChevron: true,
				expanded: isExpanded,
				hovered,
				pulseFront: activeInTurn,
			});

			let hint = "";
			if (!this.isPartial && activeInTurn) {
				const liveElapsed = formatDuration(Date.now() - this.__startedAt);
				const nextDots = renderBreathingWave(COLOR_PURPLE, COLOR_CYAN, ["•", "•", "•"]);
				hint = `  ${breatheText("正在继续执行", COLOR_AMBER, COLOR_CYAN, 3.4)}${liveElapsed ? fg("dim", ` · ${liveElapsed}`) : ""} ${nextDots}`;
			} else if (!this.isPartial) {
				if (hovered) {
					hint = isExpanded
						? `  ${rgbFg(COLOR_AMBER, bold("[ ✦ 点击收起 ]"))}`
						: `  ${rgbFg(COLOR_CYAN, bold("[ ✦ 点击展开输出 ]"))}`;
				} else if (!isExpanded) {
					hint = ` ${fg("dim", "(点击展开)")}`;
				}
			}

			lines.push(`${pad}${mainLine}${hint}`);

			if (isExpanded) {
				const pipeColor = hovered ? rgbFg(COLOR_CYAN, "│ ") : fg("borderMuted", "│ ");
				const detailPrefix = `${pad}  ${pipeColor}`;
				lines.push(...renderToolExpandedDetails(this, width, detailPrefix));
			} else if (this.result?.isError && !this.isPartial) {
				const detailPrefix = `${pad}  ${fg("borderMuted", "└─ ")}`;
				const firstErr = extractText(this.result).trim().split("\n")[0];
				if (firstErr) {
					lines.push(`${detailPrefix}${fg("error", truncateToWidth(firstErr, width - 8, "…"))}`);
				}
			}
			return lines;
		}

		// Case 2: Part of a consecutive multi-tool group (total >= 2)
		const leader = group[0];
		if (!leader.__groupStartedAt) {
			leader.__groupStartedAt = leader.__startedAt || Date.now();
		}
		const groupExpanded = Boolean(leader.__groupExpanded);
		const breakdown = summarizeGroupCounts(group);
		const runningTools = group.filter((t) => !t.result || t.isPartial);
		const isGroupRunning = runningTools.length > 0;
		const isGroupActive = isGroupRunning || isToolGroupStillActiveInTurn(group[total - 1]);
		const doneCount = total - runningTools.length;
		const errorCount = group.filter((t) => t.result && !t.isPartial && t.result.isError).length;
		const totalDurationMs = isGroupActive
			? Date.now() - leader.__groupStartedAt
			: group.reduce((acc, t) => acc + (!t.isPartial && t.result?.durationMs ? t.result.durationMs : 0), 0);
		const totalDurStr = formatDuration(totalDurationMs);

		if (isGroupActive) {
			markAnimationActive();
		}

		// Subcase 2A: Group is COLLAPSED -> earlier tools take 0 lines; only the last tool renders the group card!
		if (!groupExpanded) {
			if (myIndex < total - 1) {
				return [];
			}

			const lines: string[] = [""];
			if (isGroupActive) {
				const activeTool = runningTools[runningTools.length - 1] ?? this;
				const stepNum = isGroupRunning ? Math.min(total, doneCount + 1) : total;
				const chevron = hovered ? rgbFg(COLOR_CYAN, bold("▶")) : fg("borderMuted", "▸");
				const wave = renderBreathingWave(COLOR_AMBER, COLOR_CYAN, ["▰", "▰", "▰"]);
				const orb = renderBreathingOrb(COLOR_AMBER, COLOR_CYAN);
				const titleText = breatheText(
					isGroupRunning ? `正在执行命令 (${stepNum}/${total}` : `正在连续执行命令 (已完成 ${total} 步`,
					COLOR_AMBER,
					COLOR_CYAN,
					3.4,
					0,
				);
				const durBadge = totalDurStr ? ` · ${totalDurStr}` : "";
				const hoverBadge = hovered
					? `  ${rgbFg(COLOR_CYAN, bold("[ ✦ 点击展开实时历史 ]"))}`
					: ` ${fg("dim", "(点击展开历史)")}`;

				const header =
					`${pad}${chevron} ${wave} ${orb} ` +
					`${bold(titleText)} ` +
					`${fg("muted", `· ${breakdown}${durBadge}`)}${bold(rgbFg(COLOR_CYAN, ")"))}` +
					hoverBadge;

				const branch = hovered ? rgbFg(COLOR_CYAN, "  ╰─▶ ") : fg("borderMuted", "  └─ ");
				const activeSummary = formatSingleToolLine(activeTool, width - visibleWidth(pad) - 24, {
					showChevron: false,
					hovered,
				});
				const trailingPulse = isGroupRunning
					? ""
					: `  ${renderBreathingOrb(COLOR_PURPLE, COLOR_CYAN)} ${breatheText("准备下一步", COLOR_PURPLE, COLOR_CYAN, 3.6)} ${renderBreathingWave(COLOR_PURPLE, COLOR_CYAN, ["•", "•", "•"])}`;
				const activeLine = `${pad}${branch}${activeSummary}${trailingPulse}`;
				lines.push(header, activeLine);
			} else {
				const chevron = hovered ? rgbFg(COLOR_CYAN, bold("▶")) : fg("borderMuted", "▸");
				const statusIcon = errorCount > 0 ? fg("error", "✗") : fg("success", "⚡");
				const errBadge = errorCount > 0 ? ` ${fg("error", `· ${errorCount} 失败`)}` : "";
				const durBadge = totalDurStr ? ` ${fg("dim", `· ${totalDurStr}`)}` : "";
				const titleColored = hovered
					? rgbFg(COLOR_CYAN, bold(`已连续执行 ${total} 个命令`))
					: fg("toolTitle", bold(`已连续执行 ${total} 个命令`));
				const hoverBadge = hovered
					? `  ${rgbFg(COLOR_CYAN, bold(`[ ✦ 点击展开全部 ${total} 步历史 ]`))}`
					: ` ${fg("dim", "(点击展开历史)")}`;

				const header =
					`${pad}${chevron} ${statusIcon} ` +
					`${titleColored} ` +
					`${fg("muted", `(${breakdown}${durBadge}${errBadge})`)}` +
					hoverBadge;

				const branch = hovered ? rgbFg(COLOR_CYAN, "  ╰─▶ ") : fg("borderMuted", "  └─ ");
				const latestLine =
					`${pad}${branch}${fg("dim", "最新:")} ` +
					formatSingleToolLine(this, width - visibleWidth(pad) - 11, {
						showChevron: false,
						hovered,
					});
				lines.push(header, latestLine);
			}
			return lines;
		}

		// Subcase 2B: Group is EXPANDED -> leader renders group header + step 1; each subsequent tool renders step i+1
		const lines: string[] = [];
		const headerHovered = myIndex === 0 && hovered && hoverRow <= 1;
		const stepHovered = myIndex === 0 ? hovered && hoverRow >= 2 : hovered;

		if (myIndex === 0) {
			lines.push("");
			const chevron = headerHovered ? rgbFg(COLOR_AMBER, bold("▼")) : fg("accent", "▾");
			const statusIcon = isGroupActive
				? `${renderBreathingWave(COLOR_AMBER, COLOR_CYAN, ["▰", "▰", "▰"])} ${renderBreathingOrb(COLOR_AMBER, COLOR_CYAN)}`
				: errorCount > 0
					? fg("error", "✗")
					: fg("success", "⚡");
			const durBadge = totalDurStr ? ` · ${totalDurStr}` : "";
			const titleColored = headerHovered
				? rgbFg(COLOR_AMBER, bold(`命令调用历史 (共 ${total} 步: ${breakdown}${durBadge})`))
				: fg("toolTitle", bold(`命令调用历史 (共 ${total} 步: ${breakdown}${durBadge})`));
			const badge = headerHovered
				? `  ${rgbFg(COLOR_AMBER, bold("[ ✦ 点击此处收起历史 ]"))}`
				: ` ${fg("dim", "(点击此处收起)")}`;

			lines.push(`${pad}${chevron} ${statusIcon} ${titleColored}${badge}`);
		}

		const isLast = myIndex === total - 1;
		const branch = stepHovered
			? rgbFg(COLOR_CYAN, isLast ? "  ╰─▶ " : "  ├─▶ ")
			: fg("borderMuted", isLast ? "  └─ " : "  ├─ ");
		const stepLabel = stepHovered ? rgbFg(COLOR_CYAN, bold(`${myIndex + 1}. `)) : fg("dim", `${myIndex + 1}. `);
		const itemExpanded = Boolean(this.__itemExpanded);
		const itemLine = formatSingleToolLine(this, width - visibleWidth(pad) - 10, {
			showChevron: true,
			expanded: itemExpanded,
			hovered: stepHovered,
		});
		const stepHoverHint = stepHovered
			? itemExpanded
				? `  ${rgbFg(COLOR_AMBER, bold("[ ✦ 点击收起详情 ]"))}`
				: `  ${rgbFg(COLOR_CYAN, bold("[ ✦ 点击查看详情 ]"))}`
			: "";

		lines.push(`${pad}${branch}${stepLabel}${itemLine}${stepHoverHint}`);

		if (itemExpanded) {
			const pipe = isLast ? "        " : `${fg("borderMuted", "  │  ")}   `;
			const innerBar = stepHovered ? rgbFg(COLOR_CYAN, "│ ") : fg("borderMuted", "│ ");
			const detailPrefix = `${pad}${pipe}${innerBar}`;
			lines.push(...renderToolExpandedDetails(this, width, detailPrefix));
		}

		return lines;
	};

	toolProto.handleMouse = function (event: MouseEvent) {
		if (!compactToolsEnabled) {
			return origToolMouse.call(this, event);
		}
		setActiveTui(this.ui);

		if (event.type === "move") {
			const changed = claimHover(this, event.y);
			return { handled: true, render: changed };
		}

		if (event.type !== "click" || event.button !== "left") {
			return undefined;
		}

		const group = getConsecutiveToolGroup(this);
		const total = group.length;

		if (total <= 1) {
			this.__itemExpanded = !this.__itemExpanded;
			this.ui?.requestRender();
			return { handled: true, render: true };
		}

		const leader = group[0];
		const myIndex = group.indexOf(this);

		if (!leader.__groupExpanded) {
			leader.__groupExpanded = true;
			this.ui?.requestRender();
			return { handled: true, render: true };
		}

		if (myIndex === 0 && event.y <= 1) {
			leader.__groupExpanded = false;
			this.ui?.requestRender();
			return { handled: true, render: true };
		}

		this.__itemExpanded = !this.__itemExpanded;
		this.ui?.requestRender();
		return { handled: true, render: true };
	};
}

// ============================================================================
// 4. Arrow Prompt Editor (`❯ `) with Paste/Input Zoom & Breathing Border
// ============================================================================
const PASTE_COLLAPSE_MIN_LINES = 5;
const PASTE_COLLAPSE_MIN_CHARS = 400;
const EDITOR_PASTE_MARKER_RE = /\[paste #(\d+)(?: (\+\d+ lines|\d+ chars))?\]/g;
const EDITOR_PASTE_MARKER_SINGLE_RE = /^\[paste #(\d+)(?: (\+\d+ lines|\d+ chars))?\]$/;

class ArrowPromptEditor extends CustomEditor {
	private getAppTheme: () => Theme;
	private lastExpandedPastes: string[] = [];
	private suppressSmartInsert = false;

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, getAppTheme: () => Theme) {
		super(tui, editorTheme, keybindings, { paddingX: 0, embedWorkingStatus: true });
		this.getAppTheme = getAppTheme;
		setActiveTui(tui);
		getGlobalState().activeEditor = this;
	}

	hasCollapsedPasteMarkers(): boolean {
		const pastes: Map<number, string> | undefined = (this as any).pastes;
		if (!pastes || pastes.size === 0) return false;
		const text = this.getText();
		if (!text.includes("[paste #")) return false;
		for (const m of text.matchAll(EDITOR_PASTE_MARKER_RE)) {
			const id = Number.parseInt(m[1]!, 10);
			if (pastes.has(id)) return true;
		}
		return false;
	}

	isMultiLineCollapsible(): boolean {
		if (this.hasCollapsedPasteMarkers()) return false;
		const lines: string[] = (this as any).state?.lines ?? [];
		return lines.length >= 4 || this.getText().length > 300;
	}

	canToggleInputFold(): boolean {
		return this.hasCollapsedPasteMarkers() || this.isMultiLineCollapsible();
	}

	getCollapsedPasteStats(): { count: number; totalLines: number; totalChars: number } {
		const pastes: Map<number, string> | undefined = (this as any).pastes;
		if (!pastes || pastes.size === 0) return { count: 0, totalLines: 0, totalChars: 0 };
		const text = this.getText();
		let count = 0;
		let totalLines = 0;
		let totalChars = 0;
		for (const m of text.matchAll(EDITOR_PASTE_MARKER_RE)) {
			const id = Number.parseInt(m[1]!, 10);
			const content = pastes.get(id);
			if (content !== undefined) {
				count++;
				totalLines += content.split("\n").length;
				totalChars += content.length;
			}
		}
		return { count, totalLines, totalChars };
	}

	toggleInputFold(): "expanded" | "collapsed" | false {
		const pastes: Map<number, string> | undefined = (this as any).pastes;
		const state = (this as any).state as { lines: string[]; cursorLine: number; cursorCol: number } | undefined;
		if (!state || !pastes) return false;

		if (this.hasCollapsedPasteMarkers()) {
			(this as any).pushUndoSnapshot?.();
			const rawText = state.lines.join("\n");
			const savedBlocks: string[] = [];
			for (const m of rawText.matchAll(EDITOR_PASTE_MARKER_RE)) {
				const id = Number.parseInt(m[1]!, 10);
				const content = pastes.get(id);
				if (content !== undefined) {
					savedBlocks.push(content);
				}
			}
			this.lastExpandedPastes = savedBlocks;
			const expandedText: string = (this as any).expandPasteMarkers(rawText);
			pastes.clear();
			(this as any).pasteCounter = 0;
			const newLines = expandedText.split("\n");
			state.lines = newLines.length > 0 ? newLines : [""];
			state.cursorLine = Math.min(state.cursorLine, state.lines.length - 1);
			(this as any).setCursorCol?.(
				Math.min(state.cursorCol, (state.lines[state.cursorLine] ?? "").length),
			);
			this.onChange?.(this.getText());
			(this as any).tui?.requestRender();
			return "expanded";
		}

		const currentText = state.lines.join("\n");
		if (state.lines.length <= 1 && currentText.length <= 200) {
			return false;
		}

		(this as any).pushUndoSnapshot?.();
		pastes.clear();
		(this as any).pasteCounter = 0;

		let foldedText = currentText;
		let matchedAny = false;
		for (const block of this.lastExpandedPastes) {
			if ((block.includes("\n") || block.length > 200) && foldedText.includes(block)) {
				(this as any).pasteCounter++;
				const pasteId: number = (this as any).pasteCounter;
				pastes.set(pasteId, block);
				const blockLines = block.split("\n").length;
				const marker =
					blockLines > 1
						? `[paste #${pasteId} +${blockLines} lines]`
						: `[paste #${pasteId} ${block.length} chars]`;
				foldedText = foldedText.replace(block, () => marker);
				matchedAny = true;
			}
		}

		if (!matchedAny) {
			(this as any).pasteCounter = 1;
			pastes.set(1, currentText);
			const totalLines = state.lines.length;
			const marker =
				totalLines > 1
					? `[paste #1 +${totalLines} lines]`
					: `[paste #1 ${currentText.length} chars]`;
			foldedText = marker;
		}

		const foldedLines = foldedText.split("\n");
		state.lines = foldedLines.length > 0 ? foldedLines : [""];
		state.cursorLine = Math.min(state.cursorLine, state.lines.length - 1);
		(this as any).setCursorCol?.((state.lines[state.cursorLine] ?? "").length);
		(this as any).scrollOffset = 0;
		this.onChange?.(this.getText());
		(this as any).tui?.requestRender();
		return "collapsed";
	}

	override handlePaste(pastedText: string): void {
		const decodedText = pastedText.replace(/\x1b\[(\d+);5u/g, (match, code) => {
			const cp = Number(code);
			if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
			if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
			return match;
		});
		const cleanText: string = (this as any).normalizeText
			? (this as any).normalizeText(decodedText)
			: decodedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
		let filteredText = cleanText
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");

		const pastedLines = filteredText.split("\n");
		const totalChars = filteredText.length;

		if (pastedLines.length > PASTE_COLLAPSE_MIN_LINES || totalChars > PASTE_COLLAPSE_MIN_CHARS) {
			(this as any).cancelAutocomplete?.();
			(this as any).exitHistoryBrowsing?.();
			(this as any).lastAction = null;
			(this as any).pushUndoSnapshot?.();

			if (/^[/~.]/.test(filteredText)) {
				const state = (this as any).state;
				const currentLine = state?.lines?.[state.cursorLine] || "";
				const charBeforeCursor = state?.cursorCol > 0 ? currentLine[state.cursorCol - 1] : "";
				if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
					filteredText = ` ${filteredText}`;
				}
			}

			(this as any).pasteCounter = ((this as any).pasteCounter ?? 0) + 1;
			const pasteId: number = (this as any).pasteCounter;
			(this as any).pastes?.set(pasteId, filteredText);
			const marker =
				pastedLines.length > 1
					? `[paste #${pasteId} +${pastedLines.length} lines]`
					: `[paste #${pasteId} ${totalChars} chars]`;
			this.suppressSmartInsert = true;
			try {
				(this as any).insertTextAtCursorInternal(marker);
			} finally {
				this.suppressSmartInsert = false;
			}
			return;
		}

		super.handlePaste(pastedText);
	}

	override insertTextAtCursor(text: string): void {
		if (!this.suppressSmartInsert && text) {
			const lineCount = text.split(/\r?\n/).length;
			if (lineCount > PASTE_COLLAPSE_MIN_LINES || text.length > PASTE_COLLAPSE_MIN_CHARS) {
				this.handlePaste(text);
				return;
			}
		}
		super.insertTextAtCursor(text);
	}

	private getPromptPrefix(hovered: boolean, busy: boolean): string {
		const thm = this.getAppTheme();
		const text = this.getText();
		if (text.startsWith("!")) {
			return hovered ? rgbFg(COLOR_AMBER, bold("✦❯")) : thm.bold(thm.fg("bashMode", "❯ "));
		}
		if (text.startsWith("/")) {
			return hovered ? rgbFg(COLOR_AMBER, bold("✦❯")) : thm.bold(thm.fg("warning", "❯ "));
		}
		if (busy) {
			return bold(breatheText("❯ ", COLOR_PURPLE, COLOR_CYAN, 3.2, 0));
		}
		if (hovered) {
			return rgbFg(COLOR_CYAN, bold("✦❯"));
		}
		return thm.bold(thm.fg("accent", "❯ "));
	}

	override renderTopBorder(width: number, hiddenLineCount: number): string {
		const baseBorder = super.renderTopBorder(width, hiddenLineCount);
		if (!this.canToggleInputFold() || width < 28) {
			return baseBorder;
		}

		const st = getGlobalState();
		const borderHovered = isHovered(this) && st.hoverSubRow === 0;
		let badge = "";

		if (this.hasCollapsedPasteMarkers()) {
			const stats = this.getCollapsedPasteStats();
			const info = stats.totalLines > 1 ? `${stats.totalLines} 行` : `${stats.totalChars} 字符`;
			badge = borderHovered
				? ` ${rgbFg(COLOR_CYAN, bold(`[ ✦ 点击展开粘贴内容 (${info} · Ctrl+Alt+F) ]`))} `
				: ` ${rgbFg(COLOR_CYAN, `▸ 展开粘贴 (${info})`)} ${fg("dim", "[点击 / Ctrl+Alt+F]")} `;
		} else {
			const lineCount: number = (this as any).state?.lines?.length ?? 1;
			badge = borderHovered
				? ` ${rgbFg(COLOR_AMBER, bold(`[ ✦ 点击折叠输入 (${lineCount} 行 · Ctrl+Alt+F) ]`))} `
				: ` ${rgbFg(COLOR_AMBER, `▾ 折叠输入 (${lineCount} 行)`)} ${fg("dim", "[点击 / Ctrl+Alt+F]")} `;
		}

		const tail = this.borderColor("──");
		const rightSegment = `${badge}${tail}`;
		const rightWidth = visibleWidth(rightSegment);
		if (width <= rightWidth + 10) {
			return baseBorder;
		}

		const leftWidth = width - rightWidth;
		const leftPart = sliceByColumn(baseBorder, 0, leftWidth, true);
		const padCount = Math.max(0, leftWidth - visibleWidth(leftPart));
		return `${leftPart}${this.borderColor("─".repeat(padCount))}${rightSegment}`;
	}

	override render(width: number): string[] {
		if (width <= PROMPT_PREFIX_WIDTH + 2) {
			return super.render(width);
		}

		const st = getGlobalState();
		const hovered = isHovered(this);
		const busy = st.agentBusy || Date.now() - st.lastActiveRenderAt < 450;

		const savedBorderColor = this.borderColor;
		if (busy) {
			const c = lerpRgb(COLOR_MUTED_BORDER, COLOR_PURPLE, breathePhase(3.2, 0));
			this.borderColor = (s: string) => rgbFg(c, s);
		} else if (hovered) {
			this.borderColor = (s: string) => rgbFg(COLOR_BLUE, s);
		}

		const innerWidth = width - PROMPT_PREFIX_WIDTH;
		const lines = super.render(innerWidth);
		this.borderColor = savedBorderColor;

		if (lines.length < 2) return lines;

		const thm = this.getAppTheme();
		const visibleLineCount: number = (this as any).renderedVisibleLineCount ?? Math.max(1, lines.length - 2);
		const bottomBorderIdx = Math.min(lines.length - 1, visibleLineCount + 1);

		const activeBorderFn = busy
			? (s: string) => rgbFg(lerpRgb(COLOR_MUTED_BORDER, COLOR_PURPLE, breathePhase(3.2, 0)), s)
			: hovered
				? (s: string) => rgbFg(COLOR_BLUE, s)
				: this.borderColor;

		const borderPrefix = activeBorderFn("──");
		const firstPrompt = this.getPromptPrefix(hovered, busy);
		const contPrompt = hovered ? rgbFg(COLOR_DIM_SLATE, "· ") : thm.fg("borderMuted", "· ");
		const autocompleteIndent = " ".repeat(PROMPT_PREFIX_WIDTH);

		const out: string[] = new Array(lines.length);
		out[0] = `${borderPrefix}${lines[0]}`;

		const hasPastes = ((this as any).pastes?.size ?? 0) > 0;
		for (let i = 1; i < bottomBorderIdx; i++) {
			const prefix = i === 1 ? firstPrompt : contPrompt;
			let lineStr = lines[i]!;
			if (hasPastes && lineStr.includes("[paste #")) {
				const lineHovered = hovered && st.hoverSubRow === i;
				lineStr = lineStr.replace(
					/(?<!\x1b\[7m)(\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\])/g,
					(m) => (lineHovered ? rgbFg(COLOR_AMBER, bold(m)) : rgbFg(COLOR_CYAN, bold(m))),
				);
			}
			out[i] = `${prefix}${lineStr}`;
		}

		out[bottomBorderIdx] = `${borderPrefix}${lines[bottomBorderIdx]}`;

		for (let i = bottomBorderIdx + 1; i < lines.length; i++) {
			out[i] = `${autocompleteIndent}${lines[i]}`;
		}

		return out;
	}

	private isClickOnPasteMarker(innerX: number, y: number): boolean {
		if (!this.hasCollapsedPasteMarkers()) return false;
		const visibleLineCount: number = (this as any).renderedVisibleLineCount ?? 0;
		if (y <= 0 || y > visibleLineCount) return false;
		const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> | undefined =
			(this as any).buildVisualLineMap?.((this as any).lastWidth);
		const scrollOffset: number = (this as any).scrollOffset ?? 0;
		const visualLine = visualLines?.[scrollOffset + y - 1];
		if (!visualLine) return false;
		const state = (this as any).state as { lines: string[] } | undefined;
		const logicalLine = state?.lines?.[visualLine.logicalLine] ?? "";
		const chunk = logicalLine.slice(visualLine.startCol, visualLine.startCol + visualLine.length);
		if (!chunk.includes("[paste #")) return false;

		const maxPadding = Math.max(0, Math.floor(((this as any).lastWidth - 1) / 2));
		const paddingX = Math.min((this as any).paddingX ?? 0, maxPadding);
		const targetColumn = Math.max(0, innerX - paddingX);

		let visibleColumn = 0;
		const segments: Iterable<{ segment: string; index: number }> =
			(this as any).segment?.(chunk, "grapheme") ?? [];
		for (const grapheme of segments) {
			const segWidth = visibleWidth(grapheme.segment);
			const nextColumn = visibleColumn + segWidth;
			if (targetColumn >= visibleColumn && targetColumn < nextColumn) {
				return EDITOR_PASTE_MARKER_SINGLE_RE.test(grapheme.segment);
			}
			visibleColumn = nextColumn;
		}
		return false;
	}

	override handleMouse(event: MouseEvent) {
		const innerX = Math.max(0, event.x - PROMPT_PREFIX_WIDTH);
		const innerWidth = Math.max(4, event.width - PROMPT_PREFIX_WIDTH);

		if (event.type === "move") {
			const changed = claimHover(this, event.y);
			const sub = super.handleMouse({
				...event,
				x: innerX,
				width: innerWidth,
			});
			return sub ?? { handled: true, render: changed };
		}

		if (event.type === "click" && event.button === "left") {
			if (event.y === 0 && this.canToggleInputFold()) {
				this.toggleInputFold();
				return { handled: true, render: true, focus: true };
			}
			if (this.isClickOnPasteMarker(innerX, event.y)) {
				this.toggleInputFold();
				return { handled: true, render: true, focus: true };
			}
		}

		return super.handleMouse({
			...event,
			x: innerX,
			width: innerWidth,
		});
	}
}

// ============================================================================
// 5. Claude-Style Collapsible User Messages (Auto-Fold Large Pastes & Logs)
// ============================================================================
const ORIG_USER_RENDER_KEY = Symbol.for("pretty-ui:origUserRender");
const ORIG_USER_MOUSE_KEY = Symbol.for("pretty-ui:origUserMouse");
const USER_AUTO_COLLAPSE_LINES = 6;
const USER_AUTO_COLLAPSE_CHARS = 450;
const USER_PREVIEW_LINES = 3;
const OSC133_END_PREFIX = "\x1b]133;B\x07\x1b]133;C\x07";

function installCollapsibleUserMessageRenderer(): void {
	const userProto = UserMessageComponent.prototype as any;
	if (!userProto[ORIG_USER_RENDER_KEY]) {
		userProto[ORIG_USER_RENDER_KEY] = userProto.render;
	}
	if (!userProto[ORIG_USER_MOUSE_KEY]) {
		userProto[ORIG_USER_MOUSE_KEY] = userProto.handleMouse;
	}

	const origUserRender = userProto[ORIG_USER_RENDER_KEY];
	const origUserMouse = userProto[ORIG_USER_MOUSE_KEY];

	userProto.setExpanded = function (expanded: boolean) {
		this.__userExpanded = expanded ? true : undefined;
		getGlobalState().tui?.requestRender();
	};

	userProto.render = function (width: number): string[] {
		const lines: string[] = origUserRender.call(this, width);
		if (!compactToolsEnabled || lines.length < 3) {
			return lines;
		}

		const contentLines = lines.slice(1, lines.length - 1);
		const totalLines = contentLines.length;
		this.__lastTotalLines = totalLines;

		const rawText = String(this.text ?? "");
		const rawLineCount = rawText.split("\n").length;
		const charCount = rawText.length;

		const shouldAutoCollapse =
			totalLines > USER_AUTO_COLLAPSE_LINES ||
			rawLineCount > USER_AUTO_COLLAPSE_LINES ||
			charCount > USER_AUTO_COLLAPSE_CHARS;
		const isCollapsible = totalLines >= 2 || shouldAutoCollapse;
		if (!isCollapsible) {
			return lines;
		}

		const defaultExpanded = !shouldAutoCollapse;
		const expanded: boolean = this.__userExpanded ?? defaultExpanded;
		const hovered = isHovered(this);

		const pad = " ".repeat(Math.max(1, this.outputPad ?? 1));
		const maxInnerWidth = Math.max(10, width - visibleWidth(pad) * 2);
		const styleWithUserBg = (innerText: string): string => {
			const clipped = truncateToWidth(innerText, maxInnerWidth, "…");
			const withMargins = `${pad}${clipped}${pad}`;
			const vis = visibleWidth(withMargins);
			const fill = " ".repeat(Math.max(0, width - vis));
			const full = withMargins + fill;
			const t = getActiveTheme();
			if (t) {
				try {
					return t.bg("userMessageBg", full);
				} catch {
					// fall through
				}
			}
			return full;
		};

		// 1. Collapsed state: show first preview lines + interactive fold summary bar
		if (!expanded) {
			const previewCount = totalLines > USER_PREVIEW_LINES ? USER_PREVIEW_LINES : 1;
			const previewLines = contentLines.slice(0, previewCount);
			const hiddenCount = Math.max(1, totalLines - previewCount);

			const foldLine = hovered
				? styleWithUserBg(
						`${rgbFg(COLOR_CYAN, bold("▶"))} ${rgbFg(COLOR_PURPLE, bold(`📋 已折叠 ${hiddenCount} 行用户输入 (共 ${totalLines} 行 · ${charCount.toLocaleString()} 字符)`))}  ${rgbFg(COLOR_CYAN, bold("[ ✦ 点击展开完整内容 ]"))}`,
					)
				: styleWithUserBg(
						`${fg("borderAccent", "▸")} ${fg("muted", `📋 已折叠 ${hiddenCount} 行用户输入`)} ${fg("dim", `(共 ${totalLines} 行 · ${charCount.toLocaleString()} 字符 · 点击或 Ctrl+O 展开)`)}`,
					);

			return [lines[0]!, ...previewLines, foldLine, lines[lines.length - 1]!];
		}

		// 2. Expanded state for large messages (or manually expanded messages)
		if (shouldAutoCollapse || this.__userExpanded === true) {
			const collapseBar = hovered
				? styleWithUserBg(
						`${rgbFg(COLOR_AMBER, bold("▼"))} ${rgbFg(COLOR_PURPLE, bold(`📋 完整用户输入 (共 ${totalLines} 行 · ${charCount.toLocaleString()} 字符)`))}  ${rgbFg(COLOR_AMBER, bold("[ ✦ 点击折叠收起 ]"))}`,
					)
				: styleWithUserBg(
						`${fg("accent", "▾")} ${fg("dim", `📋 用户输入共 ${totalLines} 行 (${charCount.toLocaleString()} 字符 · 点击或 Ctrl+O 折叠收起)`)}`,
					);

			if (totalLines > 12) {
				return [lines[0]!, collapseBar, ...contentLines, collapseBar, lines[lines.length - 1]!];
			}
			return [lines[0]!, ...contentLines, collapseBar, lines[lines.length - 1]!];
		}

		// 3. Medium multi-line message (2-6 lines) in default expanded state:
		// Show hover hint inside the existing bottom padding line (0 layout height shift!)
		if (hovered) {
			const bottomHint =
				OSC133_END_PREFIX +
				styleWithUserBg(
					`${rgbFg(COLOR_AMBER, bold("▾"))} ${rgbFg(COLOR_AMBER, bold(`[ ✦ 点击折叠此条输入 (共 ${totalLines} 行) ]`))}`,
				);
			return [...lines.slice(0, -1), bottomHint];
		}

		return lines;
	};

	userProto.handleMouse = function (event: MouseEvent) {
		if (!compactToolsEnabled) {
			return origUserMouse ? origUserMouse.call(this, event) : undefined;
		}
		if (event.type === "move") {
			const changed = claimHover(this, 0);
			return { handled: true, render: changed };
		}
		if (event.type === "click" && event.button === "left") {
			const rawText = String(this.text ?? "");
			const rawLineCount = rawText.split("\n").length;
			const charCount = rawText.length;
			const lastTotalLines = this.__lastTotalLines ?? rawLineCount;
			const shouldAutoCollapse =
				lastTotalLines > USER_AUTO_COLLAPSE_LINES ||
				rawLineCount > USER_AUTO_COLLAPSE_LINES ||
				charCount > USER_AUTO_COLLAPSE_CHARS;
			const isCollapsible = lastTotalLines >= 2 || shouldAutoCollapse;
			if (!isCollapsible) {
				return origUserMouse ? origUserMouse.call(this, event) : undefined;
			}
			const defaultExpanded = !shouldAutoCollapse;
			const currentExpanded = this.__userExpanded ?? defaultExpanded;
			this.__userExpanded = !currentExpanded;
			getGlobalState().tui?.requestRender();
			return { handled: true, render: true };
		}
		return origUserMouse ? origUserMouse.call(this, event) : undefined;
	};
}

// ============================================================================
// 5. Preserve Pre-Compaction History in UI & Interactive Compaction Card
// ============================================================================
function installFullHistoryPreserver() {
	const imProto = InteractiveMode.prototype as any;
	if (!imProto.__origRebuildChat) {
		imProto.__origRebuildChat = imProto.rebuildChatFromMessages;
		imProto.__origRenderInitial = imProto.renderInitialMessages;
		imProto.__origHandleEvent = imProto.handleEvent;
	}

	const origRebuildChat = imProto.__origRebuildChat;
	const origRenderInitial = imProto.__origRenderInitial;
	const origHandleEvent = imProto.__origHandleEvent;

	imProto.rebuildChatFromMessages = function () {
		const st = getGlobalState();
		st.lastInteractiveMode = this;
		setActiveTui(this.ui);
		if (!st.keepFullHistory) {
			return origRebuildChat.call(this);
		}
		this.chatContainer.clear();
		this.renderSessionEntries(this.sessionManager.getBranch());
	};

	imProto.renderInitialMessages = function () {
		const st = getGlobalState();
		st.lastInteractiveMode = this;
		setActiveTui(this.ui);
		if (!st.keepFullHistory) {
			return origRenderInitial.call(this);
		}
		const entries = this.sessionManager.getBranch();
		this.renderSessionEntries(entries, {
			updateFooter: true,
			populateHistory: true,
		});
		this.renderProjectTrustWarningIfNeeded?.();
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e: any) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 次" : `${compactionCount} 次`;
			this.showStatus?.(`📦 会话已压缩 ${times}（上方完整历史记录已保留，输入 /history 可切换精简/完整视图）`);
		}
	};

	imProto.handleEvent = async function (event: any) {
		const st = getGlobalState();
		st.lastInteractiveMode = this;
		setActiveTui(this.ui);
		if (
			event?.type === "agent_start" ||
			event?.type === "turn_start" ||
			event?.type === "tool_execution_start"
		) {
			st.agentBusy = true;
			markAnimationActive();
		} else if (event?.type === "agent_end") {
			stopAnimTimerIfIdle();
		}
		await origHandleEvent.call(this, event);
		if (
			st.keepFullHistory &&
			((event?.type === "compaction_end" && event.result && !event.aborted) ||
				(event?.type === "entry_appended" && event.entry?.type === "compaction"))
		) {
			this.rebuildChatFromMessages();
			this.footer?.invalidate?.();
			this.ui?.requestRender?.();
		}
	};

	// Beautify CompactionSummaryMessageComponent with hover & expandable rich markdown
	const compProto = CompactionSummaryMessageComponent.prototype as any;
	if (!compProto.__origRender) {
		compProto.__origRender = compProto.render;
		compProto.__origHandleMouse = compProto.handleMouse;
	}

	compProto.render = function (width: number): string[] {
		const hovered = isHovered(this);
		const pad = " ".repeat(Math.max(0, this.outputPad ?? 1));
		const innerWidth = Math.max(20, width - visibleWidth(pad) * 2);
		const tokenStr = Number(this.message?.tokensBefore ?? 0).toLocaleString();

		const borderColor = hovered
			? (s: string) => rgbFg(COLOR_CYAN, s)
			: (s: string) => fg("borderAccent", s);
		const chevron = this.expanded
			? hovered
				? rgbFg(COLOR_AMBER, bold("▼"))
				: fg("accent", bold("▾"))
			: hovered
				? rgbFg(COLOR_CYAN, bold("▶"))
				: fg("borderAccent", "▸");
		const badge = hovered
			? this.expanded
				? `  ${rgbFg(COLOR_AMBER, bold("[ ✦ 点击收起压缩摘要 ]"))}`
				: `  ${rgbFg(COLOR_CYAN, bold("[ ✦ 点击展开压缩摘要 ]"))}`
			: fg("dim", this.expanded ? " (点击收起摘要)" : " (点击展开摘要)");

		const titleText = `${chevron} 📦 ${bold("上下文已压缩")} ${fg("muted", `(压缩前 ${tokenStr} tokens · 上方历史记录已保留)`)}${badge}`;
		const ruleWidth = Math.max(6, innerWidth);
		const topRule = `${pad}${borderColor(`╭${"─".repeat(Math.max(1, ruleWidth - 2))}╮`)}`;
		const bottomRule = `${pad}${borderColor(`╰${"─".repeat(Math.max(1, ruleWidth - 2))}╯`)}`;
		const headerLine = `${pad}${borderColor("│")} ${truncateToWidth(titleText, Math.max(10, ruleWidth - 4), "…")}`;

		if (!this.expanded) {
			return [topRule, headerLine, bottomRule];
		}

		const md = new Markdown(String(this.message?.summary ?? "").trim(), 0, 0, this.markdownTheme ?? getMarkdownTheme());
		const mdLines = md.render(Math.max(16, ruleWidth - 4));
		const sepLine = `${pad}${borderColor(`├${"─".repeat(Math.max(1, ruleWidth - 2))}┤`)}`;
		const bodyLines = mdLines.map((l: string) => `${pad}${borderColor("│")} ${l}`);
		return [topRule, headerLine, sepLine, ...bodyLines, bottomRule];
	};

	compProto.handleMouse = function (event: MouseEvent) {
		if (event.type === "move") {
			const changed = claimHover(this, event.y);
			return { handled: true, render: changed };
		}
		if (event.type === "click" && event.button === "left") {
			this.setExpanded(!this.expanded);
			getGlobalState().tui?.requestRender();
			return { handled: true, render: true };
		}
		return undefined;
	};
}

// ============================================================================
// Extension Entrypoint
// ============================================================================
export default function prettyUiExtension(pi: ExtensionAPI) {
	installRichMarkdownRenderer();
	installCompactThinkingRenderer();
	installGroupedToolRenderer();
	installCollapsibleUserMessageRenderer();
	installFullHistoryPreserver();

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		setActiveTheme(ctx.ui.theme);
		ctx.ui.setEditorComponent(
			(tui, editorTheme, keybindings) => new ArrowPromptEditor(tui, editorTheme, keybindings, () => ctx.ui.theme),
		);
	});

	// Start/stop the breathing light animation loop automatically during agent turns
	pi.on("agent_start", async () => {
		const st = getGlobalState();
		st.agentBusy = true;
		markAnimationActive();
	});

	pi.on("agent_end", async () => {
		stopAnimTimerIfIdle();
	});

	// Detect & strip mid-stream upstream retries / continuations from local proxies (e.g. magpie / 127.0.0.1:3425)
	let activeStreamContent: any[] | undefined;
	let activeStreamChunkId: string | undefined;
	let hasStreamedTextInTurn = false;
	let lastTextDeltaAt = 0;

	pi.on("message_start", async (event: any) => {
		if (event?.message?.role === "assistant" && Array.isArray(event.message.content)) {
			activeStreamContent = event.message.content;
			activeStreamChunkId = undefined;
			hasStreamedTextInTurn = false;
			lastTextDeltaAt = 0;
		}
	});

	pi.on("provider_stream_event", async (event: any) => {
		const chunk = event?.data;
		if (!chunk || typeof chunk !== "object" || !Array.isArray(activeStreamContent)) return;

		const now = Date.now();
		const chunkId = typeof chunk.id === "string" && chunk.id.length > 0 ? chunk.id : undefined;
		const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
		const delta = choice?.delta;
		const hasContentDelta = typeof delta?.content === "string" && delta.content.length > 0;

		const idChangedMidStream = Boolean(chunkId && activeStreamChunkId && chunkId !== activeStreamChunkId);
		const roleRestartedMidStream = Boolean(hasStreamedTextInTurn && delta?.role === "assistant");
		const reasoningRestartedAfterText = Boolean(
			hasStreamedTextInTurn &&
				((typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) ||
					(typeof delta?.reasoning === "string" && delta.reasoning.length > 0) ||
					(typeof delta?.reasoning_text === "string" && delta.reasoning_text.length > 0)),
		);
		// magpie's (*Server).streamTranslated + (*continuation).again aborts after 1.0s idle and starts a new
		// upstream Gemini request (whose hidden thinking phase takes 3.5s–20s), reusing the same chunk.id.
		const continuationRestartAfterSilence = Boolean(
			hasStreamedTextInTurn && hasContentDelta && lastTextDeltaAt > 0 && now - lastTextDeltaAt > 2200,
		);

		if (
			idChangedMidStream ||
			roleRestartedMidStream ||
			reasoningRestartedAfterText ||
			continuationRestartAfterSilence
		) {
			for (const block of activeStreamContent) {
				if (block && block.type === "text") {
					block.text = "";
				} else if (block && block.type === "thinking") {
					block.thinking = "";
				} else if (block && block.type === "toolCall") {
					block.id = "";
					block.partialArgs = "";
					block.arguments = {};
				}
			}
			activeStreamChunkId = chunkId;
			hasStreamedTextInTurn = false;
			lastTextDeltaAt = 0;
		} else if (chunkId && !activeStreamChunkId) {
			activeStreamChunkId = chunkId;
		}

		if (hasContentDelta) {
			hasStreamedTextInTurn = true;
			lastTextDeltaAt = now;
		}

		// Also guard against a tool_call retry at the same streamIndex with a new toolCall.id
		if (Array.isArray(delta?.tool_calls)) {
			for (const tc of delta.tool_calls) {
				if (tc?.id && tc?.function?.name) {
					for (const block of activeStreamContent) {
						if (
							block &&
							block.type === "toolCall" &&
							block.streamIndex === tc.index &&
							block.id &&
							block.id !== tc.id &&
							block.partialArgs
						) {
							block.id = tc.id;
							block.partialArgs = "";
							block.arguments = {};
						}
					}
				}
			}
		}
	});

	pi.on("message_end", async () => {
		activeStreamContent = undefined;
		activeStreamChunkId = undefined;
		hasStreamedTextInTurn = false;
		lastTextDeltaAt = 0;
	});

	pi.on("session_shutdown", async () => {
		const st = getGlobalState();
		st.agentBusy = false;
		if (st.animTimer) {
			clearInterval(st.animTimer);
			st.animTimer = undefined;
		}
	});

	pi.registerCommand("compact-tools", {
		description: "Toggle Claude-style grouped tool & thinking view vs default output",
		handler: async (_args, ctx) => {
			compactToolsEnabled = !compactToolsEnabled;
			ctx.ui.notify(
				compactToolsEnabled
					? "Claude-style compact tools & thinking enabled"
					: "Default tool & thinking output restored",
				"info",
			);
		},
	});

	pi.registerCommand("pretty-md", {
		description: "Toggle rich Markdown rendering (framed code blocks, clean headings, bullets)",
		handler: async (_args, ctx) => {
			prettyMarkdownEnabled = !prettyMarkdownEnabled;
			ctx.ui.notify(
				prettyMarkdownEnabled ? "Rich Markdown rendering enabled" : "Default Markdown rendering restored",
				"info",
			);
		},
	});

	pi.registerCommand("history", {
		description: "Toggle showing full pre-compaction conversation history in chat scrollback",
		handler: async (_args, ctx) => {
			const st = getGlobalState();
			st.keepFullHistory = !st.keepFullHistory;
			const im = st.lastInteractiveMode;
			if (im && typeof im.rebuildChatFromMessages === "function") {
				im.rebuildChatFromMessages();
				im.ui?.requestRender?.();
			}
			ctx.ui.notify(
				st.keepFullHistory
					? "已开启：显示完整历史对话（含 Compact 之前的所有记录）"
					: "已切换：仅显示 Compact 之后的精简上下文",
				"info",
			);
		},
	});

	const toggleFoldAction = (ctx: any) => {
		const st = getGlobalState();
		const editor = st.activeEditor;
		if (editor && editor.canToggleInputFold()) {
			const result = editor.toggleInputFold();
			if (result === "expanded") {
				ctx.ui.notify("已展开输入框内的粘贴内容（可编辑，再次按 Ctrl+Alt+F 或点击上边框可折叠）", "info");
				return;
			}
			if (result === "collapsed") {
				ctx.ui.notify("已将输入框多行内容折叠为 [paste] 胶囊（发送时会自动还原完整文本）", "info");
				return;
			}
		}

		const children: any[] = st.lastInteractiveMode?.chatContainer?.children ?? [];
		const userComps = children.filter((c) => c instanceof UserMessageComponent);
		if (userComps.length === 0) {
			ctx.ui.notify("当前没有可折叠/展开的用户输入记录", "info");
			return;
		}

		// Find collapsible user messages
		const collapsible = userComps.filter((c: any) => {
			const raw = String(c.text ?? "");
			return (c.__lastTotalLines ?? raw.split("\n").length) >= 2 || raw.length > USER_AUTO_COLLAPSE_CHARS;
		});
		const targets = collapsible.length > 0 ? collapsible : userComps;
		const anyCollapsed = targets.some((c: any) => {
			const raw = String(c.text ?? "");
			const total = c.__lastTotalLines ?? raw.split("\n").length;
			const autoCollapse =
				total > USER_AUTO_COLLAPSE_LINES ||
				raw.split("\n").length > USER_AUTO_COLLAPSE_LINES ||
				raw.length > USER_AUTO_COLLAPSE_CHARS;
			const isExpanded = c.__userExpanded ?? !autoCollapse;
			return !isExpanded;
		});

		for (const c of targets) {
			(c as any).__userExpanded = anyCollapsed;
		}
		st.tui?.requestRender();
		ctx.ui.notify(
			anyCollapsed ? "已展开对话中的所有多行用户输入" : "已折叠对话中的所有多行用户输入",
			"info",
		);
	};

	pi.registerCommand("fold", {
		description: "Toggle folding/expanding pasted logs in the input box or user messages in chat",
		handler: async (_args, ctx) => {
			toggleFoldAction(ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+f", {
		description: "Fold or unfold pasted logs in editor / user messages in chat",
		handler: async (ctx) => {
			toggleFoldAction(ctx);
		},
	});

	pi.registerToolRenderer((_toolName, next) => {
		const base = next();
		if (!base) return undefined;
		return {
			...base,
			renderShell: "self",
			renderCall(args, theme, context) {
				setActiveTheme(theme);
				return base.renderCall ? base.renderCall(args, theme, context) : new Text("", 0, 0);
			},
		};
	});
}
