import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { discoverAgents, type AgentConfig } from "pi-subagents/agents.ts";
import { runSync } from "pi-subagents/execution.ts";
import type { Details, SingleResult, Usage } from "pi-subagents/types.ts";
import { getSingleResultOutput } from "pi-subagents/utils.ts";

const EXTENSION_NAME = "pi-goal-driven";
const COMMAND_NAME = "goal-driven";
const DEFAULT_AGENT_NAME = "worker";
const INACTIVITY_CHECK_MS = 30_000;
const INACTIVITY_WINDOW_MS = 5 * 60_000;
const STATUS_REFRESH_MS = 1_000;
const HISTORY_LIMIT = 3;
const DASHBOARD_MAX_ROWS = 6;
const SNIPPET_LIMIT = 1_800;
const VERIFIER_TOOLS = ["read", "bash", "grep", "find", "ls"];
const OVERLAY_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_CONFIG_PATH = path.join(PACKAGE_DIR, "config.json");
const GLOBAL_AGENT_DIR = getAgentDir();
const GLOBAL_EXTENSION_DIR = path.join(GLOBAL_AGENT_DIR, "extensions", EXTENSION_NAME);
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_EXTENSION_DIR, "config.json");
const GLOBAL_RUNS_DIR = path.join(GLOBAL_EXTENSION_DIR, "runs");
const GLOBAL_LATEST_RUN_PATH = path.join(GLOBAL_EXTENSION_DIR, "latest-run.json");
const GLOBAL_SETTINGS_PATH = path.join(GLOBAL_AGENT_DIR, "settings.json");
const GLOBAL_SUBAGENTS_EXTENSION_PATH = path.join(GLOBAL_AGENT_DIR, "extensions", "pi-subagents", "index.ts");

const PROMPT_TEMPLATE = `# Goal-Driven(1 master agent + 1 subagent) System

Here we define a goal-driven multi-agent system for solving any problem.

Goal: [[[[[在此定义你的目标]]]]]

Criteria for success: [[[[[在此定义你的成功标准]]]]]

Here is the System: The system contains a master agent and a subagent. You are the master agent, and you need to create 1 subagent to help you complete the task.

## Subagent's description:

The subagent's goal is to complete the task assigned by the master agent. The goal defined above is the final and the only goal for the subagent. The subagent should have the ability to break down the task into smaller sub-tasks, and assign the sub-tasks to itself or other subagents if necessary. The subagent should also have the ability to monitor the progress of each sub-task and update the master agent accordingly. The subagent should continue to work on the task until the criteria for success are met.

## Master agent's description:

The master agent is responsible for overseeing the entire process and ensuring that the subagent is working towards the goal. The only 3 tasks that the main agent need to do are:

1. Create subagents to complete the task.
2. If the subagent finishes the task successfully or fails to complete the task, the master agent should evaluate the result by checking the criteria for success. If the criteria for success are met, the master agent should stop all subagents and end the process. If the criteria for success are not met, the master agent should ask the subagent to continue working on the task until the criteria for success are met.
3. The master agent should check the activities of each subagent for every 5 minutes, and if the subagent is inactive, please check if the current goal is reached and verify the status. If the goal is not reached, restart a new subagent with the same name to replace the inactive subagent. The new subagent should continue to work on the task and update the master agent accordingly.
4. This process should continue until the criteria for success are met. DO NOT STOP THE AGENTS UNTIL THE USER STOPS THEM MANUALLY FROM OUTSIDE.

## Basic design of the goal-driven double agent system in pseudocode:

create a subagent to complete the goal

while (criteria are not met) {
  check the activty of the subagent every 5 minutes
  if (the subagent is inactive or declares that it has reached the goal) {
    check if the current goal is reached and verify the status
    if (criteria are not met) {
      restart a new subagent with the same name to replace the inactive subagent
    }
    else {
      stop all subagents and end the process
    }
  }
}`;

const WORKER_SYSTEM_PROMPT = `You are the single Goal-Driven subagent.

Your only final goal is to make the current workspace satisfy the goal and the criteria you are given.

Rules:
- Work directly in the current workspace.
- Make concrete progress instead of discussing hypotheticals.
- Break the work into smaller steps and execute them.
- Run verification commands before claiming success whenever possible.
- Do not ask the user questions.
- When you decide to stop this attempt, your final response must end with this exact header block:
GOAL_DRIVEN_STATUS: READY_FOR_VERIFICATION
SUMMARY:
- bullet points of what changed or what you verified
OPEN_ISSUES:
- bullet points of anything still failing or unknown (or '- none')`;

const VERIFIER_SYSTEM_PROMPT = `You are the Goal-Driven master verifier.

Your only job is to decide whether the goal is already met.

Rules:
- Never edit or write files.
- You may inspect the workspace with read, grep, find, ls, and bash verification commands.
- Be strict. If any criterion is unproven, the verdict must be NOT_MET.
- Return exactly JSON, with no markdown fences and no prose before or after it.
- JSON schema:
{"verdict":"MET"|"NOT_MET","summary":"short explanation","nextActions":["action 1","action 2"]}`;

type RunState = "running" | "verifying" | "stopping";
type Verdict = "MET" | "NOT_MET";
type AttemptStatus = "success" | "not_met" | "worker_failed" | "inactive";

type ProgressUpdate = {
	content?: Array<{ type?: string; text?: string }>;
	details?: Details;
};

interface GoalDrivenConfig {
	defaultAgent: string;
	provider?: string;
	model?: string;
}

interface RunModelConfig {
	primary?: string;
	exactTarget: boolean;
}

const DEFAULT_CONFIG: GoalDrivenConfig = {
	defaultAgent: DEFAULT_AGENT_NAME,
};

interface SetupResult {
	goal: string;
	criteria: string;
	agentName: string;
}

interface VerificationResult {
	verdict: Verdict;
	summary: string;
	nextActions: string[];
}

interface AttemptRecord {
	attempt: number;
	status: AttemptStatus;
	reason: string;
	summary: string;
	workerSummary: string;
	verifierSummary: string;
	nextActions: string[];
	verdict: Verdict;
	startedAt: number;
	finishedAt: number;
}

interface ManagedSingleRun {
	result: SingleResult;
	killedForInactivity: boolean;
}

