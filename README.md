# pi-goal-driven

[![npm version](https://img.shields.io/npm/v/pi-goal-driven)](https://www.npmjs.com/package/pi-goal-driven)
[![npm downloads](https://img.shields.io/npm/dm/pi-goal-driven)](https://www.npmjs.com/package/pi-goal-driven)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](https://www.npmjs.com/package/pi-goal-driven)

## Showcase

<table>
  <tr>
    <td><img src="https://raw.githubusercontent.com/vurihuang/pi-goal-driven/master/showcase-1.png" alt="Goal-Driven inline experiment dashboard" width="420" /></td>
    <td><img src="https://raw.githubusercontent.com/vurihuang/pi-goal-driven/master/showcase-2.png" alt="Goal-Driven fullscreen experiment dashboard" width="420" /></td>
  </tr>
</table>

A Pi package that turns the [Goal-Driven](https://github.com/lidangzzz/goal-driven) master/subagent pattern into a Pi-native extension.

Special thanks to [lidangzzz/goal-driven](https://github.com/lidangzzz/goal-driven) — it's a great project and the direct inspiration for this package.

Also inspired by [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch).

Instead of pasting the long prompt by hand, the package gives you a `/goal-driven` command with a Pi-native setup flow.

The flow lets you:

- use the configured `pi-subagents` worker profile
- enter the `Goal`
- enter the `Criteria for success`

Then it starts a supervised loop:

1. launch one working subagent through `pi-subagents`
2. watch it for inactivity
3. verify progress against the success criteria
4. restart the subagent if the criteria are still not met
5. stop only when the verifier says the goal is met, or when you manually stop the run

## Prerequisite

You must already have the global [`pi-subagents`](https://github.com/nicobailon/pi-subagents) Pi extension installed and enabled before using this plugin.

A normal package install via `pi install npm:pi-subagents` is enough. `pi-goal-driven` now accepts either:

- an extracted extension file at `~/.pi/agent/extensions/pi-subagents/index.ts`, or
- a `pi-subagents` package entry in `~/.pi/agent/settings.json`

```bash
pi install npm:pi-subagents
```

`pi-goal-driven` now relies on that global `pi-subagents` extension for worker runs instead of injecting its own bundled extension copy.

## Install

Recommended:

```bash
pi install npm:pi-goal-driven
```

Local development:

```bash
pi install /path/to/pi-goal-driven
```

Or load it directly for a single run:

```bash
pi -e /path/to/pi-goal-driven
```

This package uses `pi-subagents` internally for worker execution, but Goal-Driven worker sessions expect the global `pi-subagents` extension to be present.

## Quick example

After installing `pi-subagents` and `pi-goal-driven`, start Pi in the target repo and run:

```text
/goal-driven
```

Then fill in a goal and success criteria such as:

**Goal**

```text
Refactor the auth flow to remove duplicated token parsing logic and keep behavior unchanged.
```

**Criteria for success**

```text
1. Token parsing lives in one shared implementation.
2. Existing auth routes still behave the same.
3. `npx tsc --noEmit` passes.
4. `npx eslint . --quiet` passes.
```

Useful follow-up commands:

```text
/goal-driven status
/goal-driven stop
```

Typical flow:

1. run `/goal-driven`
2. enter the goal
3. enter the criteria for success
4. let the worker run and the verifier check progress automatically
5. use `/goal-driven status` to inspect the latest run
6. use `/goal-driven stop` if you want to stop supervision manually

## Commands

### `/goal-driven`

Starts a new Goal-Driven run.

The command prompts for:

- Goal
- Criteria for success

It uses the worker configured in `pi-goal-driven` config, and uses either:

- the configured `provider` and `model` from `pi-goal-driven` config, or
- your current Pi session model when no config model is set

While the loop is running, every worker cycle is shown as an **experiment** in the UI:

- compact widget above the editor in an autoresearch-style single-line format
- counts for runs, met, retry, failed, and inactive experiments
- per-experiment duration and description-like summaries
- `Ctrl+X` toggles the inline experiment dashboard
- `Ctrl+Shift+X` opens a fullscreen scrollable dashboard
- the latest run snapshot is persisted, so you can still inspect the experiment history after restarting Pi

### `/goal-driven setup`

Copies the default config to:

```bash
~/.pi/agent/extensions/pi-goal-driven/config.json
```

This is the only supported config location.

Config example:

```json
{
  "defaultAgent": "worker",
  "provider": "openai",
  "model": "gpt-5.4"
}
```

### `/goal-driven status`

Shows the current run status, including experiment counts, recent experiment summaries, and the per-run log directory.

Each attempt now writes worker/verifier output under:

```bash
~/.pi/agent/extensions/pi-goal-driven/runs/
```

Inside each run directory you will find per-attempt `session/`, `artifacts/`, and `output.md` files for both worker and verifier.

### `/goal-driven stop`

Stops the current Goal-Driven run and kills the active subprocess.

## Notes

- The worker is executed with `pi-subagents`'s `runSync()` engine, not a custom raw `spawn()` loop.
- The configured worker profile is wrapped with Goal-Driven-specific instructions and relies on your globally installed `pi-subagents` extension during worker runs.
- `pi-subagents` is a hard prerequisite for this plugin. `/goal-driven` accepts either the extracted extension path or an installed `pi-subagents` package entry in `~/.pi/agent/settings.json`.
- The verifier is read-only in practice: it gets inspection tools plus `bash` for checks, but no edit/write tools.
- The extension keeps a short history of recent failed attempts and feeds that back into the next worker attempt.
- The package only activates when you explicitly run `/goal-driven`, so it does not constantly inject the Goal-Driven prompt into normal Pi conversations.
