# Agent Instructions

## Workflow

Commit when a task is completed.

## Pre-commit

```bash
npm install
npx tsc --noEmit
npx prettier --write src/index.ts
```

## Commit Style

Match existing commits:
- `chore: add pi-package manifest and update README`
- `style: add separators around report output`
- `Fix TypeScript types and add dev dependency`

## Critical Implementation Notes

- Sub-agents run via `pi --mode rpc --no-session`
- Always kill processes on `session_before_switch` (reason: "new")
- Widget updates use `ctx.ui.setWidget()` and `ctx.ui.setStatus()`
