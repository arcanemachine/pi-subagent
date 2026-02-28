# pi-subagent

A pi extension that enables spawning sub-agents via RPC for parallel task execution.

## Features

- Spawn pi sub-agents as separate processes via RPC
- Fire-and-forget or wait for results from sub-agents
- Manage multiple concurrent sub-agents
- Track status and output of running sub-agents
- Automatic cleanup on session shutdown

## Installation

```bash
mkdir -p ~/.pi/agent/extensions/pi-subagent
cp src/index.ts ~/.pi/agent/extensions/pi-subagent/
```

## Usage

### Commands

```
/subagent spawn <task>     # Spawn a new sub-agent
/subagent report <id>      # Get transcript of agent activity
/subagent list             # List all sub-agents
/subagent kill <id>        # Kill a specific sub-agent
/subagent killall          # Kill all sub-agents
```

### Tools

- spawn_subagent - Spawn a single sub-agent
- subagent_report - Get detailed report
- spawn_parallel - Spawn multiple sub-agents and wait for all

## How It Works

Spawns pi --mode rpc --no-session processes and communicates via JSON over stdin/stdout.

## Development

```bash
cd /workspace/projects/pi-subagent
pi -e ./src/index.ts
```

See AGENTS.md for agent-specific information.
