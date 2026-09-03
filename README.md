# pi-subagent

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/pi-subagent/main/logo.jpg" alt="pi-subagent logo" width="250" />
</p>

A [Pi](https://pi.dev) extension for delegating work to configurable sub-agents.

Give each sub-agent its own model, thinking level, instructions, and time budget. Pi can launch several at once, continue other work while they run, and receive each result automatically. A live fleet window lets you inspect, steer, stop, and review them without leaving the session.

> Like this extension? See [my other Pi extensions](https://github.com/arcanemachine/pi-projects).

## Requirements

- Pi 0.84.1 or later
- At least one model configured in Pi for use by a sub-agent
- Node.js 22.19.0 or later for package development

## Installation

From npm:

```bash
pi install npm:@arcanemachine/pi-subagent
```

From GitHub:

```bash
pi install git:github.com/arcanemachine/pi-subagent
```

For local development:

```bash
pi -e ./src/index.ts
```

Restart Pi after installation, or use `/reload` in an existing session.

## Quick start

Define at least one agent type in Pi's global `~/.pi/agent/settings.json`:

```json
{
  "pi-subagent": {
    "agents": {
      "research": {
        "model": "provider/model",
        "thinking_level": "high",
        "when_to_use": "Research, source gathering, and focused investigation"
      }
    }
  }
}
```

Replace `provider/model` with a model available in your Pi configuration, then reload Pi. You can delegate directly:

```text
/subagent spawn:research Compare these two libraries and report the tradeoffs
```

The command returns immediately. When the sub-agent finishes, its result is delivered back into the parent conversation automatically.

You can also ask Pi to delegate work naturally, for example:

> Use the research sub-agent to investigate this API while you continue reviewing the implementation.

Open the live fleet at any time with `/subagent`.

## Commands

| Command                                              | Action                                  |
| ---------------------------------------------------- | --------------------------------------- |
| `/subagent`                                          | Open the live sub-agent fleet           |
| `/subagent fleet`                                    | Open the same fleet window              |
| `/subagent spawn:<agent> [timeout:<seconds>] <task>` | Start a configured sub-agent            |
| `/subagent steer <id\|all> <guidance>`               | Redirect one or every running sub-agent |
| `/subagent kill <id>`                                | Stop one running sub-agent              |
| `/subagent killall`                                  | Stop every running sub-agent            |

Agent names are exact configuration keys. A spawn request cannot override the configured model or session fork.

## Live fleet

The fleet presents each sub-agent as a small, selectable Pi session. It shows the current activity, streamed response preview, elapsed time, context usage, and final result when available.

| Key                     | Action                                       |
| ----------------------- | -------------------------------------------- |
| `↑` / `↓`, `j` / `k`    | Select a sub-agent                           |
| `Page Up` / `Page Down` | Scroll the selected session                  |
| `s`                     | Write guidance for the selected sub-agent    |
| `x` / `X`               | Stop the selected sub-agent / all running    |
| `r` / `R`               | Remove the selected result / all finished    |
| `Escape`                | Cancel the current action or close the fleet |

Stopping and removal require confirmation. Starting and running agents can be steered or stopped; completed, errored, and stopped agents can be removed. The fleet retains the 20 most recent finished sessions without keeping their child processes alive.

## Agent tools

These tools let Pi manage sub-agents from the conversation. You normally do not need to call them yourself.

| Tool                  | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `subagent_spawn`      | Start one configured sub-agent and return immediately       |
| `subagent_list_types` | List configured agent types and their usage guidance        |
| `subagent_steer`      | Send follow-up guidance to one running agent or all of them |
| `subagent_status`     | Inspect structured live status when an update is needed     |
| `subagent_kill`       | Stop one running sub-agent                                  |

Sub-agents report completion automatically. Pi should never poll for progress or completion by any means, including status checks, sleep commands, or wait loops; `subagent_status` remains available for a one-time inspection rather than repeated waiting.

## Configuration

The extension reads the `pi-subagent` namespace from Pi's normal settings files:

- Global: `~/.pi/agent/settings.json`
- Project: `<project>/.pi/settings.json`

Trusted project settings are deep-merged over global settings, including individual agent properties. Project settings are ignored when the project is not trusted.

### Agent types

Each entry under `agents` defines one agent type:

| Property         | Required | Description                                                             |
| ---------------- | -------- | ----------------------------------------------------------------------- |
| `model`          | Yes      | Exact `provider/model` used by the child                                |
| `thinking_level` | No       | Child thinking level; inherits the parent's current level when omitted  |
| `when_to_use`    | No       | Description shown by `subagent_list_types` and spawn command completion |
| `extra_context`  | No       | Additional instructions prepended to every task for this agent type     |
| `fork`           | No       | Pi session ID or snapshot path used as the child's starting context     |

Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Pi may clamp a level that the selected model does not support.

A configured `fork` follows Pi's native `--fork` behavior. Relative paths are resolved from the project working directory. Forked agents create persistent child sessions; ordinary agents do not. Snapshots created by [`pi-session-snapshot`](https://github.com/arcanemachine/pi-session-snapshot) can be used as fork sources.

### Runtime controls

| Setting                   | Default   | Behavior                                                                 |
| ------------------------- | --------- | ------------------------------------------------------------------------ |
| `max_active_subagents`    | Unlimited | Reject new spawns after the configured concurrency limit is reached      |
| `default_timeout_seconds` | `180`     | Give each child a default time budget and ask it to wrap up when reached |
| `allow_nested_subagents`  | `false`   | Allow spawned children to use this extension's own sub-agent tools       |

`max_active_subagents` accepts positive integers up to 100. Requests above the limit are rejected rather than queued.

`default_timeout_seconds` is a finishing budget, not a hard process kill. The extension warns the child as the deadline approaches and asks it to submit its best available result when time expires. Use `subagent_kill` when a child must be stopped immediately. A spawn can override the budget with `timeout_seconds` in the tool or `timeout:<seconds>` in the command.

Nested sub-agents are disabled by default to prevent unplanned recursive fan-out. Enable them only when you explicitly want children to delegate further work.

## Completion and lifecycle

Each child receives the child-only `subagent_complete` tool for returning its final deliverable. If it finishes with an ordinary final response instead, that response is used as a fallback. Empty, errored, aborted, or truncated responses are reported as failures rather than silently treated as complete.

Finished children leave active status automatically and remain available in the recent fleet history. Starting a new parent session stops the current children. Reloading the extension also stops them, but records an interruption message in the parent conversation so unfinished work is not mistaken for a task failure.

Activity and response previews are kept in bounded memory. Each sub-agent runs as a separate Pi child process; configured forks preserve the source session context, while ordinary tasks do not create persistent sessions.

## Development

```bash
npm install --ignore-scripts --workspaces=false
npm run format:check
npm run typecheck
npm run test
npm run build
npm pack --dry-run
```

Pi loads the TypeScript entrypoint directly from `src/index.ts`; no compiled runtime artifact is required.

## License

MIT
