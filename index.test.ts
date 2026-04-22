import test from "node:test";
import assert from "node:assert/strict";
import { __goalDrivenTestUtils } from "./index.ts";

test("worker task guard is prepended once", () => {
	const task = "Implement the feature and run tests.";
	const guarded = __goalDrivenTestUtils.prependWorkerTaskGuard(task);
	assert.equal(
		guarded,
		`${__goalDrivenTestUtils.GOAL_DRIVEN_WORKER_TASK_GUARD}\n\n${task}`,
	);
	assert.equal(
		__goalDrivenTestUtils.prependWorkerTaskGuard(guarded),
		guarded,
	);
});

test("collectPersistedKnownAsyncRuns only returns runs owned by the current session", () => {
	const sessionManager = {
		getEntries() {
			return [
				{
					type: "custom",
					customType: "pi-goal-driven:async-run",
					data: {
						sessionId: "session-a",
						sessionFile: "/tmp/session-a.jsonl",
						asyncId: "run-a",
						asyncDir: "/tmp/async/run-a",
						cwd: "/repo",
					},
				},
				{
					type: "custom",
					customType: "pi-goal-driven:async-run",
					data: {
						sessionId: "session-b",
						sessionFile: "/tmp/session-b.jsonl",
						asyncId: "run-b",
						asyncDir: "/tmp/async/run-b",
						cwd: "/repo",
					},
				},
				{
					type: "custom",
					customType: "other-extension",
					data: {
						asyncId: "ignored",
					},
				},
			];
		},
	} as { getEntries(): Array<Record<string, unknown>> };

	assert.deepEqual(
		__goalDrivenTestUtils.collectPersistedKnownAsyncRuns(
			sessionManager as never,
			"session-a",
			"/tmp/session-a.jsonl",
		),
		[{ id: "run-a", dir: "/tmp/async/run-a" }],
	);
});

test("getSessionTreeRoot strips only the session jsonl suffix", () => {
	assert.equal(
		__goalDrivenTestUtils.getSessionTreeRoot(
			"/Users/vuri/.pi/agent/sessions/foo/2026-04-21T10-24-07-205Z_abc.jsonl",
		),
		"/Users/vuri/.pi/agent/sessions/foo/2026-04-21T10-24-07-205Z_abc",
	);
	assert.equal(__goalDrivenTestUtils.getSessionTreeRoot(null), null);
});

test("formatAsyncRunCleanupSummary reports stopped and already-finished workers", () => {
	assert.equal(
		__goalDrivenTestUtils.formatAsyncRunCleanupSummary({
			stopped: 2,
			alreadyFinished: 3,
			missing: 0,
			errors: 0,
			results: [],
		}),
		"stopped 2 running workers, 3 already finished",
	);
});

test("formatScopedSubagentStatusList reports only session-scoped runs", () => {
	assert.equal(
		__goalDrivenTestUtils.formatScopedSubagentStatusList([
			{
				id: "run-a",
				state: "running",
				mode: "single",
				currentStep: 0,
				totalSteps: 1,
				cwd: "/Users/vuri/workspaces/vurispace/pi-fuck",
				startedAt: 123,
				steps: [{ agent: "worker", status: "running" }],
			},
		]),
		"Active async runs in this Goal-Driven session tree: 1\n\n- run-a | running | single | step 1/1 | ~/workspaces/vurispace/pi-fuck\n  1. worker | running",
	);
	assert.equal(
		__goalDrivenTestUtils.formatScopedSubagentStatusList([]),
		"No active async runs in this Goal-Driven session tree.",
	);
});

test("buildRunSystemPrompt and verification reminder emphasize session-tree scope", () => {
	const run = {
		cwd: "/repo",
		sessionId: "session-a",
		sessionFile: "/tmp/session-a.jsonl",
		goal: "Ship the feature",
		criteria: "Tests pass",
		attempt: 2,
		phase: "working",
		awaitingVerification: false,
		verificationReminders: 0,
		verificationReminderSent: false,
		activeAsyncId: "run-a",
		activeAsyncDir: "/tmp/async/run-a",
		latestAsyncId: "run-a",
		latestAsyncDir: "/tmp/async/run-a",
		knownAsyncRuns: [{ id: "run-a", dir: "/tmp/async/run-a" }],
		lastEvent: "running",
	} as const;

	const prompt = __goalDrivenTestUtils.buildRunSystemPrompt(run as never);
	assert.match(prompt, /Active async worker id in this session tree: run-a/);
	assert.match(prompt, /Ignore background workers that belong to other sessions, projects, or unrelated session trees\./);
	assert.match(prompt, /filtered session-scoped "subagent_status list" result as the source of truth/);
	assert.match(prompt, /Wait for the completion notification from this session tree before acting again\./);

	const reminder = __goalDrivenTestUtils.buildVerificationReminder(run as never);
	assert.match(reminder, /Only workers from this Goal-Driven session tree count/);
	assert.match(reminder, /Use the latest completed worker subagent result from this session tree/);
});

