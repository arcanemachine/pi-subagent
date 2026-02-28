# pi-subagent Extension

## Overview

A pi extension that enables spawning sub-agents via RPC for parallel task execution, making sub-agents a first-class part of the LLM workflow.

## Project Structure

```
pi-subagent/
├── src/
│   └── index.ts              # Main extension code
├── AGENTS.md                 # This file - project overview
├── AGENTS.SESSION.md         # Session logs and development history
├── AGENTS.TODO.md            # TODO list and future ideas
└── README.md                 # User-facing documentation
```

## Quick Start

### Development

```bash
cd /workspace/projects/pi-subagent
pi -e ./src/index.ts
```

### Installation

```bash
mkdir -p ~/.pi/agent/extensions/pi-subagent
cp src/index.ts ~/.pi/agent/extensions/pi-subagent/
```

## Architecture

The extension uses pi's RPC mode to spawn headless sub-agents:

1. Each sub-agent is a separate `pi` process running in RPC mode (`pi --mode rpc --no-session`)
2. Communication happens via JSON over stdin/stdout
3. The extension parses events (`agent_start`, `message_update`, `agent_end`, etc.)
4. Sub-agents run independently with full access to pi's tools

### Key Components

- **SubAgent interface**: Tracks id, process, task, status, output, timing
- **spawnSubAgent()**: Creates and configures a new sub-agent process
- **updateSubAgentWidget()**: Updates the UI widget with current agent status
- **getAgentReport()**: Generates a readable transcript of agent activity
- **Status functions**: `getActiveAgentCount()`, `getStatusText()` for consistent status display

## Commands

| Command | Description |
|---------|-------------|
| `/subagent spawn <task>` | Spawn a new sub-agent with a task |
| `/subagent report <id>` | Get full transcript of sub-agent activity |
| `/subagent list` | List all sub-agents |
| `/subagent kill <id>` | Kill a specific sub-agent |
| `/subagent killall` | Kill all sub-agents |

## Tools

| Tool | Description |
|------|-------------|
| `spawn_subagent` | Spawn a single sub-agent |
| `subagent_report` | Get detailed report of sub-agent activity |
| `spawn_parallel` | Spawn multiple sub-agents and wait for all |

## Development Guidelines

- Use conventional commit format: `type(scope): description`
- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- Update AGENTS.SESSION.md for significant changes
- Update AGENTS.TODO.md when completing or adding tasks

## Status Display

The status bar shows `active subagents: N` where N is the count of non-completed agents:
- Widget shows all agents (completed and active) with status icons
- Status only counts running agents
- Format is consistent across all status updates

## Session Management

- Agents are tracked in a module-level Map
- Completed agents remain in the widget for reference
- All agents are killed on session shutdown
- Status updates automatically on agent state changes
