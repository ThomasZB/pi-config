/**
 * Web Search & Fetch Extension (DeepSeek Search/Fetch API + Fallbacks)
 *
 * Provides two native tools for the agent (and codemode scripts):
 * - `web_search`: Search the web via DeepSeek Search API (`POST https://api.deepseek.com/v1/tools/search`),
 *                 with automatic fallback to Tavily API if configured.
 * - `web_fetch`:  Fetch a URL as clean Markdown via DeepSeek Fetch API (`POST https://api.deepseek.com/v1/tools/fetch`),
 *                 with automatic fallback to direct HTTP fetch & HTML-to-text extraction.
 *
 * Environment variables:
 * - `DEEPSEEK_API_KEY`: Used for DeepSeek Search & Fetch APIs (primary)
 * - `TAVILY_API_KEY`:   Optional fallback for `web_search`
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	getAgentDir,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

interface DeepSeekSearchResultItem {
	rerank_score?: number;
	title?: string;
	url?: string;
	snippet?: string;
	summary?: string;
	content?: string;
	site_name?: string | null;
	site_icon?: string | null;
	date?: string | null;
	authority?: number;
}

interface DeepSeekSearchResponse {
	results?: DeepSeekSearchResultItem[];
	error?: {
		message?: string;
		type?: string;
		code?: string;
	};
}

interface DeepSeekFetchResponse {
	title?: string;
	content?: string;
	error?: {
		message?: string;
		type?: string;
		code?: string;
	};
}

interface WebSearchDetails {
	provider: "deepseek" | "tavily";
	query: string;
	resultCount: number;
	error?: string;
}

interface WebFetchDetails {
	provider: "deepseek" | "direct";
	url: string;
	title?: string;
	charCount: number;
	truncated?: boolean;
	error?: string;
}

interface WebSettingsConfig {
	deepseekApiKey?: string;
	deepseekApiKeyEnv?: string;
	tavilyApiKey?: string;
	tavilyApiKeyEnv?: string;
}

function readWebSettings(cwd?: string): WebSettingsConfig {
	const merged: WebSettingsConfig = {};
	const files = [
		path.join(getAgentDir(), "settings.json"),
		...(cwd ? [path.join(cwd, ".pi", "settings.json")] : []),
	];
	for (const filePath of files) {
		if (!fs.existsSync(filePath)) continue;
		try {
			const raw = JSON.parse(fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, ""));
			if (raw?.web && typeof raw.web === "object") {
				Object.assign(merged, raw.web);
			}
		} catch {
			// Ignore malformed settings
		}
	}
	return merged;
}

/**
 * Resolve API key supporting:
 * 1. `web.<provider>ApiKeyEnv` in settings.json (custom environment variable name, e.g. "DEEPSEEK_API_KEY")
 * 2. `web.<provider>ApiKey` in settings.json (supports "${ENV_VAR}", "$ENV_VAR", env var name, or literal key)
 * 3. Default environment variable (`DEEPSEEK_API_KEY` / `TAVILY_API_KEY`)
 */
function resolveApiKey(
	defaultEnvName: "DEEPSEEK_API_KEY" | "TAVILY_API_KEY",
	cwd?: string,
): { key?: string; envName: string } {
	const webSettings = readWebSettings(cwd);
	const isDeepSeek = defaultEnvName === "DEEPSEEK_API_KEY";
	const configuredEnvName = (
		isDeepSeek ? webSettings.deepseekApiKeyEnv : webSettings.tavilyApiKeyEnv
	)?.trim();
	const configuredKeyOrRef = (
		isDeepSeek ? webSettings.deepseekApiKey : webSettings.tavilyApiKey
	)?.trim();

	const envName = configuredEnvName || defaultEnvName;

	// 1. If a custom env var name is configured, read from process.env[envName]
	if (configuredEnvName && process.env[configuredEnvName]?.trim()) {
		return { key: process.env[configuredEnvName]!.trim(), envName: configuredEnvName };
	}

	// 2. If `deepseekApiKey` / `tavilyApiKey` is set:
	//    - "${VAR_NAME}" or "$VAR_NAME" -> read from process.env[VAR_NAME]
	//    - Uppercase identifier matching an existing env var -> read from process.env[val]
	//    - Otherwise treat as literal API key
	if (configuredKeyOrRef) {
		const braceMatch = configuredKeyOrRef.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
		const dollarMatch = configuredKeyOrRef.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
		const refEnv = braceMatch?.[1] ?? dollarMatch?.[1];
		if (refEnv) {
			return { key: process.env[refEnv]?.trim() || undefined, envName: refEnv };
		}
		if (/^[A-Z][A-Z0-9_]+$/.test(configuredKeyOrRef)) {
			return {
				key: process.env[configuredKeyOrRef]?.trim() || undefined,
				envName: configuredKeyOrRef,
			};
		}
		return { key: configuredKeyOrRef, envName };
	}

	// 3. Fallback to default env var
	const fromDefaultEnv = process.env[envName]?.trim();
	return { key: fromDefaultEnv || undefined, envName };
}

