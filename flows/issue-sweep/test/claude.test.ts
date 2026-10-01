import { Sandbox } from "@smthrs/sandbox"
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, PlatformError, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as Spawner from "effect/unstable/process/ChildProcessSpawner"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { makeAccountPicker, type Pools } from "../accounts.ts"
import { guestCheckout } from "../vm.ts"
import {
  assertNoClaudeLogin,
  claudeCommand,
  ClaudeFailed,
  claudeInGuest,
  guestClaudeHome,
  readClaudeLogin,
  reserveRemoteAccount
} from "../work/claude.ts"

const token = "fake-subscription-token-for-tests"
const now = 1_000
const accounts = (t: { after: (fn: () => void) => void }) => {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-claude-login-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, "claude-5")
  mkdirSync(directory)
  return { root, directory }
}
const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.ok(Exit.isFailure(exit))
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
  assert.ok(error instanceof ClaudeFailed)
  return error
}

test("a configured token file trims its final newline and takes precedence over Keychain", async (t) => {
  const { root, directory } = accounts(t)
  writeFileSync(join(directory, "oauth-token"), ` ${token}\n`, { mode: 0o600 })
  let calls = 0
  const login = await Effect.runPromise(readClaudeLogin("claude-5", {
    accountsDirectory: root,
    platform: "darwin",
    keychain: async () => {
      calls++
      throw new Error("must not query Keychain")
    }
  }))
  assert.equal(login, token)
  assert.equal(calls, 0)
})

test("missing token files use the account directory's hashed Keychain service and return only the access token", async (t) => {
  const { root, directory } = accounts(t)
  let queried = ""
  const login = await Effect.runPromise(readClaudeLogin("claude-5", {
    accountsDirectory: join(root, "..", root.split("/").at(-1)!),
    platform: "darwin",
    now,
    keychain: async (service) => {
      queried = service
      return JSON.stringify({
        claudeAiOauth: { accessToken: token, refreshToken: "never-borrow-refresh", expiresAt: now + 1 }
      })
    }
  }))
  assert.equal(
    queried,
    `Claude Code-credentials-${createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 8)}`
  )
  assert.equal(login, token)
})

test("the native Keychain adapter invokes security with the scoped service and reads JSON stdout", async (t) => {
  const { root, directory } = accounts(t)
  const argumentsFile = join(root, "arguments.json")
  writeFileSync(
    join(root, "security"),
    `#!${process.execPath}\n` +
      `import{writeFileSync}from'node:fs';writeFileSync(${
        JSON.stringify(argumentsFile)
      },JSON.stringify(process.argv.slice(2)));` +
      `process.stdout.write(${
        JSON.stringify(JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 60_000 } }))
      });\n`,
    { mode: 0o700 }
  )
  const previous = process.env.PATH
  process.env.PATH = `${root}:${previous ?? ""}`
  t.after(() => {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  })
  assert.equal(
    await Effect.runPromise(readClaudeLogin("claude-5", { accountsDirectory: root, platform: "darwin" })),
    token
  )
  assert.deepEqual(JSON.parse(readFileSync(argumentsFile, "utf8")), [
    "find-generic-password",
    "-s",
    `Claude Code-credentials-${createHash("sha256").update(directory).digest("hex").slice(0, 8)}`,
    "-w"
  ])
})

test("default host location and platform query only the generated test account", async () => {
  const account = `claude-issue-sweep-test-${process.pid}`
  const exit = await Effect.runPromiseExit(readClaudeLogin(account, {
    keychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 60_000 } })
  }))
  if (process.platform === "darwin") {
    assert.ok(Exit.isSuccess(exit))
    assert.equal(exit.value, token)
  } else failure(exit)
})

for (const invalid of ["", " \n", "two tokens", "one\nother"]) {
  test(`an invalid configured token file fails closed (${JSON.stringify(invalid)})`, async (t) => {
    const { root, directory } = accounts(t)
    writeFileSync(join(directory, "oauth-token"), invalid)
    let calls = 0
    const error = failure(
      await Effect.runPromiseExit(readClaudeLogin("claude-5", {
        accountsDirectory: root,
        platform: "darwin",
        keychain: async () => {
          calls++
          return "{}"
        }
      }))
    )
    assert.equal(calls, 0)
    assert.match(error.message, /claude-5: no usable/)
  })
}

