import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import Preview, { layer, PreviewFailed, validateReceipt } from "../preview/flow.ts"

const label = "//distribution:preview"
const fixture = (
  t: TestContext,
  options: {
    rows?: number
    failure?: string
    build?: boolean
    stdout?: boolean
    noResults?: boolean
    noReceipt?: boolean
    signalExit?: boolean
    tree?: boolean
    flood?: boolean
    receipt?: Record<string, unknown>
  } = {}
) => {
  const root = mkdtempSync(join(tmpdir(), "preview-flow-"))
  const cwd = process.cwd()
  const path = process.env.PATH
  mkdirSync(join(root, ".smithers"))
  mkdirSync(join(root, "bin"))
  mkdirSync(join(root, "distribution", "cloud-run-preview"), { recursive: true })
  execFileSync("git", ["init", "-q", "--initial-branch=fixture", root])
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture"
  ])
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const success = {
    revision: commit.slice(0, 7),
    expiresAt: "2099-10-07T14:40:00Z",
    access: "private",
    open: {
      command: `gcloud run services proxy fixture --tag r-${
        commit.slice(0, 7)
      } --region fixture-region --project fixture-project --port 4100`,
      localUrl: "http://preview.localhost:4100"
    }
  }
  writeFileSync(
    join(root, ".smithers", "target-index.json"),
    JSON.stringify(
      Array.from(
        { length: options.rows ?? 1 },
        (_, i) => ({
          label: i ? "//other:preview" : label,
          package: "distribution",
          name: "preview",
          rule: "CloudRun.Preview"
        })
      )
    )
  )
  const fake = join(root, "bin", "smthrs")
  writeFileSync(
    fake,
    `#!${process.execPath}\nimport fs from 'node:fs'; import { createHash } from 'node:crypto';\nfs.appendFileSync('calls.jsonl', JSON.stringify({argv:process.argv.slice(2),env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!['PWD','OLDPWD','_','SHLVL'].includes(k)).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')]))})+'\\n');\nconst results=process.argv[process.argv.indexOf('--results-file')+1];\n${
      options.noResults
        ? ""
        : `fs.writeFileSync(results,JSON.stringify({version:1,results:[{label:${
          JSON.stringify(options.build ? "//distribution:image" : label)
        },status:${JSON.stringify(options.failure ? "failed" : "ran")}}]}));`
    }\n${
      options.flood ? "process.stdout.write('x'.repeat(2*1024*1024)); setInterval(()=>{},1000);" : options.tree ?
        `const {spawn}=await import("node:child_process"); spawn(process.execPath,["-e", ${
          JSON.stringify(
            "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync('descendant.pid',String(process.pid)); setInterval(()=>{},1000)"
          )
        }],{stdio:"ignore"}); setInterval(()=>{},1000);` :
        options.signalExit ?
        "process.kill(process.pid, 'SIGTERM');" :
        options.noReceipt ?
        "" :
        options.failure
        ? `console.${options.stdout ? "log" : "error"}(${JSON.stringify(options.failure)});process.exit(1);`
        : `fs.writeFileSync('distribution/cloud-run-preview/preview.json',JSON.stringify(${
          JSON.stringify({
            version: 1,
            label,
            commit,
            service: "fixture",
            tag: `r-${commit.slice(0, 7)}`,
            region: "fixture-region",
            project: "fixture-project",
            ...success,
            ...options.receipt
          })
        }));`
    }\n`
  )
  chmodSync(fake, 0o755)
  // Fake the package-manager launcher too: no installs or network access.
  writeFileSync(join(root, "bin", "pnpm"), "#!/bin/sh\n[ \"$1\" = exec ] || exit 2\nshift\nexec \"$@\"\n")
  chmodSync(join(root, "bin", "pnpm"), 0o755)
  process.chdir(root)
  process.env.PATH = `${join(root, "bin")}:${path}`
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !["PWD", "OLDPWD", "_", "SHLVL"].includes(key)).map((
      [key, value]
    ) => [key, createHash("sha256").update(value!).digest("hex")])
  )
  const runtime = ManagedRuntime.make(
    Interpreter.layerWithImplementations(Preview, layer).pipe(
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
  )
  t.after(async () => {
    await runtime.dispose()
    process.chdir(cwd)
    process.env.PATH = path
    rmSync(root, { recursive: true, force: true })
  })
  const calls = () => {
    try {
      return readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  return { root, runtime, commit, success, calls, environment }
}

test("preview maps the private receipt and launches once through the package manager without adding credentials", async (t) => {
  const f = fixture(t)
  const result = await f.runtime.runPromise(Preview.execute({}))
  assert.deepEqual(result, f.success)
  assert.equal(f.calls().length, 1)
  assert.deepEqual(f.calls()[0].argv.slice(0, 3), ["run", label, "--results-file"])
  assert.deepEqual(f.calls()[0].env, f.environment)
  assert.doesNotMatch(JSON.stringify(result), /ya29\.|ghp_|Bearer /)
})
for (
  const [name, options, code, step, retryable] of [
    ["build failure", { failure: "image build failed", build: true }, "build_failed", "build", true],
    ["missing target", { rows: 0 }, "no_target", "deploy", false],
    ["ambiguous target", { rows: 2 }, "ambiguous_target", "deploy", false],
    ["missing builder", { failure: "tool_missing: docker unavailable" }, "builder_unavailable", "build", true],
    [
      "missing credentials",
      { failure: "ERROR: (gcloud) You do not currently have an active account selected." },
      "credentials_missing",
      "deploy",
      false
    ],
    ["public refusal", { failure: "public_access_off" }, "public_access_off", "deploy", false],
    ["deploy failure", { failure: "service failed" }, "deploy_failed", "deploy", true]
  ] as const
) {
  test(`preview refuses ${name}`, async (t) => {
    const f = fixture(t, options)
    const result = await f.runtime.runPromise(Effect.result(Preview.execute({})))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.ok(result.failure instanceof PreviewFailed)
      assert.equal(result.failure.code, code)
      assert.equal(result.failure.step, step)
      assert.equal(result.failure.retryable, retryable)
      assert.doesNotMatch(JSON.stringify(result.failure), /ya29\.|ghp_|Bearer /)
    }
    assert.equal(f.calls().length, "rows" in options ? 0 : 1)
  })
}
test("preview refuses a revision other than HEAD before launching", async (t) => {
  const f = fixture(t)
  const result = await f.runtime.runPromise(Effect.result(Preview.execute({ revision: "0".repeat(40) })))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof PreviewFailed)
    assert.equal(result.failure.code, "revision_not_checked_out")
  }
  assert.equal(f.calls().length, 0)
})
test("preview replays the same commit without a second deployment", async (t) => {
  const f = fixture(t)
  assert.deepEqual(await f.runtime.runPromise(Preview.execute({})), f.success)
  assert.deepEqual(await f.runtime.runPromise(Preview.execute({ revision: f.commit })), f.success)
  assert.equal(f.calls().length, 1)
})

