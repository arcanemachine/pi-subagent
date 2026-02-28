# Session Log: pi-subagent Extension Development

## Date
Current session - pi-subagent extension development and testing

## Goal
Develop a pi extension that enables spawning sub-agents via RPC for parallel task execution, making sub-agents a first-class part of the LLM workflow.

## What Was Built

### Core Extension (`src/index.ts`)
A pi extension that:
- Spawns pi sub-agents as separate processes via RPC (`pi --mode rpc --no-session`)
- Tracks sub-agent status (starting, running, completed, error)
- Shows live widget with sub-agent activity
- Provides detailed transcripts of sub-agent work
- Supports parallel spawning of multiple sub-agents

### Commands
- `/subagent spawn <task>` - Spawn a new sub-agent
- `/subagent report <id>` - Get full transcript of sub-agent activity
- `/subagent list` - List all sub-agents
- `/subagent kill <id>` - Kill a specific sub-agent
- `/subagent killall` - Kill all sub-agents

### Tools (LLM-callable)
- `spawn_subagent` - Spawn a single sub-agent
- `subagent_report` - Get detailed report of sub-agent activity
- `spawn_parallel` - Spawn multiple sub-agents and wait for all

### Key Design Decisions
1. **Status shows only running agents**: "active subagents: N" counts only non-completed agents
2. **Widget shows all agents**: Completed agents remain visible with ✓ mark
3. **Conversation integration**: Spawned agents announce themselves in chat
4. **Transcript-based reports**: Full history of tools called and messages generated

## Testing Performed

### Test 1: Basic Spawn
- Spawned sub-agent to list files
- Verified status changed from "active subagents: 0" to "active subagents: 1"
- Verified widget showed running agent
- Verified status returned to "active subagents: 0" on completion
- Retrieved report showing bash tool call and file listing

### Test 2: Parallel Spawn
- Used `spawn_parallel` with 2 tasks
- Both sub-agents ran concurrently
- Results aggregated into single response

## Current State
- Extension installed at `~/.pi/agent/extensions/pi-subagent/`
- Status format: "active subagents: N" (where N is running count)
- Widget shows all agents with status icons (○ starting, ▶ running, ✓ completed, ✗ error)
- Reports show full transcript of sub-agent activity

## Git History
```
2117a3e Remove test.sh - it was just documentation, not an actual test
0cc2d13 Fix: also show 'active subagents: 0' when no agents exist
3d3510d Change status format to 'active subagents: {count}'
0becb96 Fix: status shows 'ready' when all sub-agents complete, not total count
23520b5 Redesign: sub-agents now show live widget, conversation messages, and detailed reports
```

## Known Issues / Fixed
- ~~Completed agents counted as "active" in status~~ - Fixed
- ~~Stale agents from previous sessions~~ - Verified not an issue
- Status format now consistent: always "active subagents: N"

## Next Steps
See AGENTS.TODO.md for planned improvements and features.
