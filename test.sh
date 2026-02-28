#!/bin/bash
# Test script for pi-subagent extension

echo "Testing pi-subagent extension..."
echo "Run this with: pi -e ./src/index.ts"
echo ""
echo "Commands to try:"
echo "  /subagent spawn 'List files in current directory'"
echo "  /subagent list"
echo "  /subagent status <id>"
echo "  /subagent wait <id> 30000"
echo "  /subagent kill <id>"
echo ""
echo "Or use the tools:"
echo "  spawn_subagent with task='Count lines in all .ts files'"
echo "  wait_for_subagent with agent_id='<id>'"