test("preview refuses unresolved HEAD before launching", async (t) => {
  const f = fixture(t)
  rmSync(join(f.root, ".git"), { recursive: true })
  const result = await f.runtime.runPromise(Effect.result(Preview.execute({})))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof PreviewFailed)
    assert.equal(result.failure.code, "revision_not_checked_out")
  }
  assert.equal(f.calls().length, 0)
})
test("preview redacts a tool token from its first error line", async (t) => {
  const f = fixture(t, { failure: "progress\nERROR: deploy failed Bearer fixture-token-value\nmore detail" })
  const result = await f.runtime.runPromise(Effect.result(Preview.execute({})))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof PreviewFailed)
    assert.match(result.failure.message, /^ERROR: deploy failed .*REDACTED/)
    assert.equal(JSON.stringify(result.failure).includes("fixture-token-value"), false)
  }
})
for (const active of [true, false]) {
  test(
    active
      ? "the CLI executes preview through the same deploy action"
      : "registered preview without a target refuses honestly and starts nothing",
    { timeout: 90_000 },
    (t) => {
      const f = fixture(t, { rows: active ? 1 : 0 })
      const source = fileURLToPath(new URL("../preview/flow.ts", import.meta.url))
      const entry = fileURLToPath(new URL("../../packages/smithers/bin/smithers.mjs", import.meta.url))
      const helperDirectory = join(f.root, "packages", "smithers", "build", "build-cli", "src", "internal")
      mkdirSync(helperDirectory, { recursive: true })
      copyFileSync(
        fileURLToPath(
          new URL("../../packages/smithers/build/build-cli/src/internal/ContainedProcess.ts", import.meta.url)
        ),
        join(helperDirectory, "ContainedProcess.ts")
      )
      mkdirSync(join(f.root, ".flows"))
      mkdirSync(join(f.root, "flows", "preview"), { recursive: true })
      copyFileSync(source, join(f.root, "flows", "preview", "flow.ts"))
      symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(f.root, "node_modules"), "dir")
      writeFileSync(join(f.root, "package.json"), JSON.stringify({ type: "module" }))
      const result = spawnSync(process.execPath, [entry, "flow", "start", "preview", "--wait", "--verbose"], {
        encoding: "utf8",
        timeout: 80_000
      })
      if (!active) {
        assert.equal(result.status, 1, result.stderr + result.stdout)
        assert.match(result.stdout + result.stderr, /no_target/)
        assert.equal(f.calls().length, 0)
        assert.equal(existsSync(join(f.root, "distribution", "cloud-run-preview", "preview.json")), false)
        return
      }
      assert.equal(result.status, 0, result.stderr + result.stdout)
      const runId = /runId: (\S+)/.exec(result.stdout)?.[1]
      assert.ok(runId, result.stdout)
      assert.match(result.stdout + result.stderr, new RegExp(`preview requested · run ${runId}`))
      assert.ok(result.stdout.includes(f.success.open.command), result.stdout)
      assert.ok(result.stdout.includes(f.success.open.localUrl), result.stdout)
      assert.ok(result.stdout.includes(f.success.expiresAt), result.stdout)
      assert.equal(f.calls().length, 1, result.stdout)
      const saved = JSON.parse(readFileSync(join(f.root, "distribution", "cloud-run-preview", "preview.json"), "utf8"))
      assert.equal(saved.open.localUrl, f.success.open.localUrl)
      assert.equal(f.calls().length, 1)
    }
  )
}

