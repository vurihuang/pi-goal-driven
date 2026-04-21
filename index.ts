import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

const EXTENSION_NAME = "pi-goal-driven";
const COMMAND_NAME = "goal-driven";
const BRAINSTORM_COMMAND_NAME = `${COMMAND_NAME}:brainstorm`;
const WORK_COMMAND_NAME = `${COMMAND_NAME}:work`;
const PROMPT_START = "GOAL_DRIVEN_PROMPT_START";
const PROMPT_END = "GOAL_DRIVEN_PROMPT_END";
const GOAL_PLACEHOLDER = "[[[[[DEFINE YOUR GOAL HERE]]]]]";
const CRITERIA_PLACEHOLDER = "[[[[[DEFINE YOUR CRITERIA FOR SUCCESS HERE]]]]]";
const PLACEHOLDER_TOKEN = "[[[[[";
const MASTER_MET_VERDICT = "GOAL_DRIVEN_VERDICT: MET";
const GOAL_DRIVEN_WORKER_AGENT = "worker";
const WATCHDOG_POLL_MS = 15_000;
const WATCHDOG_INACTIVE_TIMEOUT_MS = 15 * 60 * 1000;
const WATCHDOG_STOP_REASON = "Stopped by Goal-Driven inactivity watchdog";

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(PACKAGE_DIR, "goal-driven-template.md");
const GLOBAL_EXTENSION_DIR = path.join(getAgentDir(), "extensions", EXTENSION_NAME);
const GLOBAL_PROMPTS_DIR = path.join(GLOBAL_EXTENSION_DIR, "prompts");

const USAGE_TEXT = [
	`/${COMMAND_NAME}`,
	`/${BRAINSTORM_COMMAND_NAME} [task]`,
	`/${WORK_COMMAND_NAME}`,
	`/${COMMAND_NAME} stop`,
].join(", ");

type RunPhase = "working" | "verifying";
type AsyncRunState = "queued" | "running" | "complete" | "failed";

interface ActiveBrainstorm {
	cwd: string;
	lastEvent: string;
	template: string;
}

interface KnownAsyncRun {
	id: string;
	dir: string | null;
}

interface AsyncRunSnapshot {
	state: AsyncRunState | null;
	lastUpdate: number | null;
	pid: number | null;
	outputFile: string | null;
}

interface ActiveRun {
	cwd: string;
	goal: string;
	criteria: string;
	attempt: number;
	phase: RunPhase;
	awaitingVerification: boolean;
	verificationReminders: number;
	verificationReminderSent: boolean;
	activeAsyncId: string | null;
	activeAsyncDir: string | null;
	latestAsyncId: string | null;
	latestAsyncDir: string | null;
	knownAsyncRuns: KnownAsyncRun[];
	lastEvent: string;
}

let latestCtx: ExtensionContext | null = null;
let activeBrainstorm: ActiveBrainstorm | null = null;
let activeRun: ActiveRun | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function getAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function assistantMessageHasSubagentExecutionCall(message: AssistantMessage): boolean {
	return message.content.some((part) => {
		const candidate = part as { type?: string; name?: string; arguments?: Record<string, unknown> };
		return candidate.type === "toolCall" && candidate.name === "subagent" && isSubagentExecutionInput(candidate.arguments);
	});
}

