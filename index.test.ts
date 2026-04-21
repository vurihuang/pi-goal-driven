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
