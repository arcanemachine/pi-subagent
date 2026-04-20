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

- `/subagent spawn <task>` - Spawn a new sub-agent
- `/subagent report <id>` - View report (concise status while running, full transcript after completion)
- `/subagent append <id>` - View transcript and add to conversation context
- `/subagent list` - List all sub-agents
- `/subagent kill <id>` - Kill a specific sub-agent
- `/subagent killall` - Kill all sub-agents
- `/subagent prune` - Remove completed sub-agents from list
- `/subagent show [id]` - Watch sub-agent(s) in widget (no ID = all)
- `/subagent hide [id]` - Stop watching sub-agent(s) (no ID = all)

### Tools

- `spawn_subagent` - Spawn a single sub-agent (optional `model`)
- `subagent_report` - Get report (concise status while running, full transcript after completion)
- `spawn_parallel` - Spawn multiple sub-agents and wait for all (optional `model`)

#### Model resolution behavior

Sub-agent model selection uses this precedence:

1. Tool parameter `model` (explicit per-call override)
2. `settings.json` key `"pi-subagent".model` (global/project override)
3. Current session model

If none of the above is available, pi falls back to its normal model resolution.

`"pi-subagent".model` must be an actual model override string (for example `"openai/gpt-5.3-codex"` or another valid model pattern). There is no special `"current"` value for this setting.

### Configuration (`settings.json`)

Use the main pi settings files:

- Global: `~/.pi/agent/settings.json`
- Project: `.pi/settings.json`

Project settings override global settings.

Example (global):

```json
{
  "pi-subagent": {
    "model": "openai/gpt-5.3-codex"
  }
}
```

Example (project override):

```json
{
  "pi-subagent": {
    "model": "anthropic/claude-sonnet-4-5"
  }
}
```

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
