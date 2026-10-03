# C-INS-06 `smthrs host start` runs a built bundle as a launchd service

Proves: mvp.md J1.1, §6.1 Install on a Mac, §11 stage 1 item 1 · spec.md §1.2, §5.1.0, §16.1.2, §20.2 · Layer: integration · Stage: S1 · Tickets: T-INS-08
Automation: `packages/smithers/test/host-service.integration.test.ts` (new) drives the CLI and records timings · Runs in: reference host (every step); a macOS arm64 CI runner (every step except 5)

## Setup
- The reference host with a clean macOS user , no `$STATE` and no `SMITHERS_*` variable. The installing user is logged in.
- The T-INS-01 bundle built from a clean checkout at commit X (`smthrs build //apps/app:serverBundle`) into `<out>`, and the `smthrs` CLI from the installer archive of the same commit.

## Steps
11. Record launcher, backend, PostgreSQL and flow-host effective UIDs at initial start and after restart.

1. `smthrs host start --bundle <out>`. Record every printed line and time to `/readyz`; require no privilege prompt.
2. Run step 1's command again. Record the backend pid before and after.
3. `smthrs host status`.
4. Open the printed setup URL in a browser on the Mac and exchange the token for a setup session.
5. Reboot, log in as the installing user, then probe `/readyz` and `smthrs host status`. Record boot and doctor in the LaunchAgent context.
6. Log in. `kill -9` the backend process, then poll `/readyz` every second.
7. `smthrs host stop`, and list processes under the bundle prefix. Then `smthrs host start --bundle <out>`, and reload the setup card from step 4.
8. Copy the bundle to `<out2>` and run `smthrs host start --bundle <out2>`. Move `<out2>` away and run `smthrs host status`.
9. Change one byte of one file in a third copy of the bundle and start with it.
10. Before T-INS-06 lands, run the real host status command and require exit 0 for healthy processes with unavailable install telemetry omitted. With T-INS-04, invoke host start --bind --origin through the registered CLI. Disable the configured msb in a disposable bundle and require startup refusal with no repository process. A file absent from manifest.json must also refuse before plist mutation.
- Inspect literal ProgramArguments for `--setup-handoff=file`, stat `$STATE/run/setup-urls.json`, and invoke start before and after claim. Scan service logs after each start/restart.

## Pass when
- Step 11: every service effective UID equals the installing user before and after restart.

- Service mode: neither initial nor rotated token occurs in logs; claim removes the handoff file and subsequent start prints "already set up".
- Step 1: no privilege prompt; `launchctl print gui/<uid>/<label>` shows the absolute bundled launcher. `/readyz` answers within 60 s and start prints the loopback setup URL.
- Step 2: no prompt, the same backend pid and the same setup URL (the token didn't rotate).
- Step 3: exit 0, one healthy line per process, and the bundle path.
- Step 4: the setup card opens a setup session.
- Step 5: after login, `/readyz` answers 200 and status reports doctor ready.
- Step 6: launchd restarts the launcher, the backend and PostgreSQL return, and `/readyz` answers 200 within 30 s.
- Step 7: after `stop`, no launcher, backend or PostgreSQL process remains; after `start`, the setup session and every setup step state from step 4 are unchanged.
- Step 8: after one restart the plist points at `<out2>`; with `<out2>` gone, `status` exits non-zero and names the missing path.
- Step 9: refused before any plist change, naming the file whose hash differs.
- Expected plist fields, URL prefixes, exit codes and timing limits are committed literal fixtures; no test reads spec Markdown or derives expected results from production helpers.
- ProgramArguments includes `--setup-handoff=file`; the handoff file is mode 0600, owned by the installing user, and absent after claim. No log contains setup token bytes; after claim start prints "already set up".

## Fail when
- A repeated start launches a second backend or PostgreSQL, or changes the setup token.
- Any Smithers process runs as root.
- The service requires privilege escalation or runs outside the installing user’s GUI domain.
- The install needs a Homebrew formula, `pnpm dev` or a file placed by hand.

## Evidence
`.artifacts/checks/C-INS-06/<UTC timestamp>/`: timestamped transcript, literal LaunchAgent plist, GUI bootstrap/print output, process UIDs, readiness timings, status, manifest hash, commit X and post-login boot/doctor results.
