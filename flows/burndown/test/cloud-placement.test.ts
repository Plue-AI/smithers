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
import { layerPlacementWith, makeCloudPlacement } from "../cloud-placement.ts"
import { agentArgv, Placement } from "../run-agent.ts"
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

// A fake control API makes workspace lifecycle deterministic; real subprocesses
// exercise CommandSandbox stdin, temporary guest config and cleanup together.
for (const tool of ["codex", "claude"] as const) {
  test(`Cloud placement injects ${tool} login on stdin and deletes configs/workspace`, async () => {
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
          const machine = yield* placement.machine({ ...assignment, tool }, { ...account, tool })
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
      assert.deepEqual(calls, ["POST", "GET", "DELETE"])
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
          const machine = yield* placement.machine({ ...assignment, tool: "claude" }, { ...account, tool: "claude" })
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
      assert.deepEqual(calls, ["POST", "GET", "DELETE"])
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
        console.log(`${tool}: Cloud command execution passed; scoped workspace released`)
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
          if (args[1]!.includes("git show")) return Effect.succeed(Buffer.from(`${guestSha}\0${"b".repeat(40)}\0fix: fixture`).toString("base64"))
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
        const machine = yield* placement.machine({ ...assignment, tool: "claude" }, { ...account, tool: "claude" })
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
        }).machine({ ...assignment, tool: "claude" }, { ...account, tool: "claude", directory: reviewer })
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
  const calls: string[] = []
  try {
    await Effect.runPromise(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const machine = yield* makeCloudPlacement({
        spawner, workdir: dir, install: false, artifactDirectory: dir,
        identity: async () => "smithers-dev", prepareRepository: async () => {},
        credential: async () => ({ auth: {} }),
        api: {
          request: async (method) => { calls.push(method); return { id: "ws-recovery", status: "running" } },
          sshPrefix: async () => []
        }
      }).machine(assignment, account)
      yield* Effect.gen(function*() {
        const guest = yield* ChildProcessSpawner
        const command = yield* machine.command!("printf 'READY " + sha + "\\n'")
        const output = yield* guest.string(ChildProcess.make("sh", ["-c", command.script], {
          stdin: Stream.make(command.stdin!), env: machine.env, extendEnv: true
        }))
        assert.match(output, /READY/)
        const exit = yield* Effect.exit(machine.handoff!({
          key: assignment.key, status: "ready", commits: [{ issue: 42, commit: sha }],
          notes: "PRIVATE-REPORT-NOTES", agentHours: 0
        }, () => Effect.fail("PRIVATE-TRANSPORT-ERROR")))
        assert.equal(exit._tag, "Failure")
        const raw = yield* Effect.promise(() => readFile(join(dir, "recovery.json"), "utf8"))
        assert.ok(!raw.includes("PRIVATE-REPORT-NOTES"))
        assert.ok(!raw.includes("PRIVATE-TRANSPORT-ERROR"))
        assert.match(raw, /ws-recovery/)
        assert.match(raw, /gpt-6.1-sol/)
        assert.match(raw, new RegExp(sha))
      }).pipe(Effect.provide(Sandbox.layerHost(machine.provider, { session: assignment.key + dir })), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer)))
    assert.deepEqual(calls, ["POST", "GET"], "failed export must keep remote committed code")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

for (const tool of ["codex", "claude"] as const) {
  test(`Cloud retained ${tool} artifact permits cleanup and preserves assignment attribution`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "burndown-retained-cleanup-"))
    const sha = "a".repeat(40)
    const model = tool === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5"
    const calls: string[] = []
    let reconstructed = false
    try {
      await Effect.runPromise(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const machine = yield* makeCloudPlacement({
          spawner, workdir: dir, install: false, artifactDirectory: dir,
          identity: async () => "smithers-dev", prepareRepository: async () => {},
          credential: async () => tool === "codex" ? { auth: {} } : { token: "fixture" },
          api: {
            request: async (method) => {
              calls.push(method)
              if (method === "DELETE") {
                assert.ok((await readdir(dir)).some((entry) => /^[a-f0-9]{64}$/.test(entry)), "retain before cleanup")
              }
              return { id: "ws-retained", status: "running" }
            }, sshPrefix: async () => []
          },
          review: async () => "VERDICT: PASS",
          handoff: async (_artifact, attribution) => {
            assert.deepEqual(attribution, { tool, model })
            reconstructed = true
            return { artifactPath: dir, receiptPath: dir, commit: sha, commits: [{ source: sha, local: sha }] }
          }
        }).machine({ ...assignment, tool, model }, { ...account, tool })
        yield* Effect.gen(function*() {
          const guest = yield* ChildProcessSpawner
          const command = yield* machine.command!("printf READY")
          assert.equal(yield* guest.string(ChildProcess.make("sh", ["-c", command.script], {
            stdin: Stream.make(command.stdin!), env: machine.env, extendEnv: true
          })), "READY")
          yield* machine.handoff!({ key: assignment.key, status: "ready", commits: [{ issue: 42, commit: sha }], notes: "", agentHours: 0 },
            (_program, args) => Effect.succeed(args[1]!.includes("git show")
              ? Buffer.from(`${sha}\0${"b".repeat(40)}\0fix: retained`).toString("base64")
              : args[1]!.includes("diff-tree")
              ? Buffer.from(`:000000 100644 ${"0".repeat(40)} ${"1".repeat(40)} A\0file\0`).toString("base64")
              : Buffer.from("retained").toString("base64")))
        }).pipe(Effect.provide(Sandbox.layerHost(machine.provider, { session: assignment.key + dir })), Effect.scoped)
      }).pipe(Effect.provide(NodeServices.layer)))
      assert.equal(reconstructed, true)
      assert.deepEqual(calls, ["POST", "GET", "DELETE"])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}
