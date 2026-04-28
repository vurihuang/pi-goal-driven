import { access, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
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
const GOAL_DRIVEN_ASYNC_RUN_ENTRY = `${EXTENSION_NAME}:async-run`;
const GOAL_DRIVEN_BUSY_STALL_ENTRY = `${EXTENSION_NAME}:busy-stall`;
const GOAL_DRIVEN_WORKER_TASK_GUARD = [
	"Goal-Driven worker execution rules:",
	"- Do the implementation work directly in this worker session.",
	"- Do not call the subagent tool.",
	"- Do not launch nested agents, chains, or parallel worker runs.",
	"- Do not run /goal-driven commands inside the worker session.",
	"- If you think delegation is needed, do the work yourself instead.",
].join("\n");
const GOAL_DRIVEN_ASYNC_RUNS_DIR = path.join(
	os.tmpdir(),
	`pi-subagents-uid-${typeof process.getuid === "function" ? process.getuid() : "unknown"}`,
	"async-subagent-runs",
);
const WATCHDOG_POLL_MS = 15_000;
const WATCHDOG_INACTIVE_PROBE_AFTER_MS = 5 * 60 * 1000;
const WATCHDOG_INACTIVE_GRACE_MS = 2 * 60 * 1000;
const WATCHDOG_INACTIVE_TIMEOUT_MS = 15 * 60 * 1000;
const WATCHDOG_STOP_REASON = "Stopped by Goal-Driven inactivity watchdog";
const WATCHDOG_STALE_RUNNING_STOP_REASON = "Stopped by Goal-Driven stale-running watchdog";
const WATCHDOG_INACTIVE_PROBE_STOP_REASON = "Stopped by Goal-Driven inactive heartbeat probe";
const WATCHDOG_BUSY_STALL_WARNING_MIN_AGE_MS = 10 * 60 * 1000;
const WATCHDOG_BUSY_STALL_STOP_MIN_AGE_MS = 30 * 60 * 1000;
const WATCHDOG_BUSY_STALL_WARNING_REPEAT_COUNT = 12;
const WATCHDOG_BUSY_STALL_STOP_REPEAT_COUNT = 30;
const WATCHDOG_BUSY_STALL_MAX_RECOVERIES = 2;
const WATCHDOG_BUSY_STALL_STOP_REASON = "Stopped by Goal-Driven busy-stall watchdog";
const ASYNC_TAIL_BYTES = 64 * 1024;

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
type AsyncRunStopOutcome = "stopped" | "already-finished" | "missing" | "error";
type BusyStallClassification = "healthy" | "possible-busy-stall" | "busy-stall";
type InactiveProbeStatus = "probe-pending" | "stale-running";
type InactiveProbeClassification = "active" | "probe-pending" | "stale-running" | "inactive-expired" | "unknown";

interface ActiveBrainstorm {
	cwd: string;
	lastEvent: string;
	template: string;
	userReplyCount: number;
	autoDraftNudgeSent: boolean;
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

interface GoalDrivenAsyncRunEntry {
	sessionId: string;
	sessionFile: string | null;
	asyncId: string;
	asyncDir: string | null;
	cwd: string;
}

interface AsyncRunStopResult {
	id: string;
	outcome: AsyncRunStopOutcome;
	previousState: AsyncRunState | null;
	pid: number | null;
	error?: string;
}

interface AsyncRunCleanupSummary {
	stopped: number;
	alreadyFinished: number;
	missing: number;
	errors: number;
	results: AsyncRunStopResult[];
}

interface ScopedAsyncRunStatus {
	id: string;
	state: AsyncRunState;
	mode: string | null;
	currentStep: number | null;
	totalSteps: number;
	cwd: string | null;
	startedAt: number | null;
	busyStall?: BusyStallClassification;
	busyStallReason?: string;
	steps: Array<{
		agent: string;
		status: string;
	}>;
}

interface AsyncRunBusyStallInspection {
	id: string;
	asyncDir: string;
	state: AsyncRunState | null;
	pid: number | null;
	cwd: string | null;
	startedAt: number | null;
	elapsedMs: number | null;
	recentToolSignatures: string[];
	recentOutputLines: string[];
	evidence: string[];
}

interface BusyStallDiagnostic {
	classification: BusyStallClassification;
	reason: string;
	repeatedSignature: string | null;
	repeatCount: number;
	evidence: string[];
}

interface InactiveProbeState {
	asyncId: string;
	firstInactiveAt: number;
	lastHeartbeatAt: number;
	graceUntil: number;
	pid: number | null;
	status: InactiveProbeStatus;
}

interface InactiveProbeResult {
	classification: InactiveProbeClassification;
	reason: string;
	probe?: InactiveProbeState;
	inactiveForMs?: number;
}

interface GoalDrivenBusyStallEntry {
	sessionId: string;
	sessionFile: string | null;
	asyncId: string;
	asyncDir: string;
	pid: number | null;
	cwd: string | null;
	elapsedMs: number | null;
	classification: BusyStallClassification;
	reason: string;
	repeatedSignature: string | null;
	repeatCount: number;
	evidence: string[];
	stoppedAt: number;
	recoveryCount: number;
	replacementRequested: boolean;
}

type SessionManagerView = ExtensionContext["sessionManager"];

interface ActiveRun {
	cwd: string;
	sessionId: string;
	sessionFile: string | null;
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
	busyStallRecoveries: number;
	inactiveProbe: InactiveProbeState | null;
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

function prependWorkerTaskGuard(task: unknown): unknown {
	if (typeof task !== "string") return task;
	if (task.includes(GOAL_DRIVEN_WORKER_TASK_GUARD)) return task;
	return `${GOAL_DRIVEN_WORKER_TASK_GUARD}\n\n${task}`;
}

function forceGoalDrivenSubagentExecution(input: unknown): void {
	if (!input || typeof input !== "object") return;
	const candidate = input as Record<string, unknown>;
	candidate.async = true;
	candidate.clarify = false;

	if (typeof candidate.agent === "string") {
		candidate.agent = GOAL_DRIVEN_WORKER_AGENT;
		candidate.task = prependWorkerTaskGuard(candidate.task);
	}

	if (Array.isArray(candidate.tasks)) {
		for (const task of candidate.tasks) {
			if (!task || typeof task !== "object") continue;
			const taskInput = task as Record<string, unknown>;
			taskInput.agent = GOAL_DRIVEN_WORKER_AGENT;
			taskInput.task = prependWorkerTaskGuard(taskInput.task);
		}
	}

	if (!Array.isArray(candidate.chain)) return;
	for (const step of candidate.chain) {
		if (!step || typeof step !== "object") continue;
		const chainStep = step as Record<string, unknown>;
		if (typeof chainStep.agent === "string") {
			chainStep.agent = GOAL_DRIVEN_WORKER_AGENT;
			chainStep.task = prependWorkerTaskGuard(chainStep.task);
		}
		if (!Array.isArray(chainStep.parallel)) continue;
		for (const parallelStep of chainStep.parallel) {
			if (!parallelStep || typeof parallelStep !== "object") continue;
			const parallelInput = parallelStep as Record<string, unknown>;
			parallelInput.agent = GOAL_DRIVEN_WORKER_AGENT;
			parallelInput.task = prependWorkerTaskGuard(parallelInput.task);
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

function getSessionRef(ctx: ExtensionContext): { sessionId: string; sessionFile: string | null } {
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile() ?? null,
	};
}

function matchesSessionRef(
	entry: Pick<GoalDrivenAsyncRunEntry, "sessionId" | "sessionFile">,
	sessionId: string,
	sessionFile: string | null,
): boolean {
	if (entry.sessionId === sessionId) return true;
	return Boolean(sessionFile && entry.sessionFile && entry.sessionFile === sessionFile);
}

function collectPersistedKnownAsyncRuns(
	sessionManager: SessionManagerView,
	sessionId: string,
	sessionFile: string | null,
): KnownAsyncRun[] {
	const knownRuns = new Map<string, KnownAsyncRun>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== GOAL_DRIVEN_ASYNC_RUN_ENTRY) continue;
		const data = entry.data as Partial<GoalDrivenAsyncRunEntry> | undefined;
		if (!data || typeof data.asyncId !== "string") continue;
		const persistedRun: GoalDrivenAsyncRunEntry = {
			sessionId: typeof data.sessionId === "string" ? data.sessionId : "",
			sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : null,
			asyncId: data.asyncId,
			asyncDir: typeof data.asyncDir === "string" ? data.asyncDir : null,
			cwd: typeof data.cwd === "string" ? data.cwd : "",
		};
		if (!matchesSessionRef(persistedRun, sessionId, sessionFile)) continue;
		const existing = knownRuns.get(persistedRun.asyncId);
		if (existing) {
			if (!existing.dir && persistedRun.asyncDir) existing.dir = persistedRun.asyncDir;
			continue;
		}
		knownRuns.set(persistedRun.asyncId, {
			id: persistedRun.asyncId,
			dir: persistedRun.asyncDir,
		});
	}
	return [...knownRuns.values()];
}

function mergeKnownAsyncRuns(run: ActiveRun, knownAsyncRuns: KnownAsyncRun[]): void {
	for (const knownRun of knownAsyncRuns) {
		const existing = run.knownAsyncRuns.find((candidate) => candidate.id === knownRun.id);
		if (existing) {
			if (!existing.dir && knownRun.dir) existing.dir = knownRun.dir;
			continue;
		}
		run.knownAsyncRuns.push({ ...knownRun });
	}
}

async function hydrateKnownAsyncRuns(run: ActiveRun, sessionManager: SessionManagerView | null | undefined): Promise<void> {
	if (!sessionManager) return;
	mergeKnownAsyncRuns(run, collectPersistedKnownAsyncRuns(sessionManager, run.sessionId, run.sessionFile));
}

function getAsyncRunsDir(knownAsyncRuns: KnownAsyncRun[] = []): string {
	const knownAsyncDir = knownAsyncRuns.find((knownRun) => knownRun.dir)?.dir;
	return knownAsyncDir ? path.dirname(knownAsyncDir) : GOAL_DRIVEN_ASYNC_RUNS_DIR;
}

function getSessionTreeRoot(sessionFile: string | null): string | null {
	if (!sessionFile) return null;
	return sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : null;
}

async function collectSessionTreeAsyncRunIds(sessionTreeRoot: string | null): Promise<string[]> {
	if (!sessionTreeRoot) return [];
	const asyncIds = new Set<string>();

	const walk = async (currentDir: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(currentDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			const nextDir = path.join(currentDir, entry.name);
			if (entry.name.startsWith("async-")) {
				const asyncId = entry.name.slice("async-".length);
				if (asyncId) asyncIds.add(asyncId);
				continue;
			}
			await walk(nextDir);
		}
	};

	await walk(sessionTreeRoot);
	return [...asyncIds];
}

async function stopAsyncRunById(asyncId: string, reason: string, asyncRunsDir: string): Promise<AsyncRunStopResult> {
	const statusPath = path.join(asyncRunsDir, asyncId, "status.json");
	try {
		const raw = await readFile(statusPath, "utf8");
		const candidate = JSON.parse(raw) as {
			state?: string;
			pid?: number;
			lastUpdate?: number;
			endedAt?: number;
			error?: string;
			steps?: Array<Record<string, unknown>>;
		};
		const previousState = candidate.state === "queued"
			|| candidate.state === "running"
			|| candidate.state === "complete"
			|| candidate.state === "failed"
			? candidate.state
			: null;
		const pid = typeof candidate.pid === "number" ? candidate.pid : null;
		if (previousState !== "queued" && previousState !== "running") {
			return { id: asyncId, outcome: "already-finished", previousState, pid };
		}

		const stoppedAt = Date.now();
		if (pid !== null) {
			try {
				process.kill(pid, "SIGTERM");
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
		return { id: asyncId, outcome: "stopped", previousState, pid };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("ENOENT")) {
			return { id: asyncId, outcome: "missing", previousState: null, pid: null };
		}
		return { id: asyncId, outcome: "error", previousState: null, pid: null, error: message };
	}
}

function summarizeAsyncRunCleanup(results: AsyncRunStopResult[]): AsyncRunCleanupSummary {
	return {
		stopped: results.filter((result) => result.outcome === "stopped").length,
		alreadyFinished: results.filter((result) => result.outcome === "already-finished").length,
		missing: results.filter((result) => result.outcome === "missing").length,
		errors: results.filter((result) => result.outcome === "error").length,
		results,
	};
}

async function stopAsyncRunsByIds(asyncIds: string[], reason: string, asyncRunsDir: string): Promise<AsyncRunCleanupSummary> {
	const uniqueIds = [...new Set(asyncIds.filter(Boolean))];
	const results: AsyncRunStopResult[] = [];
	for (const asyncId of uniqueIds) {
		results.push(await stopAsyncRunById(asyncId, reason, asyncRunsDir));
	}
	return summarizeAsyncRunCleanup(results);
}

async function stopSessionScopedAsyncRuns(
	sessionFile: string | null,
	knownAsyncRuns: KnownAsyncRun[],
	reason: string,
): Promise<AsyncRunCleanupSummary> {
	const asyncIds = new Set(knownAsyncRuns.map((knownRun) => knownRun.id));
	for (const asyncId of await collectSessionTreeAsyncRunIds(getSessionTreeRoot(sessionFile))) {
		asyncIds.add(asyncId);
	}
	return stopAsyncRunsByIds([...asyncIds], reason, getAsyncRunsDir(knownAsyncRuns));
}

function formatAsyncRunCleanupSummary(summary: AsyncRunCleanupSummary): string {
	const parts: string[] = [];
	if (summary.stopped > 0) parts.push(`stopped ${summary.stopped} running ${pluralize(summary.stopped, "worker")}`);
	if (summary.alreadyFinished > 0) parts.push(`${summary.alreadyFinished} already finished`);
	if (summary.missing > 0) parts.push(`${summary.missing} missing`);
	if (summary.errors > 0) parts.push(`${summary.errors} cleanup ${summary.errors === 1 ? "error" : "errors"}`);
	return parts.length > 0 ? parts.join(", ") : "no async workers found";
}

async function stopKnownAsyncRuns(run: ActiveRun, reason = "Stopped by /goal-driven stop"): Promise<number> {
	const summary = await stopAsyncRunsByIds(run.knownAsyncRuns.map((knownRun) => knownRun.id), reason, getAsyncRunsDir(run.knownAsyncRuns));
	return summary.stopped;
}

function shortenHomePath(targetPath: string | null): string {
	if (!targetPath) return "(cwd unknown)";
	const homeDir = os.homedir();
	return targetPath.startsWith(homeDir) ? `~${targetPath.slice(homeDir.length)}` : targetPath;
}

function isSubagentStatusListInput(input: Record<string, unknown>): boolean {
	return input.action === "list";
}

async function readScopedAsyncRunStatus(asyncId: string, asyncRunsDir: string): Promise<ScopedAsyncRunStatus | null> {
	try {
		const raw = await readFile(path.join(asyncRunsDir, asyncId, "status.json"), "utf8");
		const candidate = JSON.parse(raw) as {
			state?: string;
			mode?: string;
			currentStep?: number;
			cwd?: string;
			startedAt?: number;
			steps?: Array<{ agent?: string; status?: string }>;
		};
		if (
			candidate.state !== "queued"
			&& candidate.state !== "running"
			&& candidate.state !== "complete"
			&& candidate.state !== "failed"
		) {
			return null;
		}
		const steps = Array.isArray(candidate.steps)
			? candidate.steps.map((step) => ({
				agent: typeof step?.agent === "string" ? step.agent : "worker",
				status: typeof step?.status === "string" ? step.status : "unknown",
			}))
			: [];
		return {
			id: asyncId,
			state: candidate.state,
			mode: typeof candidate.mode === "string" ? candidate.mode : null,
			currentStep: typeof candidate.currentStep === "number" ? candidate.currentStep : null,
			totalSteps: steps.length,
			cwd: typeof candidate.cwd === "string" ? candidate.cwd : null,
			startedAt: typeof candidate.startedAt === "number" ? candidate.startedAt : null,
			steps,
		};
	} catch {
		return null;
	}
}

async function listSessionScopedActiveAsyncRuns(
	sessionFile: string | null,
	knownAsyncRuns: KnownAsyncRun[],
): Promise<ScopedAsyncRunStatus[]> {
	const asyncRunsDir = getAsyncRunsDir(knownAsyncRuns);
	const asyncIds = new Set(knownAsyncRuns.map((knownRun) => knownRun.id));
	for (const asyncId of await collectSessionTreeAsyncRunIds(getSessionTreeRoot(sessionFile))) {
		asyncIds.add(asyncId);
	}
	const runs: ScopedAsyncRunStatus[] = [];
	for (const asyncId of asyncIds) {
		const status = await readScopedAsyncRunStatus(asyncId, asyncRunsDir);
		if (!status) continue;
		if (status.state !== "queued" && status.state !== "running") continue;
		const inspection = await inspectAsyncRunForBusyStall(asyncId, path.join(asyncRunsDir, asyncId));
		if (inspection) {
			const diagnostic = classifyBusyStall(inspection);
			if (diagnostic.classification !== "healthy") {
				status.busyStall = diagnostic.classification;
				status.busyStallReason = diagnostic.reason;
			}
		}
		runs.push(status);
	}
	return runs.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
}

function formatScopedSubagentStatusList(runs: ScopedAsyncRunStatus[]): string {
	if (runs.length === 0) return "No active async runs in this Goal-Driven session tree.";
	const lines = [`Active async runs in this Goal-Driven session tree: ${runs.length}`, ""];
	for (const run of runs) {
		const stepNumber = run.currentStep === null ? "?" : String(Math.min(run.currentStep + 1, Math.max(run.totalSteps, 1)));
		const totalSteps = run.totalSteps > 0 ? String(run.totalSteps) : "?";
		const busyStall = run.busyStall && run.busyStall !== "healthy"
			? ` | ${run.busyStall}: ${run.busyStallReason ?? "repeated low-progress activity"}`
			: "";
		lines.push(
			`- ${run.id} | ${run.state} | ${run.mode ?? "single"} | step ${stepNumber}/${totalSteps} | ${shortenHomePath(run.cwd)}${busyStall}`,
		);
		for (const [index, step] of run.steps.entries()) {
			lines.push(`  ${index + 1}. ${step.agent} | ${step.status}`);
		}
		if (run.steps.length > 0) lines.push("");
	}
	if (lines.at(-1) === "") lines.pop();
	return lines.join("\n");
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

function isPidAlive(pid: number | null): boolean {
	if (pid === null) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function probeInactiveAsyncRun(input: {
	asyncId: string;
	snapshot: AsyncRunSnapshot;
	heartbeatAt: number | null;
	previousProbe: InactiveProbeState | null;
	now: number;
	pidAlive: (pid: number | null) => boolean;
	probeAfterMs?: number;
	graceMs?: number;
}): InactiveProbeResult {
	const probeAfterMs = input.probeAfterMs ?? WATCHDOG_INACTIVE_PROBE_AFTER_MS;
	const graceMs = input.graceMs ?? WATCHDOG_INACTIVE_GRACE_MS;
	if (input.snapshot.state !== "queued" && input.snapshot.state !== "running") {
		return { classification: "active", reason: "async run is not active" };
	}
	if (input.heartbeatAt === null) {
		return { classification: "unknown", reason: "no heartbeat evidence available" };
	}

	const inactiveForMs = Math.max(0, input.now - input.heartbeatAt);
	if (inactiveForMs < probeAfterMs) {
		return { classification: "active", reason: `heartbeat observed ${formatInactivity(inactiveForMs)} ago`, inactiveForMs };
	}

	if (input.snapshot.state === "running" && !input.pidAlive(input.snapshot.pid)) {
		return {
			classification: "stale-running",
			reason: input.snapshot.pid === null
				? "async status is running but has no recorded PID"
				: `async status is running but PID ${input.snapshot.pid} is no longer alive`,
			probe: {
				asyncId: input.asyncId,
				firstInactiveAt: input.now,
				lastHeartbeatAt: input.heartbeatAt,
				graceUntil: input.now,
				pid: input.snapshot.pid,
				status: "stale-running",
			},
			inactiveForMs,
		};
	}

	const previous = input.previousProbe?.asyncId === input.asyncId && input.previousProbe.lastHeartbeatAt === input.heartbeatAt
		? input.previousProbe
		: null;
	const probe = previous ?? {
		asyncId: input.asyncId,
		firstInactiveAt: input.now,
		lastHeartbeatAt: input.heartbeatAt,
		graceUntil: input.now + graceMs,
		pid: input.snapshot.pid,
		status: "probe-pending" as const,
	};
	if (input.now < probe.graceUntil) {
		return {
			classification: "probe-pending",
			reason: `worker inactive for ${formatInactivity(inactiveForMs)}; heartbeat probe grace pending`,
			probe,
			inactiveForMs,
		};
	}

	return {
		classification: "inactive-expired",
		reason: `worker remained inactive for ${formatInactivity(inactiveForMs)} after heartbeat probe grace`,
		probe,
		inactiveForMs,
	};
}

function buildInactiveProbeReplacementInstruction(result: InactiveProbeResult): string {
	return [
		"The previous worker stopped producing heartbeat updates and was stopped by the Goal-Driven watchdog.",
		`Probe result: ${result.reason}.`,
		"Launch exactly one replacement worker subagent with agent: \"worker\", async: true, and clarify: false, then stop.",
		"The replacement worker should inspect the previous async status/output evidence first and avoid repeating any silent long-running command without a timeout or visible progress output.",
	].join("\n\n");
}

async function readTailText(filePath: string | null, maxBytes = ASYNC_TAIL_BYTES): Promise<string> {
	if (!filePath) return "";
	try {
		const fileStat = await stat(filePath);
		if (fileStat.size <= maxBytes) return readFile(filePath, "utf8");
		const handle = await open(filePath, "r");
		try {
			const buffer = Buffer.alloc(maxBytes);
			await handle.read(buffer, 0, maxBytes, Math.max(0, fileStat.size - maxBytes));
			return buffer.toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return "";
	}
}

function normalizeForSignature(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeForSignature);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, normalizeForSignature(entry)]),
	);
}

function eventToolSignature(event: unknown): string | null {
	if (!event || typeof event !== "object") return null;
	const candidate = event as { type?: unknown; toolName?: unknown; args?: unknown };
	if (candidate.type !== "tool_execution_start" || typeof candidate.toolName !== "string") return null;
	const args = candidate.args === undefined ? "" : ` ${JSON.stringify(normalizeForSignature(candidate.args))}`;
	return `${candidate.toolName}${args}`;
}

function eventOutputLine(event: unknown): string | null {
	if (!event || typeof event !== "object") return null;
	const candidate = event as { type?: unknown; line?: unknown };
	if (candidate.type !== "subagent.child.stdout" && candidate.type !== "subagent.child.stderr") return null;
	return typeof candidate.line === "string" ? candidate.line.trim() : null;
}

function resolveAsyncOutputFile(asyncDir: string, outputFile: unknown): string | null {
	if (typeof outputFile !== "string" || !outputFile) return null;
	return path.isAbsolute(outputFile) ? outputFile : path.join(asyncDir, outputFile);
}

async function inspectAsyncRunForBusyStall(
	asyncId: string,
	asyncDir: string,
	now = Date.now(),
): Promise<AsyncRunBusyStallInspection | null> {
	try {
		const raw = await readFile(path.join(asyncDir, "status.json"), "utf8");
		const status = JSON.parse(raw) as {
			state?: string;
			pid?: number;
			cwd?: string;
			startedAt?: number;
			outputFile?: string;
		};
		const state = status.state === "queued"
			|| status.state === "running"
			|| status.state === "complete"
			|| status.state === "failed"
			? status.state
			: null;
		const startedAt = typeof status.startedAt === "number" ? status.startedAt : null;
		const outputFile = resolveAsyncOutputFile(asyncDir, status.outputFile);
		const toolSignatures: string[] = [];
		const outputLines: string[] = [];

		const eventsText = await readTailText(path.join(asyncDir, "events.jsonl"));
		for (const line of eventsText.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as unknown;
				const toolSignature = eventToolSignature(event);
				if (toolSignature) toolSignatures.push(toolSignature);
				const outputLine = eventOutputLine(event);
				if (outputLine) outputLines.push(outputLine);
			} catch {
				continue;
			}
		}

		const outputText = await readTailText(outputFile);
		for (const line of outputText.split("\n")) {
			const trimmed = line.trim();
			if (trimmed) outputLines.push(trimmed);
		}

		const recentToolSignatures = toolSignatures.slice(-200);
		const recentOutputLines = outputLines.slice(-200);
		return {
			id: asyncId,
			asyncDir,
			state,
			pid: typeof status.pid === "number" ? status.pid : null,
			cwd: typeof status.cwd === "string" ? status.cwd : null,
			startedAt,
			elapsedMs: startedAt === null ? null : Math.max(0, now - startedAt),
			recentToolSignatures,
			recentOutputLines,
			evidence: [...recentToolSignatures.map((signature) => `tool: ${signature}`), ...recentOutputLines.map((line) => `output: ${line}`)].slice(-12),
		};
	} catch {
		return null;
	}
}

function isLowInformationOutputLine(line: string): boolean {
	return /^exit:\s*\d+$/i.test(line) || line.startsWith("bash:");
}

function mostRepeated(values: string[]): { value: string | null; count: number } {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	let repeated = { value: null as string | null, count: 0 };
	for (const [value, count] of counts.entries()) {
		if (count > repeated.count) repeated = { value, count };
	}
	return repeated;
}

function classifyBusyStall(inspection: AsyncRunBusyStallInspection): BusyStallDiagnostic {
	if (inspection.state !== "queued" && inspection.state !== "running") {
		return { classification: "healthy", reason: "async run is not active", repeatedSignature: null, repeatCount: 0, evidence: [] };
	}
	const elapsedMs = inspection.elapsedMs ?? 0;
	const signatures = [
		...inspection.recentToolSignatures.map((signature) => `tool: ${signature}`),
		...inspection.recentOutputLines.filter(isLowInformationOutputLine).map((line) => `output: ${line}`),
	];
	const repeated = mostRepeated(signatures);
	const evidence = inspection.evidence.filter((entry) => !repeated.value || entry === repeated.value).slice(-6);
	if (elapsedMs >= WATCHDOG_BUSY_STALL_STOP_MIN_AGE_MS && repeated.count >= WATCHDOG_BUSY_STALL_STOP_REPEAT_COUNT) {
		return {
			classification: "busy-stall",
			reason: `repeated ${repeated.count} low-progress events over ${formatInactivity(elapsedMs)}`,
			repeatedSignature: repeated.value,
			repeatCount: repeated.count,
			evidence,
		};
	}
	if (elapsedMs >= WATCHDOG_BUSY_STALL_WARNING_MIN_AGE_MS && repeated.count >= WATCHDOG_BUSY_STALL_WARNING_REPEAT_COUNT) {
		return {
			classification: "possible-busy-stall",
			reason: `repeated ${repeated.count} low-progress events over ${formatInactivity(elapsedMs)}`,
			repeatedSignature: repeated.value,
			repeatCount: repeated.count,
			evidence,
		};
	}
	return { classification: "healthy", reason: "no repeated low-progress pattern detected", repeatedSignature: repeated.value, repeatCount: repeated.count, evidence };
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

function buildBusyStallEntry(input: {
	run: ActiveRun;
	knownRun: KnownAsyncRun;
	inspection: AsyncRunBusyStallInspection;
	diagnostic: BusyStallDiagnostic;
	stoppedAt: number;
	recoveryCount: number;
	replacementRequested: boolean;
}): GoalDrivenBusyStallEntry {
	return {
		sessionId: input.run.sessionId,
		sessionFile: input.run.sessionFile,
		asyncId: input.knownRun.id,
		asyncDir: input.knownRun.dir ?? input.inspection.asyncDir,
		pid: input.inspection.pid,
		cwd: input.inspection.cwd,
		elapsedMs: input.inspection.elapsedMs,
		classification: input.diagnostic.classification,
		reason: input.diagnostic.reason,
		repeatedSignature: input.diagnostic.repeatedSignature,
		repeatCount: input.diagnostic.repeatCount,
		evidence: input.diagnostic.evidence,
		stoppedAt: input.stoppedAt,
		recoveryCount: input.recoveryCount,
		replacementRequested: input.replacementRequested,
	};
}

function formatBusyStallEvidence(diagnostic: BusyStallDiagnostic): string {
	const evidence = diagnostic.evidence.length > 0
		? diagnostic.evidence.map((entry) => `- ${entry}`).join("\n")
		: "- No recent event sample was available.";
	return [
		`Reason: ${diagnostic.reason}`,
		diagnostic.repeatedSignature ? `Repeated signature: ${diagnostic.repeatedSignature}` : undefined,
		`Evidence:\n${evidence}`,
	].filter((line): line is string => Boolean(line)).join("\n");
}

function buildBusyStallReplacementInstruction(diagnostic: BusyStallDiagnostic, recoveryCount: number): string {
	return [
		"The previous worker was stopped by the Goal-Driven busy-stall watchdog because it was active but repeating low-progress work.",
		formatBusyStallEvidence(diagnostic),
		`Busy-stall recovery attempt ${recoveryCount} of ${WATCHDOG_BUSY_STALL_MAX_RECOVERIES}.`,
		"Launch exactly one replacement worker subagent with agent: \"worker\", async: true, and clarify: false, then stop.",
		"The replacement worker must not repeat the same exploration loop. It should inspect the preserved evidence, choose the smallest concrete fix or verification path, and return a final report or patch for the master to verify.",
	].join("\n\n");
}

function buildBusyStallEscalationInstruction(diagnostic: BusyStallDiagnostic): string {
	return [
		"A Goal-Driven worker was stopped after repeated busy-stall recoveries. Do not launch another replacement worker automatically.",
		formatBusyStallEvidence(diagnostic),
		"Inspect the preserved async run evidence and decide whether to narrow the goal, ask the user for direction, or verify the workspace manually.",
	].join("\n\n");
}

async function watchdogTick(pi: ExtensionAPI): Promise<void> {
	const run = activeRun;
	if (!run) {
		stopWatchdog();
		return;
	}
	await hydrateKnownAsyncRuns(run, latestCtx?.sessionManager);
	if (!activeRun) {
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
	const now = Date.now();
	const inactiveProbe = probeInactiveAsyncRun({
		asyncId: runningKnownRun.id,
		snapshot,
		heartbeatAt,
		previousProbe: run.inactiveProbe,
		now,
		pidAlive: isPidAlive,
	});
	if (inactiveProbe.classification === "active") {
		run.inactiveProbe = null;
	} else if (inactiveProbe.classification === "probe-pending" && inactiveProbe.probe) {
		run.inactiveProbe = inactiveProbe.probe;
		run.lastEvent = `Worker [${runningKnownRun.id.slice(0, 6)}] ${inactiveProbe.reason}; grace until ${new Date(inactiveProbe.probe.graceUntil).toLocaleTimeString()}`;
		refreshStatus();
		return;
	} else if (inactiveProbe.classification === "stale-running" || inactiveProbe.classification === "inactive-expired") {
		run.inactiveProbe = inactiveProbe.probe ?? null;
		const stoppedWorkers = await stopKnownAsyncRuns(
			run,
			inactiveProbe.classification === "stale-running" ? WATCHDOG_STALE_RUNNING_STOP_REASON : WATCHDOG_INACTIVE_PROBE_STOP_REASON,
		);
		if (stoppedWorkers <= 0) return;

		run.phase = "working";
		run.awaitingVerification = false;
		run.verificationReminderSent = false;
		run.activeAsyncId = null;
		run.activeAsyncDir = null;
		run.latestAsyncId = runningKnownRun.id;
		run.latestAsyncDir = runningKnownRun.dir;
		run.inactiveProbe = null;
		run.lastEvent = `Worker [${runningKnownRun.id.slice(0, 6)}] ${inactiveProbe.reason}; replacement requested`;
		refreshStatus();
		if (latestCtx?.hasUI) {
			latestCtx.ui.notify(
				`Goal-Driven worker ${runningKnownRun.id.slice(0, 6)} ${inactiveProbe.reason}. Stopped it and requested a replacement worker.`,
				"warning",
			);
		}
		sendGoalDrivenFollowUp(pi, buildInactiveProbeReplacementInstruction(inactiveProbe));
		return;
	} else if (heartbeatAt !== null && now - heartbeatAt >= WATCHDOG_INACTIVE_TIMEOUT_MS) {
		const stoppedWorkers = await stopKnownAsyncRuns(run, WATCHDOG_STOP_REASON);
		if (stoppedWorkers <= 0) return;

		run.phase = "working";
		run.awaitingVerification = false;
		run.verificationReminderSent = false;
		run.activeAsyncId = null;
		run.activeAsyncDir = null;
		run.latestAsyncId = runningKnownRun.id;
		run.latestAsyncDir = runningKnownRun.dir;
		run.inactiveProbe = null;
		run.lastEvent = `Worker [${runningKnownRun.id.slice(0, 6)}] inactive for ${formatInactivity(now - heartbeatAt)}; replacement requested`;
		refreshStatus();
		if (latestCtx?.hasUI) {
			latestCtx.ui.notify(
				`Goal-Driven worker ${runningKnownRun.id.slice(0, 6)} was inactive for ${formatInactivity(now - heartbeatAt)}. Stopped it and requested a replacement worker.`,
				"warning",
			);
		}
		sendGoalDrivenFollowUp(
			pi,
			"The previous worker became inactive and was stopped by the Goal-Driven watchdog. Launch exactly one replacement worker subagent with agent: \"worker\", async: true, and clarify: false, then stop.",
		);
		return;
	}

	const inspection = await inspectAsyncRunForBusyStall(runningKnownRun.id, runningKnownRun.dir);
	if (!inspection) return;
	const busyStall = classifyBusyStall(inspection);
	if (busyStall.classification !== "busy-stall") return;

	const nextRecoveryCount = run.busyStallRecoveries + 1;
	const replacementRequested = nextRecoveryCount <= WATCHDOG_BUSY_STALL_MAX_RECOVERIES;
	const stoppedWorkers = await stopKnownAsyncRuns(run, WATCHDOG_BUSY_STALL_STOP_REASON);
	if (stoppedWorkers <= 0) return;

	run.busyStallRecoveries = nextRecoveryCount;
	run.phase = "working";
	run.awaitingVerification = false;
	run.verificationReminderSent = false;
	run.activeAsyncId = null;
	run.activeAsyncDir = null;
	run.latestAsyncId = runningKnownRun.id;
	run.latestAsyncDir = runningKnownRun.dir;
	run.lastEvent = replacementRequested
		? `Worker [${runningKnownRun.id.slice(0, 6)}] busy-stalled; replacement requested`
		: `Worker [${runningKnownRun.id.slice(0, 6)}] busy-stalled; awaiting attention`;
	pi.appendEntry<GoalDrivenBusyStallEntry>(GOAL_DRIVEN_BUSY_STALL_ENTRY, buildBusyStallEntry({
		run,
		knownRun: runningKnownRun,
		inspection,
		diagnostic: busyStall,
		stoppedAt: Date.now(),
		recoveryCount: nextRecoveryCount,
		replacementRequested,
	}));
	refreshStatus();
	if (latestCtx?.hasUI) {
		latestCtx.ui.notify(
			replacementRequested
				? `Goal-Driven worker ${runningKnownRun.id.slice(0, 6)} was busy-stalled. Stopped it and requested a narrower replacement worker.`
				: `Goal-Driven worker ${runningKnownRun.id.slice(0, 6)} was busy-stalled again. Stopped it and paused automatic replacement.`,
			"warning",
		);
	}
	sendGoalDrivenFollowUp(
		pi,
		replacementRequested
			? buildBusyStallReplacementInstruction(busyStall, nextRecoveryCount)
			: buildBusyStallEscalationInstruction(busyStall),
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
	const goalMatch = prompt.match(/(?:^|\n)Goal:\s*([\s\S]*?)(?:\n\s*\n)Criteria for success:/i);
	const criteriaMatch = prompt.match(/(?:^|\n)Criteria for success:\s*([\s\S]*?)(?:\n\s*\n)Here is the System:/i);
	return {
		goal: normalizeGoal(goalMatch?.[1] ?? ""),
		criteria: normalizeCriteria(criteriaMatch?.[1] ?? ""),
	};
}

function sanitizeBrainstormPrompt(prompt: string, template: string): string | null {
	const parsed = parsePromptSections(prompt);
	if (!parsed.goal || !parsed.criteria) return null;
	const rebuilt = fillTemplate(template, parsed.goal, parsed.criteria).trim();
	if (hasUnfilledPlaceholders(rebuilt)) return null;
	return rebuilt;
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

function shouldAutoDraftBrainstorm(text: string, brainstorm: ActiveBrainstorm): boolean {
	if (brainstorm.autoDraftNudgeSent || brainstorm.userReplyCount < 1) return false;
	const normalized = text.toLowerCase();
	if (normalized.includes(PROMPT_START.toLowerCase())) return false;
	const repeatQuestionSignals = [
		"one more",
		"one final",
		"one quick",
		"one more clarification",
		"one more question",
		"final clarification",
		"another question",
		"good. one clarifying question",
		"one clarifying question about verification",
		"one focused question about verification",
		"let me confirm one detail",
		"one detail",
		"one last detail",
		"one quick detail",
		"to confirm one detail",
	];
	if (repeatQuestionSignals.some((signal) => normalized.includes(signal))) return true;
	const answerProvidedEnoughConstraints = [
		"good constraints",
		"perfect. i have enough",
		"i have enough to draft",
		"i have what i need",
		"that helps",
	].some((signal) => normalized.includes(signal));
	if (!answerProvidedEnoughConstraints) return false;
	const highSignalFollowUp = [
		"what should",
		"which ",
		"where does",
		"where is",
		"how will",
		"what is the source of truth",
		"what is your source of truth",
		"what does",
	].some((signal) => normalized.includes(signal));
	return highSignalFollowUp;
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
- Do not create implementation files, commands, patches, or code samples for the task itself. Your output here is only the completed Goal-Driven prompt.
- If information is still missing, ask for it or draft a prompt that makes the remaining uncertainty explicit. Never switch into implementation mode during brainstorm.
- Ask at most one focused question at a time, and only when it materially improves Goal or Criteria for Success.
- When several clarifications are possible, ask only the single highest-value question — the one most likely to unlock a strong Goal and testable Criteria for Success.
- Prefer questions that uncover output format, preserved behavior, compatibility constraints, reversibility, required checks, scope boundaries, or the observable definition of done.
- A strong default first question is some form of: what would make this done, and what must stay unchanged?
- Prefer asking about externally visible results and verification first. Avoid spending the first question on implementation internals like schema column names, storage layout, or where a design artifact lives if the worker can inspect those during execution.
- If the task is already clear, skip questions and draft the prompt immediately.
- If the user gives concrete success criteria or constraints, treat that as enough to draft even if they did not directly answer your exact question, unless a missing detail would still make the final output contract unknowable.
- After the user answers a clarifying question, prefer drafting the completed prompt instead of asking another question unless the missing detail would still force the worker to guess the core task contract.
- Do not repeat the same question in different words. If the user answers with adjacent constraints, incorporate them and move forward.
- If some low-priority detail is still unknown, draft the prompt anyway and write success criteria around what is observable and user-confirmed.
- The Goal should describe the desired end state, not the implementation plan.
- Criteria for success should be a numbered list of observable, testable checks.
- Explicitly capture user-stated constraints such as preserving existing behavior, tests or typecheck, no new dependencies, compatibility windows, reversibility, or output format when they matter.
- Avoid filler criteria like "production-ready", "handle edge cases gracefully", or deployment steps unless the user explicitly asked for them.
- Whenever you have enough information, return the completed prompt between the exact markers:
${PROMPT_START}
<completed prompt>
${PROMPT_END}
- Reuse the template's Goal / Criteria for success / Here is the System section labels so the saved prompt stays easy to parse.
- If the user asks for revisions, update the prompt and return a fresh completed version with the same markers.
- Always finish with: Run /${WORK_COMMAND_NAME} to execute it.
- The completed prompt must not contain placeholder brackets.

Template:
${template}`;
}

function buildRunSystemPrompt(run: ActiveRun): string {
	const phaseInstruction = run.awaitingVerification
		? `The latest worker subagent attempt from this Goal-Driven session tree has completed. You must verify the workspace and evidence now.`
		: run.activeAsyncId
			? `Worker subagent attempt #${run.attempt} is still running in background inside this Goal-Driven session tree (async id: ${run.activeAsyncId}). Do not verify yet. Wait for the completion notification from this session tree before acting again.`
			: `Launch exactly one worker subagent attempt to continue the run.`;

	return `You are inside an active /${WORK_COMMAND_NAME} Goal-Driven run.

You are the master agent. The worker subagent does implementation work, but the master agent does all verification itself.

Current run state:
- Attempt count so far: ${run.attempt}
- Phase: ${run.phase}
- Active async worker id in this session tree: ${run.activeAsyncId ?? "none"}
- Session scope: only background workers that belong to this Goal-Driven session tree count for waiting, recovery, blocking, or verification decisions
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
- While a worker subagent is running in background inside this session tree, do not verify and do not launch another worker.
- Ignore background workers that belong to other sessions, projects, or unrelated session trees.
- If you inspect worker status, treat the filtered session-scoped "subagent_status list" result as the source of truth.
- After a worker completion notification from this session tree arrives, the master agent must verify the result itself against the Criteria for Success.
- Treat any unmet or unproven criterion as NOT met.
- Before ending a message after a worker completion, do exactly one of these:
  1. If all criteria are fully satisfied and proven, include the exact line:
     ${MASTER_MET_VERDICT}
     Then summarize the evidence and do not call subagent again.
  2. If any criterion is unmet or unproven, create exactly one new worker subagent call to continue the work before ending the message.
- After launching a background worker, end the message and wait for completion from this session tree. Do not verify immediately after launch.
- Do not stop early because the result looks "mostly done".
- Do not end a verification message without either launching one new worker subagent or emitting ${MASTER_MET_VERDICT}.

Immediate instruction:
${phaseInstruction}`;
}

function buildVerificationReminder(run: ActiveRun): string {
	return [
		`Master verification is still required for the active Goal-Driven run.`,
		`Only workers from this Goal-Driven session tree count when deciding whether to wait, recover, or relaunch. Ignore global async noise from other sessions or projects.`,
		`Goal:\n${run.goal || "(see saved prompt above)"}`,
		`Criteria for Success:\n${run.criteria || "(see saved prompt above)"}`,
		`Use the latest completed worker subagent result from this session tree already present in the conversation.`,
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
		userReplyCount: 0,
		autoDraftNudgeSent: false,
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
	const sessionRef = getSessionRef(ctx);
	activeRun = {
		cwd: ctx.cwd,
		sessionId: sessionRef.sessionId,
		sessionFile: sessionRef.sessionFile,
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
		busyStallRecoveries: 0,
		inactiveProbe: null,
		lastEvent: "Launching master/subagent run",
	};
	await hydrateKnownAsyncRuns(activeRun, ctx.sessionManager);
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
	const cleanupSummary = runToStop
		? await stopSessionScopedAsyncRuns(runToStop.sessionFile, runToStop.knownAsyncRuns, "Stopped by /goal-driven stop")
		: summarizeAsyncRunCleanup([]);
	clearBrainstorm();
	clearRun();
	if (!ctx.isIdle()) ctx.abort();
	if (!hadBrainstorm && !hadRun) {
		ctx.ui.notify("No Goal-Driven flow is active.", "info");
		return;
	}
	ctx.ui.notify(
		cleanupSummary.stopped > 0 || cleanupSummary.alreadyFinished > 0 || cleanupSummary.missing > 0 || cleanupSummary.errors > 0
			? `Stopped the active Goal-Driven flow; ${formatAsyncRunCleanupSummary(cleanupSummary)} across this session tree.`
			: "Stopped the active Goal-Driven flow.",
		"info",
	);
}

export default function goalDriven(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (activeRun) {
			await hydrateKnownAsyncRuns(activeRun, ctx.sessionManager);
		}
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

	pi.on("tool_call", async (event, ctx) => {
		if (!activeRun || event.toolName !== "subagent") return;
		if (!isSubagentExecutionInput(event.input)) return;
		await hydrateKnownAsyncRuns(activeRun, ctx.sessionManager);

		const runningKnownRun = await findRunningKnownAsyncRun(activeRun);
		if (runningKnownRun) {
			activeRun.phase = "working";
			activeRun.awaitingVerification = false;
			activeRun.verificationReminderSent = false;
			activeRun.activeAsyncId = runningKnownRun.id;
			activeRun.activeAsyncDir = runningKnownRun.dir;
			activeRun.inactiveProbe = null;
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
		activeRun.inactiveProbe = null;
		activeRun.lastEvent = `Worker subagent attempt #${activeRun.attempt} launching in background`;
		refreshStatus();
	});

	pi.on("tool_result", async (event, ctx) => {
		if (activeRun && event.toolName === "subagent_status" && isSubagentStatusListInput(event.input)) {
			await hydrateKnownAsyncRuns(activeRun, ctx.sessionManager);
			const runs = await listSessionScopedActiveAsyncRuns(activeRun.sessionFile, activeRun.knownAsyncRuns);
			return {
				content: [{ type: "text", text: formatScopedSubagentStatusList(runs) }],
				details: {
					mode: "single",
					results: [],
					scoped: true,
					count: runs.length,
				},
			};
		}

		if (!activeRun || event.toolName !== "subagent") return;
		if (!isSubagentExecutionInput(event.input)) return;
		const launch = getSubagentAsyncLaunch(event.details);
		await hydrateKnownAsyncRuns(activeRun, ctx.sessionManager);
		if (!launch.asyncId) {
			activeRun.phase = "working";
			activeRun.awaitingVerification = false;
			activeRun.verificationReminderSent = false;
			activeRun.activeAsyncId = null;
			activeRun.activeAsyncDir = null;
			activeRun.inactiveProbe = null;
			activeRun.lastEvent = `Worker subagent attempt #${Math.max(activeRun.attempt, 1)} failed to launch in async mode`;
			refreshStatus();
			sendGoalDrivenFollowUp(
				pi,
				"The previous worker did not launch in async mode. Launch exactly one replacement worker subagent with async: true and clarify: false, then stop.",
			);
			return;
		}
		trackKnownAsyncRun(activeRun, launch.asyncId, launch.asyncDir);
		pi.appendEntry<GoalDrivenAsyncRunEntry>(GOAL_DRIVEN_ASYNC_RUN_ENTRY, {
			sessionId: activeRun.sessionId,
			sessionFile: activeRun.sessionFile,
			asyncId: launch.asyncId,
			asyncDir: launch.asyncDir,
			cwd: activeRun.cwd,
		});
		activeRun.phase = "working";
		activeRun.awaitingVerification = false;
		activeRun.verificationReminderSent = false;
		activeRun.activeAsyncId = launch.asyncId;
		activeRun.activeAsyncDir = launch.asyncDir;
		activeRun.inactiveProbe = null;
		activeRun.lastEvent = `Worker subagent attempt #${Math.max(activeRun.attempt, 1)} running in background [${launch.asyncId.slice(0, 6)}]`;
		refreshStatus();
		ensureWatchdog(pi);
	});

	pi.events.on("subagent:complete", async (data: unknown) => {
		if (!activeRun) return;
		await hydrateKnownAsyncRuns(activeRun, latestCtx?.sessionManager);
		const result = data as { id?: string; success?: boolean; asyncDir?: string; summary?: string };
		if (!result.id) return;
		const matchesActive = result.id === activeRun.activeAsyncId;
		const matchesLatest = result.id === activeRun.latestAsyncId;
		if (!matchesActive && !matchesLatest) return;
		activeRun.phase = "verifying";
		activeRun.awaitingVerification = true;
		activeRun.verificationReminders = 0;
		activeRun.verificationReminderSent = false;
		activeRun.busyStallRecoveries = 0;
		activeRun.inactiveProbe = null;
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
		const assistantMessage = isAssistantMessage(event.message) ? event.message : null;
		if (activeBrainstorm && event.message.role === "user") {
			activeBrainstorm.userReplyCount += 1;
			refreshStatus();
		}
		if (!assistantMessage) return;
		const text = getAssistantText(assistantMessage);

		if (activeBrainstorm) {
			if (text.trim()) {
				activeBrainstorm.lastEvent = text.includes(PROMPT_START)
					? "Drafted a Goal-Driven prompt"
					: singleLine(text, 100);
			}

			const prompt = extractPromptBlock(text);
			if (!prompt) {
				if (shouldAutoDraftBrainstorm(text, activeBrainstorm)) {
					activeBrainstorm.autoDraftNudgeSent = true;
					sendGoalDrivenFollowUp(
						pi,
						`You already have enough information to draft a strong Goal and Criteria for Success. Do not ask another clarifying question. Produce the completed prompt now between ${PROMPT_START} and ${PROMPT_END}, reusing the template's canonical section labels.`,
					);
				}
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

			const sanitizedPrompt = sanitizeBrainstormPrompt(prompt, activeBrainstorm.template);
			if (!sanitizedPrompt) {
				ctx.ui.notify(
					"The generated prompt could not be normalized back into the canonical Goal-Driven template. Continue the conversation or regenerate it.",
					"warning",
				);
				refreshStatus();
				return;
			}

			const savePath = await savePrompt(activeBrainstorm.cwd, sanitizedPrompt);
			clearBrainstorm();
			ctx.ui.notify(
				`Saved the completed Goal-Driven prompt to ${savePath}. Run /${WORK_COMMAND_NAME} to execute it.`,
				"info",
			);
			return;
		}

		if (!activeRun) return;
		await hydrateKnownAsyncRuns(activeRun, ctx.sessionManager);

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
			activeRun.inactiveProbe = null;
			activeRun.lastEvent = `Recovered still-running worker [${runningKnownRun.id.slice(0, 6)}]`;
			refreshStatus();
			return;
		}

		if (assistantMessageHasSubagentExecutionCall(assistantMessage)) {
			activeRun.awaitingVerification = false;
			activeRun.verificationReminderSent = false;
			activeRun.phase = "working";
			activeRun.inactiveProbe = null;
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

async function runWatchdogTickForTest(run: ActiveRun, pi: ExtensionAPI, sessionManager?: SessionManagerView | null): Promise<ActiveRun | null> {
	activeRun = run;
	latestCtx = { sessionManager, hasUI: false } as ExtensionContext;
	await watchdogTick(pi);
	const result = activeRun;
	latestCtx = null;
	activeRun = null;
	return result;
}

export const __goalDrivenTestUtils = {
	GOAL_DRIVEN_WORKER_TASK_GUARD,
	WATCHDOG_INACTIVE_PROBE_AFTER_MS,
	WATCHDOG_INACTIVE_GRACE_MS,
	prependWorkerTaskGuard,
	collectPersistedKnownAsyncRuns,
	matchesSessionRef,
	getSessionTreeRoot,
	formatAsyncRunCleanupSummary,
	formatScopedSubagentStatusList,
	probeInactiveAsyncRun,
	buildInactiveProbeReplacementInstruction,
	runWatchdogTickForTest,
	inspectAsyncRunForBusyStall,
	classifyBusyStall,
	buildBusyStallReplacementInstruction,
	buildBusyStallEscalationInstruction,
	sanitizeBrainstormPrompt,
	parsePromptSections,
	shouldAutoDraftBrainstorm,
	buildBrainstormSystemPrompt,
	buildRunSystemPrompt,
	buildVerificationReminder,
};
