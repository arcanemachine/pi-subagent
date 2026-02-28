# Session: pi-subagent Extension

## Current State

- Status only: `active subagents: N` (hidden when no agents)
- Commands: `spawn`, `interact`, `report`, `list`, `kill`, `killall`, `purge`
- Tools: `spawn_subagent`, `subagent_report`, `spawn_parallel`
- Interactive: `/subagent interact` with SelectList UI
- Global `currentCtx` for reliable status updates

## Architecture

- Spawns `pi --mode rpc --no-session` processes
- JSON events over stdin/stdout
- `Map<string, SubAgent>` tracking
- Status shows count of running/starting agents only

## Check HUMANS.TODO.md Before Next Session