interface PersistedRunSnapshot {
	goal: string;
	criteria: string;
	filledPrompt: string;
	cwd: string;
	modelConfig: RunModelConfig;
	thinkingLevel: string;
	startedAt: number;
	attempt: number;
	attemptStartedAt: number;
	state: RunState;
	lastActivityAt: number;
	lastEvent: string;
	history: AttemptRecord[];
	dashboardExpanded: boolean;
	stopRequested: boolean;
	stopReason?: string;
	agentName: string;
	debugDir: string;
	lastWorkerSummary?: string;
	lastFailureReason?: string;
	lastVerifierSummary?: string;
	archivedAt: number;
}

interface ActiveRun {
	goal: string;
	criteria: string;
	filledPrompt: string;
	cwd: string;
	modelConfig: RunModelConfig;
	thinkingLevel: string;
	startedAt: number;
	attempt: number;
	attemptStartedAt: number;
	state: RunState;
	lastActivityAt: number;
	lastEvent: string;
	history: AttemptRecord[];
	dashboardExpanded: boolean;
	stopRequested: boolean;
	stopReason?: string;
	currentAbort?: AbortController;
	agentName: string;
	debugDir: string;
	lastWorkerSummary?: string;
	lastFailureReason?: string;
	lastVerifierSummary?: string;
	statusTimer?: NodeJS.Timeout;
}

let activeRun: ActiveRun | null = null;
let latestArchivedRun: ActiveRun | null = null;
let latestCtx: ExtensionContext | null = null;

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function truncate(text: string, max = SNIPPET_LIMIT): string {
	const normalized = text.trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, max - 1)}…`;
}

function singleLine(text: string, max = 100): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, max - 1)}…`;
}

function formatDuration(ms: number): string {
	if (ms < 1_000) return "just now";
	const seconds = Math.floor(ms / 1_000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ago`;
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1_000));
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes === 0) return `${remainder}s`;
	return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function getTuiSize(tui: { terminal?: { columns?: number; rows?: number } }): { width: number; height: number } {
	return {
		width: tui.terminal?.columns ?? process.stdout.columns ?? 120,
		height: tui.terminal?.rows ?? process.stdout.rows ?? 40,
	};
}

function sanitizePathSegment(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "run";
}

async function createRunDebugDir(): Promise<string> {
	const dir = path.join(GLOBAL_RUNS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

function historyLogPath(run: { debugDir: string }): string {
	return path.join(run.debugDir, "experiments.jsonl");
}

function toPersistedRunSnapshot(run: ActiveRun): PersistedRunSnapshot {
	return {
		goal: run.goal,
		criteria: run.criteria,
		filledPrompt: run.filledPrompt,
		cwd: run.cwd,
		modelConfig: run.modelConfig,
		thinkingLevel: run.thinkingLevel,
		startedAt: run.startedAt,
		attempt: run.attempt,
		attemptStartedAt: run.attemptStartedAt,
		state: run.state,
		lastActivityAt: run.lastActivityAt,
		lastEvent: run.lastEvent,
		history: run.history,
		dashboardExpanded: run.dashboardExpanded,
		stopRequested: run.stopRequested,
		stopReason: run.stopReason,
		agentName: run.agentName,
		debugDir: run.debugDir,
		lastWorkerSummary: run.lastWorkerSummary,
		lastFailureReason: run.lastFailureReason,
		lastVerifierSummary: run.lastVerifierSummary,
		archivedAt: Date.now(),
	};
}

function cloneArchivedRun(snapshot: PersistedRunSnapshot): ActiveRun {
	return {
		...snapshot,
		history: snapshot.history.map((item) => ({ ...item, nextActions: [...item.nextActions] })),
		currentAbort: undefined,
		statusTimer: undefined,
	};
}

async function persistRunSnapshot(run: ActiveRun): Promise<void> {
	await mkdir(GLOBAL_EXTENSION_DIR, { recursive: true });
	await writeFile(GLOBAL_LATEST_RUN_PATH, `${JSON.stringify(toPersistedRunSnapshot(run), null, 2)}\n`, "utf8");
}

async function appendAttemptRecord(run: ActiveRun, attempt: AttemptRecord): Promise<void> {
	await writeFile(historyLogPath(run), `${JSON.stringify(attempt)}\n`, { encoding: "utf8", flag: "a" });
}

async function restoreLatestArchivedRun(): Promise<ActiveRun | null> {
	if (!(await pathExists(GLOBAL_LATEST_RUN_PATH))) return null;
	try {
		const parsed = JSON.parse(await readFile(GLOBAL_LATEST_RUN_PATH, "utf8")) as PersistedRunSnapshot;
		return cloneArchivedRun(parsed);
	} catch {
		return null;
	}
}

function normalizeConfig(raw: unknown): GoalDrivenConfig {
	if (!isRecord(raw)) return { ...DEFAULT_CONFIG };
	const defaultAgent = typeof raw.defaultAgent === "string"
		? raw.defaultAgent.trim()
		: typeof raw.agent === "string"
			? raw.agent.trim()
			: "";
	const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
	const model = typeof raw.model === "string" ? raw.model.trim() : "";
	return {
		defaultAgent: defaultAgent || DEFAULT_AGENT_NAME,
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
	};
}

async function ensureBundledConfigFile(): Promise<void> {
	if (await pathExists(BUNDLED_CONFIG_PATH)) return;
	await writeFile(BUNDLED_CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
}

async function resolveConfigPath(_cwd: string): Promise<string> {
	if (await pathExists(GLOBAL_CONFIG_PATH)) return GLOBAL_CONFIG_PATH;
	return BUNDLED_CONFIG_PATH;
}

async function copyBundledConfig(destinationPath: string): Promise<void> {
	await ensureBundledConfigFile();
	await mkdir(path.dirname(destinationPath), { recursive: true });
	await copyFile(BUNDLED_CONFIG_PATH, destinationPath);
}

async function loadGoalDrivenConfig(ctx: ExtensionContext): Promise<{ config: GoalDrivenConfig; path: string }> {
	await ensureBundledConfigFile();
	const configPath = await resolveConfigPath(ctx.cwd);
	try {
		const parsed = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
		return { config: parsed, path: configPath };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(
			`[${EXTENSION_NAME}] Failed to read config from ${configPath}. Falling back to bundled defaults: ${message}`,
			"warning",
		);
		return { config: { ...DEFAULT_CONFIG }, path: BUNDLED_CONFIG_PATH };
	}
}

async function hasGlobalPiSubagentsInstalled(): Promise<boolean> {
	if (await pathExists(GLOBAL_SUBAGENTS_EXTENSION_PATH)) return true;
	if (!(await pathExists(GLOBAL_SETTINGS_PATH))) return false;

	try {
		const settings = JSON.parse(await readFile(GLOBAL_SETTINGS_PATH, "utf8")) as Record<string, unknown>;
		const packages = Array.isArray(settings.packages) ? settings.packages : [];
		const extensions = Array.isArray(settings.extensions) ? settings.extensions : [];
		const allEntries = [...packages, ...extensions].filter((entry): entry is string => typeof entry === "string");
		return allEntries.some((entry) => {
			const normalized = entry.toLowerCase();
			return normalized === "npm:pi-subagents"
				|| normalized === "pi-subagents"
				|| normalized.includes("/pi-subagents")
				|| normalized.includes("pi-subagents@");
		});
	} catch {
		return false;
	}
}

function selectConfiguredAgent(
	agents: AgentConfig[],
	configuredName: string,
): { agent: AgentConfig; requestedName: string; fallbackUsed: boolean } {
	const exact = agents.find((agent) => agent.name === configuredName);
	if (exact) return { agent: exact, requestedName: configuredName, fallbackUsed: false };

	const fallbackAgent = agents.find((agent) => agent.name === DEFAULT_AGENT_NAME) ?? agents[0]!;
	return { agent: fallbackAgent, requestedName: configuredName, fallbackUsed: true };
}

function buildModelRef(provider: string | undefined, modelId: string | undefined): string | undefined {
	const normalizedProvider = provider?.trim();
	const normalizedModelId = modelId?.trim();
	if (!normalizedProvider || !normalizedModelId) return undefined;
	return `${normalizedProvider}/${normalizedModelId}`;
}

function buildRunModelConfig(ctx: ExtensionContext, config: GoalDrivenConfig): RunModelConfig {
	const hasConfiguredModel = Boolean(config.provider && config.model);
	return {
		primary: hasConfiguredModel
			? buildModelRef(config.provider, config.model)
			: buildModelRef(ctx.model?.provider, ctx.model?.id),
		exactTarget: hasConfiguredModel,
	};
}

function fillPromptTemplate(goal: string, criteria: string): string {
	return PROMPT_TEMPLATE.replace("[[[[[在此定义你的目标]]]]]", goal).replace(
		"[[[[[在此定义你的成功标准]]]]]",
		criteria,
	);
}

function stripFences(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```")) return trimmed;
	return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function parseVerificationOutput(text: string): VerificationResult {
	const raw = text.trim();
	const cleaned = stripFences(raw);

	try {
		const parsed = JSON.parse(cleaned) as {
			verdict?: string;
			summary?: string;
			nextActions?: unknown;
		};
		const verdict = parsed.verdict === "MET" ? "MET" : "NOT_MET";
		const summary = typeof parsed.summary === "string" && parsed.summary.trim()
			? parsed.summary.trim()
			: "Verifier returned no summary.";
		const nextActions = Array.isArray(parsed.nextActions)
			? parsed.nextActions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
			: [];
		return { verdict, summary, nextActions };
	} catch {
		const verdictMatch = cleaned.match(/VERDICT\s*:\s*(MET|NOT_MET)/i);
		const verdict = verdictMatch?.[1]?.toUpperCase() === "MET" ? "MET" : "NOT_MET";
		const fallback = cleaned || "Verifier returned no output.";
		return {
			verdict,
			summary: truncate(fallback, 400),
			nextActions: [],
		};
	}
}

function mergeSystemPrompt(base: string | undefined, extra: string): string {
	const trimmedBase = base?.trim();
	return trimmedBase ? `${trimmedBase}\n\n${extra}` : extra;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath);
		return true;
	} catch {
		return false;
	}
}

