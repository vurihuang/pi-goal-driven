# CHANGELOG

All notable changes to `pi-goal-driven` are documented here.

## 0.4.0 - 2026-04-21

**Version mapping**
- Previous version on `origin/master`: `0.2.0`
- Current latest version in this branch/codebase: `0.4.0`
- Runtime alignment: `pi-subagents` background execution, completion lifecycle, and async widget flow

### Summary

This release updates `/goal-driven:work` so Goal-Driven worker execution behaves like a real `pi-subagents` async run instead of treating the initial `subagent` tool result as task completion.

### Changed

- `/goal-driven:work` now forces worker launches to use:
  - `async: true`
  - `clarify: false`
- Goal-Driven now treats the initial `subagent` tool result as an **async launch acknowledgement**, not as proof that the worker finished.
- Master verification now starts only after the `subagent:complete` event arrives.
- While a worker is already running in background, new worker launches are blocked.
- Worker completion now triggers the next master verification turn automatically.
- README was updated to document the async behavior and `pi-subagents` requirement.

### User-visible behavior difference vs 0.2.0

- In `0.2.0`, the Goal-Driven flow could move to verification immediately after the `subagent` tool returned.
- In `0.4.0`, verification waits for actual async completion.
- In `0.2.0`, `/goal-driven:work` did not reliably line up with the lower `Async subagents` UI behavior.
- In `0.4.0`, the intended progress UI is the native `pi-subagents` async widget.

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
