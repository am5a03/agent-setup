/**
 * Custom Footer Extension — redesigned Pi footer
 *
 * Line 1: ~/path (branch) +2 ~1 ?5     — cwd, git branch (accent), staged/unstaged/untracked
 * Line 2: ↑1.2k ↓500 $0.003 (45.2%) | ⏱️ 30m | 🔧 24     (google) gemini-2.5-pro • high
 * Line 3: [extension statuses if any]
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ─── Git Status Cache ─────────────────────────────────────────────

interface GitStatusResult {
	isRepo: boolean;
	staged: number;
	unstaged: number;
	untracked: number;
}

const GIT_CACHE_MS = 5000;
let gitCache: GitStatusResult | null = null;
let gitCacheTime = 0;
let gitFetchInFlight = false;

async function fetchGitStatus(pi: ExtensionAPI, cwd: string): Promise<GitStatusResult> {
	const notRepo: GitStatusResult = { isRepo: false, staged: 0, unstaged: 0, untracked: 0 };
	try {
		const { code } = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
		if (code !== 0) return notRepo;

		const { stdout, code: status } = await pi.exec(
			"git",
			["--no-optional-locks", "status", "--porcelain"],
			{ cwd },
		);
		if (status !== 0) return notRepo;

		const lines = stdout.trim().split("\n").filter((l) => l.length > 0);

		let staged = 0;
		let unstaged = 0;
		let untracked = 0;

		for (const line of lines) {
			if (line.startsWith("!!")) continue; // ignored
			const x = line[0] ?? " ";
			const y = line[1] ?? " ";

			if (x === "?" && y === "?") {
				untracked++;
			} else {
				if (x !== " " && x !== "?") staged++;
				if (y !== " " && y !== "?") unstaged++;
			}
		}

		return { isRepo: true, staged, unstaged, untracked };
	} catch {
		return notRepo;
	}
}

async function getGitStatus(pi: ExtensionAPI, cwd: string): Promise<GitStatusResult> {
	const now = Date.now();
	if (gitCache && now - gitCacheTime < GIT_CACHE_MS) return gitCache;
	if (gitFetchInFlight) return gitCache ?? { isRepo: false, staged: 0, unstaged: 0, untracked: 0 };

	gitFetchInFlight = true;
	try {
		gitCache = await fetchGitStatus(pi, cwd);
		gitCacheTime = Date.now();
		return gitCache;
	} finally {
		gitFetchInFlight = false;
	}
}

function invalidateGitCache() {
	gitCacheTime = 0;
}

// ─── State ────────────────────────────────────────────────────────

let sessionStart: number | null = null;
let toolCallCount = 0;
let durationTimer: ReturnType<typeof setInterval> | null = null;
let currentThinkingLevel: string | undefined;

// ─── Formatters ────────────────────────────────────────────────────

function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m`;
	return `${Math.max(s, 0)}s`;
}

function sanitize(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

// ─── Footer Component ─────────────────────────────────────────────

function makeFooterComponent(
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	theme: ExtensionContext["ui"]["theme"],
	tui: { requestRender(): void },
	pi: ExtensionAPI,
) {
	return {
		dispose() { },
		invalidate() { },
		render(width: number): string[] {
			const model = ctx.model;
			const cwd = ctx.sessionManager.getCwd();

			// ── Line 1: cwd + branch + git dirty ──
			let pwd = cwd;
			const home = process.env.HOME || process.env.USERPROFILE;
			if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

			const branch = footerData.getGitBranch();
			if (branch) pwd = `${pwd} ${theme.fg("dim", "(")}${theme.fg("accent", branch)}${theme.fg("dim", ")")}`;

			let gitIndicator = "";
			if (gitCache?.isRepo) {
				if (gitCache.staged === 0 && gitCache.unstaged === 0 && gitCache.untracked === 0) {
					gitIndicator = " " + theme.fg("success", "✓");
				} else {
					const parts: string[] = [];
					if (gitCache.staged > 0) parts.push(theme.fg("success", `+${gitCache.staged}`));
					if (gitCache.unstaged > 0) parts.push(theme.fg("warning", `~${gitCache.unstaged}`));
					if (gitCache.untracked > 0) parts.push(theme.fg("muted", `?${gitCache.untracked}`));
					gitIndicator = " " + parts.join(" ");
				}
			}

			const line1 = truncateToWidth(theme.fg("dim", pwd) + gitIndicator, width, theme.fg("dim", "..."));

			// ── Line 2: metrics (left) + model (right) ──
			let totalInput = 0;
			let totalOutput = 0;
			let totalCost = 0;
			const usingSub = model ? ctx.modelRegistry.isUsingOAuth(model) : false;

			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					const m = entry.message as AssistantMessage;
					totalInput += m.usage.input;
					totalOutput += m.usage.output;
					totalCost += m.usage.cost.total;
				}
			}

			// Build left-side stats with two levels of grouping:
			// - Inner group (space-separated): token stats + cost + context% are one unit
			// - Outer groups (pipe-separated): [inner] | duration | tool count
			// Each segment carries its own styling so ANSI resets don't bleed.

			// ── Inner group: tokens + cost (context %) ──
			const tokenParts: string[] = [];
			if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCost || usingSub) {
				tokenParts.push(`$${totalCost.toFixed(3)}${usingSub ? " (sub)" : ""}`);
			}

			// Context % — error/warning for high usage, else plain
			const usage = ctx.getContextUsage();
			const pctVal = usage?.percent ?? 0;
			const pctStr = usage?.percent != null ? pctVal.toFixed(1) : "?";
			const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
			const windowStr = contextWindow > 0 ? formatTokens(contextWindow) : "?";

			let contextDisplay: string;
			if (pctStr === "?") {
				contextDisplay = theme.fg("dim", `(?/${windowStr})`);
			} else if (pctVal >= 60) {
				contextDisplay = theme.fg("error", `(${pctStr}%/${windowStr})`);
			} else if (pctVal >= 40) {
				contextDisplay = theme.fg("warning", `(${pctStr}%/${windowStr})`);
			} else {
				contextDisplay = theme.fg("dim", `(${pctStr}%/${windowStr})`);
			}

			// Join token parts with spaces, then append context % with a space
			let innerGroup = "";
			if (tokenParts.length > 0) {
				innerGroup = tokenParts.map(p => theme.fg("dim", p)).join(" ");
				innerGroup += " " + contextDisplay;
			} else {
				innerGroup = contextDisplay;
			}

			// ── Outer groups: [inner] | duration | tool count ──
			const outerParts: string[] = [innerGroup];

			// Duration
			if (sessionStart) {
				outerParts.push(theme.fg("dim", `⏱️ ${formatDuration(Date.now() - sessionStart)}`));
			}

			// Tool calls (hide when 0)
			if (toolCallCount > 0) {
				outerParts.push(theme.fg("dim", `🔧 ${toolCallCount}`));
			}

			const sep = theme.fg("dim", " | ");
			const statsLeft = outerParts.join(sep);
			const statsLeftWidth = visibleWidth(statsLeft);
			const leftFinal = statsLeftWidth <= width
				? statsLeft
				: truncateToWidth(statsLeft, width, "...");
			const leftW = visibleWidth(leftFinal);

			// ── Line 2 right: provider + model + thinking ──
			const modelId = model?.id || "no-model";
			let rightNoProvider = modelId;
			if (model?.reasoning && currentThinkingLevel && currentThinkingLevel !== "off") {
				rightNoProvider = `${modelId} • ${currentThinkingLevel}`;
			}

			const rightSide = model
				? theme.fg("dim", `(${model.provider}) ${rightNoProvider}`)
				: theme.fg("dim", rightNoProvider);

			const rightW = visibleWidth(rightSide);
			const minPad = 2;

			let line2: string;
			if (leftW + minPad + rightW <= width) {
				const pad = " ".repeat(width - leftW - rightW);
				line2 = leftFinal + pad + rightSide;
			} else {
				const avail = width - leftW - minPad;
				if (avail > 0) {
					const truncR = truncateToWidth(rightSide, avail, "");
					const truncRW = visibleWidth(truncR);
					const pad = " ".repeat(Math.max(0, width - leftW - truncRW));
					line2 = leftFinal + pad + truncR;
				} else {
					line2 = leftFinal;
				}
			}

			const lines = [line1, line2];

			// ── Line 3: extension statuses ──
			const extStatuses = footerData.getExtensionStatuses();
			if (extStatuses.size > 0) {
				const sorted = Array.from(extStatuses.entries())
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, t]) => sanitize(t));
				const statusLine = sorted.join(" ");
				lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
			}

			return lines;
		},
	};
}

// ─── Extension Factory ────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		sessionStart = Date.now();
		toolCallCount = 0;
		invalidateGitCache();
		currentThinkingLevel = pi.getThinkingLevel();

		if (ctx.hasUI) {
			ctx.ui.setFooter((tui, theme, footerData) => {
				const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

				const component = makeFooterComponent(ctx, footerData, theme, tui, pi);

				// Duration timer: refresh every 15s
				durationTimer = setInterval(() => tui.requestRender(), 15000);

				// Initial async git fetch (non-blocking)
				getGitStatus(pi, ctx.sessionManager.getCwd()).then(() => tui.requestRender());

				return {
					dispose() {
						unsubBranch();
						if (durationTimer) {
							clearInterval(durationTimer);
							durationTimer = null;
						}
					},
					invalidate() { },
					render(width: number): string[] {
						return component.render(width);
					},
				};
			});
		}
	});

	pi.on("session_shutdown", async () => {
		if (durationTimer) {
			clearInterval(durationTimer);
			durationTimer = null;
		}
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		toolCallCount++;
		// Invalidate git cache — tool may modify files
		invalidateGitCache();
		getGitStatus(pi, ctx.sessionManager.getCwd());
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		invalidateGitCache();
		getGitStatus(pi, ctx.sessionManager.getCwd());
	});

	pi.on("model_select", async () => {
		currentThinkingLevel = pi.getThinkingLevel();
	});

	pi.registerCommand("footer-refresh", {
		description: "Force refresh the custom footer (re-fetches git status)",
		handler: async (_args, ctx) => {
			invalidateGitCache();
			await getGitStatus(pi, ctx.sessionManager.getCwd());
			ctx.ui.notify("Footer refreshed", "info");
		},
	});
}