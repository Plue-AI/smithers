# Runnable examples

Run `pnpm run check` and `pnpm run test -- --run` in this directory. Live model
examples require explicit opt-in with `SMITHERS_LIVE_EXAMPLES=1`. An ambient
provider key or a running Ollama daemon never selects them on its own.

To run a live test from this directory:

```sh
# Also requires OPENAI_API_KEY in the environment.
SMITHERS_LIVE_EXAMPLES=1 pnpm exec vitest run test/12-agent-live-smoke.test.ts

# Requires Ollama at localhost:11434 and ollama pull qwen2.5:7b.
SMITHERS_LIVE_EXAMPLES=1 pnpm exec vitest run test/13-agent-live-smoke-local.test.ts
```

Both tests allow 300 seconds for model work. Without opt-in they report skipped
with their requirements in the test titles. The OpenAI test also skips without
a key; the local test reports a skip reason if its daemon or model is missing.
Both declarations defer loading their native agent implementations until the
test bodies execute. The selection fixture verifies the real opt-in gates and
rejects eager implementation imports while collecting the declarations.

## Inspecting parked runs

Examples 06 and 38 use `src/park-run.ts` before rewinding or monitoring a parked
execution. The helper drives the execution in a private engine layer and waits
for the journal's committed suspension record. Stopping that caller alone is not
enough: the record can reach the reader after the caller's automatic retry has
already admitted a new coordinator drive, and the coordinator owns its drives
separately. The helper therefore stops the caller to end retry admission and
then closes the private engine, whose scope joins every admitted drive. A
running drive would otherwise move a rewind's journal tail or count as progress
to a monitor. The helper requests no durable cancellation and confirms through
storage that the run is still suspended, so a later engine can resume it.
The monitor recognizes an explicit event wait as healthy, even beyond its stall
threshold. Example 38 verifies that neither opt-in recovery nor a zero-delay
alert policy resumes or pages about that expected wait.

## Host containment

`src/37-host-containment.ts` starts a host, kills it, and verifies that its
replacement reaps the abandoned process group. The runtime creates the SQLite
parent directory, which may also be the host's repository root. The jj version
probe can run before that directory exists.
Both hosts run that probe through the contained spawner, so the shared journal
also records its spawn and normal exit before and after the orphan's reaping.

The companion `src/37-host-containment-host.ts` prints its process group id only
after recording the child durably. Startup failures print the Effect cause to
stderr and exit with status 1. The example summary preserves `hostStderr`,
including Node runtime warnings such as an experimental-feature notice.

## Sandbox filesystem tools

`src/25-agent-tools-in-sandbox.ts` exposes only `read` and `write`, with
capabilities restricted to the scratch root. Tool paths are relative to that
root. The host filesystem service rejects absolute paths, `..` components,
symlinks (including dangling links), and hard-linked files. Nested file creation
and replacement remain supported. Root names cannot contain capability glob
characters (`*` or `?`).

On POSIX the scratch root must belong to the running user and grant no group or
other permissions (mode `0700`); `main` creates it that way and refuses any other
root, so no other user can reach the tree whatever its inner modes. Windows skips
this check because it has no POSIX owner or mode bits.
The host must still exclusively own the scratch tree during the run. Path checks
do not provide an OS boundary against another process of the same user racing
filesystem mutations. QuickJS bounds cell evaluation; the supplied host service confines
tool access. The optional third `main` argument supplies a model for exercising
other cells; the default model is scripted and requires no API key.
