# pi-subagent

A pi extension that enables spawning sub-agents via RPC for parallel task execution.

## Features

- **Spawn pi sub-agents** as separate processes via RPC
- **Fire-and-forget** or **wait for results** from sub-agents
- **Manage multiple concurrent** sub-agents
- **Track status** and output of running sub-agents
- **Automatic cleanup** on session shutdown

## Installation

### Local Development

```bash
cd /workspace/projects/pi-agent
pi -e ./src/index.ts
```

### Install to pi

Copy to your pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions/pi-subagent
cp src/index.ts ~/.pi/agent/extensions/pi-subagent/
```

Or use pi's package system (if published):

```bash
pi install npm:@yourname/pi-subagent
```

## Usage

### Commands

Once loaded, the extension provides the `/subagent` command:

```
/subagent spawn <task>           # Spawn a new sub-agent with a task
/subagent list                   # List all active sub-agents
/subagent status <id>            # Show detailed status of a sub-agent
/subagent wait <id> [timeout_ms] # Wait for a sub-agent to complete
/subagent kill <id>              # Kill a specific sub-agent
/subagent killall                # Kill all sub-agents
```

### Tools

The extension also registers tools that the LLM can call:

#### `spawn_subagent`

Spawn a sub-agent to handle a task in parallel.

```json
{
  "task": "Find all TODO comments in the codebase"
}
```

Returns the sub-agent ID and initial status.

#### `wait_for_subagent`

Wait for a sub-agent to complete and return its results.

```json
{
  "agent_id": "abc123",
  "timeout_ms": 60000
}
```

Returns the final output from the sub-agent.

### Example Workflow

1. **Spawn a sub-agent to work on a task:**
   ```
   /subagent spawn "Analyze the test coverage in src/"
   ```
   Output: `Spawned sub-agent a1b2c3d4`

2. **Check status:**
   ```
   /subagent status a1b2c3d4
   ```

3. **Wait for completion:**
   ```
   /subagent wait a1b2c3d4 30000
   ```

4. **Or use tools for automated workflows:**
   ```
   spawn_subagent task="Refactor utils.ts"
   wait_for_subagent agent_id="a1b2c3d4"
   ```

## How It Works

The extension uses pi's **RPC mode** (`pi --mode rpc`) to spawn headless sub-agents:

1. Each sub-agent is a separate `pi` process running in RPC mode
2. Communication happens via JSON over stdin/stdout
3. The extension parses events (`agent_start`, `message_update`, `agent_end`)
4. Sub-agents run independently with full access to pi's tools

## Architecture

```
Main pi session (with extension)
    │
    ├── spawn_subagent tool/command
    │       │
    │       └── spawns: pi --mode rpc --no-session
    │               │
    │               ├── stdin: JSON commands
    │               └── stdout: JSON events
    │
    ├── Tracks active agents in Map<id, SubAgent>
    │
    └── Provides: status, wait, kill operations
```

## Development

### Project Structure

```
pi-agent/
├── src/
│   └── index.ts       # Main extension
├── test.sh            # Test helper script
└── README.md
```

### Testing

```bash
# Load the extension in pi
pi -e ./src/index.ts

# Then try:
/subagent spawn "echo Hello from sub-agent"
/subagent list
```

## Limitations

- Sub-agents run in separate processes (memory overhead)
- No shared state between main agent and sub-agents
- Results must be explicitly waited for
- Sub-agents inherit the same API key/environment

## Future Ideas

- [ ] Parallel map-reduce operations across sub-agents
- [ ] Sub-agent result aggregation
- [ ] Sub-agent-to-sub-agent communication
- [ ] Resource limits (CPU, memory, time)
- [ ] Sandbox/isolated environments
