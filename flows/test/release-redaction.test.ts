import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { commandRunner } from "../release-support/io.ts"

test("command failures redact credentials under any credential name and across the tail cut", async (test) => {
  const root = await mkdtemp(join(tmpdir(), "release-redaction-"))
  test.after(() => rm(root, { recursive: true, force: true }))
  const pat = "ghp_fakePersonalAccessTokenValue"
  const auth = "npm-fake-auth-value-for-redaction"
  const explicit = "explicit-step-secret-value-0123"
  // The PAT straddles the 6000-character stdout tail cut.
  const script = [
    "const e = process.env",
    "process.stdout.write(e.GH_PAT.slice(0, 10) + e.GH_PAT.slice(10) + 'x'.repeat(6000 - e.GH_PAT.length + 10))",
    "process.stderr.write(e.NPM_CONFIG__AUTH + ' ' + e.STEP_VALUE + ' ' + e.DEPLOY_CREDENTIAL)",
    "process.exitCode = 1"
  ].join(";")
  await assert.rejects(
    commandRunner(root)(process.execPath, ["-e", script], {
      env: { GH_PAT: pat, NPM_CONFIG__AUTH: auth, STEP_VALUE: explicit, DEPLOY_CREDENTIAL: "cred-9876" }
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      for (const leaked of [pat.slice(10), auth, explicit, "cred-9876"]) {
        assert.ok(!error.message.includes(leaked), `diagnostic leaked ${leaked}`)
      }
      return true
    }
  )
})

test("command failures keep benign session and socket values legible", async (test) => {
  const root = await mkdtemp(join(tmpdir(), "release-redaction-"))
  test.after(() => rm(root, { recursive: true, force: true }))
  const sessionKey = "sess-fake-key-0123"
  // Inherited, as on a Linux release runner; only the step's own values are explicit.
  const saved = { XDG_SESSION_CLASS: process.env.XDG_SESSION_CLASS, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }
  test.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  process.env.XDG_SESSION_CLASS = "user"
  process.env.SSH_AUTH_SOCK = root
  const script = [
    "const e = process.env",
    "process.stderr.write([e.XDG_SESSION_CLASS, e.SSH_AUTH_SOCK, e.APP_SESSION_KEY].join(' '))",
    "process.exitCode = 1"
  ].join(";")
  await assert.rejects(
    commandRunner(root)(process.execPath, ["-e", script], {
      env: { APP_SESSION_KEY: sessionKey }
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, new RegExp(`user ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} <redacted>`))
      assert.ok(!error.message.includes(sessionKey), "diagnostic leaked the session key")
      return true
    }
  )
})
