/**
 * Compaction Model Extension
 *
 * Allows configuring a dedicated (typically faster/cheaper) model and thinking level
 * for context compaction (`/compact` & auto-compaction) and `/tree` branch summarization,
 * while preserving 100% of Pi's native summarization format, split-turn handling, and
 * cumulative `<read-files>` / `<modified-files>` tracking.
 *
 * Configuration priority (highest to lowest):
 * 1. CLI flag: `--compact-model <provider/modelId>`
 * 2. Environment variable: `PI_COMPACTION_MODEL` (and `PI_COMPACTION_THINKING`)
 * 3. Project settings (`.pi/settings.json`): `compaction.model` / `compaction.thinkingLevel`
 * 4. Global settings (`~/.pi/agent/settings.json`): `compaction.model` / `compaction.thinkingLevel`
 *
 * Example in `~/.pi/agent/settings.json`:
 * ```json
 * {
 *   "compaction": {
 *     "model": "anthropic/claude-haiku-4-5",
 *     "thinkingLevel": "off"
 *   }
 * }
 * ```
 * You can also specify a fallback array or comma-separated list:
 * `"model": ["anthropic/claude-haiku-4-5", "google/gemini-2.5-flash"]`
 *
 * Interactive command:
 * - `/compact-model`                    Open interactive model selector
 * - `/compact-model <provider/model>`   Set global compaction model
 * - `/compact-model -p <provider/model>`Set project compaction model
 * - `/compact-model thinking <level>`   Set compaction thinking level (off|minimal|low|medium|high)
 * - `/compact-model off`                Reset to follow the active session model
 * - `/compact-model status`             Show current compaction model configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	compact,
	type ExtensionAPI,
	type ExtensionContext,
	generateBranchSummary,
	getAgentDir,
	getLatestCompactionEntry,
	type SessionEntry,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

interface CompactionModelConfig {
	/** Ordered list of model candidates (e.g. ["anthropic/claude-haiku-4-5", "gemini-2.5-flash"]) */
	models: string[];
	/** Thinking level used during compaction (defaults to "off" when using a dedicated compaction model) */
	thinkingLevel?: ThinkingLevel;
	/** Where the model setting came from */
	source: "flag" | "env" | "project" | "global" | "default";
}

interface RawSettingsFile {
	compactionModel?: string | string[];
	compactionThinkingLevel?: string;
	compaction?: {
		model?: string | string[];
		thinkingLevel?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
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

function readJsonSettings(filePath: string): RawSettingsFile | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	try {
		const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as RawSettingsFile)
			: undefined;
	} catch {
		return undefined;
	}
}

async function updateJsonSettings(
	filePath: string,
	updater: (data: RawSettingsFile) => void,
): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		let data: RawSettingsFile = {};
		if (fs.existsSync(filePath)) {
			try {
				const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
				const parsed = JSON.parse(raw);
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
					data = parsed as RawSettingsFile;
				}
			} catch {
				// Start fresh if malformed
			}
		}
		updater(data);
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		await fs.promises.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	});
}

function resolveConfig(pi: ExtensionAPI, cwd: string): CompactionModelConfig {
	const flagModel = pi.getFlag("compact-model");
	const flagCandidates = parseModelCandidates(flagModel);

	const envCandidates = parseModelCandidates(process.env.PI_COMPACTION_MODEL);
	const envThinking = parseThinkingLevel(process.env.PI_COMPACTION_THINKING);

	const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
	const globalSettingsPath = path.join(getAgentDir(), "settings.json");

	const projectSettings = readJsonSettings(projectSettingsPath);
	const globalSettings = readJsonSettings(globalSettingsPath);

	const projectCandidates = parseModelCandidates(
		projectSettings?.compaction?.model ?? projectSettings?.compactionModel,
	);
	const globalCandidates = parseModelCandidates(
		globalSettings?.compaction?.model ?? globalSettings?.compactionModel,
	);

	const projectThinking = parseThinkingLevel(
		projectSettings?.compaction?.thinkingLevel ?? projectSettings?.compactionThinkingLevel,
	);
	const globalThinking = parseThinkingLevel(
		globalSettings?.compaction?.thinkingLevel ?? globalSettings?.compactionThinkingLevel,
	);

	const thinkingLevel = envThinking ?? projectThinking ?? globalThinking;

	if (flagCandidates.length > 0) {
		return { models: flagCandidates, thinkingLevel: thinkingLevel ?? "off", source: "flag" };
	}
	if (envCandidates.length > 0) {
		return { models: envCandidates, thinkingLevel: thinkingLevel ?? "off", source: "env" };
	}
	if (projectCandidates.length > 0) {
		return { models: projectCandidates, thinkingLevel: thinkingLevel ?? "off", source: "project" };
	}
	if (globalCandidates.length > 0) {
		return { models: globalCandidates, thinkingLevel: thinkingLevel ?? "off", source: "global" };
	}

	return {
		models: [],
		thinkingLevel,
		source: "default",
	};
}