function buildWorkerAgent(
	baseAgent: AgentConfig,
	thinkingLevel: string,
	exactTarget: boolean,
): AgentConfig {
	return {
		...baseAgent,
		name: "goal-driven-worker",
		description: `Goal-Driven worker based on ${baseAgent.name}`,
		tools: baseAgent.tools,
		fallbackModels: undefined,
		systemPrompt: mergeSystemPrompt(baseAgent.systemPrompt, WORKER_SYSTEM_PROMPT),
		thinking: exactTarget || thinkingLevel === "off" ? undefined : thinkingLevel,
	};
}

function buildVerifierAgent(
	baseAgent: AgentConfig,
	thinkingLevel: string,
	exactTarget: boolean,
): AgentConfig {
	return {
		name: "goal-driven-verifier",
		description: "Read-only Goal-Driven verifier",
		tools: [...VERIFIER_TOOLS],
		mcpDirectTools: [],
		model: baseAgent.model,
		fallbackModels: undefined,
		thinking: exactTarget || thinkingLevel === "off" ? undefined : thinkingLevel,
		systemPrompt: VERIFIER_SYSTEM_PROMPT,
		source: baseAgent.source,
		filePath: baseAgent.filePath,
		skills: undefined,
		extensions: [],
		output: undefined,
		defaultReads: undefined,
		defaultProgress: false,
		interactive: false,
		maxSubagentDepth: baseAgent.maxSubagentDepth,
		extraFields: undefined,
		override: undefined,
	};
}

function summarizeSingleResult(result: SingleResult): string {
	const output = getSingleResultOutput(result).trim();
	if (output) return truncate(output);
	if (result.error?.trim()) return truncate(result.error);
	return "No assistant output.";
}

function summarizeProgressUpdate(update: ProgressUpdate, fallbackAgent: string): string {
	const progress = update.details?.progress?.[0] ?? update.details?.results?.[0]?.progress;
	if (progress) {
		if (progress.currentTool) {
			const args = progress.currentToolArgs ? ` ${singleLine(progress.currentToolArgs, 60)}` : "";
			return `${progress.agent}: ${progress.currentTool}${args}`;
		}
		const recentOutput = progress.recentOutput.find((line) => line.trim().length > 0);
		if (recentOutput) return `${progress.agent}: ${singleLine(recentOutput, 120)}`;
		if (progress.status) return `${progress.agent}: ${progress.status}`;
	}

	const text = update.content?.find((part) => part.type === "text" && typeof part.text === "string")?.text;
	return `${fallbackAgent}: ${singleLine(text ?? "Working...", 120)}`;
}

