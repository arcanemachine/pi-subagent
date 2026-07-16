# TODO

- Rename `/subagent notify` to `/subagent steer`, and rename `subagent_notify` to `subagent_steer` (do not worry about compatibility; this is our application, and we can do whatever we want to with the code.)
- Support steering every running sub-agent with a single target such as `/subagent steer all Stop now and report back`, with a per-agent delivery summary.
- Keep sub-agents available for follow-up steering after they report back. Design this with bounded retention: cap retained agents, expire idle processes, release transcript buffers, and expose explicit close/prune controls.
