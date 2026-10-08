# C-STK-03 Stop then Resume continues from the last finished step; Retry keeps the earlier attempt

Folded into T-STK-05's tests (minimal-code synthesis, 2026-10-03).

## Four-step production-engine qualification

`packages/backend/internal/compose/todo_four_step_integration_test.go` loads
`testdata/todo-four-step/flow.ts` through the install's production loader. Four
literal actions append counters inside the workspace; s3 waits for a fixture
release and s4 fails. Stop, Resume, Retry and Retry with the current flow enter
`POST /api/todos/{n}` and the production dispatcher. The test keeps the paused
wait, timestamped transitions, counters, failure card and attempt snapshots in
`.artifacts/checks/C-STK-03/rehearsal/<UTC>/`.

- Linux component execution: `SMITHERS_TODO_FOUR_STEP=1 go test -p 4
  ./packages/backend/internal/compose -run '^TestTodoFourStepComposedInstall$'
  -count=1 -v -timeout=15m`.
- Reference machine: `SMITHERS_TODO_FOUR_STEP_MICROVM=1
  SMITHERS_CHECK_BUNDLE=<approved bundle> go test -p 4
  ./packages/backend/internal/compose -run '^TestTodoFourStepMicroVM$'
  -count=1 -v -timeout=20m`. This uses the installed microVM composition without
  a trusted-process fallback and also requires retained safe-idle machine release.
- Both require `SMITHERS_TEST_DATABASE_URL`; use a private database namespace.
  The GitHub peer is `githubfake`, never a real repository write.

A successful Linux run does not qualify machine isolation, R1–R5, reference-host
latency, real GitHub or the human journeys. Those receipts remain required.
Historical/opaque overrides without a successfully loaded inspection containing
`coding/todo-boundary` still refuse Stop before recording a signal. The exact
retained digest and source are checked; a different Active graph is insufficient.
