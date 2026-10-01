/** Explicitly opt in: this test spends one Claude subscription request in a real microVM. */
import { type MicrosandboxSandbox, Sandbox } from "@smthrs/sandbox"
import { Effect, FileSystem } from "effect"
import * as Microsandbox from "microsandbox"
import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import test from "node:test"
import { coolAccount, makeAccountPicker, perAccount, readPools } from "../accounts.ts"
import { guestCheckout, make } from "../vm.ts"
import { claudeInGuest, guestClaudeHome, reserveRemoteAccount } from "../work/claude.ts"
import { AgentFailed, fixRemotely } from "../work/flow.ts"

const sdk = Microsandbox as unknown as MicrosandboxSandbox.Sdk

test("real Claude edits a VM checkout, removes its borrowed login before capture, and destroys the VM", {
  skip: process.env.ISSUE_SWEEP_CLAUDE_REAL !== "1"
    ? "set ISSUE_SWEEP_CLAUDE_REAL=1 to run Claude in a real VM"
    : false,
  timeout: 20 * 60_000
}, async (t) => {
  const requested = process.env.ISSUE_SWEEP_CLAUDE_ACCOUNT
  let selected = ""
  let login = ""
  const picker = makeAccountPicker(
    perAccount,
    readPools.pipe(Effect.map((current) => ({
      codex: { ready: [], unavailable: [] },
      claude: {
        ...current.claude,
        ready: current.claude.ready.filter((label) => requested === undefined || label === requested)
      }
    })))
  )
  const choose = requested === undefined ? reserveRemoteAccount(3355) : reserveRemoteAccount(3355, { picker })
  const marker = `issue-sweep Claude VM proof ${process.pid}`
  let machine = ""
  let cleanedBeforeCapture = false
  const provider = make()
  const observed: Sandbox.Provider = {
    acquire: (id) =>
      provider.acquire(id).pipe(Effect.tap((session) =>
        Effect.sync(() => {
          machine = session.remoteId
        })
      ))
  }
  const remote = await Effect.runPromise(Effect.scoped(Effect.andThen(
    choose.pipe(Effect.tap((chosen) =>
      Effect.sync(() => {
        assert.equal(chosen.agent, "claude")
        assert.ok(chosen.login)
        selected = chosen.account
        login = chosen.login
      })
    )),
    fixRemotely(
      observed,
      `real-claude-${process.pid}`,
      Effect.gen(function*() {
        const result = yield* claudeInGuest(
          selected,
          login,
          "vm",
          `Answer the trivial question 2+2, then append exactly one line '${marker}' to README.md in ` +
            `${guestCheckout}. Do not edit any other file or run git or jj. Reply with the answer and ` +
            "COMMIT: 🧪 test: Claude VM proof (#3355).",
          (stdout, stderr, code) => coolAccount("claude", selected, stdout, stderr, code)
        )
        const fs = yield* FileSystem.FileSystem
        assert.equal(yield* fs.exists(guestClaudeHome), false, "the token directory is removed before work capture")
        cleanedBeforeCapture = true
        return result
      }).pipe(Effect.mapError((cause) => new AgentFailed({ message: cause.message })))
    )
  )))
  assert.equal(cleanedBeforeCapture, true)
  assert.equal(remote.result.agent, "claude")
  assert.equal(remote.result.account, selected)
  assert.match(remote.result.report, /4/)
  assert.equal(remote.work._tag, "Changed")
  if (remote.work._tag === "Changed") {
    assert.match(remote.work.patch, new RegExp(`^\\+${marker}$`, "m"))
    assert.doesNotMatch(remote.work.patch, /oauth-token|\.claude-sweep|\.credentials\.json/)
  }
  // Deliberately avoid including credential values in assertion messages or receipts.
  assert.equal(JSON.stringify(remote).includes(login), false, "no borrowed login is persisted in work or result")
  assert.notEqual(machine, "")
  await assert.rejects(
    sdk.Sandbox.get(machine),
    (cause: unknown) => (cause as { code?: string }).code === "sandboxNotFound"
  )
  t.diagnostic(`account=${selected} machine=${machine} base=${remote.work.base} cleanup=before-capture destroyed=true`)
  if (process.env.ISSUE_SWEEP_CLAUDE_RECEIPT !== undefined) {
    await writeFile(
      process.env.ISSUE_SWEEP_CLAUDE_RECEIPT,
      JSON.stringify(
        {
          ...remote,
          account: selected,
          machine,
          cleanup: "before-capture",
          destroyed: true
        },
        null,
        2
      ) + "\n",
      { mode: 0o600 }
    )
  }
})
