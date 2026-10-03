# File-write control

`Run(ctx, runtime, workspaceID, artifactDir)` uses the already-running spike VM.
It starts one temporary local PostgreSQL instance on its own Unix socket, with
fsync enabled, and stops it and removes its directory on return. The fixture
contains product baseline table definitions and only the later workspace
columns this service queries. Identity and repository seeds follow the backend
service fixtures. No product code or repository metadata receipts are changed.

Two independent series retain 100 sequential writes of a 400-line file:

- `control.csv` calls the actual `WorkspaceService.WriteWorkspaceFile`, including
  authorization, SQL, VM inspection, the canonical-path guard, and the write.
- `one-exec-control.csv` calls the actual `microsandbox.Runtime.WriteFile` once
  per write, matching the ticket's rejected one-exec alternative.

The current service's provider path uses **two** guest execs per write, whereas
the ticket describes one. Its provider adapter forwards real observations,
execs, and writes to microsandbox, translating the fixed provider working-copy
root to the microsandbox root. These are separate results, not interchangeable
latency claims. The runtime service path additionally validates Git/Jujutsu
repository initialization, so this control explicitly measures the provider
service path and does not claim to measure that runtime path.

Each write has a sequence value, and every file is read back byte-for-byte
outside its measured interval. Raw CSV includes every sample and its content
SHA-256. Timings use Go's host monotonic clock; percentiles use nearest rank.
No warm-up sample is discarded. A failed or partial run has no completed
summary. Existing control artifacts are refused.

Series order is service first, direct second, in one VM with the same file.
The direct series therefore inherits a populated file and warm guest state.
These timings are observations on that host, not product performance gates.

Test-first receipt: `go test ./control` initially failed with undefined
`sequence`, `measure`, `Summary`, and `summarize`; `control_test.go` existed
before those implementations. Tests cover real file writes, cancellation,
readback mismatch, immutable evidence, nearest-rank calculations, real
PostgreSQL authorization, and fixture cleanup.