function singleLine(text: string, max = 140): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, max - 1)}…`;
}

function normalizeGoal(text: string): string {
	return text.trim();
}

function normalizeCriteria(text: string): string {
	return text.trim();
}

function hasUnfilledPlaceholders(text: string): boolean {
	return text.includes(PLACEHOLDER_TOKEN);
}

function hasMetVerdict(text: string): boolean {
	return text.includes(MASTER_MET_VERDICT);
}

function hasTool(pi: ExtensionAPI, toolName: string): boolean {
	return pi.getAllTools().some((tool) => tool.name === toolName);
}

function ensureToolActive(pi: ExtensionAPI, toolName: string): boolean {
	if (!hasTool(pi, toolName)) return false;
	const activeTools = new Set(pi.getActiveTools());
	if (!activeTools.has(toolName)) {
		activeTools.add(toolName);
		pi.setActiveTools([...activeTools]);
	}
	return true;
}

function isSubagentExecutionInput(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	const candidate = input as Record<string, unknown>;
	return typeof candidate.agent === "string" || Array.isArray(candidate.tasks) || Array.isArray(candidate.chain);
}

function forceGoalDrivenSubagentExecution(input: unknown): void {
	if (!input || typeof input !== "object") return;
	const candidate = input as Record<string, unknown>;
	candidate.async = true;
	candidate.clarify = false;

	if (typeof candidate.agent === "string") {
		candidate.agent = GOAL_DRIVEN_WORKER_AGENT;
	}

	if (Array.isArray(candidate.tasks)) {
		for (const task of candidate.tasks) {
			if (!task || typeof task !== "object") continue;
			(task as Record<string, unknown>).agent = GOAL_DRIVEN_WORKER_AGENT;
		}
	}

	if (!Array.isArray(candidate.chain)) return;
	for (const step of candidate.chain) {
		if (!step || typeof step !== "object") continue;
		const chainStep = step as Record<string, unknown>;
		if (typeof chainStep.agent === "string") {
			chainStep.agent = GOAL_DRIVEN_WORKER_AGENT;
		}
		if (!Array.isArray(chainStep.parallel)) continue;
		for (const parallelStep of chainStep.parallel) {
			if (!parallelStep || typeof parallelStep !== "object") continue;
			(parallelStep as Record<string, unknown>).agent = GOAL_DRIVEN_WORKER_AGENT;
		}
	}
}

function getSubagentAsyncLaunch(details: unknown): { asyncId: string | null; asyncDir: string | null } {
	if (!details || typeof details !== "object") return { asyncId: null, asyncDir: null };
	const candidate = details as Record<string, unknown>;
	return {
		asyncId: typeof candidate.asyncId === "string" ? candidate.asyncId : null,
		asyncDir: typeof candidate.asyncDir === "string" ? candidate.asyncDir : null,
	};
}

async function readAsyncRunState(asyncDir: string | null): Promise<AsyncRunState | null> {
	if (!asyncDir) return null;
	try {
		const raw = await readFile(path.join(asyncDir, "status.json"), "utf8");
		const candidate = JSON.parse(raw) as { state?: string };
		if (
			candidate.state === "queued"
			|| candidate.state === "running"
			|| candidate.state === "complete"
			|| candidate.state === "failed"
		) {
			return candidate.state;
		}
		return null;
	} catch {
		return null;
	}
}

async function findRunningKnownAsyncRun(run: ActiveRun): Promise<KnownAsyncRun | null> {
	for (let index = run.knownAsyncRuns.length - 1; index >= 0; index -= 1) {
		const knownRun = run.knownAsyncRuns[index];
		const state = await readAsyncRunState(knownRun.dir);
		if (state === "queued" || state === "running") {
			return knownRun;
		}
	}
	return null;
}

function trackKnownAsyncRun(run: ActiveRun, asyncId: string, asyncDir: string | null): void {
	const existing = run.knownAsyncRuns.find((knownRun) => knownRun.id === asyncId);
	if (existing) {
		existing.dir = asyncDir;
	} else {
		run.knownAsyncRuns.push({ id: asyncId, dir: asyncDir });
	}
	run.latestAsyncId = asyncId;
	run.latestAsyncDir = asyncDir;
}

async function stopKnownAsyncRuns(run: ActiveRun, reason = "Stopped by /goal-driven stop"): Promise<number> {
	let stopped = 0;
	for (const knownRun of run.knownAsyncRuns) {
		if (!knownRun.dir) continue;
		try {
			const statusPath = path.join(knownRun.dir, "status.json");
			const raw = await readFile(statusPath, "utf8");
			const candidate = JSON.parse(raw) as {
				state?: string;
				pid?: number;
				lastUpdate?: number;
				endedAt?: number;
				error?: string;
				steps?: Array<Record<string, unknown>>;
			};
			if (candidate.state !== "queued" && candidate.state !== "running") continue;

			const stoppedAt = Date.now();
			if (typeof candidate.pid === "number") {
				try {
					process.kill(candidate.pid, "SIGTERM");
				} catch {
					// The process may have already exited; still rewrite status below.
				}
			}

			candidate.state = "failed";
			candidate.lastUpdate = stoppedAt;
			candidate.endedAt = stoppedAt;
			candidate.error = reason;
			candidate.steps = (candidate.steps ?? []).map((step) => {
				const nextStep = { ...step };
				if (nextStep.status === "queued" || nextStep.status === "pending" || nextStep.status === "running") {
					nextStep.status = "failed";
					nextStep.endedAt = stoppedAt;
					if (typeof nextStep.startedAt === "number") {
						nextStep.durationMs = Math.max(0, stoppedAt - nextStep.startedAt);
					}
					if (typeof nextStep.error !== "string" || !nextStep.error) {
						nextStep.error = reason;
					}
				}
				return nextStep;
			});

			await writeFile(statusPath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
			stopped += 1;
		} catch {
			// Best-effort cleanup; ignore missing, finished, or already-dead runs.
		}
	}
	return stopped;
}

async function readAsyncRunSnapshot(asyncDir: string | null): Promise<AsyncRunSnapshot | null> {
	if (!asyncDir) return null;
	try {
		const raw = await readFile(path.join(asyncDir, "status.json"), "utf8");
		const candidate = JSON.parse(raw) as {
			state?: string;
			lastUpdate?: number;
			pid?: number;
			outputFile?: string;
		};
		return {
			state: candidate.state === "queued"
				|| candidate.state === "running"
				|| candidate.state === "complete"
				|| candidate.state === "failed"
				? candidate.state
				: null,
			lastUpdate: typeof candidate.lastUpdate === "number" ? candidate.lastUpdate : null,
			pid: typeof candidate.pid === "number" ? candidate.pid : null,
			outputFile: typeof candidate.outputFile === "string" ? candidate.outputFile : null,
		};
	} catch {
		return null;
	}
}

async function readPathMtime(targetPath: string | null): Promise<number | null> {
	if (!targetPath) return null;
	try {
		return (await stat(targetPath)).mtimeMs;
	} catch {
		return null;
	}
}

async function getAsyncRunHeartbeatAt(asyncDir: string): Promise<number | null> {
	const snapshot = await readAsyncRunSnapshot(asyncDir);
	if (!snapshot) return null;
	const candidates = [
		snapshot.lastUpdate,
		await readPathMtime(path.join(asyncDir, "events.jsonl")),
		await readPathMtime(snapshot.outputFile),
	].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	return candidates.length > 0 ? Math.max(...candidates) : null;
}

function formatInactivity(durationMs: number): string {
	if (durationMs < 60_000) return `${Math.max(1, Math.floor(durationMs / 1000))}s`;
	return `${Math.max(1, Math.floor(durationMs / 60_000))}m`;
}

function stopWatchdog(): void {
	if (!watchdogTimer) return;
	clearInterval(watchdogTimer);
	watchdogTimer = null;
}

function ensureWatchdog(pi: ExtensionAPI): void {
	if (watchdogTimer || !activeRun) return;
	watchdogTimer = setInterval(() => {
		void watchdogTick(pi);
	}, WATCHDOG_POLL_MS);
	watchdogTimer.unref?.();
}

async function watchdogTick(pi: ExtensionAPI): Promise<void> {
	const run = activeRun;
	if (!run) {
		stopWatchdog();
		return;
	}
	if (run.awaitingVerification) return;

	const runningKnownRun = await findRunningKnownAsyncRun(run);
	if (!runningKnownRun?.dir) return;
	if (run.activeAsyncId !== runningKnownRun.id || run.activeAsyncDir !== runningKnownRun.dir) {
		run.activeAsyncId = runningKnownRun.id;
		run.activeAsyncDir = runningKnownRun.dir;
	}

	const snapshot = await readAsyncRunSnapshot(runningKnownRun.dir);
	if (!snapshot || (snapshot.state !== "queued" && snapshot.state !== "running")) return;

	const heartbeatAt = await getAsyncRunHeartbeatAt(runningKnownRun.dir);
	if (heartbeatAt === null) return;

	const inactiveForMs = Date.now() - heartbeatAt;
	if (inactiveForMs < WATCHDOG_INACTIVE_TIMEOUT_MS) return;

	const stoppedWorkers = await stopKnownAsyncRuns(run, WATCHDOG_STOP_REASON);
	if (stoppedWorkers <= 0) return;

	run.phase = "working";
	run.awaitingVerification = false;
	run.verificationReminderSent = false;
	run.activeAsyncId = null;
	run.activeAsyncDir = null;
	run.latestAsyncId = runningKnownRun.id;
	run.latestAsyncDir = runningKnownRun.dir;
	run.lastEvent = `Worker [${runningKnownRun.id.slice(0, 6)}] inactive for ${formatInactivity(inactiveForMs)}; replacement requested`;
	refreshStatus();
	if (latestCtx?.hasUI) {
		latestCtx.ui.notify(
			`Goal-Driven worker ${runningKnownRun.id.slice(0, 6)} was inactive for ${formatInactivity(inactiveForMs)}. Stopped it and requested a replacement worker.`,
			"warning",
		);
	}
	sendGoalDrivenFollowUp(
		pi,
		"The previous worker became inactive and was stopped by the Goal-Driven watchdog. Launch exactly one replacement worker subagent with agent: \"worker\", async: true, and clarify: false, then stop.",
	);
}

function sendGoalDrivenFollowUp(pi: ExtensionAPI, content: string): void {
	pi.sendMessage(
		{
			customType: EXTENSION_NAME,
			content,
			display: false,
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

function sanitizePathSegment(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "workspace";
}

function promptPathForCwd(cwd: string): string {
	return path.join(GLOBAL_PROMPTS_DIR, sanitizePathSegment(cwd), "latest-prompt.md");
}

async function loadTemplate(): Promise<string> {
	return readFile(TEMPLATE_PATH, "utf8");
}

function fillTemplate(template: string, goal: string, criteria: string): string {
	return template
		.replace(GOAL_PLACEHOLDER, goal.trim())
		.replace(CRITERIA_PLACEHOLDER, criteria.trim());
}

function parsePromptSections(prompt: string): { goal: string; criteria: string } {
	const goalMatch = prompt.match(/\nGoal:\s*([\s\S]*?)\n\nCriteria for success:/i);
	const criteriaMatch = prompt.match(/\nCriteria for success:\s*([\s\S]*?)\n\nHere is the System:/i);
	return {
		goal: normalizeGoal(goalMatch?.[1] ?? ""),
		criteria: normalizeCriteria(criteriaMatch?.[1] ?? ""),
	};
}

async function savePrompt(cwd: string, prompt: string): Promise<string> {
	const targetPath = promptPathForCwd(cwd);
	await ensureDir(path.dirname(targetPath));
	await writeFile(targetPath, `${prompt.trim()}\n`, "utf8");
	return targetPath;
}

async function loadSavedPrompt(cwd: string): Promise<string | null> {
	const targetPath = promptPathForCwd(cwd);
	if (!(await pathExists(targetPath))) return null;
	return (await readFile(targetPath, "utf8")).trim() || null;
}

function extractPromptBlock(text: string): string | null {
	const start = text.indexOf(PROMPT_START);
	if (start === -1) return null;
	const end = text.indexOf(PROMPT_END, start + PROMPT_START.length);
	if (end === -1) return null;
	const prompt = text.slice(start + PROMPT_START.length, end).trim();
	return prompt || null;
}

function refreshStatus(): void {
	if (!latestCtx?.hasUI) return;
	if (activeBrainstorm) {
		latestCtx.ui.setStatus(COMMAND_NAME, `goal-driven:brainstorm ${singleLine(activeBrainstorm.lastEvent, 60)}`);
		return;
	}
	if (activeRun) {
		latestCtx.ui.setStatus(
			COMMAND_NAME,
			`goal-driven:${activeRun.phase} #${activeRun.attempt || 0} ${singleLine(activeRun.lastEvent, 60)}`,
		);
		return;
	}
	latestCtx.ui.setStatus(COMMAND_NAME, undefined);
}

