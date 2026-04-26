# pi-subagent

A pi extension that enables spawning sub-agents via RPC for parallel task execution.

## Features

- Spawn pi sub-agents as separate processes via RPC
- Fire-and-forget or wait for results from sub-agents
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
- `/subagent append <id> [count]` - Add recent activity report to conversation context
- `/subagent list` - List all sub-agents
- `/subagent kill <id>` - Kill a specific sub-agent
- `/subagent killall` - Kill all sub-agents
- `/subagent prune` - Remove completed sub-agents from list
- `/subagent show [id]` - Watch sub-agent(s) in widget (no ID = all)
- `/subagent hide [id]` - Stop watching sub-agent(s) (no ID = all)

### Tools

- `spawn_subagent` - Spawn a single sub-agent (required `agent`)
- `subagent_report` - Get recent activity entries (`count` optional, default: 3)
- `spawn_parallel` - Spawn multiple sub-agents and wait for all (required per-task `agent`)

`count` is clamped to a safe maximum (50).

#### Agent resolution behavior

Sub-agent model selection is strict and uses configured agent types only:

1. Command syntax: `/subagent spawn:<agent> <task>`
2. Tool syntax: provide `agent` for each sub-agent task
3. Resolve `agent` from `"pi-subagent".agents[agent].model`

There is no model override parameter and no fallback to legacy `"pi-subagent".model`.

### Configuration (`settings.json`)

Use the main pi settings files:

- Global: `~/.pi/agent/settings.json`
- Project: `.pi/settings.json`

Project settings override global settings.

Example:

```json
{
  "pi-subagent": {
    "agents": {
      "simple": {
        "model": "provider/some-simple-model",
        "when_to_use": "For simple tasks"
      },
      "smart": {
        "model": "provider/some-smart-model",
        "when_to_use": "For challenging tasks"
      },
      "code-review": {
        "model": "provider/some-coding-model",
        "when_to_use": "For reviewing code"
      }
    }
  }
}
```

Project settings override global settings by agent key.

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
- Current tool being executed (if running)

Completed agents remain visible until you run `/subagent hide`.

## Development

```
cd /workspace/projects/pi-subagent
pi -e ./src/index.ts
```

See AGENTS.md for agent-specific information.
