import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { discoverAgents, type AgentConfig } from "pi-subagents/agents.ts";
import { runSync } from "pi-subagents/execution.ts";
import type { Details, SingleResult, Usage } from "pi-subagents/types.ts";
import { getSingleResultOutput } from "pi-subagents/utils.ts";

const EXTENSION_NAME = "pi-goal-driven";
const COMMAND_NAME = "goal-driven";
const DEFAULT_AGENT_NAME = "worker";
const INACTIVITY_CHECK_MS = 30_000;
const INACTIVITY_WINDOW_MS = 5 * 60_000;
const STATUS_REFRESH_MS = 15_000;
const HISTORY_LIMIT = 3;
const SNIPPET_LIMIT = 1_800;
const VERIFIER_TOOLS = ["read", "bash", "grep", "find", "ls"];

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_CONFIG_PATH = path.join(PACKAGE_DIR, "config.json");
const GLOBAL_AGENT_DIR = getAgentDir();
const GLOBAL_EXTENSION_DIR = path.join(GLOBAL_AGENT_DIR, "extensions", EXTENSION_NAME);
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_EXTENSION_DIR, "config.json");
const GLOBAL_RUNS_DIR = path.join(GLOBAL_EXTENSION_DIR, "runs");
const GLOBAL_SETTINGS_PATH = path.join(GLOBAL_AGENT_DIR, "settings.json");
const GLOBAL_SUBAGENTS_EXTENSION_PATH = path.join(GLOBAL_AGENT_DIR, "extensions", "pi-subagents", "index.ts");
const PROJECT_CONFIG_CANDIDATES = [".pi-goal-driven.json", path.join(".pi", "pi-goal-driven.json")] as const;

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

type ProgressUpdate = {
	content?: Array<{ type?: string; text?: string }>;
	details?: Details;
};

interface GoalDrivenModelTarget {
	provider: string;
	model: string;
}

interface GoalDrivenConfig {
	defaultAgent: string;
	target?: GoalDrivenModelTarget;
}

interface RunModelConfig {
	primary?: string;
	fallbacks: string[];
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
	reason: string;
	workerSummary: string;
	verifierSummary: string;
	verdict: Verdict;
	startedAt: number;
	finishedAt: number;
}