test("unreadable configured token files fail without consulting Keychain", async (t) => {
  const { root, directory } = accounts(t)
  mkdirSync(join(directory, "oauth-token"))
  let calls = 0
  failure(
    await Effect.runPromiseExit(readClaudeLogin("claude-5", {
      accountsDirectory: root,
      platform: "darwin",
      keychain: async () => {
        calls++
        return "{}"
      }
    }))
  )
  assert.equal(calls, 0)
})

test("a non-macOS host needs a configured token file", async (t) => {
  const { root } = accounts(t)
  let calls = 0
  failure(
    await Effect.runPromiseExit(readClaudeLogin("claude-5", {
      accountsDirectory: root,
      platform: "linux",
      keychain: async () => {
        calls++
        return "{}"
      }
    }))
  )
  assert.equal(calls, 0)
})

for (
  const credentials of [
    "not JSON",
    "null",
    "{}",
    JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: now } }),
    JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: now - 1 } }),
    JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: "2000" } }),
    JSON.stringify({ claudeAiOauth: { accessToken: "", expiresAt: now + 1 } }),
    JSON.stringify({ claudeAiOauth: { accessToken: "two tokens", expiresAt: now + 1 } })
  ]
) {
  test("malformed or expired Keychain credentials fail without exposing their contents", async (t) => {
    const { root } = accounts(t)
    const error = failure(
      await Effect.runPromiseExit(readClaudeLogin("claude-5", {
        accountsDirectory: root,
        platform: "darwin",
        now,
        keychain: async () => credentials
      }))
    )
    assert.equal(error.message.includes(token), false)
    assert.equal(error.message, "claude-5: no usable oauth-token file or unexpired Keychain login")
  })
}

test("Keychain process errors cannot expose credential stdout", async (t) => {
  const { root } = accounts(t)
  const error = failure(
    await Effect.runPromiseExit(readClaudeLogin("claude-5", {
      accountsDirectory: root,
      platform: "darwin",
      keychain: async () => {
        throw new Error(`security failed; stdout: ${token}`)
      }
    }))
  )
  assert.equal(error.message.includes(token), false)
})

for (const account of ["../claude-5", "claude-5/../../outside", "codex-5", "claude-", "/claude-5"]) {
  test(`invalid account label never queries a credential store: ${account}`, async (t) => {
    const { root } = accounts(t)
    let calls = 0
    failure(
      await Effect.runPromiseExit(readClaudeLogin(account, {
        accountsDirectory: root,
        platform: "darwin",
        keychain: async () => {
          calls++
          return "{}"
        }
      }))
    )
    assert.equal(calls, 0)
  })
}

const prompt = "quotes ' \" and $HOME; $(touch /tmp/escaped)\n--add-dir /outside"
test("the command gives the shell one literal prompt argument and reads the token outside the checkout", () => {
  const [command, args] = claudeCommand(prompt)
  assert.equal(command, "sh")
  assert.deepEqual(args.slice(-2), ["sh", prompt])
  assert.equal(args.filter((arg) => arg === prompt).length, 1)
  assert.equal(args[1]?.includes(prompt), false)
  assert.match(args[1]!, /claude -p "\$1"/)
  assert.match(args[1]!, /--output-format json/)
  assert.match(args[1]!, /CLAUDE_CODE_OAUTH_TOKEN=\$\(cat \/home\/developer\/\.claude-sweep\/oauth-token\)/)
  assert.match(args[1]!, /<\/dev\/null/)
  assert.equal(guestClaudeHome.startsWith(`${guestCheckout}/`), false)
})

const platformError = (method: string) =>
  PlatformError.badArgument({
    module: "test",
    method,
    description: `failure with ${token}`
  })

