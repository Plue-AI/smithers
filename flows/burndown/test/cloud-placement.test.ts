import { NodeServices } from "@effect/platform-node"
import { Sandbox } from "@smthrs/sandbox"
import { Effect, Fiber, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { type Account, discoverAccounts } from "../accounts.ts"
import type { CloudHandoff } from "../cloud-handoff.ts"
import { layerPlacementWith, makeCloudPlacement } from "../cloud-placement.ts"
import { agentArgv, Placement, readRunOutput } from "../run-agent.ts"
import type { Assignment } from "../schema.ts"

const assignment: Assignment = {
  key: "test-42",
  repo: "acme/repo",
  lead: { repo: "acme/repo", n: 42, title: "test" },
  extras: [],
  account: "test-account",
  tool: "codex",
  model: "gpt-6.1-sol",
  attempt: 0,
  placement: "cloud"
}
const account: Account = {
  id: "test-account",
  tool: "codex",
  email: "fixture@example.test",
  directory: "/local/account",
  aliases: []
}

const recoveryReceipts = async (directory: string) => {
  const root = join(directory, "recoveries")
  return await Promise.all((await readdir(root)).map(async (id) => {
    const path = join(root, id, "recovery.json")
    return { path, raw: await readFile(path, "utf8") }
  }))
}
const readRecovery = async (directory: string): Promise<string> => {
  const receipts = await recoveryReceipts(directory)
  assert.equal(receipts.length, 1, "a fresh machine retains one unique recovery receipt")
  return receipts[0]!.raw
}

// A fake control API makes workspace lifecycle deterministic; real subprocesses
// exercise CommandSandbox stdin, temporary guest config and cleanup together.
for (const tool of ["codex", "claude"] as const) {
  test(`Cloud placement injects ${tool} login on stdin and cleans scoped configs while retaining unexported workspace`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "burndown-cloud-"))
    const secret = "private-token-fixture"
    const calls: Array<string> = []
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const placement = makeCloudPlacement({
            identity: async () => "smithers-dev",
            prepareRepository: async () => {},
            spawner,
            workdir: dir,
            install: false,
            credential: async () =>
              tool === "codex" ? { auth: { tokens: { access_token: secret } } } : { token: secret },
            api: {
              request: async (method) => {
                calls.push(method)
                return { id: "ws-test", status: "running" }
              },
              sshPrefix: async () => []
            }
          })
          const machine = yield* placement.machine({
            ...assignment,
            tool,
            model: tool === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5"
          }, { ...account, tool })
          assert.equal(machine.env.TMPDIR, "/tmp")
          assert.equal(machine.env.GOCACHE, `${machine.stateDir}/go-cache`)
          const command = yield* machine.command!(
            tool === "codex"
              ? "node -e 'const fs=require(\"fs\");console.log(process.env.CODEX_HOME);console.log(fs.readFileSync(process.env.CODEX_HOME+\"/auth.json\",\"utf8\"));console.log(\"READY abcdef012345\")'"
              : "node -e 'console.log(process.env.CLAUDE_CONFIG_DIR);console.log(process.env.CLAUDE_CODE_OAUTH_TOKEN);console.log(\"READY abcdef012345\")'"
          )
          assert.ok(!command.script.includes(secret))
          const output = yield* Effect.gen(function*() {
            const guest = yield* ChildProcessSpawner
            return yield* guest.string(
              ChildProcess.make("sh", ["-c", command.script], {
                stdin: Stream.make(command.stdin!),
                env: machine.env,
                extendEnv: true
              })
            )
          }).pipe(
            Effect.provide(Sandbox.layerHost(machine.provider, { session: `${assignment.key}:${dir}` })),
            Effect.scoped
          )
          assert.match(output, /READY abcdef012345/)
          assert.ok(!output.includes(secret))
          const config = output.trim().split("\n")[0]!
          yield* Effect.promise(() => assert.rejects(readdir(dirname(config))))
          assert.deepEqual(
            (yield* Effect.promise(() => readdir(tmpdir()))).filter((name) => name.startsWith("smithers-agent-")),
            []
          )
        }).pipe(Effect.provide(NodeServices.layer))
      )
      assert.deepEqual(calls, ["POST", "GET"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test("Cloud placement refuses mismatched account/tool and credential failures redact causes", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const placement = makeCloudPlacement({
        identity: async () => "smithers-dev",
        prepareRepository: async () => {},
        spawner,
        credential: async () => {
          throw new Error("SECRET")
        }
      })
      const mismatch = yield* Effect.exit(placement.machine(assignment, { ...account, tool: "claude" }))
      assert.match(JSON.stringify(mismatch), /account tool/)
      const machine = yield* placement.machine(assignment, account)
      const failed = yield* Effect.exit(machine.command!("true"))
      assert.ok(!JSON.stringify(failed).includes("SECRET"))
      assert.match(JSON.stringify(failed), /local credential/)
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

for (const mode of ["failure", "cancellation"] as const) {
  test(`Cloud placement cleans temporary login on ${mode}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "burndown-cleanup-"))
    const marker = join(dir, "config-path")
    const calls: Array<string> = []
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const placement = makeCloudPlacement({
            identity: async () => "smithers-dev",
            prepareRepository: async () => {},
            spawner,
            workdir: dir,
            install: false,
            credential: async () => ({ token: "fixture-token" }),
            api: {
              request: async (method) => {
                calls.push(method)
                return { id: "ws-clean", status: "running" }
              },
              sshPrefix: async () => []
            }
          })
          const machine = yield* placement.machine({ ...assignment, tool: "claude", model: "claude-opus-5-5" }, {
            ...account,
            tool: "claude"
          })
          const command = yield* machine.command!(
            `printf '%s' "$CLAUDE_CONFIG_DIR" > '${marker}'; ${mode === "failure" ? "exit 7" : "sleep 10"}`
          )
          const running = Effect.gen(function*() {
            const guest = yield* ChildProcessSpawner
            return yield* guest.string(
              ChildProcess.make("sh", ["-c", command.script], {
                stdin: Stream.make(command.stdin!),
                env: machine.env,
                extendEnv: true
              })
            )
          }).pipe(
            Effect.provide(Sandbox.layerHost(machine.provider, { session: `${assignment.key}:${dir}` })),
            Effect.scoped
          )
          if (mode === "failure") {
            const failed = yield* running
            assert.equal(failed, "")
          } else {
            const fiber = yield* Effect.forkChild(running)
            for (let retry = 0; retry < 100; retry++) {
              const ready = yield* Effect.promise(() => readFile(marker).then(() => true, () => false))
              if (ready) break
              yield* Effect.sleep("20 millis")
            }
            yield* Fiber.interrupt(fiber)
          }
          const config = yield* Effect.promise(() => readFile(marker, "utf8"))
          yield* Effect.promise(() => assert.rejects(readdir(dirname(config))))
        }).pipe(Effect.provide(NodeServices.layer))
      )
      assert.deepEqual(calls, ["POST", "GET"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test("Cloud placement rejects an operator identity before allocating workspaces", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const placement = makeCloudPlacement({ spawner, identity: async () => "other-user" })
      const denied = yield* Effect.exit(placement.machine(assignment, account))
      assert.match(JSON.stringify(denied), /requires smithers-dev/)
      const wrongModel = yield* Effect.exit(placement.machine({ ...assignment, model: "other" }, account))
      assert.match(JSON.stringify(wrongModel), /gpt-6.1-sol/)
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

test("live Cloud native agents execute tools through temporary stdin auth", {
  skip: process.env.BURNDOWN_CLOUD_SMOKE !== "1",
  timeout: 600_000
}, async () => {
  for (const tool of ["codex", "claude"] as const) {
    const id = tool === "codex" ? "codex-5" : "claude-9"
    const selected = await discoverAccounts({ onlyIds: [id] })
    const login = selected.accounts.find((account) => account.id === id)!
    assert.ok(login, "selected smoke account available")
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const request = {
          ...assignment,
          repo: "smithersai/plue",
          key: `cloud-smoke-${tool}-${Date.now()}`,
          tool,
          model: tool === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5",
          account: id
        }
        const machine = yield* makeCloudPlacement({ spawner }).machine(request, login)
        const marker = `/tmp/smithers-tool-proof-${tool}`
        const prompt =
          `Use your command tool to run this exact shell command: printf CLOUD-${tool.toUpperCase()}-TOOL-OK > ${marker}. Then reply DONE only.`
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
        const command = yield* machine.command!(
          `set -e; cd ${
            quote(machine.workdir)
          }; jj --ignore-working-copy status >/dev/null; printf "SMITHERS_JJ_PROOF=OK\\n"; printf '%s' ${
            quote(prompt)
          } | ${agentArgv(request, machine.workdir).map(quote).join(" ")}; test -f ${
            quote(marker)
          } && printf "\\nSMITHERS_TOOL_PROOF=%s\\n" "$(cat ${quote(marker)})"; rm -f ${quote(marker)}`
        )
        const output = yield* Effect.gen(function*() {
          const guest = yield* ChildProcessSpawner
          return yield* guest.string(
            ChildProcess.make("sh", ["-c", command.script], {
              stdin: Stream.make(command.stdin!),
              env: machine.env,
              extendEnv: true
            })
          )
        }).pipe(Effect.provide(Sandbox.layerHost(machine.provider, { session: request.key })), Effect.scoped)
        assert.match(output, new RegExp(`^SMITHERS_TOOL_PROOF=CLOUD-${tool.toUpperCase()}-TOOL-OK$`, "m"))
        assert.match(output, /^SMITHERS_JJ_PROOF=OK$/m)
        assert.ok(!output.includes("code-mode host is missing"))
        process.stdout.write(`${tool}: Cloud command execution passed; scoped workspace released\n`)
      }).pipe(Effect.provide(NodeServices.layer))
    )
  }
})

test("worker placement layer routes each assignment to the declared machine", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const placement = yield* Placement
      const local = yield* placement.machine(
        { ...assignment, repo: "smithersai/smithers", placement: "local" },
        account
      )
      assert.equal(local.command, undefined)
      assert.match(local.workdir, /smithers$/)
      const cloud = yield* placement.machine({ ...assignment, repo: "smithersai/smithers" }, account)
      assert.equal(cloud.workdir, "/home/developer/workspace")
      assert.equal(cloud.logFile, false)
      assert.ok(cloud.command)
      assert.match(cloud.files![0]!.contents, /fcntl.LOCK_EX/)
      const closed = { key: assignment.key, status: "closed" as const, commits: [], notes: "closed", agentHours: 0 }
      assert.deepEqual(yield* cloud.handoff!(closed, () => Effect.die("closed work must not export")), closed)
    }).pipe(
      Effect.provide(layerPlacementWith({ identity: async () => "smithers-dev", prepareRepository: async () => {} })),
      Effect.provide(NodeServices.layer)
    )
  )
})

test("Cloud placement validates repository freshness before workspace creation", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const placement = makeCloudPlacement({
        spawner,
        identity: async () => "smithers-dev",
        prepareRepository: async () => {
          throw new Error("stale")
        }
      })
      const exit = yield* Effect.exit(placement.machine(assignment, account))
      assert.match(JSON.stringify(exit), /current GitHub main/)
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

test("Codex command supports jj-only checkouts while pinning gpt-6.1-sol", () => {
  const argv = agentArgv(assignment, "/workspace")
  assert.ok(argv.includes("--skip-git-repo-check"))
  assert.equal(argv[argv.indexOf("-m") + 1], "gpt-6.1-sol")
})

// Host review/reconstruction are ports here: no paid calls or writes to the shared
// checkout. The handoff module independently tests real jj and durable retention.
test("READY artifacts are retained and reviewed on the host before local IDs replace guest commits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-ready-"))
  const guestSha = "a".repeat(40)
  const localSha = "c".repeat(40)
  let handoffs = 0
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const placement = makeCloudPlacement({
          spawner,
          identity: async () => "smithers-dev",
          prepareRepository: async () => {},
          artifactDirectory: dir,
          review: async (source) => {
            assert.match(source, /after/)
            assert.ok((await readdir(dir)).length > 0)
            return "VERDICT: PASS"
          },
          handoff: async (artifact) => {
            handoffs++
            assert.equal(artifact.commits[0]!.sha, guestSha)
            return {
              artifactPath: dir,
              receiptPath: dir,
              commit: localSha,
              commits: [{ source: guestSha, local: localSha }]
            }
          }
        })
        const machine = yield* placement.machine({ ...assignment, repo: "smithersai/smithers" }, account)
        let reads = 0
        const result = yield* machine.handoff!({
          key: assignment.key,
          status: "ready",
          commits: [{ issue: 42, commit: guestSha }],
          notes: "tests passed",
          agentHours: 0
        }, (program, args) => {
          assert.ok(program === "git" || program === "sh", "review must never execute in the coding guest")
          reads++
          if (args[1]!.includes("git show")) {
            return Effect.succeed(Buffer.from(`${guestSha}\0${"b".repeat(40)}\0fix: fixture`).toString("base64"))
          }
          if (args[1]!.includes("diff-tree")) {
            return Effect.succeed(
              Buffer.from(`:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0file\0`).toString("base64")
            )
          }
          return Effect.succeed(Buffer.from(reads === 3 ? "before" : "after").toString("base64"))
        })
        assert.equal(result.commits[0]!.commit, localSha)
        assert.equal(handoffs, 1)
        assert.equal(reads, 4)
      }).pipe(Effect.provide(NodeServices.layer))
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

for (const fail of ["review", "reconstruct"] as const) {
  test(`Cloud ${fail} failure keeps artifact and refuses READY handoff`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "burndown-failure-"))
    const sha = "a".repeat(40)
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const placement = makeCloudPlacement({
            spawner,
            identity: async () => "smithers-dev",
            prepareRepository: async () => {},
            artifactDirectory: dir,
            review: async () => fail === "review" ? "VERDICT: FAIL" : "VERDICT: PASS",
            handoff: async () => {
              throw new Error("conflicting local edits")
            }
          })
          const machine = yield* placement.machine({ ...assignment, repo: "smithersai/smithers" }, account)
          const exit = yield* Effect.exit(
            machine.handoff!({
              key: assignment.key,
              status: "ready",
              commits: [{ issue: 42, commit: sha }],
              notes: "",
              agentHours: 0
            }, (program, args) =>
              Effect.succeed(
                args[1]!.includes("git show")
                  ? Buffer.from(`${sha}\0${"b".repeat(40)}\0fix: fixture`).toString("base64")
                  : args[1]!.includes("diff-tree")
                  ? Buffer.from(`:000000 100644 ${"0".repeat(40)} ${"1".repeat(40)} A\0file\0`).toString("base64")
                  : "dGVzdA=="
              ))
          )
          assert.equal(exit._tag, "Failure")
          assert.ok((yield* Effect.promise(() => readdir(dir))).length > 0)
        }).pipe(Effect.provide(NodeServices.layer))
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test("Cloud wrapper keeps the exit receipt after agent stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-stderr-"))
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const placement = makeCloudPlacement({
          spawner,
          identity: async () => "smithers-dev",
          prepareRepository: async () => {},
          install: false,
          workdir: dir,
          credential: async () => ({ token: "fixture-token" }),
          api: { request: async () => ({ id: "ws-stderr", status: "running" }), sshPrefix: async () => [] }
        })
        const machine = yield* placement.machine({ ...assignment, tool: "claude", model: "claude-opus-5-5" }, {
          ...account,
          tool: "claude"
        })
        const command = yield* machine.command!(
          "printf 'agent warning\\n' >&2; printf 'agent report\\nBURNDOWN_EXIT=0\\n'"
        )
        const output = yield* Effect.gen(function*() {
          const guest = yield* ChildProcessSpawner
          return yield* guest.string(
            ChildProcess.make("sh", ["-c", command.script], {
              stdin: Stream.make(command.stdin!),
              env: machine.env,
              extendEnv: true
            })
          )
        }).pipe(
          Effect.provide(Sandbox.layerHost(machine.provider, { session: `${assignment.key}:${dir}` })),
          Effect.scoped
        )
        assert.match(output, /^agent warning\nagent report\nBURNDOWN_EXIT=0\n$/)
      }).pipe(Effect.provide(NodeServices.layer))
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("Cloud default preflight verifies explicit identity and current mirror through HTTP", async () => {
  const { createServer } = await import("node:http")
  const { chmod, writeFile } = await import("node:fs/promises")
  const dir = await mkdtemp(join(tmpdir(), "burndown-preflight-"))
  const expected = "a".repeat(40)
  const seen: Array<string> = []
  let identityStatus = 200
  let username = "smithers-dev"
  let omitUsername = false
  let repoStatus = 200
  let repoError = ""
  let stale = false
  const realNow = Date.now
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-cloud-token")
    seen.push(`${request.method} ${request.url}`)
    response.setHeader("content-type", "application/json")
    if (request.url === "/api/user") {
      response.statusCode = identityStatus
      response.end(JSON.stringify({ username: omitUsername ? undefined : username }))
      return
    }
    response.statusCode = repoStatus
    if (stale && request.method === "GET") Date.now = () => 120001
    response.end(
      JSON.stringify({
        github_head: expected,
        smithers_head: repoError || stale ? "b".repeat(40) : expected,
        last_error: repoError
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const previous = {
    token: process.env.SMITHERS_TOKEN,
    origin: process.env.SMITHERS_API_ORIGIN,
    path: process.env.PATH
  }
  const gh = join(dir, "gh")
  await writeFile(gh, `#!/bin/sh\nprintf '%s\\n' '${expected}'\n`)
  await chmod(gh, 0o755)
  process.env.SMITHERS_TOKEN = "fixture-cloud-token"
  process.env.SMITHERS_API_ORIGIN = `http://127.0.0.1:${address.port}`
  process.env.PATH = dir + ":" + previous.path
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const placement = makeCloudPlacement({ spawner })
        const machine = yield* placement.machine(assignment, account)
        assert.equal(machine.workdir, "/home/developer/workspace")
        assert.deepEqual(seen, [
          "GET /api/user",
          "POST /api/repos/acme/repo/github/main-pull",
          "GET /api/repos/acme/repo/github/main-pull"
        ])
        for (
          const scenario of [
            "missing-token",
            "bad-identity-http",
            "bad-user",
            "missing-username",
            "invalid-github-head",
            "bad-repo-http",
            "repo-error",
            "stale-timeout"
          ] as const
        ) {
          identityStatus = 200
          username = "smithers-dev"
          omitUsername = scenario === "missing-username"
          repoStatus = 200
          repoError = ""
          stale = scenario === "stale-timeout"
          Date.now = stale ? () => 0 : realNow
          process.env.SMITHERS_TOKEN = "fixture-cloud-token"
          yield* Effect.promise(() =>
            writeFile(gh, `#!/bin/sh\nprintf '%s\\n' '${scenario === "invalid-github-head" ? "invalid" : expected}'\n`)
          )
          if (scenario === "missing-token") delete process.env.SMITHERS_TOKEN
          if (scenario === "bad-identity-http") identityStatus = 401
          if (scenario === "bad-user") username = "operator"
          if (scenario === "bad-repo-http") repoStatus = 503
          if (scenario === "repo-error") repoError = "failed import"
          const failed = yield* Effect.exit(placement.machine(assignment, account))
          assert.equal(failed._tag, "Failure", scenario)
          assert.ok(!JSON.stringify(failed).includes("fixture-cloud-token"))
        }
      }).pipe(Effect.provide(NodeServices.layer))
    )
  } finally {
    Date.now = realNow
    for (
      const [key, value] of [["SMITHERS_TOKEN", previous.token], ["SMITHERS_API_ORIGIN", previous.origin], [
        "PATH",
        previous.path
      ]]
    ) {
      if (value === undefined) delete process.env[key!]
      else process.env[key!] = value
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test("Cloud failed and closed reports bypass export, review and reconstruction", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const placement = makeCloudPlacement({
        spawner,
        identity: async () => "smithers-dev",
        prepareRepository: async () => {},
        review: async () => {
          throw Error("must not review")
        },
        handoff: async () => {
          throw Error("must not prepare")
        }
      })
      const machine = yield* placement.machine(assignment, account)
      for (const status of ["closed", "failed", "blocked", "limited"] as const) {
        const result = { key: assignment.key, status, commits: [], notes: "receipt", agentHours: 0 }
        assert.deepEqual(yield* machine.handoff!(result, () => Effect.die("must not export")), result)
      }
      const model = yield* Effect.exit(placement.machine({ ...assignment, model: "other-model" }, account))
      assert.match(JSON.stringify(model), /gpt-6.1-sol/)
      const identity = makeCloudPlacement({
        spawner,
        identity: async () => {
          throw Error("private-token-fixture")
        }
      })
      const failed = yield* Effect.exit(identity.machine(assignment, account))
      assert.match(JSON.stringify(failed), /verify Cloud user/)
      assert.ok(!JSON.stringify(failed).includes("private-token-fixture"))
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

test("default host review pins a fixture login, disables tools, redacts receipts and fails closed", async () => {
  const { chmod, mkdir, writeFile } = await import("node:fs/promises")
  const dir = await mkdtemp(join(tmpdir(), "burndown-host-review-"))
  const accounts = join(dir, "accounts")
  const reviewer = join(accounts, "claude-fixture")
  await mkdir(reviewer, { recursive: true })
  await writeFile(
    join(reviewer, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "review@example.test" } })
  )
  await writeFile(
    join(reviewer, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "fixture-review-token" } })
  )
  const security = join(dir, "security")
  await writeFile(security, "#!/bin/sh\nprintf '%s' '{\"claudeAiOauth\":{\"accessToken\":\"fixture-review-token\"}}'\n")
  await chmod(security, 0o755)
  const executable = join(dir, "claude")
  const names = ["BURNDOWN_ACCOUNTS_DIR", "BURNDOWN_REVIEW_ACCOUNT", "PATH"]
  const previous = names.map((name) => process.env[name])
  process.env.BURNDOWN_ACCOUNTS_DIR = accounts
  process.env.BURNDOWN_REVIEW_ACCOUNT = "claude-fixture"
  process.env.PATH = dir
  const sha = "a".repeat(40)
  const result = {
    key: assignment.key,
    status: "ready" as const,
    commits: [{ issue: 42, commit: sha }],
    notes: "",
    agentHours: 0
  }
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        for (
          const mode of [
            "pass",
            "fail",
            "exit",
            "missing-account",
            "unavailable-account",
            "missing-cli",
            "oversized-output"
          ] as const
        ) {
          const artifactDirectory = join(dir, mode)
          process.env.BURNDOWN_REVIEW_ACCOUNT = "claude-fixture"
          const script =
            `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[args.indexOf('--model')+1]!=='fable'||args[args.indexOf('--tools')+1]!==''||process.env.CLAUDE_CODE_OAUTH_TOKEN!=='fixture-review-token'||process.env.CLAUDE_CONFIG_DIR!==${
              JSON.stringify(reviewer)
            })process.exit(5);fs.readFileSync(0,'utf8');${
              mode === "exit"
                ? "process.exit(7)"
                : mode === "oversized-output"
                ? "process.stdout.write('x'.repeat(1000001));setInterval(()=>{},1000)"
                : `console.log('fixture-review-token');console.log('VERDICT: ${mode === "fail" ? "FAIL" : "PASS"}')`
            }\n`
          yield* Effect.promise(() => writeFile(executable, script))
          yield* Effect.promise(() => chmod(executable, 0o755))
          if (mode === "missing-account") delete process.env.BURNDOWN_REVIEW_ACCOUNT
          if (mode === "unavailable-account") process.env.BURNDOWN_REVIEW_ACCOUNT = "claude-absent"
          if (mode === "missing-cli") yield* Effect.promise(() => rm(executable))
          const machine = yield* makeCloudPlacement({
            spawner,
            identity: async () => "smithers-dev",
            prepareRepository: async () => {},
            artifactDirectory,
            handoff: async () => ({
              artifactPath: artifactDirectory,
              receiptPath: artifactDirectory,
              commit: sha,
              commits: [{ source: sha, local: sha }]
            })
          }).machine({ ...assignment, repo: "smithersai/smithers" }, account)
          const exit = yield* Effect.exit(machine.handoff!(result, (program, args) =>
            Effect.succeed(
              args[1]!.includes("git show")
                ? Buffer.from(`${sha}\0${"b".repeat(40)}\0fix: fixture`).toString("base64")
                : args[1]!.includes("diff-tree")
                ? Buffer.from(`:000000 100644 ${"0".repeat(40)} ${"1".repeat(40)} A\0file\0`).toString("base64")
                : "dGVzdA=="
            )))
          assert.equal(exit._tag, mode === "pass" ? "Success" : "Failure", mode)
          assert.ok(
            (yield* Effect.promise(() => readdir(artifactDirectory))).length > 0
          )
          if (mode === "pass" || mode === "fail") {
            const review = yield* Effect.promise(() => readFile(join(artifactDirectory, "review.txt"), "utf8"))
            assert.ok(!review.includes("fixture-review-token"))
            assert.match(review, /\[redacted\]/)
          }
        }
        const authPath = join(dir, "auth.json")
        yield* Effect.promise(() =>
          writeFile(authPath, JSON.stringify({ tokens: { access_token: "fixture-coding-token" } }))
        )
        const machine = yield* makeCloudPlacement({
          spawner,
          identity: async () => "smithers-dev",
          prepareRepository: async () => {}
        }).machine(assignment, { ...account, directory: dir })
        const command = yield* machine.command!("true")
        assert.ok(Buffer.from(command.stdin!).toString().includes("fixture-coding-token"))
        assert.ok(!command.script.includes("fixture-coding-token"))
        const claudeMachine = yield* makeCloudPlacement({
          spawner,
          identity: async () => "smithers-dev",
          prepareRepository: async () => {}
        }).machine({ ...assignment, tool: "claude", model: "claude-opus-5-5" }, {
          ...account,
          tool: "claude",
          directory: reviewer
        })
        const claudeCommand = yield* claudeMachine.command!("true")
        assert.ok(Buffer.from(claudeCommand.stdin!).toString().includes("fixture-review-token"))
        assert.ok(!claudeCommand.script.includes("fixture-review-token"))
      }).pipe(Effect.provide(NodeServices.layer))
    )
  } finally {
    for (let index = 0; index < names.length; index++) {
      const name = names[index]!
      const value = previous[index]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test("Cloud issue brief reads full lead and extra context on the launcher", async () => {
  const { chmod, writeFile } = await import("node:fs/promises")
  const dir = await mkdtemp(join(tmpdir(), "burndown-context-"))
  const previous = process.env.PATH
  const gh = join(dir, "gh")
  await writeFile(
    gh,
    `#!${process.execPath}\nif(process.argv[2]!=='issue'||process.argv[3]!=='view')process.exit(8);console.log(JSON.stringify({number:Number(process.argv[4]),body:'fixture body',comments:[{body:'fixture comment'}]}))\n`
  )
  await chmod(gh, 0o755)
  process.env.PATH = dir
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const machine = yield* makeCloudPlacement({
          spawner,
          identity: async () => "smithers-dev",
          prepareRepository: async () => {}
        }).machine({ ...assignment, extras: [{ repo: assignment.repo, n: 43, title: "extra" }] }, account)
        const brief = yield* machine.brief!("engineering instructions")
        assert.match(brief, /engineering instructions/)
        assert.match(brief, /fixture comment/)
        assert.match(brief, /"number":42/)
        assert.match(brief, /"number":43/)
        yield* Effect.promise(() => writeFile(gh, "#!/bin/sh\necho private-fixture-token\nexit 4\n"))
        const failed = yield* Effect.exit(machine.brief!("engineering instructions"))
        assert.equal(failed._tag, "Failure")
        assert.ok(!JSON.stringify(failed).includes("private-fixture-token"))
      }).pipe(Effect.provide(NodeServices.layer))
    )
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test("Cloud handoff summarizes binary files, bounds review context and requires every local commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-bounds-"))
  const sha = "a".repeat(40)
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        for (const mode of ["binary", "oversized-context", "missing-commit"] as const) {
          let reviews = 0
          const machine = yield* makeCloudPlacement({
            spawner,
            identity: async () => "smithers-dev",
            prepareRepository: async () => {},
            artifactDirectory: join(dir, mode),
            review: async (prompt) => {
              reviews++
              if (mode === "binary") {
                assert.match(prompt, /"binary":true/)
                assert.match(prompt, /"sha256":"[a-f0-9]{64}"/)
                assert.match(prompt, /"size":2/)
              }
              return "VERDICT: PASS"
            },
            handoff: async () => ({
              artifactPath: dir,
              receiptPath: dir,
              commit: sha,
              commits: mode === "missing-commit" ? [] : [{ source: sha, local: sha }]
            })
          }).machine({ ...assignment, repo: "smithersai/smithers" }, account)
          const data = mode === "oversized-context" ? Buffer.alloc(500001, 120) : Buffer.from([0, 255])
          const result = yield* Effect.exit(
            machine.handoff!({
              key: assignment.key,
              status: "ready",
              commits: [{ issue: 42, commit: sha }],
              notes: "",
              agentHours: 0
            }, (program, args) =>
              Effect.succeed(
                args[1]!.includes("git show")
                  ? Buffer.from(`${sha}\0${"b".repeat(40)}\0fix: binary`).toString("base64")
                  : args[1]!.includes("diff-tree")
                  ? Buffer.from(`:000000 100644 ${"0".repeat(40)} ${"1".repeat(40)} A\0file\0`).toString("base64")
                  : data.toString("base64")
              ))
          )
          assert.equal(result._tag, mode === "binary" ? "Success" : "Failure")
          assert.equal(reviews, mode === "oversized-context" ? 0 : 1)
          assert.ok((yield* Effect.promise(() => readdir(join(dir, mode)))).length > 0)
        }
      }).pipe(Effect.provide(NodeServices.layer))
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("default Cloud handoff retains work when the local checkout is unavailable", async () => {
  const { homedir } = await import("node:os")
  const dir = await mkdtemp(join(tmpdir(), "burndown-missing-checkout-"))
  const previous = process.env.HOME
  process.env.HOME = dir
  assert.equal(homedir(), dir)
  const sha = "a".repeat(40)
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const machine = yield* makeCloudPlacement({
          spawner,
          identity: async () => "smithers-dev",
          prepareRepository: async () => {},
          review: async () => "VERDICT: PASS"
        }).machine({ ...assignment, repo: "smithersai/smithers" }, account)
        const result = yield* Effect.exit(
          machine.handoff!({
            key: assignment.key,
            status: "ready",
            commits: [{ issue: 42, commit: sha }],
            notes: "",
            agentHours: 0
          }, (program, args) =>
            Effect.succeed(
              args[1]!.includes("git show")
                ? Buffer.from(`${sha}\0${"b".repeat(40)}\0fix: fixture`).toString("base64")
                : args[1]!.includes("diff-tree")
                ? Buffer.from(`:000000 100644 ${"0".repeat(40)} ${"1".repeat(40)} A\0file\0`).toString("base64")
                : "dGVzdA=="
            ))
        )
        assert.equal(result._tag, "Failure")
        assert.match(JSON.stringify(result), /Cloud commit handoff failed/)
        const receipt = join(dir, "Smithers-Ops/burndown/receipts", assignment.key)
        const entries = yield* Effect.promise(() => readdir(receipt))
        assert.ok(entries.some((path) => /^[a-f0-9]{64}$/.test(path)))
        assert.equal(yield* Effect.promise(() => readFile(join(receipt, "review.txt"), "utf8")), "VERDICT: PASS")
      }).pipe(Effect.provide(NodeServices.layer))
    )
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test("Cloud storage failures refuse READY before reconstruction", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises")
  const dir = await mkdtemp(join(tmpdir(), "burndown-storage-failure-"))
  const sha = "a".repeat(40)
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        for (const mode of ["artifact", "review-receipt"] as const) {
          const artifactDirectory = join(dir, mode)
          if (mode === "artifact") {
            yield* Effect.promise(() => writeFile(artifactDirectory, "file blocking receipt directory"))
          }
          let reviews = 0
          const machine = yield* makeCloudPlacement({
            spawner,
            identity: async () => "smithers-dev",
            prepareRepository: async () => {},
            artifactDirectory,
            review: async () => {
              reviews++
              await mkdir(join(artifactDirectory, "review.txt"))
              return "VERDICT: PASS"
            },
            handoff: async () => {
              throw Error("must not reconstruct")
            }
          }).machine({ ...assignment, repo: "smithersai/smithers" }, account)
          const result = yield* Effect.exit(
            machine.handoff!({
              key: assignment.key,
              status: "ready",
              commits: [{ issue: 42, commit: sha }],
              notes: "",
              agentHours: 0
            }, (program, args) =>
              Effect.succeed(
                args[1]!.includes("git show")
                  ? Buffer.from(`${sha}\0${"b".repeat(40)}\0fix: fixture`).toString("base64")
                  : args[1]!.includes("diff-tree")
                  ? Buffer.from(`:000000 100644 ${"0".repeat(40)} ${"1".repeat(40)} A\0file\0`).toString("base64")
                  : "dGVzdA=="
              ))
          )
          assert.equal(result._tag, "Failure")
          assert.match(
            JSON.stringify(result),
            mode === "artifact" ? /retain Cloud commit artifact/ : /retain Cloud review receipt/
          )
          assert.equal(reviews, mode === "artifact" ? 0 : 1)
          if (mode === "review-receipt") {
            assert.ok(
              (yield* Effect.promise(() => readdir(artifactDirectory))).some((path) => /^[a-f0-9]{64}$/.test(path))
            )
          }
        }
      }).pipe(Effect.provide(NodeServices.layer))
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Control-plane calls are fixtures because production Cloud is unavailable in the
// deterministic suite. The provider and guest process are the public real boundary.
test("Cloud export failure retains report and workspace for recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-export-recovery-"))
  const sha = "a".repeat(40)
  const calls: Array<string> = []
  let guestExecuted = false
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const machine = yield* makeCloudPlacement({
          spawner,
          workdir: dir,
          install: false,
          artifactDirectory: dir,
          identity: async () => "smithers-dev",
          prepareRepository: async () => {},
          credential: async () => ({ auth: {} }),
          api: {
            request: async (method) => {
              calls.push(method)
              return { id: "ws-recovery", status: "running" }
            },
            sshPrefix: async () => {
              if (guestExecuted) throw Error("PRIVATE-TRANSPORT-ERROR")
              return []
            }
          }
        }).machine(assignment, account)
        yield* Effect.gen(function*() {
          const guest = yield* ChildProcessSpawner
          const command = yield* machine.command!("printf 'READY " + sha + "\\n'")
          const output = yield* guest.string(ChildProcess.make("sh", ["-c", command.script], {
            stdin: Stream.make(command.stdin!),
            env: machine.env,
            extendEnv: true
          }))
          assert.match(output, /READY/)
          guestExecuted = true
          const exit = yield* Effect.exit(machine.handoff!({
            key: assignment.key,
            status: "ready",
            commits: [{ issue: 42, commit: sha }],
            notes: "PRIVATE-REPORT-NOTES",
            agentHours: 0
          }, (program, args) =>
            guest.string(ChildProcess.make(program, [...args])).pipe(
              Effect.mapError(() => "ssh-grant timeout; PRIVATE-TRANSPORT-ERROR")
            )))
          assert.equal(exit._tag, "Failure")
          const raw = yield* Effect.promise(() => readRecovery(dir))
          assert.ok(!raw.includes("PRIVATE-REPORT-NOTES"))
          assert.ok(!raw.includes("PRIVATE-TRANSPORT-ERROR"))
          assert.match(raw, /ws-recovery/)
          assert.match(raw, /gpt-6.1-sol/)
          assert.match(raw, new RegExp(sha))
          const recovery = JSON.parse(raw)
          assert.deepEqual(recovery.assignment, {
            key: assignment.key,
            repository: assignment.repo,
            tool: assignment.tool,
            model: assignment.model,
            issues: [42]
          })
          assert.deepEqual(recovery.result, { status: "ready", commits: [{ issue: 42, commit: sha }] })
          assert.equal(recovery.failure.stage, "ssh-grant")
        }).pipe(Effect.provide(Sandbox.layerHost(machine.provider, { session: assignment.key + dir })), Effect.scoped)
      }).pipe(Effect.provide(NodeServices.layer))
    )
    assert.deepEqual(calls, ["POST", "GET"], "failed export must keep remote committed code")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