function clearBrainstorm(): void {
	activeBrainstorm = null;
	refreshStatus();
}

function clearRun(): void {
	activeRun = null;
	stopWatchdog();
	refreshStatus();
}

function sendSessionUserMessage(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	text: string,
	mode: "schedule" | "followUp" = "followUp",
): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(text);
		return;
	}

	if (mode === "followUp") {
		pi.sendUserMessage(text, { deliverAs: "followUp" });
		ctx.ui.notify("Queued Goal-Driven message after the current turn.", "info");
		return;
	}

	const trySend = () => {
		if (ctx.isIdle()) {
			pi.sendUserMessage(text);
			return;
		}
		setTimeout(trySend, 25);
	};
	setTimeout(trySend, 0);
	ctx.ui.notify("Scheduled Goal-Driven message to start as soon as the current command finishes.", "info");
}

function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

function renderWizardTabs(theme: Theme, step: number): string {
	const labels = ["1 Goal", "2 Criteria", "3 Review"];
	return labels
		.map((label, index) =>
			index === step
				? theme.bg("selectedBg", theme.fg("text", ` ${label} `))
				: theme.fg("muted", ` ${label} `),
		)
		.join(theme.fg("dim", " › "));
}

async function collectGoalDrivenPromptFallback(
	ctx: ExtensionCommandContext,
	template: string,
): Promise<string | null> {
	const goal = normalizeGoal(
		(await ctx.ui.editor(
			"Goal",
			"Describe the final outcome the master/subagent system should achieve.",
		)) ?? "",
	);
	if (!goal) return null;

	const criteria = normalizeCriteria(
		(await ctx.ui.editor(
			"Criteria for Success",
			"List the observable checks that prove the goal is done.",
		)) ?? "",
	);
	if (!criteria) return null;

	const draftPrompt = fillTemplate(template, goal, criteria);
	const reviewedPrompt = (await ctx.ui.editor("Review Goal-Driven prompt", draftPrompt))?.trim();
	if (!reviewedPrompt) return null;
	if (hasUnfilledPlaceholders(reviewedPrompt)) {
		ctx.ui.notify("The reviewed prompt still contains unfilled placeholders. Edit it again or cancel.", "warning");
		return null;
	}

	return reviewedPrompt;
}