/** Mock only OS adapters: destructive failure and cancellation paths need deterministic injection. */
const guest = (options: {
  stdout?: string
  stderr?: string
  code?: number
  login?: string
  fail?: "mkdir" | "chmod" | "write" | "spawn" | "stdout" | "remove"
  wait?: boolean
  checkout?: string
} = {}) => {
  const checkout = options.checkout ?? guestCheckout
  const home = resolve(checkout, "../.claude-sweep")
  const paths = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)))
  const guestPaths = { ...paths, resolve: (...parts: string[]) => resolve(checkout, ...parts) }
  const events: string[] = []
  const commands: ChildProcess.StandardCommand[] = []
  const ready = Deferred.makeUnsafe<void>()
  const stage = (method: "mkdir" | "chmod" | "write" | "remove") =>
    Effect.gen(function*() {
      events.push(method)
      if (options.fail === method) return yield* Effect.fail(platformError(method))
    })
  const fs = FileSystem.makeNoop({
    makeDirectory: (path, config) => {
      assert.equal(path, home)
      assert.equal(config?.recursive, true)
      return stage("mkdir")
    },
    chmod: (path, mode) => {
      assert.equal(path, home)
      assert.equal(mode, 0o700)
      return stage("chmod")
    },
    writeFileString: (path, content, config) => {
      assert.equal(path, `${home}/oauth-token`)
      assert.equal(content, options.login ?? token)
      assert.deepEqual(config, { flag: "wx", mode: 0o600 })
      return stage("write")
    },
    remove: (path, config) => {
      assert.equal(path, home)
      assert.deepEqual(config, { recursive: true, force: true })
      return stage("remove")
    }
  })
  const spawner = Spawner.make((command) =>
    Effect.gen(function*() {
      assert.equal(command._tag, "StandardCommand")
      if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline")
      commands.push(command)
      events.push("spawn")
      assert.equal(JSON.stringify(command).includes(token), false, "token never enters process arguments")
      if (options.fail === "spawn") return yield* Effect.fail(platformError("spawn"))
      yield* Deferred.succeed(ready, undefined)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          events.push("process-close")
        })
      )
      const stdout = options.fail === "stdout" ?
        Stream.fail(platformError("stdout")) :
        Stream.make(
          new TextEncoder().encode(
            options.stdout ?? JSON.stringify({ result: " Fixed.\nCOMMIT: test (#3355) ", subtype: "success" })
          )
        )
      return Spawner.makeHandle({
        pid: Spawner.ProcessId(1),
        exitCode: options.wait ? Effect.never : Effect.succeed(Spawner.ExitCode(options.code ?? 0)),
        isRunning: Effect.succeed(options.wait ?? false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout,
        stderr: Stream.make(new TextEncoder().encode(options.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )
  return {
    events,
    commands,
    ready,
    layer: Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem)(fs),
      Layer.succeed(Spawner.ChildProcessSpawner)(spawner),
      Layer.succeed(Path.Path)(guestPaths)
    )
  }
}

test("a successful guest run parses the last JSON reply and removes the login before returning", async () => {
  const made = guest({
    stdout: `startup noise\n${JSON.stringify({ result: `Fixed ${token}.`, subtype: "success" })}\n`
  })
  const result = await Effect.runPromise(
    claudeInGuest("claude-5", token, "vm", prompt).pipe(Effect.provide(made.layer))
  )
  assert.deepEqual(result, { agent: "claude", account: "claude-5", report: "Fixed [redacted]." })
  assert.deepEqual(made.events, ["mkdir", "chmod", "write", "spawn", "process-close", "remove"])
  assert.equal(made.commands[0]?.args.at(-1), prompt)
})

test("an empty login cannot turn redaction into insertion between every output character", async () => {
  const made = guest({ login: "", stdout: JSON.stringify({ result: "plain reply" }) })
  const result = await Effect.runPromise(claudeInGuest("claude-5", "", "vm", prompt).pipe(Effect.provide(made.layer)))
  assert.equal(result.report, "plain reply")
  assert.equal(made.events.at(-1), "remove")
})

for (
  const output of [
    { stdout: "not json" },
    { stdout: JSON.stringify({ result: "", subtype: "success" }) },
    { stdout: JSON.stringify({ result: " \n ", subtype: "success" }) },
    { stdout: JSON.stringify({ result: "failed", is_error: true }) },
    { stdout: JSON.stringify({ result: "failed", subtype: "error_during_execution" }) },
    { code: 1, stderr: `auth failed ${token}` },
    { code: 1, stdout: `auth failed ${token}` }
  ]
) {
  test("guest failure rejects the result, redacts credentials and removes the complete login directory", async () => {
    const made = guest(output)
    const error = failure(
      await Effect.runPromiseExit(claudeInGuest("claude-5", token, "cloud", prompt).pipe(Effect.provide(made.layer)))
    )
    assert.match(error.message, /claude-5 on cloud: Claude failed/)
    assert.equal(error.message.includes(token), false)
    assert.equal(made.events.at(-1), "remove")
  })
}

for (const fail of ["mkdir", "chmod", "write", "spawn", "stdout"] as const) {
  test(`guest ${fail} failure still removes staged login and redacts the platform error`, async () => {
    const made = guest({ fail })
    const error = failure(
      await Effect.runPromiseExit(claudeInGuest("claude-5", token, "vm", prompt).pipe(Effect.provide(made.layer)))
    )
    assert.equal(error.message.includes(token), false)
    assert.match(error.message, /\[redacted\]/)
    assert.equal(made.events.at(-1), "remove")
    if (["mkdir", "chmod", "write"].includes(fail)) assert.equal(made.commands.length, 0)
  })
}

test("interrupting a running guest process closes it before removing the token directory", async () => {
  const made = guest({ wait: true })
  const fiber = Effect.runFork(claudeInGuest("claude-5", token, "vm", prompt).pipe(Effect.provide(made.layer)))
  await Effect.runPromise(Deferred.await(made.ready))
  await Effect.runPromise(Fiber.interrupt(fiber))
  const exit = await Effect.runPromise(Fiber.await(fiber))
  assert.ok(Exit.isFailure(exit))
  assert.deepEqual(made.events.slice(-2), ["process-close", "remove"])
})

test("a guest exceeding its time budget fails and removes credentials", async () => {
  const made = guest({ wait: true })
  const exit = await Effect.runPromise(
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(claudeInGuest("claude-5", token, "vm", prompt))
      yield* Deferred.await(made.ready)
      yield* TestClock.adjust("2 hours")
      return yield* Fiber.await(fiber)
    }).pipe(Effect.provide(made.layer), Effect.provide(TestClock.layer()))
  )
  assert.match(failure(exit).message, /no answer within/)
  assert.deepEqual(made.events.slice(-2), ["process-close", "remove"])
})

