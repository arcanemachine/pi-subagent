# Human TODOs

## Verify Fix

- [ ] Test that status updates immediately when sub-agent completes
  - Spawn a sub-agent: `/subagent spawn "sleep 2 && echo done"`
  - Watch status go from `active subagents: 1` to `active subagents: 0` immediately on completion

## Test New Features

- [ ] Test `/subagent purge` command
  - Spawn a few sub-agents, let them complete
  - Run `/subagent purge`
  - Verify completed agents are removed
  - Verify count is shown in notification

- [ ] Test widget removal
  - Verify no `📦 Sub-Agents` widget appears at top
  - Verify only `active subagents: N` shows in bottom status
  - Use `/subagent list` to see agent details

- [ ] Test status hiding
  - On fresh start, verify NO `active subagents` in status bar
  - Spawn a sub-agent, verify status appears
  - Purge all agents, verify status disappears again

## Future Testing

- [ ] Test `/subagent interact` with arrow keys
- [ ] Test kill functionality
- [ ] Test parallel spawning with multiple agents
