# TODO: pi-subagent Extension

## Bugs / Issues
- [ ] Verify status updates correctly when sub-agent errors (not just completes)
- [ ] Check if widget updates properly when multiple agents complete simultaneously
- [ ] Test behavior when sub-agent process crashes unexpectedly

## Features to Add

### High Priority
- [ ] **Streaming reports** - Show sub-agent output in real-time, not just at completion
- [ ] **Sub-agent-to-parent messaging** - Allow sub-agents to ask parent questions
- [ ] **Result artifacts** - Structured output (files created, data returned, etc.)

### Medium Priority
- [ ] **Resource limits** - Timeout, max tokens, max file operations per sub-agent
- [ ] **Sandbox directories** - Restrict sub-agents to specific paths
- [ ] **Checkpoint/restore** - Save and resume sub-agent state

### Low Priority
- [ ] **Sub-agent templates** - Pre-defined task templates
- [ ] **Result aggregation helpers** - Combine outputs from multiple sub-agents
- [ ] **Performance metrics** - Track tokens used, time spent, efficiency

## Documentation
- [ ] Add example workflows to README
- [ ] Document best practices for parallel tasks
- [ ] Add troubleshooting guide

## Testing
- [ ] Test with 5+ concurrent sub-agents
- [ ] Test with long-running tasks (5+ minutes)
- [ ] Test error handling and recovery
- [ ] Test in different directories/with different contexts

## Polish
- [ ] Better error messages when sub-agent fails
- [ ] Configurable status update frequency
- [ ] Option to auto-remove completed agents from widget
- [ ] Color-coded status in widget

## Ideas / Exploration
- [ ] Can sub-agents spawn their own sub-agents?
- [ ] Should sub-agents inherit parent context (files, variables)?
- [ ] Could we have "persistent" sub-agents that stay alive across tasks?
- [ ] Integration with plan mode for complex parallel workflows?
