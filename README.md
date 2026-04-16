# pi-goal-driven

A Pi package that turns the [Goal-Driven](https://github.com/lidangzzz/goal-driven) master/subagent pattern into a Pi-native extension.

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

A normal package install via `pi install pi-subagents` is enough. `pi-goal-driven` now accepts either:

- an extracted extension file at `~/.pi/agent/extensions/pi-subagents/index.ts`, or
- a `pi-subagents` package entry in `~/.pi/agent/settings.json`

```bash
pi install pi-subagents
```

`pi-goal-driven` now relies on that global `pi-subagents` extension for worker runs instead of injecting its own bundled extension copy.

## Install

```bash
pi install /path/to/pi-goal-driven
```

Or load it directly for a single run:

```bash
pi -e /path/to/pi-goal-driven
```

This package uses `pi-subagents` internally for worker execution, but Goal-Driven worker sessions expect the global `pi-subagents` extension to be present.

## Commands

### `/goal-driven`

Starts a new Goal-Driven run.

The command prompts for:

- Goal
- Criteria for success

It uses the worker configured in `pi-goal-driven` config, and uses either:

- the configured model target from `pi-goal-driven` config, exactly as specified, or
- your current Pi model when no config target is set

When a config target is set, Goal-Driven does not append the current Pi thinking suffix like `:high`, so a configured model such as `gpt-5-4` stays `gpt-5-4`.

While the loop is running, every worker cycle is shown as an **experiment** in the UI:

- compact widget above the editor with live activity
- counts for experiments, success, and failure
- per-experiment duration and summary
- `Ctrl+X` toggles the inline experiment dashboard
- `Ctrl+Shift+X` opens a fullscreen scrollable dashboard

### `/goal-driven setup`

Copies the default config to:

```bash
~/.pi/agent/extensions/pi-goal-driven/config.json
```

You can also create a project-local config at either:

- `.pi-goal-driven.json`
- `.pi/pi-goal-driven.json`

Config example:

```json
{
  "defaultAgent": "worker",
  "target": {
    "provider": "openai-codex",
    "model": "gpt-5-4"
  }
}
```

The config parser also accepts a flat shape:

```json
{
  "defaultAgent": "worker",
  "provider": "openai-codex",
  "model": "gpt-5-4"
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