async function collectGoalDrivenPrompt(ctx: ExtensionCommandContext): Promise<string | null> {
	const template = await loadTemplate();
	const customResult = await ctx.ui.custom<string | null>(
		(tui, theme, _keybindings, done) => {
			const editorTheme = createEditorTheme(theme);
			const goalEditor = new Editor(tui, editorTheme);
			const criteriaEditor = new Editor(tui, editorTheme);
			const reviewEditor = new Editor(tui, editorTheme);
			let step = 0;
			let cachedLines: string[] | undefined;
			let errorMessage: string | undefined;
			let reviewNeedsRefresh = true;

			const clearError = () => {
				errorMessage = undefined;
				cachedLines = undefined;
			};

			const markInputsChanged = () => {
				reviewNeedsRefresh = true;
				clearError();
			};

			goalEditor.onChange = markInputsChanged;
			criteriaEditor.onChange = markInputsChanged;
			reviewEditor.onChange = clearError;

			const currentGoal = () => normalizeGoal(goalEditor.getText());
			const currentCriteria = () => normalizeCriteria(criteriaEditor.getText());

			const syncReviewEditor = () => {
				if (!reviewNeedsRefresh) return;
				reviewEditor.setText(fillTemplate(template, currentGoal(), currentCriteria()));
				reviewNeedsRefresh = false;
			};

			const setFocus = () => {
				goalEditor.focused = step === 0;
				criteriaEditor.focused = step === 1;
				reviewEditor.focused = step === 2;
			};

			const refresh = () => {
				if (step === 2) syncReviewEditor();
				setFocus();
				cachedLines = undefined;
				tui.requestRender();
			};

			const goToStep = (nextStep: number) => {
				step = nextStep;
				errorMessage = undefined;
				refresh();
			};

			goalEditor.onSubmit = (value) => {
				if (!normalizeGoal(value)) {
					errorMessage = "Goal is required.";
					refresh();
					return;
				}
				goToStep(1);
			};

			criteriaEditor.onSubmit = (value) => {
				if (!normalizeCriteria(value)) {
					errorMessage = "Criteria for Success is required.";
					refresh();
					return;
				}
				goToStep(2);
			};

			reviewEditor.onSubmit = (value) => {
				const prompt = value.trim();
				if (!prompt) {
					errorMessage = "Prompt cannot be empty.";
					refresh();
					return;
				}
				if (hasUnfilledPlaceholders(prompt)) {
					errorMessage = "Remove all placeholders before saving.";
					refresh();
					return;
				}
				done(prompt);
			};

			const activeEditor = () => (step === 0 ? goalEditor : step === 1 ? criteriaEditor : reviewEditor);

			const handleBack = () => {
				if (step === 0) {
					done(null);
					return;
				}
				goToStep(step - 1);
			};

			const renderStepBody = (width: number): string[] => {
				const editorWidth = Math.max(24, width - 2);
				const lines: string[] = [];
				const add = (text = "") => lines.push(truncateToWidth(text, width));

				if (step === 0) {
					add(theme.fg("accent", theme.bold("Goal")));
					add(theme.fg("muted", "Describe the final outcome the master/subagent system should achieve."));
					add();
					for (const line of goalEditor.render(editorWidth)) add(` ${line}`);
					return lines;
				}

				if (step === 1) {
					add(theme.fg("accent", theme.bold("Criteria for Success")));
					add(theme.fg("muted", "List the observable checks that prove the goal is done."));
					add();
					for (const line of criteriaEditor.render(editorWidth)) add(` ${line}`);
					return lines;
				}

				syncReviewEditor();
				add(theme.fg("accent", theme.bold("Review Goal-Driven prompt")));
				add(theme.fg("muted", `Goal: ${singleLine(currentGoal(), 100) || "(empty)"}`));
				add(theme.fg("muted", `Criteria: ${singleLine(currentCriteria(), 100) || "(empty)"}`));
				add();
				for (const line of reviewEditor.render(editorWidth)) add(` ${line}`);
				return lines;
			};

			refresh();

			return {
				render(width: number): string[] {
					if (cachedLines) return cachedLines;
					if (step === 2) syncReviewEditor();
					setFocus();

					const lines: string[] = [];
					const add = (text = "") => lines.push(truncateToWidth(text, width));

					add(theme.fg("accent", "─".repeat(width)));
					add(theme.fg("accent", theme.bold(" Goal-Driven Wizard")));
					add(renderWizardTabs(theme, step));
					add();
					lines.push(...renderStepBody(width));
					add();
					if (errorMessage) add(theme.fg("warning", errorMessage));
					const help = step === 0
						? "Enter continue • Shift+Enter newline • Esc cancel"
						: step === 1
							? "Enter continue • Shift+Enter newline • Esc back"
							: "Enter save • Shift+Enter newline • Esc back";
					add(theme.fg("dim", help));
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				},
				invalidate(): void {
					cachedLines = undefined;
				},
				handleInput(data: string): void {
					if (matchesKey(data, Key.escape)) {
						handleBack();
						return;
					}

					activeEditor().handleInput(data);
					cachedLines = undefined;
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "92%",
				maxHeight: "88%",
				margin: 1,
			},
		},
	);

	if (customResult !== undefined) return customResult;
	return collectGoalDrivenPromptFallback(ctx, template);
}

function buildBrainstormSystemPrompt(template: string): string {
	return `You are running /${BRAINSTORM_COMMAND_NAME}.

Your only job is to help the user fill the Goal-Driven template through normal conversation.

Rules:
- Do not execute the prompt.
- Do not call subagent.
- Do not edit files.
- Ask at most one focused question at a time, and only when it materially improves Goal or Criteria for Success.
- If the task is already clear, skip questions and draft the prompt immediately.
- Whenever you have enough information, return the completed prompt between the exact markers:
${PROMPT_START}
<completed prompt>
${PROMPT_END}
- If the user asks for revisions, update the prompt and return a fresh completed version with the same markers.
- Always finish with: Run /${WORK_COMMAND_NAME} to execute it.
- The completed prompt must not contain placeholder brackets.

Template:
${template}`;
}

function buildRunSystemPrompt(run: ActiveRun): string {
	const phaseInstruction = run.awaitingVerification
		? `The latest worker subagent attempt has completed. You must verify the workspace and evidence now.`
		: run.activeAsyncId
			? `Worker subagent attempt #${run.attempt} is still running in background (async id: ${run.activeAsyncId}). Do not verify yet. Wait for the completion notification before acting again.`
			: `Launch exactly one worker subagent attempt to continue the run.`;

	return `You are inside an active /${WORK_COMMAND_NAME} Goal-Driven run.

You are the master agent. The worker subagent does implementation work, but the master agent does all verification itself.

Current run state:
- Attempt count so far: ${run.attempt}
- Phase: ${run.phase}
- Active async worker id: ${run.activeAsyncId ?? "none"}
- Goal:
${run.goal || "(see saved prompt in conversation)"}
- Criteria for Success:
${run.criteria || "(see saved prompt in conversation)"}

Rules:
- Never create a separate verifier subagent.
- Use only worker subagents for implementation work.
- When calling the subagent tool, set agent: "worker" exactly.
- Do not invent alternate agent names or use descriptive labels in place of the actual agent name.
- Every worker subagent call must run in background with async: true and clarify: false.
- An async launch result only means the worker started. It is NOT proof that the task finished.
- While a worker subagent is running in background, do not verify and do not launch another worker.
- After a worker completion notification arrives, the master agent must verify the result itself against the Criteria for Success.
- Treat any unmet or unproven criterion as NOT met.
- Before ending a message after a worker completion, do exactly one of these:
  1. If all criteria are fully satisfied and proven, include the exact line:
     ${MASTER_MET_VERDICT}
     Then summarize the evidence and do not call subagent again.
  2. If any criterion is unmet or unproven, create exactly one new worker subagent call to continue the work before ending the message.
- After launching a background worker, end the message and wait for completion. Do not verify immediately after launch.
- Do not stop early because the result looks "mostly done".
- Do not end a verification message without either launching one new worker subagent or emitting ${MASTER_MET_VERDICT}.

Immediate instruction:
${phaseInstruction}`;
}

function buildVerificationReminder(run: ActiveRun): string {
	return [
		`Master verification is still required for the active Goal-Driven run.`,
		`Goal:\n${run.goal || "(see saved prompt above)"}`,
		`Criteria for Success:\n${run.criteria || "(see saved prompt above)"}`,
		`Use the latest completed worker subagent result already present in the conversation.`,
		`Before ending your next message, do exactly one of the following:`,
		`1. If every criterion is fully satisfied and proven, output the exact line: ${MASTER_MET_VERDICT}`,
		`2. Otherwise create exactly one new worker subagent call with agent: "worker", async: true, and clarify: false to continue the work.`,
		`Do not create a verifier subagent and do not substitute any other name for the worker agent.`,
	].join("\n\n");
}

async function startBrainstorm(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	if (activeBrainstorm || activeRun) {
		ctx.ui.notify(`A Goal-Driven flow is already active. Run /${COMMAND_NAME} stop first if you want to replace it.`, "warning");
		return;
	}

	const template = await loadTemplate();
	activeBrainstorm = {
		cwd: ctx.cwd,
		lastEvent: "Brainstorming Goal and Criteria for Success",
		template,
	};
	refreshStatus();

	const request = args.trim()
		? `Start /${BRAINSTORM_COMMAND_NAME} for this task:\n\n${args.trim()}`
		: `Start /${BRAINSTORM_COMMAND_NAME}. Help me fill the Goal-Driven template through conversation. Ask the first focused question only if you need more information.`;

	sendSessionUserMessage(pi, ctx, request);
	ctx.ui.notify(
		`Started /${BRAINSTORM_COMMAND_NAME}. Refine the template in chat, then run /${WORK_COMMAND_NAME} when the prompt is ready.`,
		"info",
	);
}

async function runSavedPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (activeRun || activeBrainstorm) {
		ctx.ui.notify(`A Goal-Driven flow is already active. Run /${COMMAND_NAME} stop first if you want to replace it.`, "warning");
		return;
	}

	const savedPrompt = await loadSavedPrompt(ctx.cwd);
	if (!savedPrompt) {
		ctx.ui.notify(
			`No saved Goal-Driven prompt found for this workspace. Run /${COMMAND_NAME} or /${BRAINSTORM_COMMAND_NAME} first.`,
			"warning",
		);
		return;
	}

	const parsed = parsePromptSections(savedPrompt);
	activeRun = {
		cwd: ctx.cwd,
		goal: parsed.goal,
		criteria: parsed.criteria,
		attempt: 0,
		phase: "working",
		awaitingVerification: false,
		verificationReminders: 0,
		verificationReminderSent: false,
		activeAsyncId: null,
		activeAsyncDir: null,
		latestAsyncId: null,
		latestAsyncDir: null,
		knownAsyncRuns: [],
		lastEvent: "Launching master/subagent run",
	};
	refreshStatus();
	ensureWatchdog(pi);

	if (!hasTool(pi, "subagent")) {
		ctx.ui.notify(
			"subagent tool not found. /goal-driven:work can still send the prompt, but the run cannot execute as intended without subagent.",
			"warning",
		);
	} else {
		ensureToolActive(pi, "subagent");
	}

	sendSessionUserMessage(pi, ctx, savedPrompt, "schedule");
	ctx.ui.notify(
		"Started Goal-Driven run. Worker subagents will run in background, show in the async widget, and only trigger master verification after completion.",
		"info",
	);
}

