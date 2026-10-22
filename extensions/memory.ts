/**
 * Persistent Memory Extension (Project & Global)
 *
 * Provides persistent cross-session memory stored in Markdown files:
 * - Project memory: <cwd>/.pi/MEMORY.md
 * - Global memory:  ~/.pi/agent/MEMORY.md
 *
 * Features:
 * - Automatically injects non-empty project & global memory into the system prompt
 * - `memory` tool for the agent to list, add, remove, or replace memories
 * - `/remember <fact>` command to quickly save a project memory (use `/remember -g <fact>` for global)
 * - `/memory [edit|global|clear]` command to view or edit persistent memory
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type MemoryScope = "project" | "global";

interface MemoryDetails {
	action: "list" | "add" | "remove" | "replace";
	scope: MemoryScope;
	filePath: string;
	content?: string;
	error?: string;
}

const MemoryParams = Type.Object({
	action: StringEnum(["list", "add", "remove", "replace"] as const, {
		description: "Operation: list (read memory), add (append bullet), remove (delete matching line), replace (overwrite memory file)",
	}),
	scope: Type.Optional(
		StringEnum(["project", "global"] as const, {
			description: 'Memory scope: "project" (.pi/MEMORY.md, default) or "global" (~/.pi/agent/MEMORY.md)',
			default: "project",
		}),
	),
	content: Type.Optional(
		Type.String({
			description: "Memory note to add (for add) or full Markdown text (for replace)",
		}),
	),
	match: Type.Optional(
		Type.String({
			description: "Substring or exact line to remove (for remove)",
		}),
	),
});

function getMemoryFilePath(cwd: string, scope: MemoryScope): string {
	if (scope === "global") {
		return path.join(getAgentDir(), "MEMORY.md");
	}
	return path.join(cwd, ".pi", "MEMORY.md");
}

function readMemoryFile(filePath: string): string {
	if (!fs.existsSync(filePath)) return "";
	try {
		return fs.readFileSync(filePath, "utf-8").trim();
	} catch {
		return "";
	}
}

async function writeMemoryFile(filePath: string, content: string): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		const normalized = content.trim() ? `${content.trim()}\n` : "";
		await fs.promises.writeFile(filePath, normalized, "utf-8");
	});
}

async function appendMemoryBullet(filePath: string, note: string, scope: MemoryScope): Promise<string> {
	const cleanNote = note.trim().replace(/^-\s+/, "");
	let updated = "";
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		const existing = readMemoryFile(filePath);
		const header = scope === "project" ? "# Project Memory" : "# Global Memory";
		if (!existing) {
			updated = `${header}\n\n- ${cleanNote}\n`;
		} else {
			updated = `${existing}\n- ${cleanNote}\n`;
		}
		await fs.promises.writeFile(filePath, updated, "utf-8");
	});
	return updated.trim();
}

export default function memoryExtension(pi: ExtensionAPI) {
	// Inject project and global memory into structured system prompt sections
	pi.on("before_agent_start", async (event, ctx) => {
		const globalPath = getMemoryFilePath(ctx.cwd, "global");
		const projectPath = getMemoryFilePath(ctx.cwd, "project");

		const globalMem = readMemoryFile(globalPath);
		const projectMem = readMemoryFile(projectPath);

		const parts: string[] = [];
		if (globalMem) {
			parts.push(`### Global Memory (${globalPath})\n${globalMem}`);
		}
		if (projectMem) {
			parts.push(`### Project Memory (${projectPath})\n${projectMem}`);
		}

		if (parts.length > 0) {
			event.systemPromptOptions.sections.persistent_memory = [
				"The following persistent memories have been saved across sessions:",
				"",
				...parts,
			].join("\n");
		} else {
			delete event.systemPromptOptions.sections.persistent_memory;
		}
	});

	// Register `memory` tool for the LLM
	pi.registerTool({
		name: "memory",
		label: "Memory",
		description:
			"Read or update persistent project (.pi/MEMORY.md) or global (~/.pi/agent/MEMORY.md) memory across sessions.",
		promptSnippet: "Save or update persistent project/global memories across sessions",
		promptGuidelines: [
			"Use the `memory` tool when the user asks you to remember a preference, convention, command, or architectural decision across sessions.",
			"Prefer `scope: \"project\"` for repository-specific knowledge and `scope: \"global\"` for user-wide preferences.",
		],
		parameters: MemoryParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope: MemoryScope = params.scope ?? "project";
			const filePath = getMemoryFilePath(ctx.cwd, scope);

			switch (params.action) {
				case "list": {
					const content = readMemoryFile(filePath);
					return {
						content: [
							{
								type: "text",
								text: content || `(No ${scope} memory saved yet at ${filePath})`,
							},
						],
						details: { action: "list", scope, filePath, content } satisfies MemoryDetails,
					};
				}

				case "add": {
					if (!params.content?.trim()) {
						return {
							content: [{ type: "text", text: "Error: `content` is required for action=add" }],
							details: {
								action: "add",
								scope,
								filePath,
								error: "content is required",
							} satisfies MemoryDetails,
						};
					}
					const updated = await appendMemoryBullet(filePath, params.content, scope);
					return {
						content: [
							{
								type: "text",
								text: `Saved to ${scope} memory (${filePath}):\n- ${params.content.trim().replace(/^-\s+/, "")}`,
							},
						],
						details: {
							action: "add",
							scope,
							filePath,
							content: updated,
						} satisfies MemoryDetails,
					};
				}

				case "remove": {
					const needle = params.match?.trim() || params.content?.trim();
					if (!needle) {
						return {
							content: [{ type: "text", text: "Error: `match` is required for action=remove" }],
							details: {
								action: "remove",
								scope,
								filePath,
								error: "match is required",
							} satisfies MemoryDetails,
						};
					}
					const existing = readMemoryFile(filePath);
					if (!existing) {
						return {
							content: [{ type: "text", text: `No ${scope} memory file found.` }],
							details: { action: "remove", scope, filePath } satisfies MemoryDetails,
						};
					}
					const lines = existing.split("\n");
					const filtered = lines.filter((line) => !line.toLowerCase().includes(needle.toLowerCase()));
					const removedCount = lines.length - filtered.length;
					if (removedCount === 0) {
						return {
							content: [{ type: "text", text: `No memory lines matched "${needle}".` }],
							details: {
								action: "remove",
								scope,
								filePath,
								error: `No match for "${needle}"`,
							} satisfies MemoryDetails,
						};
					}
					const updated = filtered.join("\n").trim();
					await writeMemoryFile(filePath, updated);
					return {
						content: [
							{
								type: "text",
								text: `Removed ${removedCount} line(s) matching "${needle}" from ${scope} memory.`,
							},
						],
						details: {
							action: "remove",
							scope,
							filePath,
							content: updated,
						} satisfies MemoryDetails,
					};
				}

				case "replace": {
					const newContent = params.content ?? "";
					await writeMemoryFile(filePath, newContent);
					return {
						content: [
							{
								type: "text",
								text: newContent.trim()
									? `Updated ${scope} memory (${filePath}).`
									: `Cleared ${scope} memory (${filePath}).`,
							},
						],
						details: {
							action: "replace",
							scope,
							filePath,
							content: newContent.trim(),
						} satisfies MemoryDetails,
					};
				}
			}
		},

		renderCall(args, theme) {
			const scope = args.scope ?? "project";
			let text =
				theme.fg("toolTitle", theme.bold("memory ")) +
				theme.fg("accent", `${args.action}`) +
				theme.fg("muted", ` [${scope}]`);
			if (args.content) {
				const preview = args.content.length > 60 ? `${args.content.slice(0, 60)}...` : args.content;
				text += ` ${theme.fg("dim", `"${preview.replace(/\n/g, " ")}"`)}`;
			} else if (args.match) {
				text += ` ${theme.fg("dim", `"${args.match}"`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as MemoryDetails | undefined;
			const firstText = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (details?.error) {
				return new Text(theme.fg("error", `✗ ${ details.error }`), 0, 0);
			}
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", firstText), 0, 0);
		},
	});

	// `/remember [-g|--global] <note>` quick command
	pi.registerCommand("remember", {
		description: "Save a note to persistent project memory (use -g for global memory)",
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify("Usage: /remember [-g|--global] <fact or rule to remember>", "warning");
				return;
			}

			let scope: MemoryScope = "project";
			let note = raw;
			if (raw.startsWith("-g ") || raw.startsWith("--global ")) {
				scope = "global";
				note = raw.replace(/^(-g|--global)\s+/, "").trim();
			}

			if (!note) {
				ctx.ui.notify("Usage: /remember [-g|--global] <fact or rule to remember>", "warning");
				return;
			}

			const filePath = getMemoryFilePath(ctx.cwd, scope);
			await appendMemoryBullet(filePath, note, scope);
			ctx.ui.notify(`Saved to ${scope} memory (${filePath}): ${note}`, "info");
		},
	});

	// `/memory [edit|edit-global]` command to inspect or edit memory
	pi.registerCommand("memory", {
		description: "View or edit persistent project/global memory (/memory [edit|edit-global])",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			const projectPath = getMemoryFilePath(ctx.cwd, "project");
			const globalPath = getMemoryFilePath(ctx.cwd, "global");

			if (sub === "edit" || sub === "edit-project") {
				const current = readMemoryFile(projectPath) || "# Project Memory\n\n- ";
				const edited = await ctx.ui.editor(`Edit Project Memory (${projectPath})`, current);
				if (edited !== undefined) {
					await writeMemoryFile(projectPath, edited);
					ctx.ui.notify(`Updated project memory (${projectPath})`, "info");
				}
				return;
			}

			if (sub === "edit-global" || sub === "global") {
				const current = readMemoryFile(globalPath) || "# Global Memory\n\n- ";
				const edited = await ctx.ui.editor(`Edit Global Memory (${globalPath})`, current);
				if (edited !== undefined) {
					await writeMemoryFile(globalPath, edited);
					ctx.ui.notify(`Updated global memory (${globalPath})`, "info");
				}
				return;
			}

			const projectMem = readMemoryFile(projectPath);
			const globalMem = readMemoryFile(globalPath);

			const summary = [
				`📁 Project Memory (${projectPath}):`,
				projectMem || "  (empty — use `/remember <note>` or `/memory edit`)",
				"",
				`🌐 Global Memory (${globalPath}):`,
				globalMem || "  (empty — use `/remember -g <note>` or `/memory edit-global`)",
			].join("\n");

			ctx.ui.notify(summary, "info");
		},
	});
}
