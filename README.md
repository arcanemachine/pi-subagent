# pi-subagent

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/pi-subagent/main/logo.jpg" alt="pi-subagent logo" width="250" />
</p>

A pi extension that enables spawning sub-agents via RPC for parallel task execution.

## Features

- Spawn pi sub-agents as separate processes via RPC
- Fire-and-forget sub-agents with automatic completion messages
- Manage multiple concurrent sub-agents
- Track status and output of running sub-agents
- Interactive live window for inspecting and steering sub-agents
- Automatic child-process cleanup after completion, session shutdown, and `/new`
- Bounded in-memory activity history for long-running sub-agents

## Installation

### From GitHub (Recommended)

```bash
pi install git:github.com/arcanemachine/pi-subagent
```

To update to the latest version:

```bash
pi update git:github.com/arcanemachine/pi-subagent
```

### From Local Clone

```bash
git clone https://github.com/arcanemachine/pi-subagent.git
cd pi-subagent
pi install /path/to/pi-subagent
```

No local `npm install` is required for normal usage.

Or use a symlink for development:

```bash
ln -s /path/to/pi-subagent/src ~/.pi/agent/extensions/pi-subagent
```

## Usage

### Commands

- `/subagent` - Open the interactive live sub-agent window
- `/subagent spawn:<agent> <task>` - Spawn a new sub-agent using configured agent type
- `/subagent fleet` - Open the interactive live sub-agent window
- `/subagent steer <id|all> <text>` - Send follow-up guidance to one or every running sub-agent
- `/subagent kill <id>` - Kill a specific sub-agent
- `/subagent killall` - Kill all sub-agents

### Tools

- `subagent_spawn` - Spawn a single sub-agent and return immediately (required `agent`)
- `subagent_status` - Get structured current status (`agent_id` optional)
- `subagent_steer` - Send follow-up guidance to one running sub-agent or all of them
- `subagent_kill` - Kill a specific sub-agent by ID
- `subagent_list_types` - List configured agent types (name/model/thinking level/when_to_use)

Child sub-agents receive a dedicated `subagent_complete` tool with one required `result` field. A successful call submits the complete deliverable and gracefully shuts down the child process; failed calls can be corrected and retried. If a child omits the tool, its final assistant response is used as a fallback so useful work is not discarded over formatting. Empty, errored, aborted, or truncated responses are reported as failures. Completed sub-agents are automatically removed from active tracking.

If an extension reload interrupts an active child, the parent conversation receives an `interrupted` message without triggering a new turn. The intentional SIGTERM is identified as infrastructure lifecycle behavior rather than a task failure.

#### Agent resolution behavior

Sub-agent model selection is strict and uses configured agent types only:

1. Command syntax: `/subagent spawn:<agent> <task>`
2. Tool syntax: provide `agent` for each sub-agent task
3. Resolve `agent` from `"pi-subagent".agents[agent].model`
4. Resolve the child thinking level from `thinking_level` when configured, otherwise inherit the parent's current thinking level
5. If `extra_context` is configured for that agent, it is prepended to the task prompt sent to the sub-agent
6. If `fork` is configured for that agent, the child starts from that Pi session or snapshot

There is no model or fork override parameter and no fallback to legacy `"pi-subagent".model`.

### Configuration (`settings.json`)

Use the main pi settings files:

- Global: `~/.pi/agent/settings.json`
- Project: `.pi/settings.json`

Project settings are deep-merged with global settings; project values take precedence.

Example (`thinking_level`, `extra_context`, `fork`, `max_active_subagents`, `default_timeout_seconds`, and `allow_nested_subagents` are optional):

```json
{
  "pi-subagent": {
    "max_active_subagents": 4,
    "default_timeout_seconds": 600,
    "allow_nested_subagents": false,
    "agents": {
      "example1": {
        "model": "provider/some-model",
        "when_to_use": "For example task type 1"
      },
      "example2": {
        "model": "provider/some-other-model",
        "thinking_level": "high",
        "when_to_use": "For example task type 2",
        "extra_context": "Think carefully and prefer correctness over speed."
      },
      "example3": {
        "model": "provider/yet-another-model",
        "when_to_use": "For example task type 3",
        "extra_context": "Focus on correctness, edge cases, and actionable fixes."
      },
      "snapshot_worker": {
        "model": "provider/snapshot-model",
        "fork": "~/.pi/agent/pi-session-snapshot/baseline.jsonl",
        "when_to_use": "For tasks that need the baseline session context"
      }
    }
  }
}
```

Replace `example1`, `example2`, and `example3` with keys you actually configure. The tool descriptions use these same placeholder names so the model does not mistake them for built-in agent types.

`thinking_level` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. If omitted, the child inherits the parent's current effective thinking level at spawn time. Pi may clamp a requested level when the selected child model does not support it.

Project settings are deep-merged with global settings by property and agent key. Project-local settings are used only for trusted projects. `max_active_subagents` is an optional hard cap on concurrently running sub-agents; spawn requests above the configured cap are rejected (not queued). If omitted, concurrency is unlimited.

`default_timeout_seconds` controls an automatic timeout notification for each spawned sub-agent. When the timeout is reached, the parent sends guidance asking the sub-agent to report progress so far and finish up. The default is 180 seconds.

`allow_nested_subagents` controls whether spawned sub-agents can use this extension's own sub-agent tools. Default is `false` (nested sub-agents disabled). Set to `true` only if you explicitly want recursive fan-out.

`fork` accepts the same path or session ID as Pi's native `--fork` option. Relative paths are resolved from the project working directory. Forked agents cannot use `--no-session`, so they create a persistent child session containing the configured source context. A snapshot created by `pi-session-snapshot` can be used directly as the JSONL source.

### Interactive Window

Use `/subagent fleet` to open a live window showing all running sub-agents as simplified mini Pi sessions. Select an agent with `↑`/`↓` or `j`/`k`, press `s` to enter guidance, and press Enter to steer it. Page Up/Page Down scroll the selected session; Escape closes the window.

Press `x` to stop the selected running sub-agent or `X` to stop all running sub-agents. Stopped sessions remain in the fleet. Press `r` to remove the selected finished session or `R` to remove all finished sessions. Lifecycle actions require Enter, `Y`, or `y` to confirm; Escape cancels. Here, “running” includes starting and running statuses, while “finished” includes completed, errored, and stopped statuses.

The window refreshes automatically and reads from bounded activity buffers. Finished sessions remain individually selectable and use status icons; only the 20 most recent finished sessions are retained, without keeping their child processes alive.

Each sub-agent reports its running context token usage alongside its elapsed time. The fleet roster shows `duration·tokens` on the right of each row (e.g. `02m30s·0.072Mt`, zero-padded), and the detail header shows the same token count next to status and duration. Used tokens update from every assistant reply's `usage` (`totalTokens`, falling back to `input + output + cacheRead + cacheWrite`) and are shown in millions (`Mt`) once the first reply arrives; until then the timer alone is shown. The `subagent_status` tool exposes the raw `contextTokens` and a preformatted `contextTokensDisplay` string.

## Development

For local development and verification:

```bash
npm install
npm run typecheck
npm run build
npm run format
```

To run directly in pi:

```bash
cd /path/to/pi-subagent
pi -e ./src/index.ts
```

See AGENTS.md for agent-specific information.