async function stopActiveFlow(ctx: ExtensionCommandContext): Promise<void> {
	const hadBrainstorm = Boolean(activeBrainstorm);
	const runToStop = activeRun;
	const hadRun = Boolean(runToStop);
	const stoppedWorkers = runToStop ? await stopKnownAsyncRuns(runToStop) : 0;
	clearBrainstorm();
	clearRun();
	if (!ctx.isIdle()) ctx.abort();
	if (!hadBrainstorm && !hadRun) {
		ctx.ui.notify("No Goal-Driven flow is active.", "info");
		return;
	}
	ctx.ui.notify(
		stoppedWorkers > 0
			? `Stopped the active Goal-Driven flow and sent SIGTERM to ${stoppedWorkers} background ${pluralize(stoppedWorkers, "worker")}.`
			: "Stopped the active Goal-Driven flow.",
		"info",
	);
}

export default function goalDriven(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		refreshStatus();
	});

	pi.on("session_shutdown", async () => {
		activeBrainstorm = null;
		activeRun = null;
		stopWatchdog();
		latestCtx = null;
	});

	pi.on("before_agent_start", async (event) => {
		if (activeBrainstorm) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${buildBrainstormSystemPrompt(activeBrainstorm.template)}`,
			};
		}
		if (activeRun) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${buildRunSystemPrompt(activeRun)}`,
			};
		}
	});

	pi.on("tool_call", async (event) => {
		if (!activeRun || event.toolName !== "subagent") return;
		if (!isSubagentExecutionInput(event.input)) return;

		const runningKnownRun = await findRunningKnownAsyncRun(activeRun);
		if (runningKnownRun) {
			activeRun.phase = "working";
			activeRun.awaitingVerification = false;
			activeRun.verificationReminderSent = false;
			activeRun.activeAsyncId = runningKnownRun.id;
			activeRun.activeAsyncDir = runningKnownRun.dir;
			activeRun.lastEvent = `Recovered still-running worker [${runningKnownRun.id.slice(0, 6)}]`;
			refreshStatus();
			return { block: true, reason: `Goal-Driven worker ${runningKnownRun.id} is still running in background.` };
		}

		activeRun.activeAsyncId = null;
		activeRun.activeAsyncDir = null;
		forceGoalDrivenSubagentExecution(event.input);
		activeRun.attempt += 1;
		activeRun.phase = "working";
		activeRun.awaitingVerification = false;
		activeRun.verificationReminderSent = false;
		activeRun.lastEvent = `Worker subagent attempt #${activeRun.attempt} launching in background`;
		refreshStatus();
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (!activeRun || event.toolName !== "subagent") return;
		if (!isSubagentExecutionInput(event.input)) return;
		const launch = getSubagentAsyncLaunch(event.details);
		if (!launch.asyncId) {
			activeRun.phase = "working";
			activeRun.awaitingVerification = false;
			activeRun.verificationReminderSent = false;
			activeRun.activeAsyncId = null;
			activeRun.activeAsyncDir = null;
			activeRun.lastEvent = `Worker subagent attempt #${Math.max(activeRun.attempt, 1)} failed to launch in async mode`;
			refreshStatus();
			sendGoalDrivenFollowUp(
				pi,
				"The previous worker did not launch in async mode. Launch exactly one replacement worker subagent with async: true and clarify: false, then stop.",
			);
			return;
		}
		trackKnownAsyncRun(activeRun, launch.asyncId, launch.asyncDir);
		activeRun.phase = "working";
		activeRun.awaitingVerification = false;
		activeRun.verificationReminderSent = false;
		activeRun.activeAsyncId = launch.asyncId;
		activeRun.activeAsyncDir = launch.asyncDir;
		activeRun.lastEvent = `Worker subagent attempt #${Math.max(activeRun.attempt, 1)} running in background [${launch.asyncId.slice(0, 6)}]`;
		refreshStatus();
		ensureWatchdog(pi);
	});

	pi.events.on("subagent:complete", (data: unknown) => {
		if (!activeRun) return;
		const result = data as { id?: string; success?: boolean; asyncDir?: string; summary?: string };
		if (!result.id) return;
		const matchesActive = result.id === activeRun.activeAsyncId;
		const matchesLatest = result.id === activeRun.latestAsyncId;
		if (!matchesActive && !matchesLatest) return;
		activeRun.phase = "verifying";
		activeRun.awaitingVerification = true;
		activeRun.verificationReminders = 0;
		activeRun.verificationReminderSent = false;
		activeRun.activeAsyncId = null;
		activeRun.activeAsyncDir = result.asyncDir ?? activeRun.latestAsyncDir ?? activeRun.activeAsyncDir;
		activeRun.latestAsyncId = result.id;
		activeRun.latestAsyncDir = result.asyncDir ?? activeRun.latestAsyncDir;
		activeRun.lastEvent = `Worker subagent attempt #${Math.max(activeRun.attempt, 1)} ${result.success === false ? "failed" : "completed"}; master verifying`;
		refreshStatus();
		pi.sendMessage(
			{
				customType: EXTENSION_NAME,
				content: [
					`Goal-Driven worker attempt #${Math.max(activeRun.attempt, 1)} ${result.success === false ? "failed" : "completed"}.`,
					result.summary ? "" : undefined,
					result.summary,
				].filter((line) => line !== undefined).join("\n"),
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	pi.on("message_update", async (event) => {
		if (!activeBrainstorm || !isAssistantMessage(event.message)) return;
		const text = getAssistantText(event.message).trim();
		if (!text) return;
		activeBrainstorm.lastEvent = text.includes(PROMPT_START)
			? "Drafted a Goal-Driven prompt"
			: singleLine(text, 100);
		refreshStatus();
	});

	pi.on("message_end", async (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;
		const text = getAssistantText(event.message);

		if (activeBrainstorm) {
			if (text.trim()) {
				activeBrainstorm.lastEvent = text.includes(PROMPT_START)
					? "Drafted a Goal-Driven prompt"
					: singleLine(text, 100);
			}

			const prompt = extractPromptBlock(text);
			if (!prompt) {
				refreshStatus();
				return;
			}

			if (hasUnfilledPlaceholders(prompt)) {
				ctx.ui.notify(
					"The generated prompt still contains unfilled placeholders. Continue the conversation or regenerate it.",
					"warning",
				);
				refreshStatus();
				return;
			}

			const savePath = await savePrompt(activeBrainstorm.cwd, prompt);
			clearBrainstorm();
			ctx.ui.notify(
				`Saved the completed Goal-Driven prompt to ${savePath}. Run /${WORK_COMMAND_NAME} to execute it.`,
				"info",
			);
			return;
		}

		if (!activeRun) return;

		if (hasMetVerdict(text)) {
			const completedRun = activeRun;
			const stoppedWorkers = await stopKnownAsyncRuns(completedRun);
			clearRun();
			ctx.ui.notify(
				stoppedWorkers > 0
					? `Goal-Driven run met criteria after ${completedRun.attempt} ${pluralize(completedRun.attempt, "worker attempt")} and stopped ${stoppedWorkers} stale background ${pluralize(stoppedWorkers, "worker")}.`
					: `Goal-Driven run met criteria after ${completedRun.attempt} ${pluralize(completedRun.attempt, "worker attempt")}.`,
				"info",
			);
			return;
		}

		if (!activeRun.awaitingVerification) return;

		const runningKnownRun = await findRunningKnownAsyncRun(activeRun);
		if (runningKnownRun) {
			activeRun.awaitingVerification = false;
			activeRun.verificationReminderSent = false;
			activeRun.phase = "working";
			activeRun.activeAsyncId = runningKnownRun.id;
			activeRun.activeAsyncDir = runningKnownRun.dir;
			activeRun.lastEvent = `Recovered still-running worker [${runningKnownRun.id.slice(0, 6)}]`;
			refreshStatus();
			return;
		}

		if (assistantMessageHasSubagentExecutionCall(event.message)) {
			activeRun.awaitingVerification = false;
			activeRun.verificationReminderSent = false;
			activeRun.phase = "working";
			activeRun.lastEvent = `Master requested another worker attempt after verification`;
			refreshStatus();
			return;
		}

		activeRun.verificationReminders += 1;
		activeRun.lastEvent = `Master verification incomplete; reminder #${activeRun.verificationReminders}`;
		refreshStatus();
		if (activeRun.verificationReminderSent) return;
		activeRun.verificationReminderSent = true;
		sendGoalDrivenFollowUp(pi, buildVerificationReminder(activeRun));
	});

	pi.registerCommand(BRAINSTORM_COMMAND_NAME, {
		description: "Fill the Goal-Driven template through normal conversation, then save the prompt",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			await startBrainstorm(pi, ctx, args);
		},
	});

	pi.registerCommand(WORK_COMMAND_NAME, {
		description: "Execute the latest saved Goal-Driven prompt in the current session",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			await runSavedPrompt(pi, ctx);
		},
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Collect Goal and Criteria for Success locally, or run Goal-Driven shortcuts",
		getArgumentCompletions(prefix) {
			return ["brainstorm", "work", "stop"]
				.filter((item) => item.startsWith(prefix))
				.map((item) => ({ value: item, label: item }));
		},
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const action = args.trim().toLowerCase();

			if (action === "brainstorm") {
				await startBrainstorm(pi, ctx, "");
				return;
			}

			if (action === "work") {
				await runSavedPrompt(pi, ctx);
				return;
			}

			if (action === "stop") {
				await stopActiveFlow(ctx);
				return;
			}

			if (action.length > 0) {
				ctx.ui.notify(`Usage: ${USAGE_TEXT}`, "warning");
				return;
			}

			if (activeRun || activeBrainstorm) {
				ctx.ui.notify(`A Goal-Driven flow is already active. Run /${COMMAND_NAME} stop first if you want to replace it.`, "warning");
				return;
			}

			const prompt = await collectGoalDrivenPrompt(ctx);
			if (!prompt) {
				ctx.ui.notify("Goal-Driven prompt collection cancelled.", "info");
				return;
			}

			const savePath = await savePrompt(ctx.cwd, prompt);
			ctx.ui.notify(
				`Saved the completed Goal-Driven prompt to ${savePath}. Run /${WORK_COMMAND_NAME} to execute it.`,
				"info",
			);
		},
	});
}