test("preview refuses a different branch before launching", async (t) => {
  const f = fixture(t)
  const result = await f.runtime.runPromise(Effect.result(Preview.execute({ branch: "other" })))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof PreviewFailed)
    assert.equal(result.failure.code, "revision_not_checked_out")
  }
  assert.equal(f.calls().length, 0)
})
test("preview accepts the checked-out branch", async (t) => {
  const f = fixture(t)
  assert.deepEqual(await f.runtime.runPromise(Preview.execute({ branch: "fixture" })), f.success)
  assert.equal(f.calls().length, 1)
})
for (
  const [name, receipt, code] of [
    ["public receipt", { access: "public" }, "public_access_off"],
    ["wrong commit receipt", { commit: "0".repeat(40) }, "deploy_failed"],
    ["expired receipt", { expiresAt: "2020-01-01T00:00:00Z" }, "deploy_failed"],
    ["credential in opener", {
      open: {
        command: "gcloud run services proxy fixture --token ya29.fixture-secret",
        localUrl: "http://preview.localhost:4100"
      }
    }, "deploy_failed"]
  ] as const
) {
  test(`preview refuses ${name}`, async (t) => {
    const f = fixture(t, { receipt })
    const result = await f.runtime.runPromise(Effect.result(Preview.execute({})))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.ok(result.failure instanceof PreviewFailed)
      assert.equal(result.failure.code, code)
      assert.equal(JSON.stringify(result.failure).includes("ya29.fixture-secret"), false)
    }
    assert.equal(f.calls().length, 1)
  })
}