test("failure to remove the guest login refuses a successful result", async () => {
  const made = guest({ fail: "remove" })
  const exit = await Effect.runPromiseExit(
    claudeInGuest("claude-5", token, "vm", prompt).pipe(Effect.provide(made.layer))
  )
  assert.ok(Exit.isFailure(exit))
  const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")?.defect
  assert.ok(defect instanceof ClaudeFailed)
  assert.equal(defect.message, "claude-5: could not remove the guest Claude login")
})

test("the cooling callback receives redacted streams and a failure status for Claude's JSON error with exit zero", async () => {
  const made = guest({
    stdout: JSON.stringify({ result: `out of usage credits ${token}`, is_error: true }),
    stderr: token
  })
  let receipt: readonly [string, string, number] | undefined
  failure(
    await Effect.runPromiseExit(
      claudeInGuest("claude-5", token, "vm", prompt, (stdout, stderr, code) =>
        Effect.sync(() => {
          receipt = [stdout, stderr, code]
          made.events.push("cooled")
        })).pipe(Effect.provide(made.layer))
    )
  )
  assert.ok(receipt)
  assert.equal(receipt[0].includes(token), false)
  assert.match(receipt[0], /out of usage credits/)
  assert.equal(receipt[1], "[redacted]")
  assert.equal(receipt[2], 1)
  assert.deepEqual(made.events.slice(-2), ["cooled", "remove"])
})

test("successful replies preserve status zero for cooling and callback failure still removes login", async () => {
  const success = guest()
  let code: number | undefined
  await Effect.runPromise(
    claudeInGuest("claude-5", token, "vm", prompt, (_, __, status) =>
      Effect.sync(() => {
        code = status
      })).pipe(Effect.provide(success.layer))
  )
  assert.equal(code, 0)
  const failed = guest()
  const error = failure(
    await Effect.runPromiseExit(
      claudeInGuest("claude-5", token, "vm", prompt, () => Effect.fail({ message: `cooldown failed ${token}` })).pipe(
        Effect.provide(failed.layer)
      )
    )
  )
  assert.equal(error.message, "cooldown failed [redacted]")
  assert.equal(failed.events.at(-1), "remove")
})

test("captured work containing a borrowed login cannot enter an action result", async () => {
  const error = failure(
    await Effect.runPromiseExit(assertNoClaudeLogin(
      new Sandbox.Changed({
        session: "proof",
        base: "a".repeat(40),
        patch: `diff --git a/leak b/leak\n+${token}\n`
      }),
      token
    ))
  )
  assert.equal(error.message, "Claude's captured work contains its borrowed login")
  assert.equal(error.message.includes(token), false)
  await Effect.runPromise(assertNoClaudeLogin(
    new Sandbox.Changed({
      session: "proof",
      base: "a".repeat(40),
      patch: "diff --git a/readme b/readme\n+Fixed.\n"
    }),
    token
  ))
  await Effect.runPromise(assertNoClaudeLogin(new Sandbox.Unchanged({ session: "proof", base: "a".repeat(40) }), token))
  await Effect.runPromise(
    assertNoClaudeLogin(new Sandbox.Changed({ session: "proof", base: "a".repeat(40), patch: "clean" }), "")
  )
})

