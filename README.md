# pi-subagent

A pi extension that enables spawning sub-agents via RPC for parallel task execution.

## Features

- Spawn pi sub-agents as separate processes via RPC
- Fire-and-forget or wait for results from sub-agents
- Manage multiple concurrent sub-agents
- Track status and output of running sub-agents
- **Live widget to watch sub-agent activity in real-time**
- Automatic cleanup on session shutdown and `/new`

## Installation

```
ln -s /workspace/projects/pi-subagent/src ~/.pi/agent/extensions/pi-subagent
```

Or copy the extension:

```
mkdir -p ~/.pi/agent/extensions/pi-subagent
cp src/index.ts ~/.pi/agent/extensions/pi-subagent/
```

## Usage

### Commands

- `/subagent spawn <task>` - Spawn a new sub-agent
- `/subagent report <id>` - View transcript (user only, not added to context)
- `/subagent append <id>` - View transcript and add to conversation context
- `/subagent list` - List all sub-agents
- `/subagent kill <id>` - Kill a specific sub-agent
- `/subagent killall` - Kill all sub-agents
- `/subagent prune` - Remove completed sub-agents from list
- `/subagent show [id]` - Watch sub-agent(s) in widget (no ID = all)
- `/subagent hide [id]` - Stop watching sub-agent(s) (no ID = all)

### Tools

- `spawn_subagent` - Spawn a single sub-agent
- `subagent_report` - Get detailed report
- `spawn_parallel` - Spawn multiple sub-agents and wait for all

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
