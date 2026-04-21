# CHANGELOG

All notable changes to `pi-goal-driven` are documented here.

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
