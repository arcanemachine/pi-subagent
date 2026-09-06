# Agent Instructions

## Workflow

ALWAYS commit when a task is completed.

## Verification

Run before completion:

```bash
npm run format:check
npm run typecheck
npm run test
npm run build
npm pack --dry-run
```

## Commit Style

Match existing commits:

- `chore: add pi-package manifest and update README`
- `style: add separators around report output`
- `fix: resolve TypeScript types and add dev dependency`

## Critical Implementation Notes

- Sub-agents run via `pi --mode rpc --no-session`
- Always kill processes on `session_before_switch` (reason: "new")
- Widget updates use `ctx.ui.setWidget()` and `ctx.ui.setStatus()`