/**
 * Find a matching model from `ctx.modelRegistry` given a candidate spec:
 * - Exact `provider/modelId`
 * - Exact `modelId` (preferring models with configured auth)
 * - Case-insensitive substring match on `provider/modelId` or `modelId`
 */
function findCandidateModel(
	ctx: ExtensionContext,
	spec: string,
): { model: Model<Api>; thinkingOverride?: ThinkingLevel } | undefined {
	let modelSpec = spec.trim();
	let thinkingOverride: ThinkingLevel | undefined;

	// Support optional `:thinkingLevel` suffix, e.g. `anthropic/claude-haiku-4-5:off`
	const colonIndex = modelSpec.lastIndexOf(":");
	if (colonIndex > 0) {
		const maybeLevel = parseThinkingLevel(modelSpec.slice(colonIndex + 1));
		if (maybeLevel) {
			thinkingOverride = maybeLevel;
			modelSpec = modelSpec.slice(0, colonIndex);
		}
	}

	const available = ctx.modelRegistry.getAvailable();
	const allModels = ctx.modelRegistry.getAll();

	const slashIndex = modelSpec.indexOf("/");
	if (slashIndex > 0) {
		const provider = modelSpec.slice(0, slashIndex).trim();
		const modelId = modelSpec.slice(slashIndex + 1).trim();
		const exact = ctx.modelRegistry.find(provider, modelId);
		if (exact) return { model: exact, thinkingOverride };

		const lowerProvider = provider.toLowerCase();
		const lowerId = modelId.toLowerCase();
		const ciMatch =
			available.find(
				(m) => m.provider.toLowerCase() === lowerProvider && m.id.toLowerCase() === lowerId,
			) ??
			allModels.find(
				(m) => m.provider.toLowerCase() === lowerProvider && m.id.toLowerCase() === lowerId,
			);
		if (ciMatch) return { model: ciMatch, thinkingOverride };
	}

	const lowerSpec = modelSpec.toLowerCase();

	// 1. Exact ID match in available models first, then all models
	const exactIdMatch =
		available.find((m) => m.id.toLowerCase() === lowerSpec) ??
		allModels.find((m) => m.id.toLowerCase() === lowerSpec);
	if (exactIdMatch) return { model: exactIdMatch, thinkingOverride };

	// 2. Substring match in available models
	const substringMatch = available.find(
		(m) =>
			m.id.toLowerCase().includes(lowerSpec) ||
			`${m.provider}/${m.id}`.toLowerCase().includes(lowerSpec),
	);
	if (substringMatch) return { model: substringMatch, thinkingOverride };

	return undefined;
}

/**
 * Resolve the actual model + auth to use for summarization.
 */
async function resolveCompactionTarget(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<
	| {
			model: Model<Api>;
			apiKey?: string;
			headers?: Record<string, string>;
			env?: Record<string, string>;
			thinkingLevel: ThinkingLevel;
			source: CompactionModelConfig["source"];
	  }
	| undefined
> {
	const config = resolveConfig(pi, ctx.cwd);

	// If no custom model and no custom thinking level configured, let Pi run its default compaction
	if (config.models.length === 0 && !config.thinkingLevel) {
		return undefined;
	}

	// Case A: Only thinkingLevel is customized, model follows active session model
	if (config.models.length === 0 && config.thinkingLevel && ctx.model) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) return undefined;
		const requestModel = auth.baseUrl ? { ...ctx.model, baseUrl: auth.baseUrl } : ctx.model;
		return {
			model: requestModel,
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			thinkingLevel: config.thinkingLevel,
			source: config.source,
		};
	}

	// Case B: Try each configured candidate model in order
	const errors: string[] = [];
	for (const candidate of config.models) {
		const found = findCandidateModel(ctx, candidate);
		if (!found) {
			errors.push(`未找到模型 "${candidate}"`);
			continue;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(found.model);
		if (!auth.ok) {
			errors.push(`${found.model.provider}/${found.model.id} 鉴权失败 (${auth.error})`);
			continue;
		}
		const requestModel = auth.baseUrl ? { ...found.model, baseUrl: auth.baseUrl } : found.model;
		return {
			model: requestModel,
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			thinkingLevel: found.thinkingOverride ?? config.thinkingLevel ?? "off",
			source: config.source,
		};
	}

	if (errors.length > 0) {
		ctx.ui.notify(
			`压缩模型不可用 (${errors.join("；")})，已回退到当前对话模型`,
			"warning",
		);
	}
	return undefined;
}

