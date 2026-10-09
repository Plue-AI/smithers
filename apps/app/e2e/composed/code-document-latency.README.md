# C-UI-14 development campaign

Build the real Linux daemon from the repository root after `source ~/lanes/env.sh`, then run the campaign:

```sh
export LANE=fr14-ui19
cargo build --locked --release -p smithers-machined --example rehearsal_daemon --features killpoints --target-dir "$PWD/target"
export SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY="$PWD/target/release/examples/rehearsal_daemon"
export SMITHERS_TEST_DATABASE_URL='postgres://smithers@127.0.0.1:55440/postgres?sslmode=disable'
export SMITHERS_TEST_DATABASE_NAMESPACE=fr14_ui19
export SMITHERS_CODE_LATENCY_CAMPAIGN=1
export GOMAXPROCS=8
cd packages/backend
go test -p 4 ./internal/compose -run '^TestCodeDocumentLatencyCampaign$' -count=1 -timeout 18m -v
```

The opt-in Go harness creates an isolated composed install with two admitted
members. Chromium mounts the production FileCardBody container, CodeEditorView, fileDocument binding,
LiveDocProvider and LiveChannel. Only the campaign HTML, JS and CSS are served
by Playwright; the authenticated websocket reaches the composed install.
The mount reads display actors from authenticated `/api/user` and `/api/members`;
the container derives display metadata from the provider’s authenticated author references.
The campaign requires the installed daemon; scripted receipts cannot pass it.
Use the release build for latency observations: debug native jj timings do not
measure the install’s optimized executable.
No production activation or confinement receipt is changed.

Each flag runs for five minutes. Both members type concurrently at four keys
per second on adjacent lines and select their last character, moving awareness
throughout. A newline is entered through Chromium before timing starts, so both
remote selections remain visible; this setup input is excluded from the samples. Receipt
observation runs concurrently with input, so slow delivery does not reduce the
typed workload. A bounded 60-second drain follows all five minutes of input;
individual slow arrivals are included in p95 rather than truncating the run. The campaign mount holds the production browser presence lease
for the file, matching an active member rather than an idle machine.
Unique printable Unicode characters identify individual keystrokes. A single
runner monotonic clock measures from before keyboard insertion until the other
page's production document observer reports the character (including automation
and callback overhead). Warm-up samples are retained. Each member must have at
least 1,000 samples and nearest-rank p95 below 1,000 ms for both flag states.
The runner checks convergence, exactly-once characters, remote selection and
caret visibility, and caret/gutter colour equality. Raw samples, final text,
flag comparison, screenshots, exact browser bundle/runner, browser/host identity and source identity are retained under
`.artifacts/checks/C-UI-14/<UTC>/`, including failed observations.

The Linux daemon uses the real filesystem watcher, native jj and host repository;
the broker census remains empty and there is no microVM. Each flag also retains
actual disk text and asserts equality with both browsers after the save window.
The receipt identifies the guest mode and whether disk convergence was checked.
The summary records the backing filesystem type. A lane-owned tmpfs can isolate
a Linux development run from shared storage load; that run measures live editing
and filesystem byte convergence, with physical-storage performance still pending
on the reference Mac.
For the controlled Linux run, compile before selecting the temporary state directory
(the executable and evidence stay in the worktree):

```sh
campaign_root="$PWD"
go test -C packages/backend -c -o "$campaign_root/.artifacts/code-document-latency.test" ./internal/compose
campaign_tmp=$(mktemp -d /dev/shm/"$LANE".XXXXXX)
(cd packages/backend/internal/compose && TMPDIR="$campaign_tmp" "$campaign_root/.artifacts/code-document-latency.test" -test.run '^TestCodeDocumentLatencyCampaign$' -test.count=1 -test.timeout=18m -test.v)
rmdir "$campaign_tmp"
```

Every attempted keystroke retains its send, local observation and peer observation
on the same runner clock, including missing or late arrivals. Duplicate peer
observations fail. `manifest.json` binds all retained files by SHA-256; the summary
also binds the daemon executable and native library, separately from source SHA.

These are development observations, not C-UI-14 qualification. Linux loopback
omits the reference host, second Mac and LAN. Qualification and smithers-06 screenshot/copy approval stay
pending; passing this campaign does not enable the product flag.

The Bun runner can also connect to an existing install using
`SMITHERS_CODE_DOCUMENT_ORIGIN`, `SMITHERS_CODE_DOCUMENT_TOPIC` and
`SMITHERS_CODE_DOCUMENT_COOKIES` (a JSON object with `ben` and `alice` cookie
values). Cookies are never written to artifacts. This remains a development
File container mount rather than proof of the full app’s File command door;
that door belongs to T-APP-14/C-J3-04.