for (const tool of ["codex", "claude"] as const) {
  for (const outcome of ["success", "review-failure", "reconstruction-failure"] as const) {
    test(`Cloud retained ${tool} artifact permits cleanup after ${outcome} and preserves attribution`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "burndown-retained-cleanup-"))
      const sha = "a".repeat(40)
      const model = tool === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5"
      const calls: Array<string> = []
      let reconstructed = false
      try {
        await Effect.runPromise(
          Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const machine = yield* makeCloudPlacement({
              spawner,
              workdir: dir,
              install: false,
              artifactDirectory: dir,
              identity: async () => "smithers-dev",
              prepareRepository: async () => {},
              credential: async () => tool === "codex" ? { auth: {} } : { token: "fixture" },
              api: {
                request: async (method) => {
                  calls.push(method)
                  if (method === "DELETE") {
                    assert.ok(
                      (await readdir(dir)).some((entry) => /^[a-f0-9]{64}$/.test(entry)),
                      "retain before cleanup"
                    )
                  }
                  return { id: "ws-retained", status: "running" }
                },
                sshPrefix: async () => []
              },
              review: async () => outcome === "review-failure" ? "VERDICT: FAIL" : "VERDICT: PASS",
              handoff: async (_artifact, attribution) => {
                assert.deepEqual(attribution, { tool, model })
                reconstructed = true
                if (outcome === "reconstruction-failure") throw Error("reconstruction fixture failed")
                return { artifactPath: dir, receiptPath: dir, commit: sha, commits: [{ source: sha, local: sha }] }
              }
            }).machine({ ...assignment, repo: "smithersai/smithers", tool, model }, { ...account, tool })
            yield* Effect.gen(function*() {
              const guest = yield* ChildProcessSpawner
              const command = yield* machine.command!("printf READY")
              assert.equal(
                yield* guest.string(ChildProcess.make("sh", ["-c", command.script], {
                  stdin: Stream.make(command.stdin!),
                  env: machine.env,
                  extendEnv: true
                })),
                "READY"
              )
              const exit = yield* Effect.exit(machine.handoff!({
                key: assignment.key,
                status: "ready",
                commits: [{ issue: 42, commit: sha }],
                notes: "",
                agentHours: 0
              }, (_program, args) =>
                Effect.succeed(
                  args[1]!.includes("git show")
                    ? Buffer.from(`${sha}\0${"b".repeat(40)}\0fix: retained`).toString("base64")
                    : args[1]!.includes("diff-tree")
                    ? Buffer.from(`:000000 100644 ${"0".repeat(40)} ${"1".repeat(40)} A\0file\0`).toString("base64")
                    : Buffer.from("retained").toString("base64")
                )))
              assert.equal(exit._tag, outcome === "success" ? "Success" : "Failure")
            }).pipe(
              Effect.provide(Sandbox.layerHost(machine.provider, { session: assignment.key + dir })),
              Effect.scoped
            )
          }).pipe(Effect.provide(NodeServices.layer))
        )
        assert.equal(reconstructed, outcome !== "review-failure")
        assert.deepEqual(calls, ["POST", "GET", "DELETE"])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  }
}

