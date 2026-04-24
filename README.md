# pi-goal-driven

[![npm version](https://img.shields.io/npm/v/pi-goal-driven)](https://www.npmjs.com/package/pi-goal-driven)
[![npm downloads](https://img.shields.io/npm/dm/pi-goal-driven)](https://www.npmjs.com/package/pi-goal-driven)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](https://img.shields.io/badge/license-MIT-green.svg)

Special thanks to [lidangzzz/goal-driven](https://github.com/lidangzzz/goal-driven) — it is a great project and the direct inspiration for this package.

Also inspired by [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch).

A minimal Pi extension for running a Goal-Driven master/worker workflow from a reusable template, with worker execution aligned to the `pi-subagents` async runtime.

https://github.com/user-attachments/assets/da5a59bd-7ea8-4a65-a9bb-490461cf5daf

## Version notes

- Previous version on `origin/master`: `0.2.0`
- Current version in this codebase: `0.5.1`
- Detailed release notes: [`CHANGELOG.md`](./CHANGELOG.md)

## What it does

This package provides three focused commands:

1. `/goal-driven` collects **Goal** and **Criteria for Success** with Pi's native UI dialogs
2. `/goal-driven:brainstorm` refines the same template through normal chat
3. `/goal-driven:work` executes the saved Goal-Driven run in the current session

The long prompt lives in `goal-driven-template.md` instead of being embedded directly in a large hardcoded string.

## Commands

### `/goal-driven`

Starts a local overlay wizard.

The extension opens a 3-step flow:

- `Goal`
- `Criteria for Success`
- `Review`

The wizard fills `goal-driven-template.md` locally, lets you review the final prompt in-place, and saves the completed prompt for the current workspace.

If rich overlay UI is unavailable, it falls back to native Pi editors.

When the filled prompt is ready, run:

```text
/goal-driven:work
```

### `/goal-driven:brainstorm`

Starts a chat-based refinement flow for the same template.

Use it when the task is still fuzzy and you want Pi to help shape the final prompt before execution.

Examples:

```text
/goal-driven:brainstorm
/goal-driven:brainstorm create results.txt in the repository root with exactly three lines: alpha, beta, foo
```

When Pi has enough information, it returns a completed template prompt, the extension saves it, and you can run:

```text
/goal-driven:work
```

### `/goal-driven:work`

Loads the latest saved prompt for the current workspace and sends it into the current session.

This is the execution step.

The prompt that gets sent is your filled Goal-Driven template, so Pi can run the master-agent behavior directly in the current conversation.

In the current release, worker execution is aligned to `pi-subagents` background execution:

- worker `subagent` calls are forced to `async: true`
- worker `subagent` calls are forced to `clarify: false`
- worker tasks are prefixed with a guard that forbids nested `subagent` launches and `/goal-driven` re-entry inside the worker session
- the master agent does **not** verify immediately after async launch
- verification starts only after the worker completion event arrives
- while one worker is still running in the current Goal-Driven session tree, additional worker launches are blocked
- `subagent_status list` is filtered to the current Goal-Driven session tree instead of showing global async noise from other sessions or projects
- the lower `Async subagents` panel is expected to come from `pi-subagents`

If `pi-subagents` is not installed or enabled, the prompt can still be sent, but async orchestration will not behave as intended.

### `/goal-driven stop`

Stops the active Goal-Driven flow.

This applies to both active brainstorm flows and active `/goal-driven:work` runs.

For active `/goal-driven:work` runs, stop is session-tree scoped:

- it stops the current Goal-Driven run in memory
- it sends SIGTERM to running workers owned by the current Goal-Driven session tree
- it also cleans up nested async workers discovered under that same session tree
- its completion message summarizes what happened, for example: stopped running workers, already-finished workers, missing runs, or cleanup errors

## Template file

The canonical template lives in:

```text
goal-driven-template.md
```

That file is published with the package and read at runtime.

## Saved prompts

Filled prompts are stored under:

```text
~/.pi/agent/extensions/pi-goal-driven/prompts/<workspace>/latest-prompt.md
```

Each workspace keeps its own latest saved prompt.

## Requirements

- Pi
- `pi-subagents` installed and enabled
  - provides the `subagent` tool
  - provides background execution support
  - provides the lower `Async subagents` widget
  - provides the `subagent:complete` lifecycle used by `/goal-driven:work`

## Install

```bash
pi install npm:pi-subagents
pi install npm:pi-goal-driven
```

For local development:

```bash
pi install /path/to/pi-subagents
pi install /path/to/pi-goal-driven
```

## Recommended usage

The current recommended usage is:

1. Define a concrete **Goal** and strict **Criteria for Success**
2. Save the Goal-Driven prompt with either:
   - `/goal-driven` for a direct wizard flow
   - `/goal-driven:brainstorm ...` for a chat-shaped planning flow
3. Run `/goal-driven:work`
4. Let the worker run through `pi-subagents` in background
5. Watch the lower `Async subagents` panel for progress
6. Wait for the master to verify results after worker completion
7. If the criteria are still not met, the master launches another background worker attempt automatically

Important runtime note:

- the master only treats workers from the current Goal-Driven session tree as relevant
- other async runs from unrelated sessions or projects are ignored for waiting, blocking, recovery, and verification decisions
- when the master checks worker status, the session-scoped `subagent_status list` view is the source of truth

In short:

- use `/goal-driven` when you already know the task and checks
- use `/goal-driven:brainstorm` when the task is still fuzzy
- use `/goal-driven:work` only after the prompt is saved and ready

## Examples

### Example 1: simple

Use this when the task is small, concrete, and already well-specified.

```text
/goal-driven
```

Then fill the wizard with something like:

**Goal**

```text
Create a script that reads all CSV files under data/ and writes leaderboard.txt with totals per user.
```

**Criteria for Success**

```text
1. Running `python3 build_leaderboard.py` exits successfully.
2. `leaderboard.txt` is created in the project root.
3. The output is sorted by total score descending.
4. Only `.csv` files are processed.
5. The master agent verifies the output after worker completion.
```

Then execute:

```text
/goal-driven:work
```

What happens next:

- the worker starts in background via `pi-subagents`
- the lower `Async subagents` panel shows progress
- when the worker finishes, the master verifies the criteria
- if anything is still missing, another worker attempt is launched automatically

### Example 2: brainstormed

Use this when you want chat-based refinement to turn a short request into a precise Goal-Driven prompt before execution.

```text
/goal-driven:brainstorm create results.txt in the repository root with exactly three lines: alpha, beta, foo
```

Typical result of the brainstorm phase:

- Pi rewrites the request into a concrete Goal
- Pi expands the task into explicit, verifiable success criteria
- the prompt is saved for the current workspace

For this example, a typical generated prompt looks like:

```text
Goal: Create `results.txt` in the repository root with exactly three lines: `alpha`, `beta`, and `foo`, one value per line and in that order.

Criteria for success:
1. `results.txt` exists in the workspace.
2. Line 1 of `results.txt` is exactly `alpha`.
3. Line 2 of `results.txt` is exactly `beta`.
4. Line 3 of `results.txt` is exactly `foo`.
5. `results.txt` contains no additional content beyond those three lines.
6. The master agent reads and verifies `results.txt` directly before declaring success.
```

Then execute:

```text
/goal-driven:work
```

What happens next:

- the worker starts in background via `pi-subagents`
- the master waits for that worker to finish
- the master reads `results.txt` directly instead of trusting the worker's self-report
- the run ends only after the master can output `GOAL_DRIVEN_VERDICT: MET`

## Design goal

Keep the package thin.

- Template in a file
- Prompt generation in the current session
- Execution in the current session
- Worker runtime delegated to `pi-subagents`
- Async progress UI delegated to `pi-subagents`
- No ask-user extension dependency
- No embedded subagent runtime in this package

## Comparison with `snarktank/ralph`

Both projects aim to make long-running AI-assisted work more reliable, but they solve different layers of the problem.

### High-level positioning

- **`pi-goal-driven`** is a **Pi-native extension**.
  - It stays inside the current Pi session.
  - It collects a Goal and Criteria for Success.
  - It lets a master agent coordinate background worker attempts through `pi-subagents`.
- **[`snarktank/ralph`](https://github.com/snarktank/ralph)** is a **repository-level autonomous loop**.
  - It runs as a shell script.
  - It repeatedly launches fresh Amp or Claude Code sessions.
  - It advances work story by story from a structured `prd.json` backlog.

### Core execution model

| Dimension | `pi-goal-driven` | `ralph` |
|---|---|---|
| Main runtime | Pi extension command flow | Bash loop (`ralph.sh`) |
| Agent topology | 1 master agent + 1 background worker at a time | Repeated fresh single-agent iterations |
| Execution boundary | Inside the current Pi conversation | Outside the chat, via repeated CLI invocations |
| Retry model | Master verifies after worker completion, then relaunches if criteria are not met | Loop picks next failing story and starts another clean iteration |
| State continuity | Current session context + saved prompt + async run state | Fresh context every iteration, with persistence via git, `progress.txt`, and `prd.json` |
| Progress UI | Delegated to Pi / `pi-subagents` async panel | CLI / git / files |

### Planning input and task framing

`pi-goal-driven` is centered around a **single goal-oriented prompt**:

- the user defines one Goal
- the user defines explicit Criteria for Success
- the extension fills `goal-driven-template.md`
- `/goal-driven:work` executes that saved prompt

`ralph` is centered around a **task backlog**:

- a PRD is created first
- the PRD is converted into `prd.json`
- work is broken into multiple user stories
- each story is tracked with `passes: true/false`
- the loop completes the highest-priority unfinished story each iteration

So the practical difference is:

- **`pi-goal-driven`** is optimized for **goal verification**
- **`ralph`** is optimized for **backlog traversal across many small stories**

### Dependency model

`pi-goal-driven` deliberately stays thin and depends on Pi capabilities:

- Pi
- `pi-subagents`
- Pi UI/editor/runtime features

`ralph` is more toolchain-oriented and depends on external CLI setup:

- Amp or Claude Code
- `jq`
- git repository workflow
- prompt files and optional skills installation

This means:

- `pi-goal-driven` fits best when your team is already committed to the **Pi extension ecosystem**
- `ralph` fits best when you want a **portable repo script** that can run across projects with minimal framework coupling beyond the chosen coding CLI

### Memory and continuity strategy

This is one of the biggest architectural differences.

#### `pi-goal-driven`

- keeps the master workflow in the current Pi session
- saves the filled prompt per workspace
- tracks async worker runs per Goal-Driven session
- restores session-owned worker knowledge from persisted session entries
- filters worker status to the current Goal-Driven session tree
- relies on master-side verification plus watchdog logic for inactive workers

#### `ralph`

- intentionally starts each iteration with fresh context
- treats context reset as a feature, not a bug
- preserves continuity through:
  - commit history
  - `progress.txt`
  - `prd.json`
  - optional AGENTS.md updates

In short:

- choose **`pi-goal-driven`** when maintaining a **continuous supervisory session** is useful
- choose **`ralph`** when you want **hard context resets between iterations** to reduce drift and prompt bloat

### Verification philosophy

`pi-goal-driven` emphasizes a **master verifies after worker completion** pattern:

- worker runs in background
- master waits for completion event
- master checks Criteria for Success
- master relaunches the worker if the result is still insufficient

`ralph` emphasizes a **story-by-story shipping loop**:

- implement one story
- run quality checks
- commit passing work
- mark the story complete in `prd.json`
- append learnings to `progress.txt`
- continue until all stories pass

That leads to different strengths:

- **`pi-goal-driven`** is stronger when success is best expressed as a **single end-state contract**
- **`ralph`** is stronger when success is best expressed as a **sequence of small independently shippable units**

### Operational behavior

`pi-goal-driven` currently includes Pi-specific operational behavior such as:

- forcing worker `subagent` calls to `async: true`
- forcing worker `subagent` calls to `clarify: false`
- injecting a worker guard that forbids nested `subagent` launches inside worker sessions
- blocking additional worker launches while one worker in the same Goal-Driven session tree is still active
- filtering status checks to the current Goal-Driven session tree instead of the global async run pool
- using an inactivity watchdog to stop and replace stale workers

`ralph` currently includes repo-loop behavior such as:

- feature-branch tracking from `prd.json`
- run archiving when branch context changes
- support for both Amp and Claude Code
- optional PRD/skill workflow for generating structured backlog input

So `pi-goal-driven` is closer to **runtime orchestration inside an agent platform**, while `ralph` is closer to **automation glue around coding agents**.

### Ergonomics

#### `pi-goal-driven`

Best when you want:

- native Pi commands like `/goal-driven`, `/goal-driven:brainstorm`, `/goal-driven:work`
- a lightweight setup
- quick transition from fuzzy task → explicit goal → execution
- built-in awareness of Pi async workers

#### `ralph`

Best when you want:

- a scriptable repo workflow
- explicit PRD-driven decomposition
- durable iteration logs in files committed with the project
- a model where each new run starts from a clean agent context

### Trade-offs at a glance

| If you care most about... | Better fit |
|---|---|
| Pi-native UX and extension integration | `pi-goal-driven` |
| Fresh-agent iterations with durable file-based memory | `ralph` |
| A single goal with strict success criteria | `pi-goal-driven` |
| Multi-story execution from a PRD backlog | `ralph` |
| Async worker supervision inside one ongoing session | `pi-goal-driven` |
| Portable shell-based orchestration across repos | `ralph` |

### Bottom line

The two projects are not direct clones of each other.

- `pi-goal-driven` packages the **Goal-Driven master/worker pattern** as a thin Pi extension.
- `ralph` packages an **autonomous iteration loop** as a repo-level script plus PRD workflow.

If your preferred operating model is **"stay inside Pi, supervise one goal until verified"**, `pi-goal-driven` is the more natural fit.

If your preferred operating model is **"translate a PRD into many small stories and let fresh agent runs chip away at them one by one"**, `ralph` is the more natural fit.

They are complementary ideas with different centers of gravity: **Pi-native supervised execution** vs. **repo-native autonomous iteration**.