function buildHistoryBlock(history: AttemptRecord[]): string {
	if (history.length === 0) return "No previous attempts.";

	return history
		.slice(-HISTORY_LIMIT)
		.map((item) => {
			const duration = Math.max(0, item.finishedAt - item.startedAt);
			const nextActions = item.verdict === "MET" ? "Goal met." : item.verifierSummary;
			return [
				`Attempt ${item.attempt} (${Math.round(duration / 1_000)}s)`,
				`Why it ended: ${item.reason}`,
				`Worker summary: ${item.workerSummary}`,
				`Verifier: ${nextActions}`,
			].join("\n");
		})
		.join("\n\n");
}

function buildWorkerTask(run: ActiveRun): string {
	return [
		`Goal:\n${run.goal}`,
		`Criteria for success:\n${run.criteria}`,
		`Current attempt: #${run.attempt}`,
		`Previous attempt notes:\n${buildHistoryBlock(run.history)}`,
		`Reference Goal-Driven prompt:\n${run.filledPrompt}`,
		"Continue from the current workspace state and make concrete progress now.",
	].join("\n\n");
}

function buildVerifierTask(run: ActiveRun, workerSummary: string, reason: string): string {
	return [
		`Goal:\n${run.goal}`,
		`Criteria for success:\n${run.criteria}`,
		`The latest subagent attempt ended because: ${reason}`,
		`Subagent final output:\n${workerSummary || "(no assistant output)"}`,
		"Inspect the current workspace and decide whether the criteria are already met.",
	].join("\n\n");
}

function attemptStatusLabel(status: AttemptStatus): string {
	switch (status) {
		case "success":
			return "met";
		case "inactive":
			return "inactive";
		case "worker_failed":
			return "failed";
		default:
			return "retry";
	}
}

function attemptStatusColor(theme: Theme, status: AttemptStatus): string {
	if (status === "success") return theme.fg("success", attemptStatusLabel(status));
	if (status === "inactive") return theme.fg("warning", attemptStatusLabel(status));
	if (status === "worker_failed") return theme.fg("error", attemptStatusLabel(status));
	return theme.fg("warning", attemptStatusLabel(status));
}

function currentPhaseLabel(run: ActiveRun): string {
	if (run.state === "running") return "running";
	if (run.state === "verifying") return "verifying";
	return "stopping";
}

function hasInFlightAttempt(run: ActiveRun): boolean {
	return run.attempt > run.history.length && !run.stopRequested;
}

function getAttemptCounts(run: ActiveRun): {
	started: number;
	met: number;
	retry: number;
	failed: number;
	inactive: number;
} {
	const met = run.history.filter((item) => item.status === "success").length;
	const retry = run.history.filter((item) => item.status === "not_met").length;
	const failed = run.history.filter((item) => item.status === "worker_failed").length;
	const inactive = run.history.filter((item) => item.status === "inactive").length;
	return {
		started: run.attempt,
		met,
		retry,
		failed,
		inactive,
	};
}

function extractSectionBullets(text: string, section: "SUMMARY" | "OPEN_ISSUES"): string[] {
	const match = text.match(new RegExp(`${section}:([\\s\\S]*?)(?:\\n[A-Z_]+:|$)`));
	if (!match) return [];
	return match[1]
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "))
		.map((line) => line.slice(2).trim())
		.filter((line) => line.length > 0 && line !== "none");
}

function firstMeaningfulLine(text: string): string | undefined {
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line === "GOAL_DRIVEN_STATUS: READY_FOR_VERIFICATION") continue;
		if (line === "SUMMARY:" || line === "OPEN_ISSUES:") continue;
		if (line.startsWith("```")) continue;
		if (line.startsWith("- ")) return line.slice(2).trim();
		return line;
	}
	return undefined;
}

function summarizeAttempt(status: AttemptStatus, verification: VerificationResult, reason: string, workerSummary: string): string {
	const summaryBullets = extractSectionBullets(workerSummary, "SUMMARY");
	const issueBullets = extractSectionBullets(workerSummary, "OPEN_ISSUES");
	const workerDescription = summaryBullets[0] ?? issueBullets[0] ?? firstMeaningfulLine(workerSummary);
	if (status === "success") return singleLine(workerDescription ?? verification.summary, 220);
	if (status === "worker_failed") return singleLine(workerDescription ?? reason, 220);
	if (status === "inactive") return singleLine(workerDescription ?? verification.summary ?? reason, 220);
	const nextAction = verification.nextActions[0];
	if (workerDescription && nextAction) return singleLine(`${workerDescription} → ${nextAction}`, 220);
	return singleLine(workerDescription ?? nextAction ?? verification.summary ?? reason, 220);
}

