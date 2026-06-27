# TODO

## `subagent_spawn_parallel`

- **Status:** temporarily disabled
- **Reason:** parallel sub-agent dispatch appears to interfere with structured
  `subagent_final_report` format parsing across multiple concurrent output streams.
- **Action:** re-enable the tool once structured-report handling is fixed.
- **Code location:** `src/index.ts` — flip `ENABLE_SPAWN_PARALLEL_TOOL` to `true`
  and remove this TODO.
- **Docs:** remove the TODO note and restore the `subagent_spawn_parallel`
  bullet in `README.md`.
