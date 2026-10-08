# C-UI-14 development campaign

Run from the repository root after `source ~/lanes/env.sh`:

```sh
export LANE=fr14-ui19
export SMITHERS_TEST_DATABASE_URL='postgres://smithers@127.0.0.1:55440/postgres?sslmode=disable'
export SMITHERS_TEST_DATABASE_NAMESPACE=fr14_ui19
export SMITHERS_CODE_LATENCY_CAMPAIGN=1
export GOMAXPROCS=8
cd packages/backend
go test -p 4 ./internal/compose -run '^TestCodeDocumentLatencyCampaign$' -count=1 -timeout 18m -v
```

The opt-in Go harness creates an isolated composed install with two admitted
members. Chromium mounts the production CodeEditorView, fileDocument binding,
LiveDocProvider and LiveChannel. Only the campaign HTML, JS and CSS are served
by Playwright; the authenticated websocket reaches the composed install.
The mount reads display actors from authenticated `/api/user` and `/api/members`;
it supplies that presentation metadata to the production awareness provider.
The existing scripted guest uses the native document library. No production
activation or confinement receipt is changed.

Each flag runs for five minutes. Both members type concurrently at four keys
per second and select their last character, moving awareness throughout. Receipt
observation runs concurrently with input, so slow delivery does not reduce the
typed workload. The campaign mount holds the production browser presence lease
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

To exercise the installed Linux daemon and its actual disk saves, build the
existing namespace harness and supply its binary to the same campaign:

```sh
cargo build --locked -p smithers-machined --example rehearsal_daemon --features killpoints --target-dir "$PWD/.artifacts/rehearsal-machined"
export SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY="$PWD/.artifacts/rehearsal-machined/debug/examples/rehearsal_daemon"
```

Run those commands from the repository root before entering `packages/backend`.
This mode uses the real daemon, filesystem watcher, native jj and host repository;
the broker census remains empty and there is no microVM. Each flag also retains
actual disk text and asserts equality with both browsers after the save window.
The receipt identifies the guest mode and whether disk convergence was checked.

These are development observations, not C-UI-14 qualification. Linux loopback
omits the reference host, second Mac and LAN. Qualification and smithers-06 screenshot/copy approval stay
pending; passing this campaign does not enable the product flag.

The Bun runner can also connect to an existing install using
`SMITHERS_CODE_DOCUMENT_ORIGIN`, `SMITHERS_CODE_DOCUMENT_TOPIC` and
`SMITHERS_CODE_DOCUMENT_COOKIES` (a JSON object with `ben` and `alice` cookie
values). Cookies are never written to artifacts. This remains a development
mount rather than proof of the full app's File command/binding seam; that seam
and real daemon identity/awareness projection belong to T-APP-14/C-J3-04.