interface ManagedSingleRun {
	result: SingleResult;
	killedForInactivity: boolean;
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
	state: RunState;
	lastActivityAt: number;
	lastEvent: string;
	history: AttemptRecord[];
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

function sanitizePathSegment(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "run";
}

async function createRunDebugDir(): Promise<string> {
	const dir = path.join(GLOBAL_RUNS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

function normalizeConfiguredTarget(raw: unknown): GoalDrivenModelTarget | undefined {
	if (!isRecord(raw)) return undefined;
	const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
	const model = typeof raw.model === "string" ? raw.model.trim() : "";
	if (!provider || !model) return undefined;
	return { provider, model };
}

function normalizeConfig(raw: unknown): GoalDrivenConfig {
	if (!isRecord(raw)) return { ...DEFAULT_CONFIG };
	const defaultAgent = typeof raw.defaultAgent === "string"
		? raw.defaultAgent.trim()
		: typeof raw.agent === "string"
			? raw.agent.trim()
			: "";
	const directTarget = normalizeConfiguredTarget(raw.target);
	const firstTarget = Array.isArray(raw.targets) ? normalizeConfiguredTarget(raw.targets[0]) : undefined;
	const flatTarget = normalizeConfiguredTarget(raw);
	const target = directTarget ?? firstTarget ?? flatTarget;
	return {
		defaultAgent: defaultAgent || DEFAULT_AGENT_NAME,
		...(target ? { target } : {}),
	};
}

async function ensureBundledConfigFile(): Promise<void> {
	if (await pathExists(BUNDLED_CONFIG_PATH)) return;
	await writeFile(BUNDLED_CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
}

async function resolveConfigPath(cwd: string): Promise<string> {
	for (const relativePath of PROJECT_CONFIG_CANDIDATES) {
		const candidatePath = path.join(cwd, relativePath);
		if (await pathExists(candidatePath)) return candidatePath;
	}
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

function buildModelRefs(provider: string | undefined, modelId: string | undefined): string[] {
	if (!provider || !modelId) return [];
	const variants = new Set<string>();
	for (const candidate of [modelId, modelId.replace(/\./g, "-"), modelId.replace(/-/g, ".")]) {
		const normalized = candidate.trim();
		if (normalized) variants.add(`${provider}/${normalized}`);
	}
	return [...variants];
}

function buildRunModelConfig(ctx: ExtensionContext, config: GoalDrivenConfig): RunModelConfig {
	const refs = config.target
		? buildModelRefs(config.target.provider, config.target.model)
		: buildModelRefs(ctx.model?.provider, ctx.model?.id);
	return {
		primary: refs[0],
		fallbacks: refs.slice(1),
		exactTarget: Boolean(config.target),
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

function mergeFallbackModels(...lists: Array<string[] | undefined>): string[] | undefined {
	const merged = new Set<string>();
	for (const list of lists) {
		for (const entry of list ?? []) {
			const normalized = entry.trim();
			if (normalized) merged.add(normalized);
		}
	}
	return merged.size > 0 ? [...merged] : undefined;
}

function buildWorkerAgent(
	baseAgent: AgentConfig,
	thinkingLevel: string,
	modelFallbacks: string[],
	exactTarget: boolean,
): AgentConfig {
	return {
		...baseAgent,
		name: "goal-driven-worker",
		description: `Goal-Driven worker based on ${baseAgent.name}`,
		tools: baseAgent.tools,
		fallbackModels: mergeFallbackModels(modelFallbacks, baseAgent.fallbackModels),
		systemPrompt: mergeSystemPrompt(baseAgent.systemPrompt, WORKER_SYSTEM_PROMPT),
		thinking: exactTarget || thinkingLevel === "off" ? undefined : thinkingLevel,
	};
}

function buildVerifierAgent(
	baseAgent: AgentConfig,
	thinkingLevel: string,
	modelFallbacks: string[],
	exactTarget: boolean,
): AgentConfig {
	return {
		name: "goal-driven-verifier",
		description: "Read-only Goal-Driven verifier",
		tools: [...VERIFIER_TOOLS],
		mcpDirectTools: [],
		model: baseAgent.model,
		fallbackModels: mergeFallbackModels(modelFallbacks, baseAgent.fallbackModels),
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

function buildStatusLines(run: ActiveRun): string[] {
	const lines = [
		`🎯 Goal-Driven (${run.state})`,
		`Subagent profile: ${run.agentName}`,
		`Model: ${run.modelConfig.primary ?? "inherit current Pi model"}${run.modelConfig.exactTarget ? " (exact)" : ""}`,
		`Goal: ${singleLine(run.goal, 120)}`,
		`Attempt: ${run.attempt}`,
		`Started: ${formatDuration(Date.now() - run.startedAt)}`,
		`Last activity: ${formatDuration(Date.now() - run.lastActivityAt)}`,
		`Last event: ${singleLine(run.lastEvent, 120)}`,
		`Criteria: ${singleLine(run.criteria, 120)}`,
		`Logs: ${run.debugDir}`,
	];

	if (run.lastWorkerSummary) {
		lines.push(`Worker: ${singleLine(run.lastWorkerSummary, 120)}`);
	}
	if (run.lastFailureReason) {
		lines.push(`Failure: ${singleLine(run.lastFailureReason, 120)}`);
	}
	if (run.lastVerifierSummary) {
		lines.push(`Verifier: ${singleLine(run.lastVerifierSummary, 120)}`);
	}

	for (const item of run.history.slice(-2).reverse()) {
		lines.push(`History #${item.attempt}: ${singleLine(item.verifierSummary, 120)}`);
	}

	return lines;
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

	const label = activeRun.state === "running"
		? `🎯 ${activeRun.agentName} #${activeRun.attempt}`
		: activeRun.state === "verifying"
			? "🔎 verifying"
			: "⏹ stopping";
	latestCtx.ui.setStatus(COMMAND_NAME, label);
	latestCtx.ui.setWidget(COMMAND_NAME, buildStatusLines(activeRun));
}

function notify(message: string, level: "info" | "warning" | "error" = "info"): void {
	latestCtx?.ui?.notify(message, level);
}

function finalizeRun(run: ActiveRun | null, message?: string, level: "info" | "warning" | "error" = "info"): void {
	if (!run) return;
	if (run.statusTimer) clearInterval(run.statusTimer);
	if (run.currentAbort) run.currentAbort.abort();
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
		run.modelConfig.fallbacks,
		run.modelConfig.exactTarget,
	);
	const verifierAgent = buildVerifierAgent(
		baseAgent,
		run.thinkingLevel,
		run.modelConfig.fallbacks,
		run.modelConfig.exactTarget,
	);

	run.statusTimer = setInterval(() => {
		if (activeRun === run) refreshUiStatus();
	}, STATUS_REFRESH_MS);

	refreshUiStatus();
	notify(`Goal-Driven started with '${run.agentName}'.`, "info");

	while (!run.stopRequested) {
		run.attempt += 1;
		run.state = "running";
		run.lastActivityAt = Date.now();
		run.lastEvent = `Starting ${run.agentName} attempt #${run.attempt}`;
		refreshUiStatus();

		const attemptStartedAt = Date.now();
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
		run.history.push({
			attempt: run.attempt,
			reason,
			workerSummary: singleLine(workerSummary, 280),
			verifierSummary: singleLine(
				verification.verdict === "MET"
					? verification.summary
					: [verification.summary, ...verification.nextActions].join(" "),
				280,
			),
			verdict: verification.verdict,
			startedAt: attemptStartedAt,
			finishedAt: Date.now(),
		});
		if (run.history.length > HISTORY_LIMIT) run.history = run.history.slice(-HISTORY_LIMIT);

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
	if (!activeRun) return "No Goal-Driven run is active.";
	return buildStatusLines(activeRun).join("\n");
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
			if (!ctx.model && !config.target) {
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

			const run: ActiveRun = {
				goal: setup.goal,
				criteria: setup.criteria,
				filledPrompt: fillPromptTemplate(setup.goal, setup.criteria),
				cwd: ctx.cwd,
				modelConfig: buildRunModelConfig(ctx, config),
				thinkingLevel: pi.getThinkingLevel(),
				startedAt: Date.now(),
				attempt: 0,
				state: "running",
				lastActivityAt: Date.now(),
				lastEvent: "Preparing Goal-Driven run",
				history: [],
				stopRequested: false,
				agentName: selectedAgent.agent.name,
				debugDir: await createRunDebugDir(),
			};
			activeRun = run;

			void supervise(run, selectedAgent.agent).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				finalizeRun(run, `Goal-Driven crashed: ${message}`, "error");
			});
		},
	});
}
