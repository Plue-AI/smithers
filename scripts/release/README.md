# Credential soak recording

On each machine, Ben signs into Claude Code, Codex and GitHub independently
through his personal Terminal card. On the recording Mac, use the released
`smthrs` CLI signed into the install as Ben. No login is copied or seeded.

Run once for machine A and once for machine B, using each machine's allocated
non-root personal UID and a new evidence directory:

```sh
export SMITHERS_SOAK_BEN_INDEPENDENT_LOGIN=1
scripts/release/credential-soak.sh smithers-mvp-canary/2026-10-05 MACHINE UID .artifacts/checks/C-REL-05/RUN-A
```

The parent directory must already exist. The recorder uses the production
`workspace shell` personal terminal and runs the reviewed guest script there.
It retains only numeric reports; raw terminal and tool output is discarded.
Each tool runs every ten minutes, including observations at the start and at
24 hours. Guest `timeout` must exist. A wrong UID, missing tool, late observation
or missing version refuses the capture. The script never uses sudo or root,
installs tools, copies credentials, or executes the canary's code on the host.
The recorder requires all three versions and all 435 calls, in order, including
the 24-hour endpoint. A missing, repeated or late call, a mismatched guest UID,
or a record after completion fails capture even when the terminal exits zero.
`capture.json` retains the call count and first failure without raw tool output.

Record B's sleep and wake every four hours through the install, with UTC times
and owner-signed evidence. Also retain the candidate commit/version, host
profile, Ben's account and independently created login attestations, and
C-MCH-10 evidence. These remain manual prerequisites. This recorder neither
creates check receipts nor qualifies a run: `scripts/check-run.mjs` and its
approved reference-host mapping own qualification. Terminal completion alone
is not proof that any call succeeded. Inspect every redacted call and both
machines' complete duration, including the first observation after every wake.
