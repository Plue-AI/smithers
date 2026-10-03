# C-INS-06 `smthrs host start` runs a built bundle as a launchd service

Proves: mvp.md J1.1, §6.1 Install on a Mac, §11 stage 1 item 1 · spec.md §1.2, §5.1.0, §16.1.2, §20.2 · Layer: integration · Stage: S1 · Tickets: T-INS-08
Automation: `packages/smithers/test/host-service.integration.test.ts` (new) drives the CLI and records timings · Runs in: reference host (every step); a macOS arm64 CI runner (every step except 5)

## Setup
- The reference host with a clean macOS user that is an administrator, no `$STATE` and no `SMITHERS_*` variable. Remote Login is on, so steps can run over SSH with no GUI session.
- The T-INS-01 bundle built from a clean checkout at commit X (`smthrs build //apps/app:serverBundle`) into `<out>`, and the `smthrs` CLI from the installer archive of the same commit.
- If T-INS-03 chose the launchd agent fallback, step 1 expects no `sudo` and step 5 runs after the automatic login.

## Steps
1. `smthrs host start --bundle <out>`. Answer the `sudo` prompt. Record every printed line and the time to `/readyz`.
2. Run step 1's command again. Record the backend pid before and after.
3. `smthrs host status`.
4. Open the printed setup URL in a browser on the Mac and exchange the token for a setup session.
5. Reboot to the login window. Over SSH, with `who` showing no console user, run `curl http://127.0.0.1:4000/readyz` and `smthrs host status`.
6. Log in. `kill -9` the backend process, then poll `/readyz` every second.
7. `smthrs host stop`, and list processes under the bundle prefix. Then `smthrs host start --bundle <out>`, and reload the setup card from step 4.
8. Copy the bundle to `<out2>` and run `smthrs host start --bundle <out2>`. Move `<out2>` away and run `smthrs host status`.
9. Change one byte of one file in a third copy of the bundle and start with it.

## Pass when
- Service mode (T-INS-02/T-INS-08, smithers-b8): after setup, scan `$STATE/logs/` for both the first and the re-minted token (absent); `$STATE/run/host.sock` answers "already set up" after the claim.
- Step 1: exactly one `sudo` prompt; `/readyz` within 60 s; the output shows `http://localhost:4000` with its setup URL; `launchctl print system/<label>` shows `UserName` = the installing user and the bundle's absolute `bin/smithers-server`.
- Step 2: no prompt, the same backend pid and the same setup URL (the token didn't rotate).
- Step 3: exit 0, one healthy line per process, and the bundle path.
- Step 4: the setup card opens a setup session.
- Step 5: `/readyz` answers 200 and `status` shows `msb doctor` ready, with no GUI session.
- Step 6: launchd restarts the launcher, the backend and PostgreSQL return, and `/readyz` answers 200 within 30 s.
- Step 7: after `stop`, no launcher, backend or PostgreSQL process remains; after `start`, the setup session and every setup step state from step 4 are unchanged.
- Step 8: after one restart the plist points at `<out2>`; with `<out2>` gone, `status` exits non-zero and names the missing path.
- Step 9: refused before any plist change, naming the file whose hash differs.

## Fail when
- A repeated start launches a second backend or PostgreSQL, or changes the setup token.
- Any Smithers process runs as root.
- The service answers only after a GUI login.
- The install needs a Homebrew formula, `pnpm dev` or a file placed by hand.

## Evidence
`.artifacts/checks/C-INS-06/<UTC timestamp>/`: the terminal transcript with timestamps, the plist, `launchctl print` output, process lists per step, `/readyz` timings, `smthrs host status` output per step, the bundle manifest hash and commit X.