for (
  const [name, contents] of [
    ["missing index", undefined],
    ["malformed index", "{"],
    ["non-array index", "{}"],
    [
      "invalid target",
      JSON.stringify([{ rule: "CloudRun.Preview", label: "//../:preview", package: "..", name: "preview" }])
    ],
    ["null row", "[null]"]
  ] as const
) {
  test(`preview refuses ${name} without a CLI call`, async (t) => {
    const f = fixture(t)
    const index = join(f.root, ".smithers", "target-index.json")
    if (contents === undefined) rmSync(index)
    else writeFileSync(index, contents)
    const result = await f.runtime.runPromise(Effect.result(Preview.execute({})))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.ok(result.failure instanceof PreviewFailed)
      assert.equal(result.failure.code, "no_target")
    }
    assert.equal(f.calls().length, 0)
  })
}
for (
  const [name, options] of [
    ["stdout refusal", { stdout: true }],
    ["refusal before results", { noResults: true }]
  ] as const
) {
  test(`preview maps ${name} without waiting for login`, async (t) => {
    const f = fixture(t, { failure: "tool_missing: docker unavailable", ...options })
    const result = await f.runtime.runPromise(Effect.result(Preview.execute({})))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.ok(result.failure instanceof PreviewFailed)
      assert.equal(result.failure.code, "builder_unavailable")
      assert.equal(result.failure.message, "tool_missing: docker unavailable")
    }
    assert.equal(f.calls().length, 1)
  })
}
test("preview refuses when git cannot read the branch", async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, "bin", "git"), `#!/bin/sh\n[ "$1" = rev-parse ] || exit 1\nprintf '%s\\n' '${f.commit}'\n`)
  chmodSync(join(f.root, "bin", "git"), 0o755)
  const result = await f.runtime.runPromise(Effect.result(Preview.execute({ branch: "fixture" })))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof PreviewFailed)
    assert.equal(result.failure.code, "revision_not_checked_out")
  }
  assert.equal(f.calls().length, 0)
})
test("preview refuses a non-commit git HEAD", async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, "bin", "git"), "#!/bin/sh\nprintf 'unresolved\\n'\n")
  chmodSync(join(f.root, "bin", "git"), 0o755)
  const result = await f.runtime.runPromise(Effect.result(Preview.execute({})))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof PreviewFailed)
    assert.equal(result.failure.code, "revision_not_checked_out")
  }
  assert.equal(f.calls().length, 0)
})
test("preview refuses a missing package manager without launching smthrs", async (t) => {
  const f = fixture(t)
  // A fixed HEAD and an empty search path make this failure independent of host tools.
  writeFileSync(join(f.root, "bin", "git"), `#!${process.execPath}\nconsole.log('${f.commit}')\n`)
  chmodSync(join(f.root, "bin", "git"), 0o755)
  rmSync(join(f.root, "bin", "pnpm"))
  process.env.PATH = join(f.root, "bin")
  const result = await f.runtime.runPromise(Effect.result(Preview.execute({})))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof PreviewFailed)
    assert.equal(result.failure.code, "builder_unavailable")
    assert.equal(result.failure.step, "build")
  }
  assert.equal(f.calls().length, 0)
})

test("preview reports a CLI killed without an error line", async (t) => {
  const f = fixture(t, { signalExit: true })
  const result = await f.runtime.runPromise(Effect.result(Preview.execute({})))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof PreviewFailed)
    assert.equal(result.failure.code, "deploy_failed")
    assert.equal(result.failure.message, "Preview failed")
  }
  assert.equal(f.calls().length, 1)
})
test("preview refuses a successful exit without a receipt", async (t) => {
  const f = fixture(t, { noReceipt: true })
  const result = await f.runtime.runPromise(Effect.result(Preview.execute({})))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof PreviewFailed)
    assert.equal(result.failure.code, "deploy_failed")
    assert.equal(result.failure.step, "deploy")
    assert.equal(result.failure.retryable, true)
    assert.equal(result.failure.message, "Cannot read preview receipt")
  }
  assert.equal(f.calls().length, 1)
})