function padCell(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…", true);
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function appendRightAlignedAdaptiveHint(left: string, width: number, theme: Theme, hints: string[]): string {
	for (const candidate of hints) {
		const hint = theme.fg("dim", candidate);
		const leftWidth = visibleWidth(left);
		const hintWidth = visibleWidth(hint);
		if (leftWidth + hintWidth <= width) {
			return left + " ".repeat(Math.max(0, width - leftWidth - hintWidth)) + hint;
		}
		const availableLeftWidth = Math.max(0, width - hintWidth);
		const truncatedLeft = truncateToWidth(left, availableLeftWidth, "…", true);
		const truncatedLeftWidth = visibleWidth(truncatedLeft);
		if (truncatedLeftWidth + hintWidth <= width) {
			return truncatedLeft + " ".repeat(Math.max(0, width - truncatedLeftWidth - hintWidth)) + hint;
		}
	}
	return truncateToWidth(left, width, "…", true);
}

function runTitle(run: ActiveRun): string {
	return `🔬 goal-driven: ${run.goal}`;
}

function liveSummary(run: ActiveRun): string {
	if (run.state === "verifying") return run.lastVerifierSummary ?? run.lastEvent;
	return run.lastEvent;
}

function currentAttemptElapsedMs(run: ActiveRun): number {
	if (activeRun === run && hasInFlightAttempt(run) && !run.stopRequested) {
		return Math.max(0, Date.now() - run.attemptStartedAt);
	}
	const completedAttempt = [...run.history].reverse().find((item) => item.attempt === run.attempt);
	if (completedAttempt) return Math.max(0, completedAttempt.finishedAt - completedAttempt.startedAt);
	return Math.max(0, run.lastActivityAt - run.attemptStartedAt);
}

function renderCompactWidgetLines(run: ActiveRun, theme: Theme, width: number): string[] {
	const counts = getAttemptCounts(run);
	const left = [
		theme.fg("accent", "🔬 goal-driven"),
		theme.fg("muted", ` ${counts.started} runs`),
		theme.fg("success", ` ${counts.met} met`),
		counts.retry > 0 ? theme.fg("warning", ` ${counts.retry} retry`) : "",
		counts.failed > 0 ? theme.fg("error", ` ${counts.failed} failed`) : "",
		counts.inactive > 0 ? theme.fg("warning", ` ${counts.inactive} inactive`) : "",
		theme.fg("dim", " │ "),
		theme.fg("warning", theme.bold(`★ active: #${run.attempt} ${currentPhaseLabel(run)} ${formatElapsed(currentAttemptElapsedMs(run))}`)),
		theme.fg("dim", " │ "),
		theme.fg("muted", singleLine(liveSummary(run), 120)),
	].join("");
	return [
		appendRightAlignedAdaptiveHint(left, width, theme, [
			"ctrl+x expand • ctrl+shift+x fullscreen",
			"ctrl+x expand • full: c-s-x",
			"ctrl+x • c-s-x",
		]),
	];
}

function renderDashboardBodyLines(run: ActiveRun, theme: Theme, width: number, maxRows = DASHBOARD_MAX_ROWS, headerHint?: string): string[] {
	const counts = getAttemptCounts(run);
	const lines: string[] = [];
	lines.push(
		truncateToWidth(
			`  ${theme.fg("muted", "Runs:")} ${theme.fg("text", String(counts.started))}` +
				`  ${theme.fg("success", `${counts.met} met`)}` +
				(counts.retry > 0 ? `  ${theme.fg("warning", `${counts.retry} retry`)}` : "") +
				(counts.failed > 0 ? `  ${theme.fg("error", `${counts.failed} failed`)}` : "") +
				(counts.inactive > 0 ? `  ${theme.fg("warning", `${counts.inactive} inactive`)}` : ""),
			width,
			"…",
			true,
		),
	);
	lines.push(
		truncateToWidth(
			`  ${theme.fg("muted", "Active:")} ${theme.fg("warning", `★ #${run.attempt} ${currentPhaseLabel(run)} ${formatElapsed(currentAttemptElapsedMs(run))}`)}`,
			width,
			"…",
			true,
		),
	);
	lines.push(
		truncateToWidth(
			`  ${theme.fg("muted", "Live:")} ${theme.fg("text", singleLine(liveSummary(run), 220))}`,
			width,
			"…",
			true,
		),
	);
	lines.push(
		truncateToWidth(
			`  ${theme.fg("muted", "Criteria:")} ${theme.fg("muted", singleLine(run.criteria, 220))}`,
			width,
			"…",
			true,
		),
	);
	lines.push("");

	const idxWidth = 4;
	const durWidth = 9;
	const resultWidth = 12;
	const summaryWidth = Math.max(20, width - idxWidth - durWidth - resultWidth - 6);
	const headerLine =
		`  ${theme.fg("muted", padCell("#", idxWidth))}` +
		`${theme.fg("muted", padCell("duration", durWidth))}` +
		`${theme.fg("muted", padCell("result", resultWidth))}` +
		`${theme.fg("muted", "description")}`;
	lines.push(
		headerHint
			? appendRightAlignedAdaptiveHint(headerLine, width, theme, [headerHint, "ctrl+x • c-s-x"])
			: truncateToWidth(headerLine, width, "…", true),
	);
	lines.push(truncateToWidth(`  ${theme.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`, width, "…", true));

	const effectiveMax = maxRows <= 0 ? run.history.length : maxRows;
	const start = Math.max(0, run.history.length - effectiveMax);
	if (start > 0) {
		lines.push(truncateToWidth(`  ${theme.fg("dim", `… ${start} earlier experiment${start === 1 ? "" : "s"}`)}`, width, "…", true));
	}

	for (const item of run.history.slice(start)) {
		const duration = formatElapsed(item.finishedAt - item.startedAt);
		const row =
			`  ${theme.fg("dim", padCell(String(item.attempt), idxWidth))}` +
			`${theme.fg("text", padCell(duration, durWidth))}` +
			`${padCell(attemptStatusColor(theme, item.status), resultWidth)}` +
			`${theme.fg("muted", truncateToWidth(item.summary, summaryWidth, "…", true))}`;
		lines.push(truncateToWidth(row, width, "…", true));
	}

	if (hasInFlightAttempt(run)) {
		const spinner = OVERLAY_SPINNER[Math.floor(Date.now() / 120) % OVERLAY_SPINNER.length] ?? "•";
		const row =
			`  ${theme.fg("dim", padCell(String(run.attempt), idxWidth))}` +
			`${theme.fg("warning", padCell(formatElapsed(currentAttemptElapsedMs(run)), durWidth))}` +
			`${padCell(theme.fg("warning", `${spinner} ${currentPhaseLabel(run)}`), resultWidth)}` +
			`${theme.fg("text", truncateToWidth(singleLine(liveSummary(run), 220), summaryWidth, "…", true))}`;
		lines.push(truncateToWidth(row, width, "…", true));
	}

	return lines;
}

function renderExpandedWidgetLines(run: ActiveRun, theme: Theme, width: number, maxRows = DASHBOARD_MAX_ROWS, headerHint?: string): string[] {
	const title = truncateToWidth(runTitle(run), Math.max(0, width - 8), "…", true);
	const fillLen = Math.max(0, width - 3 - 1 - visibleWidth(title) - 1);
	return [
		truncateToWidth(
			theme.fg("borderMuted", "───") +
				theme.fg("accent", ` ${title} `) +
				theme.fg("borderMuted", "─".repeat(fillLen)),
			width,
			"…",
			true,
		),
		...renderDashboardBodyLines(run, theme, width, maxRows, headerHint),
	];
}

function buildStatusLines(run: ActiveRun): string[] {
	const counts = getAttemptCounts(run);
	const lines = [
		`🎯 Goal-Driven (${run.state})`,
		`Subagent profile: ${run.agentName}`,
		`Model: ${run.modelConfig.primary ?? "inherit current Pi model"}${run.modelConfig.exactTarget ? " (configured)" : ""}`,
		`Goal: ${singleLine(run.goal, 120)}`,
		`Criteria: ${singleLine(run.criteria, 120)}`,
		`Experiments: ${counts.started} started, ${counts.met} met, ${counts.retry} retry, ${counts.failed} failed, ${counts.inactive} inactive`,
		`Current attempt: #${run.attempt} ${currentPhaseLabel(run)} (${formatElapsed(currentAttemptElapsedMs(run))})`,
		`Last activity: ${formatDuration(Date.now() - run.lastActivityAt)}`,
		`Last event: ${singleLine(run.lastEvent, 120)}`,
		`Logs: ${run.debugDir}`,
	];

	for (const item of run.history.slice(-5).reverse()) {
		lines.push(
			`Experiment #${item.attempt} ${attemptStatusLabel(item.status)} (${formatElapsed(item.finishedAt - item.startedAt)}): ${singleLine(item.summary, 120)}`,
		);
	}

	return lines;
}

function getDisplayRun(): ActiveRun | null {
	return activeRun ?? latestArchivedRun;
}

function clearUiStatus(): void {
	if (!latestCtx?.hasUI || !latestCtx.ui) return;
	latestCtx.ui.setStatus(COMMAND_NAME, undefined);
	latestCtx.ui.setWidget(COMMAND_NAME, undefined);
}

function refreshUiStatus(): void {
	if (!latestCtx?.hasUI || !latestCtx.ui) return;
	if (!activeRun) {
		clearUiStatus();
		return;
	}

	const run = activeRun;
	const counts = getAttemptCounts(run);
	const label = run.state === "running"
		? `🔬 ${counts.started} runs`
		: run.state === "verifying"
			? `🔎 #${run.attempt} verifying`
			: "⏹ stopping";
	latestCtx.ui.setStatus(COMMAND_NAME, label);
	latestCtx.ui.setWidget(COMMAND_NAME, (tui, theme) => ({
		render(width: number): string[] {
			const safeWidth = Math.max(1, width || getTuiSize(tui).width);
			return run.dashboardExpanded
				? renderExpandedWidgetLines(run, theme, safeWidth, safeWidth < 95 ? 4 : DASHBOARD_MAX_ROWS, "ctrl+x collapse • ctrl+shift+x fullscreen")
				: renderCompactWidgetLines(run, theme, safeWidth);
		},
		invalidate(): void {},
	}));
}

function notify(message: string, level: "info" | "warning" | "error" = "info"): void {
	latestCtx?.ui?.notify(message, level);
}

function finalizeRun(run: ActiveRun | null, message?: string, level: "info" | "warning" | "error" = "info"): void {
	if (!run) return;
	if (run.statusTimer) clearInterval(run.statusTimer);
	if (run.currentAbort) run.currentAbort.abort();
	latestArchivedRun = cloneArchivedRun(toPersistedRunSnapshot(run));
	void persistRunSnapshot(run);
	if (activeRun === run) activeRun = null;
	clearUiStatus();
	if (message) notify(message, level);
}

function requestStop(reason: string): boolean {
	if (!activeRun) return false;
	activeRun.stopRequested = true;
	activeRun.stopReason = reason;
	activeRun.state = "stopping";
	activeRun.lastEvent = reason;
	activeRun.currentAbort?.abort();
	refreshUiStatus();
	return true;
}

async function runManagedSubagent(
	run: ActiveRun,
	agent: AgentConfig,
	task: string,
	phase: "worker" | "verifier",
): Promise<ManagedSingleRun> {
	const controller = new AbortController();
	run.currentAbort = controller;
	let lastActivityAt = Date.now();
	let killedForInactivity = false;
	const shouldWatchInactivity = phase === "worker";
	const attemptDir = path.join(run.debugDir, `${String(run.attempt).padStart(3, "0")}-${phase}-${sanitizePathSegment(agent.name)}`);
	const sessionDir = path.join(attemptDir, "session");
	const artifactsDir = path.join(attemptDir, "artifacts");
	const outputPath = path.join(attemptDir, "output.md");
	await mkdir(sessionDir, { recursive: true });
	await mkdir(artifactsDir, { recursive: true });

	const interval = shouldWatchInactivity
		? setInterval(() => {
			if (run.stopRequested || controller.signal.aborted) return;
			if (Date.now() - lastActivityAt < INACTIVITY_WINDOW_MS) return;
			killedForInactivity = true;
			run.lastActivityAt = Date.now();
			run.lastEvent = "Subagent inactive for 5 minutes; restarting.";
			refreshUiStatus();
			controller.abort();
		}, INACTIVITY_CHECK_MS)
		: undefined;

	try {
		const runOptions = {
			cwd: run.cwd,
			signal: controller.signal,
			runId: `goal-driven-${phase}-${run.attempt}-${randomUUID().slice(0, 8)}`,
			modelOverride: run.modelConfig.primary,
			sessionDir,
			artifactsDir,
			artifactConfig: {
				enabled: true,
				includeInput: true,
				includeOutput: true,
				includeJsonl: true,
				includeMetadata: true,
			},
			outputPath,
			onUpdate: (update: unknown) => {
				lastActivityAt = Date.now();
				run.lastActivityAt = lastActivityAt;
				run.lastEvent = summarizeProgressUpdate(update as ProgressUpdate, agent.name);
				refreshUiStatus();
			},
		} as any;
		const result = await runSync(run.cwd, [agent], agent.name, task, runOptions);

		return { result, killedForInactivity };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			result: {
				agent: agent.name,
				task,
				exitCode: 1,
				messages: [],
				usage: emptyUsage(),
				error: message,
				finalOutput: "",
			},
			killedForInactivity,
		};
	} finally {
		if (interval) clearInterval(interval);
		if (run.currentAbort === controller) run.currentAbort = undefined;
	}
}