test("remote selection skips a ready account's expired login and keeps locally usable accounts available", async (t) => {
  const { root } = accounts(t)
  const pools: Pools = {
    codex: { ready: [], unavailable: [] },
    claude: { ready: ["claude-1", "claude-5"], unavailable: [] }
  }
  const picker = makeAccountPicker(1, Effect.succeed(pools))
  const expiredService = `Claude Code-credentials-${
    createHash("sha256").update(resolve(root, "claude-1")).digest("hex").slice(0, 8)
  }`
  const login: typeof readClaudeLogin = (account) =>
    readClaudeLogin(account, {
      accountsDirectory: root,
      platform: "darwin",
      now,
      keychain: async (service) =>
        JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: service === expiredService ? now : now + 1 } })
    })
  const chosen = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const remote = yield* reserveRemoteAccount(3355, { picker, login })
    const local = yield* picker(3355)
    assert.equal(local.account, "claude-1", "remote login eligibility does not remove a local account")
    return remote
  })))
  assert.equal(chosen.agent, "claude")
  assert.equal(chosen.account, "claude-5")
  assert.equal(chosen.login, token)
  assert.deepEqual(pools.claude.ready, ["claude-1", "claude-5"])
})

test("remote eligibility retains the shared account cap and releases it on interruption", async () => {
  const pools: Pools = { codex: { ready: [], unavailable: [] }, claude: { ready: ["claude-5"], unavailable: [] } }
  const picker = makeAccountPicker(1, Effect.succeed(pools))
  const login: typeof readClaudeLogin = () => Effect.succeed(token)
  const held = new AbortController()
  let ready!: () => void
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  const running = Effect.runPromiseExit(
    Effect.scoped(Effect.gen(function*() {
      yield* reserveRemoteAccount(3355, { picker, login })
      ready()
      yield* Effect.never
    })),
    { signal: held.signal }
  )
  await started
  const waiting = new AbortController()
  let borrowed = false
  const local = Effect.runPromiseExit(
    Effect.scoped(
      picker(3355).pipe(Effect.tap(() =>
        Effect.sync(() => {
          borrowed = true
        })
      ))
    ),
    { signal: waiting.signal }
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(borrowed, false, "local work cannot borrow a slot held by a remote run")
  waiting.abort()
  assert.ok(Exit.isFailure(await local))
  held.abort()
  assert.ok(Exit.isFailure(await running))
  assert.equal((await Effect.runPromise(Effect.scoped(picker(3355)))).account, "claude-5")
})

test("remote selection falls back to Codex when all Claude remote logins are unavailable and fails if neither remains", async () => {
  const claude = { ready: ["claude-1"], unavailable: [] }
  const login: typeof readClaudeLogin = () => Effect.fail(new ClaudeFailed({ message: "expired" }))
  const picker = makeAccountPicker(1, Effect.succeed({ codex: { ready: ["codex-1"], unavailable: [] }, claude }))
  const selected = await Effect.runPromise(Effect.scoped(reserveRemoteAccount(3355, { picker, login })))
  assert.equal(selected.agent, "codex")
  assert.equal(selected.account, "codex-1")
  assert.equal(selected.login, undefined)
  const empty = makeAccountPicker(1, Effect.succeed({ codex: { ready: [], unavailable: [] }, claude }))
  const exit = await Effect.runPromiseExit(Effect.scoped(reserveRemoteAccount(3355, { picker: empty, login })))
  assert.ok(Exit.isFailure(exit))
  assert.match(String(exit.cause), /no ready Codex or Claude account/)
})

// Each VM slot has its own checkout and adjacent login directory.
test("concurrent guest agents use separate checkout and login paths and clean up both", async () => {
  const first = guest({ checkout: "/home/developer/slots/one/workspace" })
  const second = guest({ checkout: "/home/developer/slots/two/workspace" })
  const results = await Promise.all([first, second].map((made) =>
    Effect.runPromise(
      claudeInGuest("claude-5", token, "vm", prompt).pipe(Effect.provide(made.layer))
    )
  ))
  assert.equal(results.length, 2)
  for (const [index, made] of [first, second].entries()) {
    const slot = index === 0 ? "one" : "two"
    assert.match(made.commands[0]!.args[1]!, new RegExp(`/slots/${slot}/workspace`))
    assert.match(made.commands[0]!.args[1]!, new RegExp(`/slots/${slot}/\\.claude-sweep`))
    assert.deepEqual(made.events, ["mkdir", "chmod", "write", "spawn", "process-close", "remove"])
  }
})
