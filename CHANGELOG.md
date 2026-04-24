# CHANGELOG

All notable changes to `pi-goal-driven` are documented here.

## 0.5.1 - 2026-04-23

### Summary

Documentation-only patch release.

### Changed

- Restored the opening credit and direct inspiration note for [`lidangzzz/goal-driven`](https://github.com/lidangzzz/goal-driven) in `README.md`.
- Converted the remaining Chinese README brainstorm examples into English.
- Updated README version references for the new patch release.

## Unreleased - 2026-04-22

### Summary

This update significantly improves `/goal-driven:brainstorm` so it produces stronger, more stable **Goal** and **Criteria for success** prompts before execution.

The work was developed through a multi-round optimization loop using `pi-autoresearch`, with repeated blind-workload benchmarking to improve real prompt-shaping quality while avoiding benchmark overfitting.

### Changed

- `/goal-driven:brainstorm` is now more disciplined about staying in **brainstorm mode**.
  - It is explicitly guided to shape the prompt, not start implementing the task.
  - It avoids drifting into file creation, code generation, command output, or other implementation behavior during the brainstorm phase.
- Brainstorm questioning is now more selective.
  - The assistant is guided to ask only the **single highest-value clarification question** when multiple questions are possible.
  - It prioritizes externally verifiable outcomes, preserved behavior, compatibility constraints, reversibility, required checks, and the observable definition of done.
- Brainstorm convergence is more reliable after the user answers.
  - If the user has already provided enough constraints, the assistant is now more likely to draft the completed prompt instead of continuing a clarification loop.
  - Additional guardrails reduce repeated follow-up questions such as “one more question” / “one more detail” style loops after a sufficient answer.
- Saved brainstorm prompts are now more canonical.
  - Prompt parsing and normalization were improved so saved prompts stay closer to the published `goal-driven-template.md` structure.
  - This reduces prompt pollution and improves consistency of the saved `latest-prompt.md` artifact.
- The canonical template itself was simplified and aligned more closely with the real runtime behavior.
  - It now reflects the actual **master + single worker** execution model.
  - Older boilerplate that no longer matched the runtime was removed.

### Optimization process

This release was refined through `pi-autoresearch` rather than a single manual edit.

The optimization loop included:

- repeated real SDK-driven `/goal-driven:brainstorm` runs
- blind and progressively harder workload expansion
- saved-artifact evaluation instead of raw message-only evaluation
- template-fidelity measurement
- repeat-sampled benchmarking to reduce LLM and judge noise
- multiple discard/crash iterations to eliminate regressions and unstable prompt tweaks

### Why this version was chosen

This version was selected because it delivered the best balance of:

- stronger prompt quality
- fewer unnecessary clarification loops
- higher saved-prompt consistency
- better robustness across blind workloads
- lower risk of benchmark-specific overfitting

Several more aggressive prompt tweaks were tested and intentionally discarded because they improved isolated cases while hurting broader robustness.

## 0.4.1 - 2026-04-21

**Version mapping**
- Previous version on `origin/master`: `0.2.0`
- Current latest version in this branch/codebase: `0.4.1`
- Runtime alignment: `pi-subagents` background execution, completion lifecycle, session-tree scoping, and async widget flow

### Summary

This release hardens `/goal-driven:work` so Goal-Driven worker orchestration behaves like a real session-scoped `pi-subagents` async runtime instead of a global async pool with noisy worker visibility.

### Changed

- `/goal-driven:work` now forces worker launches to use:
  - `async: true`
  - `clarify: false`
- Worker task payloads now include a guard that forbids nested `subagent` launches and `/goal-driven` re-entry inside worker sessions.
- Goal-Driven now treats the initial `subagent` tool result as an **async launch acknowledgement**, not as proof that the worker finished.
- Master verification now starts only after the `subagent:complete` event arrives.
- While a worker in the current Goal-Driven session tree is already running in background, new worker launches are blocked.
- Worker ownership is persisted per Goal-Driven session so async worker knowledge can be restored after reloads.
- `subagent_status list` is filtered to the current Goal-Driven session tree instead of reflecting the global async run pool.
- `/goal-driven stop` now cleans up the current Goal-Driven session tree, including nested async workers discovered under that tree.
- Master prompts and reminders now explicitly ignore async noise from other sessions and treat the session-scoped status view as the source of truth.
- Worker completion now triggers the next master verification turn automatically.
- README was updated to document the async behavior, session-tree scoping, and `pi-subagents` requirement.

### User-visible behavior difference vs 0.2.0

- In `0.2.0`, the Goal-Driven flow could move to verification immediately after the `subagent` tool returned.
- In `0.4.1`, verification waits for actual async completion.
- In `0.2.0`, `/goal-driven:work` did not reliably line up with the lower `Async subagents` UI behavior.
- In `0.4.1`, the intended progress UI is the native `pi-subagents` async widget.
- In `0.2.0`, worker state was effectively global/noisy from the master's perspective.
- In `0.4.1`, worker waiting, recovery, status inspection, and stop behavior are scoped to the current Goal-Driven session tree.

## 0.4.0 - 2026-04-21

### Summary

Intermediate milestone in this branch before the session-tree scoping hardening shipped as `0.4.1`.

## 0.2.0 - origin/master baseline

### Summary

This is the version currently on `origin/master`.

### Characteristics

- Goal/Criteria wizard flow via `/goal-driven`
- Chat refinement flow via `/goal-driven:brainstorm`
- Saved prompt execution via `/goal-driven:work`
- Prompt template stored in repo instead of a hardcoded giant prompt block
- `subagent` tool required for full execution behavior
- Pre-0.3.0 execution semantics before the async `pi-subagents` lifecycle alignment