for (
  const url of [
    "http://localhost:4000",
    "http://127.0.0.1:4000",
    "http://preview.localhost:4101",
    "http://preview.localhost:4100/"
  ]
) {
  test(`preview refuses cookie-bearing or alternate origin ${url}`, async (t) => {
    const f = fixture(t, { noReceipt: true })
    const file = join(f.root, "distribution", "cloud-run-preview", "preview.json")
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        label,
        commit: f.commit,
        service: "fixture",
        tag: `r-${f.commit.slice(0, 7)}`,
        region: "fixture-region",
        project: "fixture-project",
        ...f.success,
        open: { ...f.success.open, localUrl: url }
      })
    )
    await assert.rejects(validateReceipt(file, label, f.commit), /Invalid preview opener/)
    const result = await f.runtime.runPromise(Effect.result(Preview.execute({})))
    assert.equal(result._tag, "Failure")
    assert.equal(f.calls().length, 1, "invalid receipt cannot replay")
  })
}
for (const field of ["service", "tag", "region", "project", "port"]) {
  test(`preview refuses conflicting opener ${field}`, async (t) => {
    const f = fixture(t, { noReceipt: true })
    const file = join(f.root, "distribution", "cloud-run-preview", "preview.json")
    const command = f.success.open.command.replace(
      field === "service"
        ? "proxy fixture"
        : field === "tag"
        ? `--tag r-${f.commit.slice(0, 7)}`
        : field === "port"
        ? "--port 4100"
        : `--${field} fixture-${field}`,
      field === "service" ? "proxy other" : `--${field} other`
    )
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        label,
        commit: f.commit,
        service: "fixture",
        tag: `r-${f.commit.slice(0, 7)}`,
        region: "fixture-region",
        project: "fixture-project",
        ...f.success,
        open: { ...f.success.open, command }
      })
    )
    await assert.rejects(validateReceipt(file, label, f.commit), /Invalid preview opener/)
    const result = await f.runtime.runPromise(Effect.result(Preview.execute({})))
    assert.equal(result._tag, "Failure")
    assert.equal(f.calls().length, 1, "invalid receipt cannot replay")
  })
}
test("preview cancellation joins a descendant ignoring SIGTERM with closed pipes", { timeout: 20000 }, async (t) => {
  const f = fixture(t, { tree: true })
  const fiber = f.runtime.runFork(Preview.execute({}, { executionId: "cancel-tree" }))
  const pidFile = join(f.root, "descendant.pid")
  for (let i = 0; i < 300 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20))
  assert.ok(existsSync(pidFile), "descendant started")
  const pid = Number(readFileSync(pidFile, "utf8"))
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  })
  await f.runtime.runPromise(Preview.interrupt("cancel-tree"))
  const exit = await f.runtime.runPromise(Fiber.await(fiber))
  assert.ok(Exit.isFailure(exit))
  if (Exit.isFailure(exit)) assert.ok(Cause.hasInterrupts(exit.cause), "cancellation remains interruption")
  let alive = true
  for (let i = 0; i < 100 && alive; i++) {
    try {
      process.kill(pid, 0)
      await new Promise((r) => setTimeout(r, 20))
    } catch {
      alive = false
    }
  }
  assert.equal(alive, false, "descendant is gone after cancellation")
})

test("preview bounds captured build output", { timeout: 15000 }, async (t) => {
  const f = fixture(t, { flood: true })
  const result = await f.runtime.runPromise(Effect.result(Preview.execute({})))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof PreviewFailed)
    assert.equal(result.failure.code, "build_failed")
    assert.equal(result.failure.message, "Preview output limit exceeded")
  }
})