async function runVerification(run: ActiveRun, verifierAgent: AgentConfig, workerSummary: string, reason: string): Promise<VerificationResult> {
	const verificationRun = await runManagedSubagent(run, verifierAgent, buildVerifierTask(run, workerSummary, reason), "verifier");
	const text = summarizeSingleResult(verificationRun.result);
	return parseVerificationOutput(text);
}

async function supervise(run: ActiveRun, baseAgent: AgentConfig): Promise<void> {
	const workerAgent = buildWorkerAgent(
		baseAgent,
		run.thinkingLevel,
		run.modelConfig.exactTarget,
	);
	const verifierAgent = buildVerifierAgent(
		baseAgent,
		run.thinkingLevel,
		run.modelConfig.exactTarget,
	);

	run.statusTimer = setInterval(() => {
		if (activeRun === run) refreshUiStatus();
	}, STATUS_REFRESH_MS);

	refreshUiStatus();
	notify(`Goal-Driven started with '${run.agentName}'. Use Ctrl+X for the experiment list and Ctrl+Shift+X for fullscreen.`, "info");

	while (!run.stopRequested) {
		run.attempt += 1;
		run.state = "running";
		run.lastActivityAt = Date.now();
		run.lastEvent = `Starting ${run.agentName} attempt #${run.attempt}`;
		refreshUiStatus();

		run.attemptStartedAt = Date.now();
		const attemptStartedAt = run.attemptStartedAt;
		const workerRun = await runManagedSubagent(run, workerAgent, buildWorkerTask(run), "worker");
		if (run.stopRequested) break;

		const workerSummary = summarizeSingleResult(workerRun.result);
		const reason = workerRun.killedForInactivity
			? "the subagent was inactive for 5 minutes"
			: workerRun.result.exitCode === 0
				? "the subagent stopped and requested verification"
				: workerRun.result.error
					? `the subagent failed: ${singleLine(workerRun.result.error, 120)}`
					: `the subagent exited with code ${workerRun.result.exitCode}`;
		run.lastWorkerSummary = workerSummary;
		run.lastFailureReason = reason;

		run.state = "verifying";
		run.lastActivityAt = Date.now();
		run.lastEvent = `Verifying after attempt #${run.attempt}`;
		refreshUiStatus();

		const verification = await runVerification(run, verifierAgent, workerSummary, reason);
		if (run.stopRequested) break;

		run.lastVerifierSummary = verification.summary;
		const attemptStatus: AttemptStatus = verification.verdict === "MET"
			? "success"
			: workerRun.killedForInactivity
				? "inactive"
				: workerRun.result.exitCode === 0
					? "not_met"
					: "worker_failed";
		const attemptSummary = summarizeAttempt(attemptStatus, verification, reason, workerSummary);
		const attemptRecord: AttemptRecord = {
			attempt: run.attempt,
			status: attemptStatus,
			reason,
			summary: attemptSummary,
			workerSummary: singleLine(workerSummary, 280),
			verifierSummary: singleLine(
				verification.verdict === "MET"
					? verification.summary
					: [verification.summary, ...verification.nextActions].join(" "),
				280,
			),
			nextActions: verification.nextActions,
			verdict: verification.verdict,
			startedAt: attemptStartedAt,
			finishedAt: Date.now(),
		};
		run.history.push(attemptRecord);
		latestArchivedRun = cloneArchivedRun(toPersistedRunSnapshot(run));
		await appendAttemptRecord(run, attemptRecord);
		await persistRunSnapshot(run);

		if (verification.verdict === "MET") {
			finalizeRun(run, `Goal-Driven succeeded: ${verification.summary}`, "info");
			return;
		}

		run.lastActivityAt = Date.now();
		run.lastEvent = `Criteria not met after attempt #${run.attempt}; restarting.`;
		refreshUiStatus();
		notify(
			`Attempt #${run.attempt} did not meet the criteria. Restarting ${run.agentName}. Reason: ${singleLine(reason, 120)} Verifier: ${singleLine(verification.summary, 120)} Logs: ${run.debugDir}`,
			"warning",
		);
	}

	finalizeRun(run, run.stopReason ?? "Goal-Driven stopped.", "info");
}

