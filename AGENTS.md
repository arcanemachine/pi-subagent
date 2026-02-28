# pi-subagent

A pi extension for spawning sub-agents via RPC.

## Project Structure

- Main file: `src/index.ts`
- Install: `cp src/index.ts ~/.pi/agent/extensions/pi-subagent/`
- Test: `pi -e ./src/index.ts`

## Key Functions

- `spawnSubAgent(task, ctx)` - Spawn a new sub-agent process
- `updateSubAgentWidget(ctx)` - Update UI widget with agent status
- `getAgentReport(id)` - Generate transcript of agent activity
- `getStatusText()` - Get formatted status string

## Data Flow

1. Spawn: `pi --mode rpc --no-session` process
2. Events: JSON over stdin/stdout
3. Tracking: `Map<string, SubAgent>`
4. Display: Widget shows all agents, status shows active count

## Git Commits

I commit changes to git with clear messages. The user handles pushing.