/**
 * Retry wrapper for transient HTTP statuses (408, 429, 5xx) as recommended by DeepSeek docs.
 */
async function fetchWithRetry(
	url: string,
	init: RequestInit,
	signal?: AbortSignal,
	maxRetries = 2,
): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (signal?.aborted) {
			throw new Error("Request aborted");
		}
		try {
			const response = await fetch(url, { ...init, signal });
			if (
				attempt < maxRetries &&
				(response.status === 408 || response.status === 429 || response.status >= 500)
			) {
				const delayMs = 800 * Math.pow(2, attempt);
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				continue;
			}
			return response;
		} catch (err) {
			lastError = err;
			if (signal?.aborted || attempt >= maxRetries) {
				throw err;
			}
			const delayMs = 800 * Math.pow(2, attempt);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Simple HTML -> clean text/markdown fallback when direct HTTP fetch is used.
 */
function htmlToReadableText(html: string): { title: string; content: string } {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

	let text = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
		.replace(/<svg[\s\S]*?<\/svg>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");

	// Convert headings, links, list items, paragraphs, and line breaks
	text = text
		.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
		.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
		.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
		.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
		.replace(/<(br|hr)\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|tr|pre|blockquote)>/gi, "\n\n")
		.replace(/<[^>]+>/g, "");

	// Decode common HTML entities
	text = text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return { title, content: text };
}

/**
 * Convert a Reddit URL to its `.rss` Atom feed endpoint and parse entries into Markdown.
 */
function toRedditRssUrl(rawUrl: string): string | undefined {
	try {
		const u = new URL(rawUrl);
		if (!/(^|\.)reddit\.com$/i.test(u.hostname)) return undefined;
		u.pathname = u.pathname.replace(/\.(json|rss)$/i, "").replace(/\/+$/, "");
		u.pathname = `${u.pathname || ""}/.rss`;
		return u.toString();
	} catch {
		return undefined;
	}
}

function parseRedditAtomFeed(xml: string): { title: string; content: string } | undefined {
	if (!xml.includes("<feed") || !xml.includes("<entry>")) return undefined;
	const feedTitle = xml.match(/<feed[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "Reddit Feed";
	const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
	if (entries.length === 0) return undefined;

	const decodeEntities = (s: string) =>
		s
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&#32;/g, " ")
			.replace(/&amp;/g, "&");

	const items = entries.map((entry, idx) => {
		const title = decodeEntities(entry.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "(Untitled)").trim();
		const link = entry.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? "";
		const updated = (entry.match(/<updated>([^<]+)<\/updated>/i)?.[1] ?? "").slice(0, 10);
		const author = entry.match(/<author>\s*<name>([^<]+)<\/name>/i)?.[1] ?? "";
		const rawHtml = decodeEntities(entry.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1] ?? "");
		const text = htmlToReadableText(rawHtml).content.replace(/\s*submitted by\s+\/u\/\S+\s*\[link\]\s*\[comments\]\s*$/i, "").trim();
		const meta = [updated, author].filter(Boolean).join(" · ");
		return `### ${idx + 1}. [${title}](${link})${meta ? ` (${meta})` : ""}\nURL: ${link}${text ? `\n\n${text}` : ""}`;
	});

	return {
		title: decodeEntities(feedTitle),
		content: items.join("\n\n---\n\n"),
	};
}

export default function webExtension(pi: ExtensionAPI): void {
	// =========================================================================
	// 1. web_search tool
	// =========================================================================
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for real-time information, documentation, error messages, or current events. " +
			'Supports search operators in `query`: `site:github.com`, `-site:example.com`, `"exact phrase"`, `lang:zh,en`, `after:2025-01-01`, `before:2026`.',
		promptSnippet:
			"Search the web for up-to-date documentation, APIs, error messages, or facts (supports site:, lang:, after:, before: operators)",
		parameters: Type.Object({
			query: Type.String({
				description:
					'Search query (1-128 chars). Supports operators like `site:github.com`, `"exact phrase"`, `lang:zh,en`, `after:2025`.',
			}),
			count: Type.Optional(
				Type.Number({
					description: "Number of results to return (1-20, default: 8)",
					default: 8,
				}),
			),
			need_content: Type.Optional(
				Type.Boolean({
					description:
						"Whether to include full page text in addition to the 600-800 char summary (default: false)",
					default: false,
				}),
			),
			ori_question: Type.Optional(
				Type.String({
					description: "Optional original user question (1-128 chars) to improve search intent understanding",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const rawQuery = params.query.trim();
			if (!rawQuery) {
				return {
					content: [{ type: "text", text: "Error: `query` cannot be empty." }],
					details: {
						provider: "deepseek",
						query: "",
						resultCount: 0,
						error: "Empty query",
					} satisfies WebSearchDetails,
					isError: true,
				};
			}

			// DeepSeek requires query to be 1..128 Unicode characters
			const queryChars = Array.from(rawQuery);
			const boundedQuery = queryChars.length > 128 ? queryChars.slice(0, 128).join("") : rawQuery;
			const count = Math.max(1, Math.min(50, Math.round(params.count ?? 8)));
			const needContent = Boolean(params.need_content);

			const { key: deepseekKey, envName: deepseekEnvName } = resolveApiKey("DEEPSEEK_API_KEY", ctx.cwd);
			const { key: tavilyKey } = resolveApiKey("TAVILY_API_KEY", ctx.cwd);

			if (!deepseekKey && !tavilyKey) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Environment variable ${deepseekEnvName} is not set (configure via web.deepseekApiKeyEnv in settings.json).`,
						},
					],
					details: {
						provider: "deepseek",
						query: boundedQuery,
						resultCount: 0,
						error: `Missing ${deepseekEnvName}`,
					} satisfies WebSearchDetails,
					isError: true,
				};
			}

			// Primary: DeepSeek Search API
			if (deepseekKey) {
				try {
					const payload: Record<string, unknown> = {
						query: boundedQuery,
						count,
						need_content: needContent,
					};
					if (params.ori_question?.trim()) {
						payload.ori_question = Array.from(params.ori_question.trim()).slice(0, 128).join("");
					}

					const response = await fetchWithRetry(
						DEEPSEEK_SEARCH_URL,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${deepseekKey}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify(payload),
						},
						signal,
					);

					const data = (await response.json()) as DeepSeekSearchResponse;
					if (!response.ok) {
						const errMsg = data?.error?.message || `HTTP ${response.status}`;
						throw new Error(`DeepSeek Search API error (${response.status}): ${errMsg}`);
					}

					const results = data.results ?? [];
					if (results.length === 0) {
						return {
							content: [{ type: "text", text: `No results found for query: "${boundedQuery}"` }],
							details: {
								provider: "deepseek",
								query: boundedQuery,
								resultCount: 0,
							} satisfies WebSearchDetails,
						};
					}

					const formatted = results
						.map((item, idx) => {
							const title = item.title || "(Untitled)";
							const url = item.url || "";
							const metaParts: string[] = [];
							if (item.site_name) metaParts.push(item.site_name);
							if (item.date) metaParts.push(item.date.slice(0, 10));
							if (typeof item.rerank_score === "number") {
								metaParts.push(`score:${item.rerank_score.toFixed(2)}`);
							}
							const metaLine = metaParts.length > 0 ? ` (${metaParts.join(" · ")})` : "";
							const bodyText = item.summary || item.snippet || "";
							let block = `### ${idx + 1}. [${title}](${url})${metaLine}\nURL: ${url}`;
							if (bodyText) {
								block += `\n\n${bodyText.trim()}`;
							}
							if (needContent && item.content) {
								const contentPreview =
									item.content.length > 4000
										? `${item.content.slice(0, 4000)}\n...[content truncated]`
										: item.content;
								block += `\n\n<content>\n${contentPreview.trim()}\n</content>`;
							}
							return block;
						})
						.join("\n\n---\n\n");

					const truncation = truncateHead(formatted, {
						maxLines: DEFAULT_MAX_LINES,
						maxBytes: DEFAULT_MAX_BYTES,
					});

					return {
						content: [{ type: "text", text: truncation.content }],
						details: {
							provider: "deepseek",
							query: boundedQuery,
							resultCount: results.length,
						} satisfies WebSearchDetails,
					};
				} catch (err) {
					if (!tavilyKey || signal?.aborted) {
						const msg = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `Search failed: ${msg}` }],
							details: {
								provider: "deepseek",
								query: boundedQuery,
								resultCount: 0,
								error: msg,
							} satisfies WebSearchDetails,
							isError: true,
						};
					}
					// Fall through to Tavily if available
				}
			}

			// Fallback: Tavily Search API
			try {
				const response = await fetchWithRetry(
					TAVILY_SEARCH_URL,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							api_key: tavilyKey,
							query: rawQuery,
							max_results: count,
							include_raw_content: needContent,
						}),
					},
					signal,
				);
				if (!response.ok) {
					throw new Error(`Tavily HTTP ${response.status}`);
				}
				const data = (await response.json()) as {
					results?: Array<{ title?: string; url?: string; content?: string; raw_content?: string }>;
				};
				const results = data.results ?? [];
				const formatted = results
					.map((r, idx) => `### ${idx + 1}. [${r.title ?? "Untitled"}](${r.url ?? ""})\nURL: ${r.url ?? ""}\n\n${r.content ?? ""}`)
					.join("\n\n---\n\n");

				return {
					content: [{ type: "text", text: formatted || `No results found for "${rawQuery}"` }],
					details: {
						provider: "tavily",
						query: rawQuery,
						resultCount: results.length,
					} satisfies WebSearchDetails,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Search failed: ${msg}` }],
					details: {
						provider: "tavily",
						query: rawQuery,
						resultCount: 0,
						error: msg,
					} satisfies WebSearchDetails,
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			const q = args.query ?? "";
			const countPart = args.count ? theme.fg("muted", ` (top ${args.count})`) : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("web_search ")) +
					theme.fg("accent", `"${q}"`) +
					countPart,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as WebSearchDetails | undefined;
			if (result.isError || details?.error) {
				return new Text(theme.fg("error", `✗ ${details?.error ?? "Search failed"}`), 0, 0);
			}
			return new Text(
				theme.fg("success", "✓ ") +
					theme.fg("muted", `${details?.resultCount ?? 0} results via ${details?.provider ?? "deepseek"}`),
				0,
				0,
			);
		},
	});

	// =========================================================================
	// 2. web_fetch tool
	// =========================================================================
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a single web page URL and return its content as clean Markdown text. " +
			"Uses DeepSeek Fetch API first and automatically falls back to direct HTTP fetch if needed.",
		promptSnippet: "Fetch a URL and extract its content as clean Markdown",
		parameters: Type.Object({
			url: Type.String({
				description: "HTTP or HTTPS URL to fetch (max 8192 chars)",
			}),
			max_chars: Type.Optional(
				Type.Number({
					description: "Maximum characters of content to return (default: 30000)",
					default: 30000,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const url = params.url.trim();
			if (!/^https?:\/\//i.test(url)) {
				return {
					content: [{ type: "text", text: `Error: Invalid URL "${url}". Must start with http:// or https://.` }],
					details: {
						provider: "deepseek",
						url,
						charCount: 0,
						error: "Invalid URL",
					} satisfies WebFetchDetails,
					isError: true,
				};
			}

			const maxChars = Math.max(1000, Math.min(200000, params.max_chars ?? 30000));
			const { key: deepseekKey } = resolveApiKey("DEEPSEEK_API_KEY", ctx.cwd);

			// 1. Try DeepSeek Fetch API first when key is present and URL is not localhost/127.0.0.1
			const isLocalUrl = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(url);
			if (deepseekKey && !isLocalUrl) {
				try {
					const response = await fetchWithRetry(
						DEEPSEEK_FETCH_URL,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${deepseekKey}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({ url }),
						},
						signal,
					);

					const data = (await response.json()) as DeepSeekFetchResponse;
					if (response.ok && data.content) {
						const title = data.title?.trim() || "";
						let body = data.content.trim();
						let truncated = false;
						if (body.length > maxChars) {
							body = `${body.slice(0, maxChars)}\n\n...[truncated ${body.length - maxChars} characters]`;
							truncated = true;
						}
						const header = title ? `# ${title}\nSource: ${url}\n\n` : `Source: ${url}\n\n`;
						const fullOutput = `${header}${body}`;

						return {
							content: [{ type: "text", text: fullOutput }],
							details: {
								provider: "deepseek",
								url,
								title,
								charCount: body.length,
								truncated,
							} satisfies WebFetchDetails,
						};
					}
					// If 403/404 or empty content, fall through to direct HTTP fetch fallback
				} catch {
					if (signal?.aborted) {
						throw new Error("Request aborted");
					}
					// Fall through to direct fetch
				}
			}

			// 2. Special handling for Reddit URLs via Atom RSS feed (avoids 403 bot blocks on .json/HTML)
			const redditRssUrl = toRedditRssUrl(url);
			if (redditRssUrl) {
				try {
					const rssRes = await fetchWithRetry(
						redditRssUrl,
						{
							method: "GET",
							headers: {
								"User-Agent": "pi-coding-agent/1.0 (by /u/pi_agent)",
								Accept: "application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
							},
						},
						signal,
					);
					if (rssRes.ok) {
						const xml = await rssRes.text();
						const parsedFeed = parseRedditAtomFeed(xml);
						if (parsedFeed) {
							let body = parsedFeed.content;
							let truncated = false;
							if (body.length > maxChars) {
								body = `${body.slice(0, maxChars)}\n\n...[truncated ${body.length - maxChars} characters]`;
								truncated = true;
							}
							const header = `# ${parsedFeed.title}\nSource: ${url}\n\n`;
							return {
								content: [{ type: "text", text: `${header}${body}` }],
								details: {
									provider: "direct",
									url,
									title: parsedFeed.title,
									charCount: body.length,
									truncated,
								} satisfies WebFetchDetails,
							};
						}
					}
				} catch {
					// Fall through to generic direct HTTP fetch
				}
			}

			// 3. Fallback: Direct HTTP fetch (supports raw files, JSON APIs, localhost, or sites blocked by DeepSeek Fetch)
			try {
				const response = await fetchWithRetry(
					url,
					{
						method: "GET",
						headers: {
							"User-Agent":
								"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
							Accept: "text/markdown, text/html, application/json, text/plain;q=0.9, */*;q=0.8",
						},
					},
					signal,
				);

				if (!response.ok) {
					throw new Error(`HTTP ${response.status} ${response.statusText}`);
				}

				const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
				const rawText = await response.text();

				let title = "";
				let content = rawText;

				if (contentType.includes("text/html") || /^\s*<!doctype html/i.test(rawText)) {
					const parsed = htmlToReadableText(rawText);
					title = parsed.title;
					content = parsed.content;
				} else if (contentType.includes("application/json")) {
					try {
						content = `\`\`\`json\n${JSON.stringify(JSON.parse(rawText), null, 2)}\n\`\`\``;
					} catch {
						content = rawText;
					}
				}

				let truncated = false;
				if (content.length > maxChars) {
					content = `${content.slice(0, maxChars)}\n\n...[truncated ${content.length - maxChars} characters]`;
					truncated = true;
				}

				const header = title ? `# ${title}\nSource: ${url}\n\n` : `Source: ${url}\n\n`;
				return {
					content: [{ type: "text", text: `${header}${content}` }],
					details: {
						provider: "direct",
						url,
						title,
						charCount: content.length,
						truncated,
					} satisfies WebFetchDetails,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Failed to fetch ${url}: ${msg}` }],
					details: {
						provider: "direct",
						url,
						charCount: 0,
						error: msg,
					} satisfies WebFetchDetails,
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("mdLink", args.url ?? ""),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as WebFetchDetails | undefined;
			if (result.isError || details?.error) {
				return new Text(theme.fg("error", `✗ ${details?.error ?? "Fetch failed"}`), 0, 0);
			}
			const kb = details?.charCount ? `${(details.charCount / 1024).toFixed(1)}KB` : "done";
			return new Text(
				theme.fg("success", "✓ ") +
					theme.fg("muted", `${kb} via ${details?.provider ?? "deepseek"}`),
				0,
				0,
			);
		},
	});
}
