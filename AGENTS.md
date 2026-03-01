# pi-subagent

A pi extension for spawning sub-agents via RPC.

## Project Structure

- Main file: `src/index.ts`
- Install: `ln -s /workspace/projects/pi-subagent/src ~/.pi/agent/extensions/pi-subagent`
- Test: `pi -e ./src/index.ts`

## Key Functions

- `spawnSubAgent(task)` - Spawn a new sub-agent process via RPC
- `updateSubAgentStatus()` - Update footer status with active count
- `updateWatchWidget()` - Update live widget with watched agents
- `getAgentReport(id)` - Generate transcript of agent activity
- `killSubAgent(id)` - Kill a specific sub-agent

## State Management

- `activeAgents: Map<string, SubAgent>` - All sub-agents (running and completed)
- `watchedAgentIds: Set<string>` - IDs of agents being watched in widget
- `currentCtx: ExtensionContext | null` - Current extension context for UI updates

## Data Flow

1. **Spawn**: `pi --mode rpc --no-session` process created
2. **Events**: JSON events over stdin/stdout (tool_execution_start, message_update, agent_end, etc.)
3. **Tracking**: Events parsed and stored in `agent.output` array
4. **Status**: Footer shows active count via `updateSubAgentStatus()`
5. **Widget**: Live view of watched agents via `updateWatchWidget()`

## Event Handling

- `session_start` - Set up context and status
- `session_before_switch` - Kill processes and clear state on `/new`
- `session_shutdown` - Clean up on exit

## Commands

| Command | Description |
|---------|-------------|
| `spawn <task>` | Spawn new sub-agent |
| `report <id>` | Get full transcript |
| `list` | List all sub-agents |
| `kill <id>` | Kill specific sub-agent |
| `killall` | Kill all sub-agents |
| `prune` | Remove completed from list |
| `show [id]` | Watch in widget (no ID = all) |
| `hide [id]` | Stop watching (no ID = all) |

## Pre-commit Checks

Before committing, run:

```bash
# Type check
npx tsc --noEmit

# Format code
npx prettier --write src/index.ts
```

## Git Commits

The agent commits changes to git with clear messages. The user handles pushing.