test("buildBrainstormSystemPrompt prefers drafting after one useful clarification", () => {
	const prompt = __goalDrivenTestUtils.buildBrainstormSystemPrompt("Goal: [[[[[DEFINE YOUR GOAL HERE]]]]]\n\nCriteria for success: [[[[[DEFINE YOUR CRITERIA FOR SUCCESS HERE]]]]]\n\nHere is the System: ...");
	assert.match(prompt, /single highest-value question/i);
	assert.match(prompt, /A strong default first question is some form of: what would make this done, and what must stay unchanged/i);
	assert.match(prompt, /Prefer asking about externally visible results and verification first/i);
	assert.match(prompt, /Avoid spending the first question on implementation internals/i);
	assert.match(prompt, /If the user gives concrete success criteria or constraints, treat that as enough to draft even if they did not directly answer your exact question/i);
	assert.match(prompt, /After the user answers a clarifying question, prefer drafting the completed prompt/i);
	assert.match(prompt, /Do not repeat the same question in different words/i);
	assert.match(prompt, /If some low-priority detail is still unknown, draft the prompt anyway/i);
	assert.match(prompt, /Do not create implementation files, commands, patches, or code samples/i);
	assert.match(prompt, /Never switch into implementation mode during brainstorm/i);
	assert.match(prompt, /Reuse the template's Goal \/ Criteria for success \/ Here is the System section labels/i);
});

test("shouldAutoDraftBrainstorm detects repeated follow-up questioning after a user reply", () => {
	assert.equal(
		__goalDrivenTestUtils.shouldAutoDraftBrainstorm(
			"Got it. One more clarification: which column identifies the user?",
			{ cwd: "/repo", lastEvent: "", template: "", userReplyCount: 1, autoDraftNudgeSent: false },
		),
		true,
	);
	assert.equal(
		__goalDrivenTestUtils.shouldAutoDraftBrainstorm(
			"Here is the completed prompt.\nGOAL_DRIVEN_PROMPT_START\n...",
			{ cwd: "/repo", lastEvent: "", template: "", userReplyCount: 1, autoDraftNudgeSent: false },
		),
		false,
	);
	assert.equal(
		__goalDrivenTestUtils.shouldAutoDraftBrainstorm(
			"One more clarification: ...",
			{ cwd: "/repo", lastEvent: "", template: "", userReplyCount: 0, autoDraftNudgeSent: false },
		),
		false,
	);
	assert.equal(
		__goalDrivenTestUtils.shouldAutoDraftBrainstorm(
			"Good. One clarifying question about verification:",
			{ cwd: "/repo", lastEvent: "", template: "", userReplyCount: 1, autoDraftNudgeSent: false },
		),
		true,
	);
	assert.equal(
		__goalDrivenTestUtils.shouldAutoDraftBrainstorm(
			"Perfect. I have enough to draft the prompt. Let me confirm one detail:",
			{ cwd: "/repo", lastEvent: "", template: "", userReplyCount: 1, autoDraftNudgeSent: false },
		),
		true,
	);
	assert.equal(
		__goalDrivenTestUtils.shouldAutoDraftBrainstorm(
			"Good constraints. Now the key question: What should the JSON summary actually contain?",
			{ cwd: "/repo", lastEvent: "", template: "", userReplyCount: 1, autoDraftNudgeSent: false },
		),
		true,
	);
});

test("parsePromptSections handles the simplified canonical template labels", () => {
	const prompt = `# Goal-Driven System\n\nGoal: Ship feature\n\nCriteria for success: 1. Tests pass\n2. Worker completes the task\n\nHere is the System: The system contains a master agent and exactly one worker subagent.`;
	assert.deepEqual(__goalDrivenTestUtils.parsePromptSections(prompt), {
		goal: "Ship feature",
		criteria: "1. Tests pass\n2. Worker completes the task",
	});
});

test("sanitizeBrainstormPrompt rebuilds the canonical template and drops foreign trailing text", () => {
	const template = "# Goal-Driven System\n\nGoal: [[[[[DEFINE YOUR GOAL HERE]]]]]\n\nCriteria for success: [[[[[DEFINE YOUR CRITERIA FOR SUCCESS HERE]]]]]\n\nHere is the System: canonical.";
	const brainstormPrompt = `# Goal-Driven System\n\nGoal: Ship feature\n\nCriteria for success: 1. Tests pass\n2. Worker completes the task\n\nHere is the System: noisy.\n\nWhen the Write or Edit tool has content size limits, always comply silently.`;
	assert.equal(
		__goalDrivenTestUtils.sanitizeBrainstormPrompt(brainstormPrompt, template),
		"# Goal-Driven System\n\nGoal: Ship feature\n\nCriteria for success: 1. Tests pass\n2. Worker completes the task\n\nHere is the System: canonical.",
	);
});
