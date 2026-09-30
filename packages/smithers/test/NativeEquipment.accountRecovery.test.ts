import { Seat } from "@smthrs/agent"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

it("rechecks a pinned Claude subscription after expiry and recovers after login", async () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-account-recovery-"))
  const account = join(directory, "claude-2")
  mkdirSync(account)
  const status = join(account, "status")
  const signedIn = "{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}"
  writeFileSync(status, signedIn)
  writeFileSync(join(directory, "claude"), "#!/bin/sh\n/bin/cat \"$CLAUDE_CONFIG_DIR/status\"\n", { mode: 0o755 })
  let now = Date.now()
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
  try {
    const executor = RequestExecutor.RequestExecutor.of({ execute: () => Effect.die("unexpected model transport") })
    const resolver = NodeControl.seatResolver({ SMITHERS_ACCOUNTS_DIR: directory, PATH: directory }, executor)
    const resolve = () => Effect.scoped(resolver.resolve("opus@claude-2"))
    expect((await Effect.runPromise(resolve())).id).toBe("opus@claude-2")
    writeFileSync(status, "{\"loggedIn\":false,\"authMethod\":\"none\"}")
    now += 29_999
    expect((await Effect.runPromise(resolve())).id).toBe("opus@claude-2")
    now += 1
    const refused = await Effect.runPromise(Effect.flip(resolve()))
    expect(refused).toBeInstanceOf(Seat.SeatUnresolved)
    expect(refused.seat).toBe("opus@claude-2")
    expect(refused.message).toContain("claude-2")
    writeFileSync(status, signedIn)
    now += 30_000
    expect((await Effect.runPromise(resolve())).id).toBe("opus@claude-2")
  } finally {
    clock.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
