# pi-subagent

A pi extension that enables spawning sub-agents via RPC for parallel task execution.

## Features

- Spawn pi sub-agents as separate processes via RPC
- Send tasks to sub-agents and receive results
- Manage multiple concurrent sub-agents
- Stream sub-agent output in real-time

## Installation

```bash
# Copy to pi extensions directory
cp -r dist ~/.pi/agent/extensions/pi-subagent

# Or use pi install (if published as package)
pi install npm:@yourname/pi-subagent
```

## Usage

Once installed, the extension provides:

- `/subagent spawn <task>` - Spawn a new sub-agent with a task
- `/subagent list` - List active sub-agents
- `/subagent kill <id>` - Kill a sub-agent

## Development

```bash
# Test the extension locally
pi -e ./src/index.ts
```
