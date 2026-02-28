# pi-subagent

A pi extension for spawning sub-agents via RPC.

## Quick Reference

- **Main file**: `src/index.ts`
- **Install**: `cp src/index.ts ~/.pi/agent/extensions/pi-subagent/`
- **Test**: `pi -e ./src/index.ts`

## Key Functions

- `spawnSubAgent(task, ctx)` - Spawn a new sub-agent
- `updateSubAgentWidget(ctx)` - Update UI widget
- `getAgentReport(id)` - Get transcript of agent activity
- `getStatusText()` - Get formatted status string

## Data Flow

1. Spawn: `pi --mode rpc --no-session` process
2. Events: JSON over stdin/stdout (`agent_start`, `message_update`, `agent_end`)
3. Tracking: Stored in `Map<string, SubAgent>`
4. Display: Widget shows all agents, status shows active count only

## Status Format

Always use `getStatusText()` - returns `"active subagents: N"`

## Commits

Use conventional commits: `type(scope): description`
