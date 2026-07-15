# TODO

## `subagent_spawn_parallel`

- **Status:** temporarily disabled
- **Reason:** the previous structured-report implementation failed intermittently
  during parallel dispatch. The replacement `subagent_complete` flow has not yet
  been exercised with multiple simultaneous child processes.
- **Action:** add parallel lifecycle coverage, verify independent completion and
  cleanup, then flip `ENABLE_SPAWN_PARALLEL_TOOL` to `true`.
- **Code location:** `src/index.ts`
- **Docs:** restore the `subagent_spawn_parallel` bullet in `README.md` when the
  tool is re-enabled.
