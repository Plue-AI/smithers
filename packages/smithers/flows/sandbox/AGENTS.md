# Command transport

- Send CommandSandbox shell programs as framed stdin through a short bootstrap,
  ahead of the environment envelope and command input. Preserve input bytes,
  EOF, process identity, and cancellation.
- Keep the kernel authorizing the complete transport argv and enforcing its
  resource bound. Never truncate, hash, or skip arguments to pass authorization.
- A transport grant includes receiving guest shell programs on stdin. It is not
  a grant for each guest program. Keep this distinction explicit in the docs.
- Heartbeat deadlines bound probe observation, not cleanup after a completed
  response. Preserve the existing boot, restart, and two-failure detection.
- Regression and acceptance evidence: [#2949](https://github.com/smithersai/smithers/issues/2949).