test("Cloud grant failure is redacted and allows cleanup before guest execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-grant-failure-"))
  const calls: Array<string> = []
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const machine = yield* makeCloudPlacement({
          spawner,
          workdir: dir,
          install: false,
          artifactDirectory: dir,
          identity: async () => "smithers-dev",
          prepareRepository: async () => {},
          api: {
            request: async (method) => {
              calls.push(method)
              return { id: "ws-grant", status: "running" }
            },
            sshPrefix: async () => {
              throw Object.assign(Error("PRIVATE-GRANT-TOKEN"), { status: 401 })
            }
          }
        }).machine(assignment, account)
        const exit = yield* Effect.exit(
          Effect.gen(function*() {
            const guest = yield* ChildProcessSpawner
            yield* guest.string(ChildProcess.make("sh", ["-c", "true"]))
          }).pipe(Effect.provide(Sandbox.layerHost(machine.provider, { session: assignment.key + dir })), Effect.scoped)
        )
        assert.equal(exit._tag, "Failure")
        assert.ok(!JSON.stringify(exit).includes("PRIVATE-GRANT-TOKEN"))
        const raw = yield* Effect.promise(() => readRecovery(dir))
        assert.match(raw, /ssh-grant/)
        assert.match(raw, /ws-grant/)
        assert.ok(!raw.includes("PRIVATE-GRANT-TOKEN"))
        const recovery = JSON.parse(raw)
        assert.equal(recovery.grant.errorClass, "Error")
        assert.equal(recovery.grant.httpStatus, 401)
      }).pipe(Effect.provide(NodeServices.layer))
    )
    assert.deepEqual(calls, ["POST", "GET", "DELETE"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("Cloud replayed READY report preserves workspace without a new guest command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-replayed-ready-"))
  const sha = "a".repeat(40)
  const calls: Array<string> = []
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const machine = yield* makeCloudPlacement({
          spawner,
          workdir: dir,
          artifactDirectory: dir,
          identity: async () => "smithers-dev",
          prepareRepository: async () => {},
          api: {
            request: async (method) => {
              calls.push(method)
              return { id: "ws-replayed", status: "running" }
            },
            sshPrefix: async () => []
          }
        }).machine(assignment, account)
        yield* Effect.gen(function*() {
          // Acquiring the public provider scope reconnects the persisted worker;
          // it must not require replaying the expensive guest execution command.
          const guest = yield* ChildProcessSpawner
          yield* guest.string(ChildProcess.make("sh", ["-c", "true"]))
          const exit = yield* Effect.exit(machine.handoff!({
            key: assignment.key,
            status: "ready",
            commits: [{ issue: 42, commit: sha }],
            notes: "",
            agentHours: 0
          }, () => Effect.fail("export unavailable")))
          assert.equal(exit._tag, "Failure")
          const recovery = JSON.parse(yield* Effect.promise(() => readRecovery(dir)))
          assert.deepEqual(recovery.result, { status: "ready", commits: [{ issue: 42, commit: sha }] })
          assert.equal(recovery.workspaceId, "ws-replayed")
        }).pipe(Effect.provide(Sandbox.layerHost(machine.provider, { session: assignment.key + dir })), Effect.scoped)
      }).pipe(Effect.provide(NodeServices.layer))
    )
    assert.deepEqual(calls, ["POST", "GET"], "reported committed code must survive a replayed export failure")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("Cloud Git diagnostics redact the coding credential from the local command envelope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-credential-diagnostic-"))
  const secret = "opaque-coding-login-fixture"
  const sha = "a".repeat(40)
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const machine = yield* makeCloudPlacement({
          spawner,
          artifactDirectory: dir,
          install: false,
          identity: async () => "smithers-dev",
          prepareRepository: async () => {},
          credential: async () => ({ auth: { tokens: { access_token: secret } } })
        }).machine(assignment, account)
        yield* machine.command!("true")
        const exit = yield* Effect.exit(machine.handoff!({
          key: assignment.key,
          status: "ready",
          commits: [{ issue: 42, commit: sha }],
          notes: "",
          agentHours: 0
        }, () => Effect.succeed("#git-error:128:" + Buffer.from("fatal: " + secret).toString("base64"))))
        assert.equal(exit._tag, "Failure")
        assert.ok(!JSON.stringify(exit).includes(secret))
        assert.match(JSON.stringify(exit), /\[redacted\]/)
        const raw = yield* Effect.promise(() => readRecovery(dir))
        assert.ok(!raw.includes(secret))
        assert.match(raw, /\[redacted\]/)
        const recovery = JSON.parse(raw)
        assert.equal(recovery.failure.stage, "metadata")
        assert.equal(recovery.failure.kind, "git")
      }).pipe(Effect.provide(NodeServices.layer))
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("Cloud recovery keeps earlier workspace evidence when the same assignment is retried", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-recovery-retry-"))
  const firstSha = "a".repeat(40)
  const secondSha = "b".repeat(40)
  const deleted: Array<string> = []
  let created = 0
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const placement = makeCloudPlacement({
          spawner,
          artifactDirectory: dir,
          workdir: dir,
          identity: async () => "smithers-dev",
          prepareRepository: async () => {},
          api: {
            request: async (method, path) => {
              if (method === "POST") created++
              if (method === "DELETE") deleted.push(path)
              return { id: `ws-history-${created}`, status: "running" }
            },
            sshPrefix: async () => []
          }
        })
        let firstPath = ""
        let firstRaw = ""
        for (const [index, sha] of [firstSha, secondSha].entries()) {
          const machine = yield* placement.machine(assignment, account)
          yield* Effect.gen(function*() {
            const guest = yield* ChildProcessSpawner
            yield* guest.string(ChildProcess.make("sh", ["-c", "true"]))
            const exit = yield* Effect.exit(
              machine.handoff!({
                key: assignment.key,
                status: "ready",
                commits: [{ issue: 42, commit: sha }],
                notes: "",
                agentHours: 0
              }, () => Effect.fail("export unavailable"))
            )
            assert.equal(exit._tag, "Failure")
          }).pipe(
            Effect.provide(Sandbox.layerHost(machine.provider, { session: assignment.key + dir + index })),
            Effect.scoped
          )
          if (index === 0) {
            const receipts = yield* Effect.promise(() => recoveryReceipts(dir))
            assert.equal(receipts.length, 1)
            firstPath = receipts[0]!.path
            firstRaw = receipts[0]!.raw
          }
        }
        assert.equal(
          yield* Effect.promise(() => readFile(firstPath, "utf8")),
          firstRaw,
          "a retry must not overwrite the only committed-work recovery evidence"
        )
        const receipts = yield* Effect.promise(() => recoveryReceipts(dir))
        assert.equal(receipts.length, 2)
        const recovered = receipts.map((receipt) => JSON.parse(receipt.raw)).sort((a, b) =>
          a.workspaceId.localeCompare(b.workspaceId)
        )
        assert.deepEqual(recovered.map((receipt) => receipt.workspaceId), ["ws-history-1", "ws-history-2"])
        assert.deepEqual(recovered.map((receipt) => receipt.result.commits[0].commit), [firstSha, secondSha])
        assert.deepEqual(deleted, [])
      }).pipe(Effect.provide(NodeServices.layer))
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("Cloud refuses unsupported Claude model before contacting identity or repository", async () => {
  let contacts = 0
  await Effect.runPromise(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const machine = makeCloudPlacement({
        spawner,
        identity: async () => {
          contacts++
          return "smithers-dev"
        },
        prepareRepository: async () => {
          contacts++
        }
      })
      const exit = yield* Effect.exit(
        machine.machine({ ...assignment, tool: "claude", model: "unsupported" }, { ...account, tool: "claude" })
      )
      assert.equal(exit._tag, "Failure")
      assert.match(JSON.stringify(exit), /claude-opus-5-5/)
      assert.equal(contacts, 0)
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

test("Cloud recovered SSH grant clears active failure while retaining sanitized grant evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-grant-recovered-"))
  let grants = 0
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const machine = yield* makeCloudPlacement({
          spawner,
          artifactDirectory: dir,
          workdir: dir,
          identity: async () => "smithers-dev",
          prepareRepository: async () => {},
          api: {
            request: async () => ({ id: "ws-recovered-grant", status: "running" }),
            sshPrefix: async () => {
              if (++grants === 1) throw Object.assign(Error("PRIVATE-TRANSIENT-GRANT"), { status: 503 })
              return []
            }
          }
        }).machine(assignment, account)
        const first = yield* Effect.exit(
          Effect.gen(function*() {
            const guest = yield* ChildProcessSpawner
            return yield* guest.string(ChildProcess.make("sh", ["-c", "true"]))
          }).pipe(
            Effect.provide(Sandbox.layerHost(machine.provider, { session: assignment.key + dir + "first" })),
            Effect.scoped
          )
        )
        assert.equal(first._tag, "Failure")
        yield* Effect.gen(function*() {
          const guest = yield* ChildProcessSpawner
          assert.equal(yield* guest.string(ChildProcess.make("sh", ["-c", "printf recovered"])), "recovered")
          const raw = yield* Effect.promise(() => readRecovery(dir))
          assert.ok(!raw.includes("PRIVATE-TRANSIENT-GRANT"))
          const recovery = JSON.parse(raw)
          assert.equal(recovery.grant.status, "acquired")
          assert.equal(recovery.failure, undefined, "a recovered grant is no longer an active failure")
          assert.equal(recovery.stage, undefined)
          assert.equal(recovery.grantFailure.status, "failed")
          assert.equal(recovery.grantFailure.httpStatus, 503)
          assert.equal(recovery.grantFailure.errorClass, "Error")
        }).pipe(Effect.provide(Sandbox.layerHost(machine.provider, { session: assignment.key + dir })), Effect.scoped)
      }).pipe(Effect.provide(NodeServices.layer))
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Retained bytes are real filesystem evidence; injected review and reconstruction
// isolate recovery from Cloud allocation and coding, which must never recur.
for (
  const mode of [
    "success",
    "review-failure",
    "handoff-failure",
    "repository-mismatch",
    "source-mismatch",
    "issue-mismatch",
    "unsupported-model",
    "artifact-tampered",
    "mapping-missing",
    "mapping-invalid"
  ] as const
) {
  test(`Cloud retained recovery ${mode} requalifies local handoff without guest execution`, async () => {
    const { mkdir, writeFile } = await import("node:fs/promises")
    const { retainCloudHandoff } = await import("../cloud-handoff.ts")
    const dir = await mkdtemp(join(tmpdir(), "burndown-supported-recovery-"))
    const source = "a".repeat(40)
    const local = "c".repeat(40)
    const base = "b".repeat(40)
    const artifact: CloudHandoff = {
      version: 1 as const,
      repository: "smithersai/smithers",
      base,
      commits: [{
        sha: source,
        parent: base,
        message: "fix: retained fixture",
        changes: [{
          path: "fixture.txt",
          before: null,
          after: {
            type: "file" as const,
            mode: "644" as const,
            data: Buffer.from("retained fixture").toString("base64")
          }
        }]
      }]
    }
    try {
      const artifactPath = await retainCloudHandoff(artifact, {
        repository: artifact.repository,
        artifactDirectory: dir
      })
      if (mode === "artifact-tampered") {
        await writeFile(
          artifactPath,
          JSON.stringify({ ...artifact, commits: [{ ...artifact.commits[0]!, message: "tampered" }] })
        )
      }
      const retainedBytes = await readFile(artifactPath, "utf8")
      const recoveryPath = join(dir, "recoveries", "fixture", "recovery.json")
      await mkdir(dirname(recoveryPath), { recursive: true })
      await writeFile(
        recoveryPath,
        JSON.stringify({
          version: 1,
          assignment: {
            key: assignment.key,
            repository: mode === "repository-mismatch" ? "smithersai/plue" : artifact.repository,
            tool: "codex",
            model: mode === "unsupported-model" ? "unsupported" : assignment.model,
            issues: [42]
          },
          workspaceId: "ws-retained-recovery",
          cleanup: "preserved",
          phase: "failed",
          artifactPath,
          result: {
            status: "ready",
            commits: [{
              issue: mode === "issue-mismatch" ? 43 : 42,
              commit: mode === "source-mismatch" ? base : source
            }]
          },
          failure: { stage: "ssh-grant", kind: "unavailable" },
          stage: "metadata"
        })
      )
      const placementModule = await import("../cloud-placement.ts")
      assert.ok("recoverCloudHandoff" in placementModule, "retained evidence has a supported recovery entry point")
      const recover = placementModule.recoverCloudHandoff as (
        path: string,
        options: {
          review: (prompt: string, signal: AbortSignal) => Promise<string>
          handoff: NonNullable<Parameters<typeof makeCloudPlacement>[0]["handoff"]>
        }
      ) => Promise<{ key: string; status: string; commits: ReadonlyArray<{ issue: number; commit: string }> }>
      const calls: Array<string> = []
      const options = {
        review: async (prompt: string) => {
          calls.push("review")
          assert.match(prompt, /retained fixture/)
          return mode === "review-failure" ? "VERDICT: FAIL" : "VERDICT: PASS"
        },
        handoff: async (received: CloudHandoff, attribution: { tool: string; model: string }) => {
          calls.push("handoff")
          assert.deepEqual(received, artifact)
          assert.deepEqual(attribution, { tool: "codex", model: assignment.model })
          if (mode === "handoff-failure") throw Error("fixture reconstruction unavailable")
          return {
            artifactPath,
            receiptPath: join(dir, "receipt.json"),
            commit: local,
            commits: mode === "mapping-missing"
              ? []
              : [{ source, local: mode === "mapping-invalid" ? "invalid" : local }]
          }
        }
      }
      if (mode === "success") {
        for (let replay = 0; replay < 2; replay++) {
          const result = await recover(recoveryPath, options)
          assert.equal(result.key, assignment.key)
          assert.equal(result.status, "ready")
          assert.deepEqual(result.commits, [{ issue: 42, commit: local }])
          const recovery = JSON.parse(await readFile(recoveryPath, "utf8"))
          assert.equal(recovery.phase, "prepared")
          assert.deepEqual(recovery.prepared, [{ source, local }])
          assert.equal(recovery.failure, undefined)
          assert.equal(recovery.stage, undefined)
          assert.equal(recovery.workspaceId, "ws-retained-recovery")
          assert.equal(recovery.cleanup, "preserved", "local recovery leaves remote workspace untouched")
          assert.deepEqual(JSON.parse(await readFile(artifactPath, "utf8")), artifact)
        }
        assert.deepEqual(calls, ["review", "handoff", "review", "handoff"])
      } else {
        await assert.rejects(recover(recoveryPath, options))
        assert.deepEqual(
          calls,
          mode === "review-failure"
            ? ["review"]
            : ["handoff-failure", "mapping-missing", "mapping-invalid"].includes(mode)
            ? ["review", "handoff"]
            : []
        )
        assert.equal(await readFile(artifactPath, "utf8"), retainedBytes)
        const recovery = JSON.parse(await readFile(recoveryPath, "utf8"))
        assert.notEqual(recovery.phase, "prepared")
        assert.equal(recovery.workspaceId, "ws-retained-recovery")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

for (
  const mode of [
    "relative-receipt",
    "symlink-receipt",
    "oversized-receipt",
    "symlink-artifact",
    "outside-artifact",
    "oversized-artifact",
    "missing-repository"
  ] as const
) {
  test(`Cloud retained recovery refuses ${mode} and retains committed-work evidence`, async () => {
    const { copyFile, mkdir, symlink, truncate, writeFile } = await import("node:fs/promises")
    const { recoverCloudHandoff } = await import("../cloud-placement.ts")
    const { retainCloudHandoff } = await import("../cloud-handoff.ts")
    const dir = await mkdtemp(join(tmpdir(), "burndown-recovery-boundary-"))
    const source = "a".repeat(40)
    const base = "b".repeat(40)
    const artifact: CloudHandoff = {
      version: 1,
      repository: "smithersai/smithers",
      base,
      commits: [{
        sha: source,
        parent: base,
        message: "fix: safety fixture",
        changes: [{
          path: "fixture.txt",
          before: null,
          after: { type: "file", mode: "644", data: Buffer.from("committed work").toString("base64") }
        }]
      }]
    }
    try {
      const artifactPath = await retainCloudHandoff(artifact, {
        repository: artifact.repository,
        artifactDirectory: dir
      })
      const artifactBytes = await readFile(artifactPath)
      const recoveryDirectory = join(dir, "recoveries", "fixture")
      const recoveryPath = join(recoveryDirectory, "recovery.json")
      await mkdir(recoveryDirectory, { recursive: true })
      let referencedArtifact = artifactPath
      if (mode === "symlink-artifact") {
        referencedArtifact = join(dirname(artifactPath), "linked-artifact.json")
        await symlink(artifactPath, referencedArtifact)
      } else if (mode === "outside-artifact") {
        referencedArtifact = join(dir, "outside", "hash", "artifact.json")
        await mkdir(dirname(referencedArtifact), { recursive: true })
        await copyFile(artifactPath, referencedArtifact)
      } else if (mode === "oversized-artifact") {
        await truncate(artifactPath, 100 * 1024 * 1024 + 1)
      }
      const receipt = {
        version: 1,
        assignment: {
          key: assignment.key,
          repository: artifact.repository,
          tool: "codex",
          model: assignment.model,
          issues: [42]
        },
        result: { status: "ready", commits: [{ issue: 42, commit: source }] },
        artifactPath: referencedArtifact,
        workspaceId: "ws-retained-safety",
        cleanup: "preserved",
        phase: "retained"
      }
      await writeFile(recoveryPath, mode === "oversized-receipt" ? " ".repeat(16 * 1024 + 1) : JSON.stringify(receipt))
      const originalRecovery = await readFile(recoveryPath, "utf8")
      let invokedPath = recoveryPath
      if (mode === "relative-receipt") invokedPath = "recovery.json"
      else if (mode === "symlink-receipt") {
        invokedPath = join(recoveryDirectory, "linked-recovery.json")
        await symlink(recoveryPath, invokedPath)
      }
      let reviews = 0
      let handoffs = 0
      const options = {
        review: async () => {
          reviews++
          return "VERDICT: PASS"
        },
        ...(mode === "missing-repository"
          ? { repoDirectory: join(dir, "missing-checkout") }
          : {
            handoff: async () => {
              handoffs++
              throw Error("unsafe reconstruction reached")
            }
          })
      }
      await assert.rejects(
        recoverCloudHandoff(invokedPath, options),
        mode === "relative-receipt" || mode === "symlink-receipt"
          ? /invalid Cloud recovery receipt path/
          : mode === "oversized-receipt" ?
          /receipt exceeds limit/
          : mode === "symlink-artifact" || mode === "outside-artifact" ?
          /artifact path mismatch/
          : mode === "oversized-artifact"
          ? /artifact exceeds limit/
          : /ENOENT|no such file|not found/i
      )
      assert.equal(handoffs, 0, "invalid retained evidence never reaches reconstruction")
      assert.equal(reviews, mode === "missing-repository" ? 1 : 0)
      if (mode === "missing-repository") {
        const recovery = JSON.parse(await readFile(recoveryPath, "utf8"))
        assert.equal(recovery.phase, "failed")
        assert.deepEqual(recovery.failure, { stage: "reconstruction", kind: "validation-or-host" })
        assert.equal(recovery.workspaceId, receipt.workspaceId)
        assert.equal(recovery.cleanup, "preserved")
        assert.equal(await readFile(recovery.recoveryReviewPath, "utf8"), "VERDICT: PASS")
      } else {
        assert.equal(
          await readFile(recoveryPath, "utf8"),
          originalRecovery,
          "prequalification refusal leaves recovery evidence unchanged"
        )
        assert.deepEqual(
          (await readdir(recoveryDirectory)).sort(),
          mode === "symlink-receipt" ? ["linked-recovery.json", "recovery.json"] : ["recovery.json"]
        )
      }
      if (mode !== "oversized-artifact") assert.deepEqual(await readFile(artifactPath), artifactBytes)
      else {
        const { stat } = await import("node:fs/promises")
        assert.equal(
          (await stat(artifactPath)).size,
          100 * 1024 * 1024 + 1,
          "oversized retained file is not truncated or rewritten"
        )
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

for (const exitCode of [0, 1]) {
  test(`Cloud worker stderr decoded from its base64 transport is redacted on ${exitCode === 0 ? "success" : "failure"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "burndown-diagnostics-"))
    const secret = "opaque-cloud-login-fixture-0123456789"
    const sha = "c".repeat(40)
    const claude: Assignment = { ...assignment, tool: "claude", model: "claude-opus-5-5" }
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const machine = yield* makeCloudPlacement({
            spawner,
            identity: async () => "smithers-dev",
            prepareRepository: async () => {},
            install: false,
            workdir: dir,
            artifactDirectory: dir,
            credential: async () => ({ token: secret }),
            api: { request: async () => ({ id: "ws-diagnostics", status: "running" }), sshPrefix: async () => [] }
          }).machine(claude, { ...account, tool: "claude" })
          const report = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: `READY ${sha}` })
          // The run script's shape: report on stdout, then a base64 byte tail of
          // stderr that starts inside the secret, then the exit receipt.
          const stderr = `${secret}\nagent warning ${secret}\nlast diagnostic line\n`
          const command = yield* machine.command!([
            `printf '%s' '${report}'`,
            `printf '\\nBURNDOWN_DIAGNOSTICS='`,
            `printf '${stderr.replaceAll("\n", "\\n")}' | tail -c ${stderr.length - 7} | base64 | tr -d '\\n'`,
            `printf '\\n'`,
            `echo "BURNDOWN_EXIT=${exitCode}"`
          ].join("\n"))
          const output = yield* Effect.gen(function*() {
            const guest = yield* ChildProcessSpawner
            return yield* guest.string(
              ChildProcess.make("sh", ["-c", command.script], {
                stdin: Stream.make(command.stdin!),
                env: machine.env,
                extendEnv: true
              })
            )
          }).pipe(
            Effect.provide(Sandbox.layerHost(machine.provider, { session: `${assignment.key}:${dir}` })),
            Effect.scoped
          )
          const encoded = /BURNDOWN_DIAGNOSTICS=([A-Za-z0-9+/=]+)/.exec(output)![1]!
          assert.ok(!output.includes(secret), "guest-side output redaction never saw the encoded stderr")
          assert.ok(Buffer.from(encoded, "base64").toString("utf8").includes(secret))
          assert.ok(Buffer.from(encoded, "base64").toString("utf8").startsWith(secret.slice(7)))

          const result = readRunOutput(claude, output, 0.5, machine.redact)
          assert.equal(result.status, exitCode === 0 ? "ready" : "failed")
          assert.deepEqual(result.commits, exitCode === 0 ? [{ issue: 42, commit: sha }] : [])
          assert.ok(!result.notes.includes(secret))
          assert.ok(!result.notes.includes(secret.slice(7)), "a secret cut by the byte tail is redacted too")
          assert.match(result.notes, /\[redacted\]\nagent warning \[redacted\]\nlast diagnostic line/)
          if (exitCode === 0) assert.match(result.notes, new RegExp(`READY ${sha}`))

          const handed = yield* Effect.exit(
            machine.handoff!(
              exitCode === 0 ? { ...result, status: "blocked" } : result,
              () => Effect.fail("no export for an unready result")
            )
          )
          assert.equal(handed._tag, "Success")
          assert.ok(!JSON.stringify(handed).includes(secret))
          assert.ok(!(yield* Effect.promise(() => readRecovery(dir))).includes(secret))
        }).pipe(Effect.provide(NodeServices.layer))
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}