/**
 * Carry over `readFiles` and `modifiedFiles` from an earlier hook-generated compaction entry.
 * Pi's built-in `prepareCompaction()` skips entries with `fromHook: true`, so we merge them here
 * to keep cumulative file tracking intact across multiple compactions.
 */
function preservePreviousHookFileOps(
	branchEntries: SessionEntry[],
	fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> },
): void {
	const prevCompaction = getLatestCompactionEntry(branchEntries);
	if (!prevCompaction?.fromHook || !prevCompaction.details) return;
	const details = prevCompaction.details as {
		readFiles?: unknown;
		modifiedFiles?: unknown;
	};
	if (Array.isArray(details.readFiles)) {
		for (const file of details.readFiles) {
			if (typeof file === "string") fileOps.read.add(file);
		}
	}
	if (Array.isArray(details.modifiedFiles)) {
		for (const file of details.modifiedFiles) {
			if (typeof file === "string") fileOps.edited.add(file);
		}
	}
}

function isFastModel(model: Model<Api>): boolean {
	const id = model.id.toLowerCase();
	return (
		id.includes("haiku") ||
		id.includes("flash") ||
		id.includes("mini") ||
		id.includes("nano") ||
		id.includes("lite") ||
		id.includes("fast")
	);
}

export default function compactionModelExtension(pi: ExtensionAPI): void {
	pi.registerFlag("compact-model", {
		description: "Model to use for context compaction (e.g. anthropic/claude-haiku-4-5)",
		type: "string",
	});

	// Intercept manual (/compact) and automatic compaction
	pi.on("session_before_compact", async (event, ctx) => {
		const target = await resolveCompactionTarget(pi, ctx);
		if (!target) return;

		const { preparation, branchEntries, customInstructions, signal } = event;

		// If the target model is identical to the active session model and thinking level is unchanged,
		// let Pi run its default flow directly.
		const currentThinking = pi.getThinkingLevel();
		if (
			ctx.model &&
			target.model.provider === ctx.model.provider &&
			target.model.id === ctx.model.id &&
			target.thinkingLevel === currentThinking
		) {
			return;
		}

		preservePreviousHookFileOps(branchEntries, preparation.fileOps);

		const modelLabel = `${target.model.provider}/${target.model.id}`;
		const thinkingBadge = target.thinkingLevel !== "off" ? `:${target.thinkingLevel}` : "";
		ctx.ui.notify(
			`⚡ 正在使用 ${modelLabel}${thinkingBadge} 压缩上下文 (${preparation.tokensBefore.toLocaleString()} tokens)...`,
			"info",
		);

		try {
			const result = await compact(
				preparation,
				target.model,
				target.apiKey,
				target.headers,
				customInstructions,
				signal,
				target.thinkingLevel,
				undefined,
				target.env,
			);

			return {
				compaction: {
					summary: result.summary,
					firstKeptEntryId: result.firstKeptEntryId,
					tokensBefore: result.tokensBefore,
					usage: result.usage,
					details: result.details,
				},
			};
		} catch (error) {
			if (signal.aborted) {
				return { cancel: true };
			}
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`使用 ${modelLabel} 压缩失败 (${message})，正在回退到默认模型重试...`,
				"warning",
			);
			return;
		}
	});

	// Intercept /tree branch summarization when user chooses to summarize
	pi.on("session_before_tree", async (event, ctx) => {
		const { preparation, signal } = event;
		if (!preparation.userWantsSummary || preparation.entriesToSummarize.length === 0) {
			return;
		}

		const target = await resolveCompactionTarget(pi, ctx);
		if (!target) return;

		if (
			ctx.model &&
			target.model.provider === ctx.model.provider &&
			target.model.id === ctx.model.id
		) {
			return;
		}

		const modelLabel = `${target.model.provider}/${target.model.id}`;
		ctx.ui.notify(`⚡ 正在使用 ${modelLabel} 生成分支摘要...`, "info");

		try {
			const result = await generateBranchSummary(preparation.entriesToSummarize, {
				model: target.model,
				apiKey: target.apiKey,
				headers: target.headers,
				env: target.env,
				signal,
				customInstructions: preparation.customInstructions,
				replaceInstructions: preparation.replaceInstructions,
			});

			if (result.aborted) {
				return { cancel: true };
			}
			if (result.error || !result.summary) {
				throw new Error(result.error ?? "Empty branch summary");
			}

			return {
				summary: {
					summary: result.summary,
					usage: result.usage,
					details: {
						readFiles: result.readFiles ?? [],
						modifiedFiles: result.modifiedFiles ?? [],
					},
				},
			};
		} catch (error) {
			if (signal.aborted) {
				return { cancel: true };
			}
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`分支摘要使用 ${modelLabel} 失败 (${message})，回退到默认模型`, "warning");
			return;
		}
	});

	// Register /compact-model command for interactive configuration
	pi.registerCommand("compact-model", {
		description: "查看或设置独立的上下文压缩模型 (如 Haiku / Flash)",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trim().toLowerCase();
			const staticItems = [
				{ value: "status", label: "status — 查看当前压缩模型配置" },
				{ value: "off", label: "off — 恢复默认（跟随当前对话模型）" },
				{ value: "thinking off", label: "thinking off — 压缩时关闭思考 (推荐)" },
				{ value: "thinking low", label: "thinking low — 压缩时使用低强度思考" },
			];
			return staticItems.filter((item) => item.value.toLowerCase().startsWith(trimmed));
		},
		handler: async (args, ctx) => {
			const rawArgs = args.trim();
			const globalSettingsPath = path.join(getAgentDir(), "settings.json");
			const projectSettingsPath = path.join(ctx.cwd, ".pi", "settings.json");

			// 1. Status check
			if (rawArgs === "status") {
				const config = resolveConfig(pi, ctx.cwd);
				if (config.models.length === 0) {
					const activeModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "未选择";
					const thinkingNote = config.thinkingLevel
						? `（压缩思考档位覆盖为: ${config.thinkingLevel}）`
						: "";
					ctx.ui.notify(
						`当前压缩模型: 跟随主对话模型 (${activeModel}) ${thinkingNote}`,
						"info",
					);
					return;
				}
				const target = await resolveCompactionTarget(pi, ctx);
				const resolvedStr = target
					? `✅ 已就绪: ${target.model.provider}/${target.model.id} (thinking: ${target.thinkingLevel})`
					: "⚠️ 未匹配到可用模型，将回退到主模型";
				ctx.ui.notify(
					`压缩模型配置 [${config.source}]: ${config.models.join(", ")} → ${resolvedStr}`,
					"info",
				);
				return;
			}

			// 2. Reset / turn off
			if (rawArgs === "off" || rawArgs === "default" || rawArgs === "clear" || rawArgs === "reset") {
				await updateJsonSettings(globalSettingsPath, (data) => {
					delete data.compactionModel;
					if (data.compaction && typeof data.compaction === "object") {
						delete data.compaction.model;
						if (Object.keys(data.compaction).length === 0) {
							delete data.compaction;
						}
					}
				});
				if (fs.existsSync(projectSettingsPath)) {
					await updateJsonSettings(projectSettingsPath, (data) => {
						delete data.compactionModel;
						if (data.compaction && typeof data.compaction === "object") {
							delete data.compaction.model;
							if (Object.keys(data.compaction).length === 0) {
								delete data.compaction;
							}
						}
					});
				}
				ctx.ui.notify("✅ 已恢复默认：压缩时将直接使用当前主对话模型", "info");
				return;
			}

			// 3. Set thinking level: `/compact-model thinking <level>`
			if (rawArgs.startsWith("thinking ")) {
				const levelArg = rawArgs.slice("thinking ".length).trim();
				const level = parseThinkingLevel(levelArg);
				if (!level) {
					ctx.ui.notify(
						`无效的思考等级 "${levelArg}"，可选值: ${VALID_THINKING_LEVELS.join(", ")}`,
						"warning",
					);
					return;
				}
				await updateJsonSettings(globalSettingsPath, (data) => {
					if (!data.compaction || typeof data.compaction !== "object") {
						data.compaction = {};
					}
					data.compaction.thinkingLevel = level;
				});
				ctx.ui.notify(`✅ 已将压缩思考等级设置为: ${level} (${globalSettingsPath})`, "info");
				return;
			}

			// 4. Direct model argument: `/compact-model [-p|--project] <model>`
			if (rawArgs.length > 0) {
				let isProject = false;
				let modelSpec = rawArgs;
				if (modelSpec.startsWith("-p ") || modelSpec.startsWith("--project ")) {
					isProject = true;
					modelSpec = modelSpec.replace(/^(-p|--project)\s+/, "").trim();
				}

				const targetFile = isProject ? projectSettingsPath : globalSettingsPath;
				const candidates = parseModelCandidates(modelSpec);
				if (candidates.length === 0) {
					ctx.ui.notify("请提供有效的模型标识，例如: anthropic/claude-haiku-4-5", "warning");
					return;
				}

				const matched = findCandidateModel(ctx, candidates[0]);
				const savedValue =
					candidates.length === 1 && matched
						? `${matched.model.provider}/${matched.model.id}`
						: candidates.length === 1
							? candidates[0]
							: candidates;

				await updateJsonSettings(targetFile, (data) => {
					if (!data.compaction || typeof data.compaction !== "object") {
						data.compaction = {};
					}
					data.compaction.model = savedValue;
					if (!data.compaction.thinkingLevel) {
						data.compaction.thinkingLevel = "off";
					}
				});

				if (matched) {
					ctx.ui.notify(
						`✅ 已设置${isProject ? "项目" : "全局"}压缩模型: ${matched.model.provider}/${matched.model.id} (thinking: off)`,
						"info",
					);
				} else {
					ctx.ui.notify(
						`⚠️ 已写入配置 "${modelSpec}" 到 ${targetFile}，但当前可用模型列表中暂未找到匹配项`,
						"warning",
					);
				}
				return;
			}

			// 5. Interactive selector when called without arguments
			const config = resolveConfig(pi, ctx.cwd);
			const availableModels = ctx.modelRegistry.getAvailable();

			// Sort fast/flash/haiku models first for convenience
			const sortedModels = [...availableModels].sort((a, b) => {
				const aFast = isFastModel(a) ? 0 : 1;
				const bFast = isFastModel(b) ? 0 : 1;
				if (aFast !== bFast) return aFast - bFast;
				return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
			});

			const currentDesc =
				config.models.length > 0
					? `当前配置: ${config.models.join(", ")} (thinking: ${config.thinkingLevel ?? "off"})`
					: "当前配置: 跟随主对话模型";

			const FOLLOW_DEFAULT_OPTION = "🔄 跟随主对话模型 (默认)";
			const options: string[] = [
				FOLLOW_DEFAULT_OPTION,
				...sortedModels.map((m) => {
					const fullId = `${m.provider}/${m.id}`;
					const tag = isFastModel(m) ? " ⚡ 推荐轻量/快速" : "";
					const activeMark = config.models.includes(fullId) || config.models.includes(m.id) ? " ✓" : "";
					return `${fullId}${tag}${activeMark}`;
				}),
			];

			const choice = await ctx.ui.select(`选择上下文压缩模型 (${currentDesc})`, options);
			if (!choice) return;

			if (choice === FOLLOW_DEFAULT_OPTION) {
				await updateJsonSettings(globalSettingsPath, (data) => {
					delete data.compactionModel;
					if (data.compaction && typeof data.compaction === "object") {
						delete data.compaction.model;
						if (Object.keys(data.compaction).length === 0) {
							delete data.compaction;
						}
					}
				});
				ctx.ui.notify("✅ 已恢复默认：压缩时跟随当前主对话模型", "info");
				return;
			}

			const selectedFullId = choice.split(" ")[0].trim();
			await updateJsonSettings(globalSettingsPath, (data) => {
				if (!data.compaction || typeof data.compaction !== "object") {
					data.compaction = {};
				}
				data.compaction.model = selectedFullId;
				if (!data.compaction.thinkingLevel) {
					data.compaction.thinkingLevel = "off";
				}
			});

			ctx.ui.notify(
				`✅ 已设置全局压缩模型: ${selectedFullId} (thinking: ${config.thinkingLevel ?? "off"})`,
				"info",
			);
		},
	});
}
