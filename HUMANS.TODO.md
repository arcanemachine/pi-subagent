# Human TODOs

## Verify Fix

- [ ] Test that status updates immediately when sub-agent completes
  - Spawn a sub-agent: `/subagent spawn "sleep 2 && echo done"`
  - Watch status go from `active subagents: 1` to `active subagents: 0` immediately on completion
  - Verify widget shows ✓ for completed agent

## Future Testing

- [ ] Test `/subagent interact` with arrow keys
- [ ] Test kill functionality
- [ ] Test parallel spawning with multiple agents
