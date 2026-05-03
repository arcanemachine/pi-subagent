# pi-subagent

A pi extension that enables spawning sub-agents via RPC for parallel task execution.

## Features

- Spawn pi sub-agents as separate processes via RPC
- Fire-and-forget sub-agents with automatic completion messages
- Manage multiple concurrent sub-agents
- Track status and output of running sub-agents
- Live widget to watch sub-agent activity in real-time
- Automatic cleanup on session shutdown and `/new`

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
ln -s /workspace/projects/pi-subagent/src ~/.pi/agent/extensions/pi-subagent
```

## Usage

### Commands

- `/subagent spawn:<agent> <task>` - Spawn a new sub-agent using configured agent type
- `/subagent report <id> [count]` - View recent activity entries (default: last 3)
- `/subagent status [id]` - View structured live status for one/all sub-agents
- `/subagent append <id> [count]` - Add recent activity report to conversation context
- `/subagent notify <id> <text>` - Send follow-up guidance to a running sub-agent
- `/subagent kill <id>` - Kill a specific sub-agent
- `/subagent killall` - Kill all sub-agents
- `/subagent prune` - Remove completed sub-agents
- `/subagent show [id]` - Watch sub-agent(s) in widget (no ID = all)
- `/subagent hide [id]` - Stop watching sub-agent(s) (no ID = all)

### Tools

- `subagent_spawn` - Spawn a single sub-agent (required `agent`)
- `subagent_wait` - Wait briefly for completion of one sub-agent (`agent_id`) or all active sub-agents (omit `agent_id`); `timeout_ms` optional, default: 15000, max: 60000
- `subagent_report` - Get recent activity entries (`count` optional, default: 3)
- `subagent_status` - Get structured current status (`agent_id` optional)
- `subagent_notify` - Send follow-up guidance to a running sub-agent
- `subagent_kill` - Kill a specific sub-agent by ID
- `subagent_list_types` - List configured agent types (name/model/when_to_use)
- `subagent_spawn_parallel` - Spawn multiple sub-agents, return immediately, and receive completion messages (required per-task `agent`)

`count` is clamped to a safe maximum (50).

#### Agent resolution behavior

Sub-agent model selection is strict and uses configured agent types only:

1. Command syntax: `/subagent spawn:<agent> <task>`
2. Tool syntax: provide `agent` for each sub-agent task
3. Resolve `agent` from `"pi-subagent".agents[agent].model`
4. If `extra_context` is configured for that agent, it is prepended to the task prompt sent to the sub-agent

There is no model override parameter and no fallback to legacy `"pi-subagent".model`.

### Configuration (`settings.json`)

Use the main pi settings files:

- Global: `~/.pi/agent/settings.json`
- Project: `.pi/settings.json`

Project settings override global settings.

Example (`extra_context`, `max_active_subagents`, `default_timeout_seconds`, and `allow_nested_subagents` are optional):

```json
{
  "pi-subagent": {
    "max_active_subagents": 4,
    "default_timeout_seconds": 600,
    "allow_nested_subagents": false,
    "agents": {
      "simple": {
        "model": "provider/some-simple-model",
        "when_to_use": "For simple tasks"
      },
      "smart": {
        "model": "provider/some-smart-model",
        "when_to_use": "For challenging tasks",
        "extra_context": "Think carefully and prefer correctness over speed."
      },
      "code-review": {
        "model": "provider/some-coding-model",
        "when_to_use": "For reviewing code",
        "extra_context": "Focus on correctness, edge cases, and actionable fixes."
      }
    }
  }
}
```

Project settings override global settings by agent key. `max_active_subagents` is a hard cap on concurrently running sub-agents; spawn requests above the cap are rejected (not queued).

`default_timeout_seconds` controls an automatic timeout notification for each spawned sub-agent. When the timeout is reached, the parent sends guidance asking the sub-agent to report progress so far and finish up. The default is no timeout.

`allow_nested_subagents` controls whether spawned sub-agents can use this extension's own sub-agent tools. Default is `false` (nested sub-agents disabled). Set to `true` only if you explicitly want recursive fan-out.

On session start, the extension sends an internal guidance message listing configured agent types and the active concurrency cap so tool-calling models can pick valid `agent` values.

### Live Widget

Use `/subagent show` to watch sub-agents in a live-updating widget above the editor:

```
👁 Watching Sub-Agents
────────────────────────────────────────
⏳ abc1234 (running) | 15s
Task: analyze codebase...
🔧 bash({"command":"ls -la"})
────────────────────────────────────────
✓ def5678 (completed) | 45s
Task: review PR...
```

The widget shows:

- Status icon (⏳ running / ✓ completed / ✗ error)
- Duration
- Task description
- Current tool / last action (if running)
- Optional progress hints when sub-agents self-report percentages (for example, "50%")

Completed agents remain visible until you run `/subagent hide`.

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
cd /workspace/projects/pi/pi-subagent
pi -e ./src/index.ts
```

See AGENTS.md for agent-specific information.
