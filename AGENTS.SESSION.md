# Session: pi-subagent Extension

## Current Implementation

- Sub-agent spawning via RPC (`pi --mode rpc --no-session`)
- Global `currentCtx` for widget updates (fixed stale context issue)
- Status: `active subagents: N` (counts only running/starting)
- Widget shows all agents with icons (○ starting, ▶ running, ✓ completed, ✗ error)
- Commands: `spawn`, `interact`, `report`, `list`, `kill`, `killall`
- Tools: `spawn_subagent`, `subagent_report`, `spawn_parallel`
- Interactive UI: `/subagent interact` with SelectList (arrow keys, enter, esc)

## Recent Fixes

- Fixed stale context bug by using global `currentCtx` updated on `session_start`
- Fixed `ctx.theme` undefined error by using factory function pattern
- Added command autocompletion

## Check HUMANS.TODO.md

**User has items to verify in HUMANS.TODO.md**
