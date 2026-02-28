# Human TODOs

## Verify Fix

- [ ] Test that status updates immediately when sub-agent completes
  - Spawn a sub-agent: `/subagent spawn "sleep 2 && echo done"`
  - Watch status go from `active subagents: 1` to `active subagents: 0` immediately on completion
  - Verify widget shows ✓ for completed agent

## Test New Features

- [ ] Test `/subagent purge` command
  - Spawn a few sub-agents, let them complete
  - Run `/subagent purge`
  - Verify completed agents are removed from widget
  - Verify count is shown in notification

## Future Testing

- [ ] Test `/subagent interact` with arrow keys
- [ ] Test kill functionality
- [ ] Test parallel spawning with multiple agents
