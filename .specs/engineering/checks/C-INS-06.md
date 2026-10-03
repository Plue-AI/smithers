# C-INS-06 `smthrs host start` runs a built bundle as a launchd service

Proves: mvp.md J1.1, §6.1 Install on a Mac, §11 stage 1 item 1 · spec.md §1.2, §5.1.0, §16.1.2, §20.2 · Layer: integration · Stage: S1 · Tickets: T-INS-08
Automation: `packages/smithers/test/host-service.integration.test.ts` (new) drives the CLI and records timings · Runs in: reference host (every step); a macOS arm64 CI runner (every step except 5)

## Setup
- The reference host with a clean macOS user that is an administrator, no `$STATE` and no `SMITHERS_*` variable. Remote Login is on, so steps can run over SSH with no GUI session.
- The T-INS-01 bundle built from a clean checkout at commit X (`smthrs build //apps/app:serverBundle`) into `<out>`, and the `smthrs` CLI from the installer archive of the same commit.
- If T-INS-03 chose the LaunchAgent fallback, step 1 expects no `sudo`; configure the selected automatic-login path before step 5. C-SPK-06 proves only the agent boot/doctor alternative. Step 5 must prove automatic login after reboot.

## Steps
10. Record launcher, backend, PostgreSQL and flow-host effective UIDs at initial service start and after restart. Invoke installation through sudo and record the original installing user plus LaunchDaemon UserName, without credential values.

1. `smthrs host start --bundle <out>`. Answer the `sudo` prompt. Record every printed line and the time to `/readyz`.
2. Run step 1's command again. Record the backend pid before and after.
3. `smthrs host status`.
4. Open the printed setup URL in a browser on the Mac and exchange the token for a setup session.
5. Reboot. For the LaunchDaemon, reach the login window and use SSH with `who` showing no console user to run `curl http://127.0.0.1:4000/readyz` and `smthrs host status`. For the LaunchAgent fallback, perform no manual GUI login; record the automatically logged-in installing user, then run the same readiness/status probes. Record boot plus doctor in the selected service context.
6. Log in. `kill -9` the backend process, then poll `/readyz` every second.
7. `smthrs host stop`, and list processes under the bundle prefix. Then `smthrs host start --bundle <out>`, and reload the setup card from step 4.
8. Copy the bundle to `<out2>` and run `smthrs host start --bundle <out2>`. Move `<out2>` away and run `smthrs host status`.
9. Change one byte of one file in a third copy of the bundle and start with it.

## Pass when
- Step 10: the original installing user, LaunchDaemon UserName and every recorded service effective UID match before and after restart. Sudo never changes service identity to root.

- Service mode (T-INS-02/T-INS-08, smithers-b8): after setup, scan `$STATE/logs/` for both the first and the re-minted token (absent); `$STATE/run/host.sock` answers "already set up" after the claim.
- Step 1: for the LaunchDaemon, exactly one `sudo` prompt and `launchctl print system/<label>` shows `UserName` = the installing administrator and the absolute bundled `bin/smithers-server`; for the LaunchAgent, no sudo and `launchctl print gui/<uid>/<label>` shows the installing user and that launcher path. Both reach `/readyz` within 60 s and print the loopback setup URL.
- Step 2: no prompt, the same backend pid and the same setup URL (the token didn't rotate).
- Step 3: exit 0, one healthy line per process, and the bundle path.
- Step 4: the setup card opens a setup session.
- Step 5: `/readyz` answers 200 and status reports doctor ready. The LaunchDaemon passes with no GUI session. The LaunchAgent passes only after the configured automatic login, without manual login. This step completes automatic-login evidence left unproven by C-SPK-06.
- Step 6: launchd restarts the launcher, the backend and PostgreSQL return, and `/readyz` answers 200 within 30 s.
- Step 7: after `stop`, no launcher, backend or PostgreSQL process remains; after `start`, the setup session and every setup step state from step 4 are unchanged.
- Step 8: after one restart the plist points at `<out2>`; with `<out2>` gone, `status` exits non-zero and names the missing path.
- Step 9: refused before any plist change, naming the file whose hash differs.

## Fail when
- A repeated start launches a second backend or PostgreSQL, or changes the setup token.
- Any Smithers process runs as root.
- The selected LaunchDaemon answers only after GUI login, or the selected LaunchAgent needs manual login instead of the configured automatic login.
- The install needs a Homebrew formula, `pnpm dev` or a file placed by hand.

## Evidence
`.artifacts/checks/C-INS-06/<UTC timestamp>/`: timestamped transcript, literal selected plist, exact bootstrap and `launchctl print` commands/output, process lists per step, `/readyz` timings, status output, bundle manifest hash and commit X. Record administrator identity, macOS version, `/opt/homebrew` spike prerequisite and sudo count. For the fallback, record reboot and automatic-login evidence without manual login, plus service-context boot and doctor results.