function getStatusText(): string {
	const run = getDisplayRun();
	if (!run) return "No Goal-Driven run is active.";
	const prefix = activeRun ? "Active run" : "Last archived run";
	return `${prefix}\n${buildStatusLines(run).join("\n")}`;
}

async function collectGoalDrivenInput(ctx: ExtensionContext, agentName: string): Promise<SetupResult | null> {
	const goal = (await ctx.ui.input("Goal", `Describe what '${agentName}' should accomplish`))?.trim();
	if (!goal) return null;

	const criteria = (await ctx.ui.input(
		"Criteria for success",
		"Describe the observable checks that prove the goal is done",
	))?.trim();
	if (!criteria) return null;

	return { goal, criteria, agentName };
}

export default function goalDriven(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		latestArchivedRun = await restoreLatestArchivedRun();
		refreshUiStatus();
	});

	pi.on("session_shutdown", async () => {
		if (activeRun) {
			requestStop("Pi session ended.");
			finalizeRun(activeRun);
		}
		latestCtx = null;
	});

	pi.registerCommand(`${COMMAND_NAME}:setup`, {
		description: `Copy the default ${EXTENSION_NAME} config to ${GLOBAL_CONFIG_PATH}`,
		handler: async (_args, ctx) => {
			if (await pathExists(GLOBAL_CONFIG_PATH)) {
				ctx.ui.notify(`[${EXTENSION_NAME}] Config already exists at ${GLOBAL_CONFIG_PATH}`, "warning");
				return;
			}

			await copyBundledConfig(GLOBAL_CONFIG_PATH);
			ctx.ui.notify(`[${EXTENSION_NAME}] Config copied to ${GLOBAL_CONFIG_PATH}`, "info");
		},
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Start or manage a Goal-Driven master/subagent run",
		getArgumentCompletions(prefix) {
			return ["setup", "status", "stop"]
				.filter((item) => item.startsWith(prefix))
				.map((item) => ({ value: item, label: item }));
		},
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const action = args.trim().toLowerCase();

			if (action === "setup") {
				if (await pathExists(GLOBAL_CONFIG_PATH)) {
					ctx.ui.notify(`[${EXTENSION_NAME}] Config already exists at ${GLOBAL_CONFIG_PATH}`, "warning");
					return;
				}

				await copyBundledConfig(GLOBAL_CONFIG_PATH);
				ctx.ui.notify(`[${EXTENSION_NAME}] Config copied to ${GLOBAL_CONFIG_PATH}`, "info");
				return;
			}

			if (action === "status") {
				ctx.ui.notify(getStatusText(), "info");
				return;
			}

			if (action === "stop") {
				if (!requestStop("Stopped by user.")) {
					ctx.ui.notify("No Goal-Driven run is active.", "info");
					return;
				}
				ctx.ui.notify("Stopping Goal-Driven run...", "info");
				return;
			}

			if (action.length > 0) {
				ctx.ui.notify("Usage: /goal-driven, /goal-driven setup, /goal-driven status, or /goal-driven stop", "warning");
				return;
			}

			if (activeRun) {
				ctx.ui.notify(getStatusText(), "info");
				return;
			}

			if (!(await hasGlobalPiSubagentsInstalled())) {
				ctx.ui.notify(
					`Missing global pi-subagents install. Install and enable pi-subagents first (expected either ${GLOBAL_SUBAGENTS_EXTENSION_PATH} or a pi-subagents entry in ${GLOBAL_SETTINGS_PATH}).`,
					"error",
				);
				return;
			}

			const discovered = discoverAgents(ctx.cwd, "both").agents;
			if (discovered.length === 0) {
				ctx.ui.notify("No pi-subagents agents were found. Install and configure pi-subagents first.", "error");
				return;
			}

			const { config, path: configPath } = await loadGoalDrivenConfig(ctx);
			if (!ctx.model && !(config.provider && config.model)) {
				ctx.ui.notify("Select a model before starting Goal-Driven, or configure provider/model in pi-goal-driven config.", "error");
				return;
			}
			const selectedAgent = selectConfiguredAgent(discovered, config.defaultAgent);
			if (selectedAgent.fallbackUsed) {
				ctx.ui.notify(
					`[${EXTENSION_NAME}] Configured defaultAgent '${selectedAgent.requestedName}' was not found in ${configPath}. Using '${selectedAgent.agent.name}'.`,
					"warning",
				);
			}

			const setup = await collectGoalDrivenInput(ctx, selectedAgent.agent.name);
			if (!setup) {
				ctx.ui.notify("Goal-Driven start cancelled.", "info");
				return;
			}

			const now = Date.now();
			const run: ActiveRun = {
				goal: setup.goal,
				criteria: setup.criteria,
				filledPrompt: fillPromptTemplate(setup.goal, setup.criteria),
				cwd: ctx.cwd,
				modelConfig: buildRunModelConfig(ctx, config),
				thinkingLevel: pi.getThinkingLevel(),
				startedAt: now,
				attempt: 0,
				attemptStartedAt: now,
				state: "running",
				lastActivityAt: now,
				lastEvent: "Preparing Goal-Driven run",
				history: [],
				dashboardExpanded: false,
				stopRequested: false,
				agentName: selectedAgent.agent.name,
				debugDir: await createRunDebugDir(),
			};
			activeRun = run;
			latestArchivedRun = cloneArchivedRun(toPersistedRunSnapshot(run));
			await persistRunSnapshot(run);

			void supervise(run, selectedAgent.agent).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				finalizeRun(run, `Goal-Driven crashed: ${message}`, "error");
			});
		},
	});

	pi.registerShortcut("ctrl+x", {
		description: "Toggle Goal-Driven experiment dashboard",
		handler: async (ctx) => {
			latestCtx = ctx;
			const run = getDisplayRun();
			if (!run) {
				ctx.ui.notify("No Goal-Driven run is active.", "info");
				return;
			}
			run.dashboardExpanded = !run.dashboardExpanded;
			if (activeRun) refreshUiStatus();
			else ctx.ui.notify(getStatusText(), "info");
		},
	});

	pi.registerShortcut("ctrl+shift+x", {
		description: "Open fullscreen Goal-Driven experiment dashboard",
		handler: async (ctx) => {
			latestCtx = ctx;
			const run = getDisplayRun();
			if (!run) {
				ctx.ui.notify("No Goal-Driven run is active.", "info");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					let scrollOffset = 0;
					let lastViewportRows = 8;
					let lastTotalRows = 0;
					const timer = setInterval(() => tui.requestRender(), 120);

					return {
						render(width: number): string[] {
							const safeWidth = Math.max(1, width || getTuiSize(tui).width);
							const viewportRows = Math.max(8, getTuiSize(tui).height - 4);
							const content = renderExpandedWidgetLines(run, theme, safeWidth, 0);
							lastTotalRows = content.length;
							lastViewportRows = viewportRows;
							const maxScroll = Math.max(0, lastTotalRows - viewportRows);
							scrollOffset = clamp(scrollOffset, 0, maxScroll);
							const visible = content.slice(scrollOffset, scrollOffset + viewportRows);
							const lines = [...visible];
							while (lines.length < viewportRows) lines.push("");
							const scrollInfo = lastTotalRows > viewportRows
								? ` ${scrollOffset + 1}-${Math.min(scrollOffset + viewportRows, lastTotalRows)}/${lastTotalRows}`
								: "";
							const helpText = safeWidth >= 85
								? ` ↑↓/j/k scroll • pgup/pgdn • g/G • esc close${scrollInfo} `
								: ` j/k scroll • esc close${scrollInfo} `;
							const footFill = Math.max(0, safeWidth - visibleWidth(helpText));
							lines.push(
								truncateToWidth(
									theme.fg("borderMuted", "─".repeat(footFill)) + theme.fg("dim", helpText),
									safeWidth,
									"…",
									true,
								),
							);
							return lines;
						},
						handleInput(data: string): void {
							const maxScroll = Math.max(0, lastTotalRows - lastViewportRows);
							if (matchesKey(data, "escape") || data === "q") {
								done(undefined);
								return;
							}
							if (matchesKey(data, "up") || data === "k") scrollOffset = Math.max(0, scrollOffset - 1);
							else if (matchesKey(data, "down") || data === "j") scrollOffset = Math.min(maxScroll, scrollOffset + 1);
							else if (matchesKey(data, "pageUp") || data === "u") scrollOffset = Math.max(0, scrollOffset - lastViewportRows);
							else if (matchesKey(data, "pageDown") || data === "d") scrollOffset = Math.min(maxScroll, scrollOffset + lastViewportRows);
							else if (data === "g") scrollOffset = 0;
							else if (data === "G") scrollOffset = maxScroll;
							tui.requestRender();
						},
						invalidate(): void {},
						dispose(): void {
							clearInterval(timer);
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						width: "95%",
						maxHeight: "90%",
						anchor: "center" as const,
					},
				},
			);
		},
	});
}
