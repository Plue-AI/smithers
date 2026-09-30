import assert from "node:assert/strict"
import { chmod, lstat, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  prepareCloudHandoff,
  retainCloudHandoff,
  retainCloudRecovery,
  validateCloudHandoff
} from "../burndown/cloud-handoff.ts"
import { symlinkBytesFromDiff } from "../burndown/cloud-symlink.ts"

const base = "a".repeat(40)
const source = "b".repeat(40)
const entry = (data: string) => ({ type: "file", mode: "644", data: Buffer.from(data).toString("base64") })
const artifact = () => ({
  version: 1,
  repository: "smithersai/smithers",
  base,
  commits: [{
    sha: source,
    parent: base,
    message: "fix: issue #2924",
    changes: [{ path: "source.ts", before: entry("old"), after: entry("new") }]
  }]
})

test("Cloud READY retains a portable artifact before invoking the single locked script", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-test-"))
  try {
    let calls = 0
    const result = await prepareCloudHandoff(artifact(), {
      repository: "smithersai/smithers",
      repoDirectory: directory,
      artifactDirectory: join(directory, "receipts"),
      run: async (command, args) => {
        calls++
        assert.equal(command, "python3")
        assert.match(args[0]!, /vcs_lock\.py$/)
        assert.equal(args[1], "smithers")
        assert.ok(args[2]!.startsWith("/"))
        const retained = JSON.parse(await readFile(join(args[2]!, "..", "artifact.json"), "utf8"))
        assert.deepEqual(retained, artifact())
        await writeFile(
          join(args[2]!, "..", "receipt.json"),
          JSON.stringify({ status: "prepared", commits: [{ source, local: "c".repeat(40) }] })
        )
      }
    })
    assert.equal(calls, 1)
    assert.equal(result.commit, "c".repeat(40))
    assert.deepEqual(result.commits, [{ source, local: "c".repeat(40) }])
    assert.deepEqual(JSON.parse(await readFile(result.artifactPath, "utf8")), artifact())
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (
  const path of [
    "../escape",
    "/absolute",
    "foo/../bad",
    ".git/config",
    "safe/.jj/x",
    "a\\b",
    "a\nother",
    "./relative",
    "a//b"
  ]
) {
  test(`Cloud handoff refuses hostile path ${JSON.stringify(path)} before any runner`, () => {
    const value = artifact()
    value.commits[0]!.changes[0]!.path = path
    assert.throws(() => validateCloudHandoff(value, "smithersai/smithers"), /path/)
  })
}

test("Cloud handoff refuses malformed identity, base64, duplicate paths and broken parent chains", () => {
  const wrongRepo = artifact()
  wrongRepo.repository = "smithersai/plue"
  assert.throws(() => validateCloudHandoff(wrongRepo, "smithersai/smithers"), /repository/)
  const invalidBytes = artifact()
  invalidBytes.commits[0]!.changes[0]!.after.data = "!!!"
  assert.throws(() => validateCloudHandoff(invalidBytes, "smithersai/smithers"), /base64/)
  const duplicate = artifact()
  duplicate.commits[0]!.changes.push(duplicate.commits[0]!.changes[0]!)
  assert.throws(() => validateCloudHandoff(duplicate, "smithersai/smithers"), /duplicate/)
  const chain = artifact()
  chain.commits[0]!.parent = source
  assert.throws(() => validateCloudHandoff(chain, "smithersai/smithers"), /parent/)
  const noop = artifact()
  noop.commits[0]!.changes[0]!.after = entry("old")
  assert.throws(() => validateCloudHandoff(noop, "smithersai/smithers"), /unchanged/)
})

test("Cloud handoff retains artifact and a separate private diagnostic when lock execution fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-failure-"))
  try {
    let artifactPath = ""
    await assert.rejects(
      prepareCloudHandoff(artifact(), {
        repository: "smithersai/smithers",
        repoDirectory: directory,
        artifactDirectory: join(directory, "receipts"),
        run: async (_command, args) => {
          artifactPath = join(args[2]!, "..", "artifact.json")
          throw new Error("lock failed")
        }
      }),
      /lock failed/
    )
    assert.deepEqual(JSON.parse(await readFile(artifactPath, "utf8")), artifact())
    await assert.rejects(readFile(join(artifactPath, "..", "receipt.json")), { code: "ENOENT" })
    const retainedDirectory = join(artifactPath, "..")
    const diagnostics = (await readdir(retainedDirectory)).filter((path) => /^runner-error-.*\.json$/.test(path))
    assert.equal(diagnostics.length, 1)
    const diagnosticPath = join(retainedDirectory, diagnostics[0]!)
    assert.equal((await lstat(diagnosticPath)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(diagnosticPath, "utf8")), {
      status: "failed",
      runnerError: "Cloud handoff lock runner failed",
      receiptPath: join(retainedDirectory, "receipt.json")
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// Real jj trees are necessary to prove the diff editor preserves modes and
// uncommitted work. The temporary fixture uses a real flock without production
// credentials or a shared-checkout mutation.
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const exec = promisify(execFile)
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

const fixture = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "handoff-jj-")))
  const repoDirectory = join(directory, "repo")
  const lockPath = join(directory, "lock.py")
  await writeFile(
    lockPath,
    `import fcntl, pathlib, subprocess, sys\nroot=pathlib.Path(${
      JSON.stringify(directory)
    })\nwith (root/'vcs.lock').open('w') as lock:\n fcntl.flock(lock.fileno(),fcntl.LOCK_EX)\n sys.exit(subprocess.run([sys.argv[2]],cwd=root).returncode)\n`
  )
  const setup = join(directory, "setup.sh")
  await writeFile(
    setup,
    `#!/bin/sh\nset -eu\njj git init ${shellQuote(repoDirectory)}\ncd ${
      shellQuote(repoDirectory)
    }\nprintf old > owned.txt\nprintf clean > wip.txt\nprintf remove > gone.txt\njj --config user.name=Fixture --config user.email=fixture@example.test commit -m 'fixture base'\njj bookmark set main -r @-\n`
  )
  await chmod(setup, 0o700)
  await exec("python3", [lockPath, "smithers", setup])
  const jj = async (...args: Array<string>) =>
    (await exec("jj", ["--ignore-working-copy", "--no-pager", ...args], {
      cwd: repoDirectory,
      maxBuffer: 16 * 1024 * 1024
    })).stdout
  const base = await jj("log", "--no-graph", "-r", "@-", "-T", "commit_id")
  return {
    directory,
    repoDirectory,
    lockPath,
    base,
    jj,
    options: {
      repository: "smithersai/smithers",
      repoDirectory,
      artifactDirectory: join(directory, "receipts"),
      lockPath,
      attribution: { tool: "codex", model: "gpt-6.1-sol" } as const
    }
  }
}

test("real jj handoff reconstructs ordered commits and portable tree entries while preserving shared WIP and main", async () => {
  const env = await fixture()
  try {
    await writeFile(join(env.repoDirectory, "wip.txt"), "other agent edit")
    await writeFile(join(env.repoDirectory, "other-agent.txt"), "untracked agent work")
    const bytes = Buffer.from([0, 1, 255, 128, 10]).toString("base64")
    const value = {
      version: 1,
      repository: "smithersai/smithers",
      base: env.base,
      commits: [
        {
          sha: source,
          parent: env.base,
          message: "fix: issue #2924",
          changes: [
            { path: "owned.txt", before: entry("old"), after: entry("first") },
            { path: "gone.txt", before: entry("remove"), after: null },
            { path: "binary.bin", before: null, after: { type: "file", mode: "644", data: bytes } },
            {
              path: "run.sh",
              before: null,
              after: { type: "file", mode: "755", data: Buffer.from("#!/bin/sh\ntrue\n").toString("base64") }
            },
            {
              path: "link",
              before: null,
              after: { type: "symlink", mode: "120000", data: Buffer.from("owned.txt").toString("base64") }
            }
          ]
        },
        {
          sha: "d".repeat(40),
          parent: source,
          message: "fix: issue #2925",
          changes: [{ path: "owned.txt", before: entry("first"), after: entry("second") }]
        }
      ]
    }
    const result = await prepareCloudHandoff(value, env.options)
    assert.equal(result.commits.length, 2)
    assert.equal(await env.jj("log", "--no-graph", "-r", "main", "-T", "commit_id"), env.base)
    assert.equal(await env.jj("file", "show", "-r", result.commits[0]!.local, "owned.txt"), "first")
    assert.equal(await env.jj("file", "show", "-r", result.commit, "owned.txt"), "second")
    assert.equal(
      await env.jj("log", "--no-graph", "-r", result.commit, "-T", "parents.map(|p| p.commit_id()).join(\"\")"),
      result.commits[0]!.local
    )
    assert.match(
      await env.jj("log", "--no-graph", "-r", result.commit, "-T", "description"),
      /Co-Authored-By: GPT-6\.1 Sol <noreply@openai\.com>/
    )
    assert.equal(await readFile(join(env.repoDirectory, "wip.txt"), "utf8"), "other agent edit")
    assert.equal(await readFile(join(env.repoDirectory, "other-agent.txt"), "utf8"), "untracked agent work")
    assert.equal(await env.jj("file", "show", "-r", result.commit, "wip.txt"), "clean")
    assert.equal(await env.jj("file", "list", "-r", result.commit, "other-agent.txt"), "")
    const binary = await exec("jj", ["--ignore-working-copy", "file", "show", "-r", result.commit, "binary.bin"], {
      cwd: env.repoDirectory,
      encoding: "buffer"
    })
    assert.deepEqual(binary.stdout, Buffer.from(bytes, "base64"))
    for (const path of ["binary.bin", "run.sh", "link"]) {
      await assert.rejects(lstat(join(env.repoDirectory, path)), { code: "ENOENT" })
    }
    assert.equal(
      Buffer.from(
        symlinkBytesFromDiff(
          Buffer.from(await env.jj("diff", "--git", "--from", "root()", "--to", result.commit, "link"))
        )
      ).toString(),
      "owned.txt"
    )
    assert.equal(
      await env.jj("file", "list", "-r", result.commit, "-T", "file_type ++ \" \" ++ executable", "run.sh"),
      "file true"
    )
    assert.equal(await env.jj("file", "list", "-r", result.commit, "-T", "file_type", "link"), "symlink")
    assert.equal(await readFile(join(env.repoDirectory, "gone.txt"), "utf8"), "remove")
    assert.equal(await env.jj("file", "list", "-r", result.commit, "gone.txt"), "")
    const replay = await prepareCloudHandoff(value, env.options)
    assert.deepEqual(replay.commits, result.commits)
    assert.equal(await env.jj("log", "--no-graph", "-r", "@-", "-T", "commit_id"), env.base)
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})

for (const conflict of ["shared WIP", "main", "symlink ancestor"] as const) {
  test(`real jj handoff refuses ${conflict} conflict and retains guest bytes without clobbering`, async () => {
    const env = await fixture()
    try {
      const value = {
        ...artifact(),
        base: env.base,
        commits: [{
          ...artifact().commits[0]!,
          parent: env.base,
          changes: conflict === "symlink ancestor"
            ? [{ path: "outside/escape.txt", before: null, after: entry("unsafe") }]
            : [{ path: "owned.txt", before: entry("old"), after: entry("new") }]
        }]
      }
      if (conflict === "shared WIP") await writeFile(join(env.repoDirectory, "owned.txt"), "another agent")
      if (conflict === "symlink ancestor") {
        await symlink(env.directory, join(env.repoDirectory, "outside"))
      }
      if (conflict === "main") {
        const script = join(env.directory, "advance.sh")
        await writeFile(
          script,
          `#!/bin/sh\nset -eu\ncd ${
            shellQuote(env.repoDirectory)
          }\nprintf changed > owned.txt\njj --config user.name=Fixture --config user.email=fixture@example.test commit owned.txt -m changed\njj bookmark set main -r @-\n`
        )
        await chmod(script, 0o700)
        await exec("python3", [env.lockPath, "smithers", script])
      }
      const parent = await env.jj("log", "--no-graph", "-r", "@-", "-T", "commit_id")
      await assert.rejects(
        prepareCloudHandoff(value, env.options),
        conflict === "shared WIP"
          ? /shared working-copy edits/
          : conflict === "main"
          ? /main changed an owned path/
          : /symlink ancestor/
      )
      assert.equal(await env.jj("log", "--no-graph", "-r", "@-", "-T", "commit_id"), parent)
      if (conflict !== "symlink ancestor") {
        assert.equal(
          await readFile(join(env.repoDirectory, "owned.txt"), "utf8"),
          conflict === "main" ? "changed" : "another agent"
        )
      }
      const retained = join(
        env.options.artifactDirectory,
        (await import("node:crypto")).createHash("sha256").update(
          JSON.stringify(validateCloudHandoff(value, value.repository))
        ).digest("hex"),
        "artifact.json"
      )
      assert.deepEqual(JSON.parse(await readFile(retained, "utf8")), value)
      if (conflict === "symlink ancestor") {
        await assert.rejects(readFile(join(env.directory, "escape.txt")), { code: "ENOENT" })
      }
    } finally {
      await rm(env.directory, { recursive: true, force: true })
    }
  })
}

test("Cloud handoff enforces count and byte limits and rejects ambiguous host paths", () => {
  const oversized = artifact()
  oversized.commits[0]!.changes[0]!.after.data = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64")
  assert.throws(() => validateCloudHandoff(oversized, oversized.repository), /file size/)
  const total = artifact()
  const block = Buffer.alloc(8 * 1024 * 1024).toString("base64")
  total.commits[0]!.changes = Array.from(
    { length: 9 },
    (_, i) => ({ path: `file${i}`, before: entry(""), after: { ...entry(""), data: block } })
  )
  assert.throws(() => validateCloudHandoff(total, total.repository), /total size/)
  const count = artifact()
  count.commits[0]!.changes = Array.from(
    { length: 1001 },
    (_, i) => ({ path: `file${i}`, before: entry(""), after: entry("new") })
  )
  assert.throws(() => validateCloudHandoff(count, count.repository), /path count/)
  const commits = artifact()
  commits.commits = Array.from({ length: 21 }, () => commits.commits[0]!)
  assert.throws(() => validateCloudHandoff(commits, commits.repository), /commit count/)
  const aliases = artifact()
  aliases.commits[0]!.changes.push({ ...aliases.commits[0]!.changes[0]!, path: "SOURCE.ts" })
  assert.throws(() => validateCloudHandoff(aliases, aliases.repository), /ambiguous.*path/)
  const ancestor = artifact()
  ancestor.commits[0]!.changes.push({ ...ancestor.commits[0]!.changes[0]!, path: "source.ts/escape" })
  assert.throws(() => validateCloudHandoff(ancestor, ancestor.repository), /path ancestry/)
})

test("real jj failure retains completed detached mappings and shared bytes, and refuses duplicate partial replay", async () => {
  const env = await fixture()
  try {
    const actualJj = (await exec("which", ["jj"])).stdout.trim()
    const shim = join(env.directory, "jj")
    const count = join(env.directory, "commit-count")
    await writeFile(
      shim,
      `#!/usr/bin/env python3\nimport os,pathlib,sys\nif 'split' in sys.argv[1:]:\n p=pathlib.Path(${
        JSON.stringify(count)
      });n=int(p.read_text())+1 if p.exists() else 1;p.write_text(str(n))\n if n==2: sys.exit(42)\nos.environ['PATH']=os.environ['PATH'].split(':',1)[1]\nos.execv(${
        JSON.stringify(actualJj)
      },[${JSON.stringify(actualJj)},*sys.argv[1:]])\n`
    )
    await chmod(shim, 0o700)
    const value = {
      version: 1,
      repository: "smithersai/smithers",
      base: env.base,
      commits: [
        {
          sha: source,
          parent: env.base,
          message: "fix: first",
          changes: [{ path: "owned.txt", before: entry("old"), after: entry("first") }]
        },
        {
          sha: "d".repeat(40),
          parent: source,
          message: "fix: second",
          changes: [{ path: "owned.txt", before: entry("first"), after: entry("second") }]
        }
      ]
    }
    const options = {
      ...env.options,
      run: async (command: string, args: ReadonlyArray<string>) => {
        await exec(command, [...args], { env: { ...process.env, PATH: env.directory + ":" + process.env.PATH } })
      }
    }
    await assert.rejects(prepareCloudHandoff(value, options), /jj command failed/)
    const directory = join(
      env.options.artifactDirectory,
      (await import("node:crypto")).createHash("sha256").update(
        JSON.stringify(validateCloudHandoff(value, value.repository))
      ).digest("hex")
    )
    const receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"))
    assert.equal(receipt.status, "failed")
    assert.equal(receipt.commits.length, 1)
    assert.equal(receipt.commits[0].source, source)
    assert.equal(await env.jj("log", "--no-graph", "-r", "@-", "-T", "commit_id"), env.base)
    assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
    assert.equal(await env.jj("file", "show", "-r", receipt.commits[0].local, "owned.txt"), "first")
    assert.deepEqual(JSON.parse(await readFile(join(directory, "artifact.json"), "utf8")), value)
    await assert.rejects(prepareCloudHandoff(value, options), /partial preparation retained/)
    assert.equal(await readFile(count, "utf8"), "2")
    assert.equal(await env.jj("log", "--no-graph", "-r", "main", "-T", "commit_id"), env.base)
    const recoveryOptions = { ...options, recoverPartial: true }
    const recovered = await prepareCloudHandoff(value, recoveryOptions)
    assert.equal(recovered.commits.length, 2)
    assert.deepEqual(recovered.commits[0], receipt.commits[0])
    assert.equal(await env.jj("file", "show", "-r", recovered.commit, "owned.txt"), "second")
    assert.equal(
      await env.jj("log", "--no-graph", "-r", recovered.commit, "-T", "parents.map(|p| p.commit_id()).join(\"\")"),
      receipt.commits[0].local
    )
    assert.equal(
      await env.jj("log", "--no-graph", "-r", `children(${env.base}) ~ @`, "-T", "commit_id"),
      receipt.commits[0].local
    )
    assert.equal(
      await env.jj("log", "--no-graph", "-r", `children(${receipt.commits[0].local}) ~ @`, "-T", "commit_id"),
      recovered.commit
    )
    assert.equal(await readFile(count, "utf8"), "3")
    assert.deepEqual((await prepareCloudHandoff(value, recoveryOptions)).commits, recovered.commits)
    assert.equal(await readFile(count, "utf8"), "3")
    assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})

test("standalone host retention survives review refusal and detects corrupt retained artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-retain-"))
  try {
    const options = { repository: "smithersai/smithers", artifactDirectory: join(directory, "receipts") }
    const path = await retainCloudHandoff(artifact(), options)
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), artifact())
    assert.equal((await lstat(path)).mode & 0o777, 0o600)
    assert.equal(await retainCloudHandoff(artifact(), options), path)
    await writeFile(path, "corrupt")
    await assert.rejects(retainCloudHandoff(artifact(), options), /retained handoff identity mismatch/)
    assert.equal(await readFile(path, "utf8"), "corrupt")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Cloud handoff allows repository-owned .smithers configuration and refuses cross-commit path ancestry", () => {
  const config = artifact()
  config.commits[0]!.changes[0]!.path = ".smithers/FACTORY.ts"
  assert.equal(validateCloudHandoff(config, config.repository).commits[0]!.changes[0]!.path, ".smithers/FACTORY.ts")
  const ancestry = artifact()
  ancestry.commits.push({
    sha: "d".repeat(40),
    parent: source,
    message: "fix: next",
    changes: [{ path: "source.ts/escape", before: entry(""), after: entry("new") }]
  })
  assert.throws(() => validateCloudHandoff(ancestry, ancestry.repository), /path ancestry/)
})

test("real jj handoff commits large and ignored files, safe messages, and preserves WIP descriptions", async () => {
  const env = await fixture()
  try {
    const setup = join(env.directory, "description.sh")
    await writeFile(
      setup,
      `#!/bin/sh\nset -eu\ncd ${
        shellQuote(env.repoDirectory)
      }\nprintf 'ignored.dat\\n' > .gitignore\njj describe -m 'other agent description'\n`
    )
    await chmod(setup, 0o700)
    await exec("python3", [env.lockPath, "smithers", setup])
    const data = Buffer.alloc(2 * 1024 * 1024, 120).toString("base64")
    const value = {
      version: 1,
      repository: "smithersai/smithers",
      base: env.base,
      commits: [{
        sha: source,
        parent: env.base,
        message: "-fix: leading hyphen",
        changes: [
          { path: "large.bin", before: null, after: { type: "file", mode: "644", data } },
          { path: "ignored.dat", before: null, after: entry("ignored but committed") },
          { path: ".smithers/FACTORY.ts", before: null, after: entry("export default {}") }
        ]
      }]
    }
    const prepared = await prepareCloudHandoff(value, env.options)
    assert.equal((await env.jj("file", "show", "-r", prepared.commit, "large.bin")).length, 2 * 1024 * 1024)
    assert.equal(await env.jj("file", "show", "-r", prepared.commit, "ignored.dat"), "ignored but committed")
    assert.equal(await env.jj("file", "show", "-r", prepared.commit, ".smithers/FACTORY.ts"), "export default {}")
    assert.match(await env.jj("log", "--no-graph", "-r", prepared.commit, "-T", "description"), /^-fix: leading hyphen/)
    assert.equal(await env.jj("log", "--no-graph", "-r", "@", "-T", "description"), "other agent description\n")
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})

test("runner error after prepared receipt preserves completed preparation for replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-wrapper-"))
  try {
    const options = {
      repository: "smithersai/smithers",
      repoDirectory: directory,
      artifactDirectory: join(directory, "receipts"),
      run: async (_command: string, args: ReadonlyArray<string>) => {
        await writeFile(
          join(args[2]!, "..", "receipt.json"),
          JSON.stringify({ status: "prepared", commits: [{ source, local: "c".repeat(40) }] })
        )
        throw new Error("wrapper release failed")
      }
    }
    await assert.rejects(prepareCloudHandoff(artifact(), options), /wrapper release failed/)
    const prepared = await prepareCloudHandoff(artifact(), { ...options, run: async () => {} })
    assert.equal(prepared.commit, "c".repeat(40))
    assert.equal(JSON.parse(await readFile(prepared.receiptPath, "utf8")).status, "prepared")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("prepared receipt replay verifies under the lock after script upgrades and preserves receipt on runner failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-upgrade-"))
  try {
    let calls = 0
    const options = {
      repository: "smithersai/smithers",
      repoDirectory: directory,
      artifactDirectory: join(directory, "receipts"),
      run: async (_command: string, args: ReadonlyArray<string>) => {
        calls++
        await writeFile(
          join(args[2]!, "..", "receipt.json"),
          JSON.stringify({ status: "prepared", commits: [{ source, local: "c".repeat(40) }] })
        )
      }
    }
    const result = await prepareCloudHandoff(artifact(), options)
    await writeFile(join(result.artifactPath, "..", "prepare.py"), "older script")
    await assert.rejects(
      prepareCloudHandoff(artifact(), {
        ...options,
        run: async () => {
          calls++
          throw new Error("jj st failed")
        }
      }),
      /jj st failed/
    )
    assert.equal(calls, 2)
    const replay = await prepareCloudHandoff(artifact(), {
      ...options,
      run: async () => {
        calls++
      }
    })
    assert.equal(calls, 3)
    assert.deepEqual(replay.commits, result.commits)
    assert.equal(JSON.parse(await readFile(result.receiptPath, "utf8")).status, "prepared")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("oversized symlink targets are refused before any host write", () => {
  const value = artifact()
  value.commits[0]!.changes[0]!.after = {
    type: "symlink",
    mode: "120000",
    data: Buffer.alloc(1024, 120).toString("base64")
  }
  assert.throws(() => validateCloudHandoff(value, value.repository), /symlink/)
})

test("real mid-seed write failure restores modified paths without clobbering shared WIP", async () => {
  const env = await fixture()
  const readonly = join(env.repoDirectory, "readonly")
  try {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(readonly)
    await chmod(readonly, 0o500)
    await writeFile(join(env.repoDirectory, "wip.txt"), "other agent")
    const value = {
      version: 1,
      repository: "smithersai/smithers",
      base: env.base,
      commits: [{
        sha: source,
        parent: env.base,
        message: "fix: write failure",
        changes: [
          { path: "owned.txt", before: entry("old"), after: entry("new") },
          { path: "readonly/new.txt", before: null, after: entry("new") }
        ]
      }]
    }
    await assert.rejects(prepareCloudHandoff(value, env.options), /could not seed checked Cloud paths/)
    assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
    assert.equal(await readFile(join(env.repoDirectory, "wip.txt"), "utf8"), "other agent")
    await assert.rejects(readFile(join(readonly, "new.txt")), { code: "ENOENT" })
    assert.equal(await env.jj("log", "--no-graph", "-r", "@-", "-T", "commit_id"), env.base)
  } finally {
    await chmod(readonly, 0o700)
    await rm(env.directory, { recursive: true, force: true })
  }
})

test("Cloud handoff refuses file/directory shape changes before writes, including host case aliases", () => {
  for (const parentPath of ["dir", "DIR"]) {
    const value = {
      version: 1,
      repository: "smithersai/smithers",
      base,
      commits: [{
        sha: source,
        parent: base,
        message: "fix: shape",
        changes: [
          { path: parentPath, before: entry("file"), after: null },
          { path: "dir/child", before: null, after: entry("child") }
        ]
      }]
    }
    assert.throws(() => validateCloudHandoff(value, value.repository), /path ancestry/)
  }
})

test("real jj handoff preserves multiline, Unicode and final-newline symlink targets exactly", async () => {
  const env = await fixture()
  try {
    const targets = ["owned.txt\nsecond", "owned.txt\n", "δ/target"]
    const value = {
      version: 1,
      repository: "smithersai/smithers",
      base: env.base,
      commits: [{
        sha: source,
        parent: env.base,
        message: "fix: symlink targets",
        changes: targets.map((target, index) => ({
          path: `link-${index}`,
          before: null,
          after: { type: "symlink", mode: "120000", data: Buffer.from(target).toString("base64") }
        }))
      }]
    }
    const prepared = await prepareCloudHandoff(value, env.options)
    for (let i = 0; i < targets.length; i++) {
      assert.equal(
        Buffer.from(
          symlinkBytesFromDiff(
            Buffer.from(await env.jj("diff", "--git", "--from", "root()", "--to", prepared.commit, `link-${i}`))
          )
        ).toString(),
        targets[i]
      )
      await assert.rejects(lstat(join(env.repoDirectory, `link-${i}`)), { code: "ENOENT" })
      assert.equal(await env.jj("file", "list", "-r", prepared.commit, "-T", "file_type", `link-${i}`), "symlink")
    }
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})

test("real refused handoff retries safely after host script and parser metadata upgrades", async () => {
  const env = await fixture()
  try {
    const value = {
      ...artifact(),
      base: env.base,
      commits: [{
        ...artifact().commits[0]!,
        parent: env.base,
        changes: [{ path: "owned.txt", before: entry("old"), after: entry("new") }]
      }]
    }
    await writeFile(join(env.repoDirectory, "owned.txt"), "other agent work")
    await assert.rejects(prepareCloudHandoff(value, env.options), /shared working-copy edits/)
    const artifactPath = await retainCloudHandoff(value, env.options)
    await writeFile(join(artifactPath, "..", "prepare.py"), "old host code")
    await writeFile(join(artifactPath, "..", "symlink-reader.txt"), "/old/package/path")
    await writeFile(join(env.repoDirectory, "owned.txt"), "old")
    const prepared = await prepareCloudHandoff(value, env.options)
    assert.equal(await env.jj("file", "show", "-r", prepared.commit, "owned.txt"), "new")
    assert.equal(await env.jj("log", "--no-graph", "-r", "main", "-T", "commit_id"), env.base)
    assert.equal(JSON.parse(await readFile(prepared.receiptPath, "utf8")).status, "prepared")
    const archives = (await readdir(join(artifactPath, ".."))).filter((path) => /^recovery-from-.*\.json$/.test(path))
    assert.equal(archives.length, 1)
    const refused = JSON.parse(await readFile(join(artifactPath, "..", archives[0]!), "utf8"))
    assert.equal(refused.status, "failed")
    assert.deepEqual(refused.commits, [])
    assert.match(refused.error, /shared working-copy edits/)
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})

for (
  const attribution of [
    { tool: "codex", model: "gpt-6.1-sol", trailer: "Co-Authored-By: GPT-6.1 Sol <noreply@openai.com>" },
    { tool: "claude", model: "claude-opus-5-5", trailer: "Co-Authored-By: Claude Opus <noreply@anthropic.com>" }
  ] as const
) {
  test(`real jj handoff uses trusted ${attribution.tool} assignment and retains attribution for replay`, async () => {
    const env = await fixture()
    try {
      const { tool, model, trailer } = attribution
      const identity = { tool, model }
      const value = {
        ...artifact(),
        base: env.base,
        commits: [{
          ...artifact().commits[0]!,
          parent: env.base,
          message:
            "fix: trusted attribution\n\nCo-Authored-By: GPT-6.1 Sol <noreply@openai.com>\nCo-Authored-By: GPT-6.1 Sol <noreply@openai.com>",
          changes: [{ path: "owned.txt", before: entry("old"), after: entry("new") }]
        }]
      }
      const options = { ...env.options, attribution: identity }
      const prepared = await prepareCloudHandoff(value, options)
      const description = await env.jj("log", "--no-graph", "-r", prepared.commit, "-T", "description")
      assert.equal(description.split("\n").filter((line) => line === trailer).length, 1)
      if (tool === "claude") assert.doesNotMatch(description, /GPT-6\.1 Sol/)
      const attributionPath = join(prepared.artifactPath, "..", "attribution.json")
      assert.deepEqual(JSON.parse(await readFile(attributionPath, "utf8")), identity)
      assert.equal((await lstat(attributionPath)).mode & 0o777, 0o600)
      assert.deepEqual((await prepareCloudHandoff(value, options)).commits, prepared.commits)
      let calls = 0
      await assert.rejects(
        prepareCloudHandoff(value, {
          ...options,
          attribution: tool === "codex"
            ? { tool: "claude", model: "claude-opus-5-5" }
            : { tool: "codex", model: "gpt-6.1-sol" },
          run: async () => {
            calls++
          }
        }),
        /attribution.*mismatch|identity mismatch/
      )
      assert.equal(calls, 0)
      assert.deepEqual(JSON.parse(await readFile(attributionPath, "utf8")), identity)
    } finally {
      await rm(env.directory, { recursive: true, force: true })
    }
  })
}

test("real jj handoff without an assignment preserves guest description without inventing attribution", async () => {
  const env = await fixture()
  try {
    const message = "fix: guest message\n\nCo-Authored-By: Guest <guest@example.test>"
    const value = {
      ...artifact(),
      base: env.base,
      commits: [{
        ...artifact().commits[0]!,
        parent: env.base,
        message,
        changes: [{ path: "owned.txt", before: entry("old"), after: entry("new") }]
      }]
    }
    const { attribution: _attribution, ...options } = env.options
    const prepared = await prepareCloudHandoff(value, options)
    assert.equal(await env.jj("log", "--no-graph", "-r", prepared.commit, "-T", "description"), message + "\n")
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})

for (
  const attribution of [
    { tool: "codex", model: "claude-opus-5-5" },
    { tool: "claude", model: "gpt-6.1-sol" },
    { tool: "unknown", model: "gpt-6.1-sol" },
    { tool: "codex", model: "gpt-6.1-sol\nCo-Authored-By: forged" }
  ]
) {
  test(`Cloud handoff refuses invalid assignment ${JSON.stringify(attribution)} before runner`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "handoff-attribution-"))
    try {
      let calls = 0
      await assert.rejects(
        prepareCloudHandoff(artifact(), {
          repository: "smithersai/smithers",
          repoDirectory: directory,
          artifactDirectory: join(directory, "receipts"),
          attribution: attribution as NonNullable<Parameters<typeof prepareCloudHandoff>[1]["attribution"]>,
          run: async () => {
            calls++
          }
        }),
        /attribution|assignment|model|tool/
      )
      assert.equal(calls, 0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test("real jj handoff replaces CRLF false Sol attribution with the trusted Opus assignment", async () => {
  const env = await fixture()
  try {
    const value = {
      ...artifact(),
      base: env.base,
      commits: [{
        ...artifact().commits[0]!,
        parent: env.base,
        message: "fix: CRLF guest\r\n\r\nCo-Authored-By: GPT-6.1 Sol <noreply@openai.com>\r\n\r\nGuest detail survives",
        changes: [{ path: "owned.txt", before: entry("old"), after: entry("new") }]
      }]
    }
    const prepared = await prepareCloudHandoff(value, {
      ...env.options,
      attribution: { tool: "claude", model: "claude-opus-5-5" }
    })
    const description = await env.jj("log", "--no-graph", "-r", prepared.commit, "-T", "description")
    assert.equal(
      description.split("\n").filter((line) => line === "Co-Authored-By: Claude Opus <noreply@anthropic.com>").length,
      1
    )
    assert.doesNotMatch(description, /GPT-6\.1 Sol/)
    assert.match(description, /Guest detail survives/)
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})

test("Cloud recovery consumer reads successive private receipts and rejected writes preserve the last evidence", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "handoff-recovery-")))
  try {
    const directory = join(root, "receipts", "run", "workspace")
    const first = { workspace: "cloud-workspace", status: "export-failed", stage: "ssh-grant" }
    const second = { ...first, status: "exported", artifactPath: "retained-artifact.json" }
    await retainCloudRecovery(directory, first)
    const path = join(directory, "recovery.json")
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), first)
    assert.equal((await lstat(directory)).mode & 0o777, 0o700)
    assert.equal((await lstat(path)).mode & 0o777, 0o600)
    await retainCloudRecovery(directory, second)
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), second)
    await assert.rejects(retainCloudRecovery(directory, { diagnostic: "x".repeat(16 * 1024) }), /limit/)
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), second)
    await assert.rejects(retainCloudRecovery("relative/receipts", first), /absolute/)
    const link = join(root, "linked-receipts")
    await symlink(directory, link)
    await assert.rejects(retainCloudRecovery(link, first), /symlink/)
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), second)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const parentShape of ["stale", "divergent"] as const) {
  test(`real jj handoff anchors artifact base with ${parentShape} shared parent and preserves existing graph`, async () => {
    const env = await fixture()
    try {
      const script = join(env.directory, "shared-graph.sh")
      await writeFile(
        script,
        `#!/bin/sh
set -eu
cd ${shellQuote(env.repoDirectory)}
printf upstream > upstream.txt
jj --config user.name=Fixture --config user.email=fixture@example.test commit upstream.txt -m upstream
jj bookmark set main -r @-
jj rebase -r @ -d ${shellQuote(env.base)}
${
          parentShape === "divergent"
            ? "printf prepared > prepared.txt\njj --config user.name=Fixture --config user.email=fixture@example.test commit prepared.txt -m 'another prepared change'\njj bookmark set other-prepared -r @-"
            : "jj bookmark set other-prepared -r @-"
        }
printf descendant > descendant.txt
jj --config user.name=Fixture --config user.email=fixture@example.test commit descendant.txt -m 'protected descendant'
jj bookmark set protected-descendant -r @-
jj describe -m 'shared agent description'
printf shared > wip.txt
printf untracked > other-agent.txt
jj st
jj bookmark set shared-wip -r @
`
      )
      await chmod(script, 0o700)
      await exec("python3", [env.lockPath, "smithers", script])
      const artifactBase = await env.jj("log", "--no-graph", "-r", "main", "-T", "commit_id")
      const snapshot = async () => ({
        working: await env.jj("log", "--no-graph", "-r", "@", "-T", "change_id"),
        bookmarkedWip: await env.jj(
          "log",
          "--no-graph",
          "-r",
          "shared-wip",
          "-T",
          "change_id ++ description"
        ),
        parent: await env.jj("log", "--no-graph", "-r", "@-", "-T", "commit_id"),
        bookmarks: await env.jj(
          "bookmark",
          "list",
          "main",
          "other-prepared",
          "protected-descendant",
          "-T",
          "name ++ \" \" ++ normal_target.commit_id() ++ \"\\n\""
        ),
        graph: await env.jj(
          "log",
          "--no-graph",
          "-r",
          "::protected-descendant",
          "-T",
          "commit_id ++ \" \" ++ parents.map(|p| p.commit_id()).join(\" \") ++ \"\\n\""
        ),
        description: await env.jj("log", "--no-graph", "-r", "@", "-T", "description")
      })
      const before = await snapshot()
      const beforeWorking = await env.jj("log", "--no-graph", "-r", "@", "-T", "commit_id")
      const value = {
        ...artifact(),
        base: artifactBase,
        commits: [{
          ...artifact().commits[0]!,
          parent: artifactBase,
          changes: [{ path: "owned.txt", before: entry("old"), after: entry("new") }]
        }]
      }
      const prepared = await prepareCloudHandoff(value, env.options)
      assert.equal(
        await env.jj("log", "--no-graph", "-r", prepared.commit, "-T", "parents.map(|p| p.commit_id()).join(\"\")"),
        artifactBase
      )
      assert.equal(await env.jj("file", "show", "-r", prepared.commit, "owned.txt"), "new")
      assert.equal(await env.jj("file", "show", "-r", prepared.commit, "upstream.txt"), "upstream")
      assert.equal(
        await env.jj("file", "list", "-r", prepared.commit, "prepared.txt", "descendant.txt", "other-agent.txt"),
        ""
      )
      assert.deepEqual(await snapshot(), before)
      assert.equal(await env.jj("diff", "--from", beforeWorking, "--to", "@", "--name-only"), "")
      assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
      assert.equal(await readFile(join(env.repoDirectory, "wip.txt"), "utf8"), "shared")
      assert.equal(await readFile(join(env.repoDirectory, "other-agent.txt"), "utf8"), "untracked")
      assert.equal(await readFile(join(env.repoDirectory, "descendant.txt"), "utf8"), "descendant")
      await assert.rejects(readFile(join(env.repoDirectory, "upstream.txt")), { code: "ENOENT" })
      const replay = await prepareCloudHandoff(value, env.options)
      assert.deepEqual(replay.commits, prepared.commits)
      assert.deepEqual(await snapshot(), before)
    } finally {
      await rm(env.directory, { recursive: true, force: true })
    }
  })
}

test("real jj handoff refuses shared working revision descendants without rewriting protected work", async () => {
  const env = await fixture()
  try {
    const script = join(env.directory, "descendant.sh")
    await writeFile(
      script,
      `#!/bin/sh
set -eu
cd ${shellQuote(env.repoDirectory)}
printf descendant > descendant.txt
jj --config user.name=Fixture --config user.email=fixture@example.test commit descendant.txt -m 'another agent parent'
jj bookmark set protected-child -r @
jj edit -r @-
jj st
`
    )
    await chmod(script, 0o700)
    await exec("python3", [env.lockPath, "smithers", script])
    const graph = await env.jj(
      "log",
      "--no-graph",
      "-r",
      "::protected-child",
      "-T",
      "commit_id ++ \" \" ++ parents.map(|p| p.commit_id()).join(\" \") ++ \"\\n\""
    )
    const value = {
      ...artifact(),
      base: env.base,
      commits: [{
        ...artifact().commits[0]!,
        parent: env.base,
        changes: [{ path: "owned.txt", before: entry("old"), after: entry("new") }]
      }]
    }
    await assert.rejects(prepareCloudHandoff(value, env.options), /descendant/)
    assert.equal(
      await env.jj(
        "log",
        "--no-graph",
        "-r",
        "::protected-child",
        "-T",
        "commit_id ++ \" \" ++ parents.map(|p| p.commit_id()).join(\" \") ++ \"\\n\""
      ),
      graph
    )
    assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
    assert.equal(await readFile(join(env.repoDirectory, "descendant.txt"), "utf8"), "descendant")
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})

test("real jj handoff reconstructs a later commit reverting an owned path to the artifact base", async () => {
  const env = await fixture()
  try {
    await writeFile(join(env.repoDirectory, "wip.txt"), "shared edit")
    const value = {
      ...artifact(),
      base: env.base,
      commits: [
        {
          sha: source,
          parent: env.base,
          message: "fix: first",
          changes: [{ path: "owned.txt", before: entry("old"), after: entry("first") }]
        },
        {
          sha: "d".repeat(40),
          parent: source,
          message: "fix: revert",
          changes: [{ path: "owned.txt", before: entry("first"), after: entry("old") }]
        }
      ]
    }
    const result = await prepareCloudHandoff(value, env.options)
    assert.equal(result.commits.length, 2)
    assert.equal(await env.jj("file", "show", "-r", result.commits[0]!.local, "owned.txt"), "first")
    assert.equal(await env.jj("file", "show", "-r", result.commit, "owned.txt"), "old")
    assert.equal(
      await env.jj("diff", "--from", result.commits[0]!.local, "--to", result.commit, "--name-only"),
      "owned.txt\n"
    )
    assert.equal(
      await env.jj("log", "--no-graph", "-r", result.commit, "-T", "parents.map(|p| p.commit_id()).join(\"\")"),
      result.commits[0]!.local
    )
    assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
    assert.equal(await readFile(join(env.repoDirectory, "wip.txt"), "utf8"), "shared edit")
    assert.deepEqual((await prepareCloudHandoff(value, env.options)).commits, result.commits)
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})

test("real jj post-extraction failure retains pending recovery and never duplicates a commit on replay", async () => {
  const env = await fixture()
  try {
    const actualJj = (await exec("which", ["jj"])).stdout.trim()
    const shim = join(env.directory, "jj")
    const count = join(env.directory, "extraction-count")
    await writeFile(
      shim,
      `#!/usr/bin/env python3
import os,pathlib,subprocess,sys
os.environ['PATH']=os.environ['PATH'].split(':',1)[1]
if 'split' in sys.argv[1:]:
 p=pathlib.Path(${JSON.stringify(count)});n=int(p.read_text())+1 if p.exists() else 1;p.write_text(str(n))
 subprocess.run([${JSON.stringify(actualJj)},*sys.argv[1:]],check=True)
 sys.exit(42)
os.execv(${JSON.stringify(actualJj)},[${JSON.stringify(actualJj)},*sys.argv[1:]])
`
    )
    await chmod(shim, 0o700)
    const value = {
      ...artifact(),
      base: env.base,
      commits: [{
        ...artifact().commits[0]!,
        parent: env.base,
        changes: [{ path: "owned.txt", before: entry("old"), after: entry("new") }]
      }]
    }
    const options = {
      ...env.options,
      run: async (command: string, args: ReadonlyArray<string>) => {
        await exec(command, [...args], { env: { ...process.env, PATH: env.directory + ":" + process.env.PATH } })
      }
    }
    await assert.rejects(prepareCloudHandoff(value, options), /jj command failed/)
    const artifactPath = await retainCloudHandoff(value, env.options)
    const receipt = JSON.parse(await readFile(join(artifactPath, "..", "receipt.json"), "utf8"))
    assert.equal(receipt.status, "failed")
    assert.deepEqual(receipt.commits, [])
    assert.equal(receipt.pending.source, source)
    assert.equal(receipt.pending.parent, env.base)
    const extracted = await env.jj("log", "--no-graph", "-r", `children(${env.base}) ~ @`, "-T", "commit_id")
    assert.equal(extracted.length, 40)
    assert.equal(await env.jj("file", "show", "-r", extracted, "owned.txt"), "new")
    assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
    await assert.rejects(prepareCloudHandoff(value, options), /partial preparation retained/)
    assert.equal(await readFile(count, "utf8"), "1")
    assert.equal(await env.jj("log", "--no-graph", "-r", `children(${env.base}) ~ @`, "-T", "commit_id"), extracted)
    assert.equal(await env.jj("log", "--no-graph", "-r", "main", "-T", "commit_id"), env.base)
    const recoveryOptions = { ...options, recoverPartial: true }
    const recovered = await prepareCloudHandoff(value, recoveryOptions)
    assert.equal(recovered.commit, extracted)
    assert.deepEqual(recovered.commits, [{ source, local: extracted }])
    assert.equal(await readFile(count, "utf8"), "1")
    assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})

test("real jj handoff refuses an artifact base outside main ancestry while retaining shared work", async () => {
  const env = await fixture()
  try {
    const script = join(env.directory, "unanchored-main.sh")
    await writeFile(
      script,
      `#!/bin/sh
set -eu
cd ${shellQuote(env.repoDirectory)}
jj bookmark set main -r 'root()' --allow-backwards
printf shared > wip.txt
jj st
`
    )
    await chmod(script, 0o700)
    await exec("python3", [env.lockPath, "smithers", script])
    const before = await env.jj("log", "--no-graph", "-r", "@", "-T", "commit_id")
    const value = {
      ...artifact(),
      base: env.base,
      commits: [{
        ...artifact().commits[0]!,
        parent: env.base,
        changes: [{ path: "owned.txt", before: entry("old"), after: entry("new") }]
      }]
    }
    await assert.rejects(prepareCloudHandoff(value, env.options), /base is not an ancestor of current main/)
    assert.equal(await env.jj("log", "--no-graph", "-r", "@", "-T", "commit_id"), before)
    assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
    assert.equal(await readFile(join(env.repoDirectory, "wip.txt"), "utf8"), "shared")
    const artifactPath = await retainCloudHandoff(value, env.options)
    assert.deepEqual(JSON.parse(await readFile(artifactPath, "utf8")), value)
    const receipt = JSON.parse(await readFile(join(artifactPath, "..", "receipt.json"), "utf8"))
    assert.equal(receipt.status, "failed")
    assert.match(receipt.error, /base is not an ancestor of current main/)
    const retainedDirectory = join(artifactPath, "..")
    const diagnostics = (await readdir(retainedDirectory)).filter((path) => /^runner-error-.*\.json$/.test(path))
    assert.equal(diagnostics.length, 1)
    const diagnosticPath = join(retainedDirectory, diagnostics[0]!)
    assert.equal((await lstat(diagnosticPath)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(diagnosticPath, "utf8")), {
      status: "failed",
      runnerError: "Cloud handoff lock runner failed",
      receiptPath: join(retainedDirectory, "receipt.json")
    })
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})

test("real jj handoff preserves mode-only changes and ordered file/symlink replacement without changing the shared file", async () => {
  const env = await fixture()
  try {
    const executable = { ...entry("old"), mode: "755" }
    const link = { type: "symlink", mode: "120000", data: Buffer.from("wip.txt\n").toString("base64") }
    const value = {
      ...artifact(),
      base: env.base,
      commits: [
        {
          sha: source,
          parent: env.base,
          message: "fix: mode",
          changes: [{ path: "owned.txt", before: entry("old"), after: executable }]
        },
        {
          sha: "d".repeat(40),
          parent: source,
          message: "fix: link",
          changes: [{ path: "owned.txt", before: executable, after: link }]
        },
        {
          sha: "e".repeat(40),
          parent: "d".repeat(40),
          message: "fix: file",
          changes: [{ path: "owned.txt", before: link, after: { ...entry("final"), mode: "755" } }]
        }
      ]
    }
    const prepared = await prepareCloudHandoff(value, env.options)
    assert.equal(prepared.commits.length, 3)
    assert.equal(
      await env.jj(
        "file",
        "list",
        "-r",
        prepared.commits[0]!.local,
        "-T",
        "file_type ++ \" \" ++ executable",
        "owned.txt"
      ),
      "file true"
    )
    assert.equal(await env.jj("file", "show", "-r", prepared.commits[0]!.local, "owned.txt"), "old")
    assert.equal(
      await env.jj("file", "list", "-r", prepared.commits[1]!.local, "-T", "file_type", "owned.txt"),
      "symlink"
    )
    assert.equal(
      Buffer.from(
        symlinkBytesFromDiff(
          Buffer.from(
            await env.jj("diff", "--git", "--from", "root()", "--to", prepared.commits[1]!.local, "owned.txt")
          )
        )
      ).toString(),
      "wip.txt\n"
    )
    assert.equal(
      await env.jj("file", "list", "-r", prepared.commit, "-T", "file_type ++ \" \" ++ executable", "owned.txt"),
      "file true"
    )
    assert.equal(await env.jj("file", "show", "-r", prepared.commit, "owned.txt"), "final")
    assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
    assert.equal((await lstat(join(env.repoDirectory, "owned.txt"))).mode & 0o111, 0)
    assert.equal(await env.jj("log", "--no-graph", "-r", "@-", "-T", "commit_id"), env.base)
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})

for (const externalOwnedEdit of [false, true]) {
  test(`real jj seed crash retains rollback intent and ${externalOwnedEdit ? "refuses an external owned edit" : "restores shared bytes before retry"}`, async () => {
    const env = await fixture()
    try {
      const actualJj = (await exec("which", ["jj"])).stdout.trim()
      const shim = join(env.directory, "jj")
      const killed = join(env.directory, "seed-process-killed")
      await writeFile(
        shim,
        `#!/usr/bin/env python3
import os,pathlib,signal,subprocess,sys
os.environ['PATH']=os.environ['PATH'].split(':',1)[1]
if 'track' in sys.argv[1:] and not pathlib.Path(${JSON.stringify(killed)}).exists():
 subprocess.run([${JSON.stringify(actualJj)},*sys.argv[1:]],check=True)
 pathlib.Path(${JSON.stringify(killed)}).write_text('killed after tracking seeded bytes')
 os.kill(os.getppid(),signal.SIGKILL)
 sys.exit(42)
os.execv(${JSON.stringify(actualJj)},[${JSON.stringify(actualJj)},*sys.argv[1:]])
`
      )
      await chmod(shim, 0o700)
      await writeFile(join(env.repoDirectory, "wip.txt"), "another agent WIP")
      await writeFile(join(env.repoDirectory, "untracked.txt"), "another agent new file")
      const value = {
        ...artifact(),
        base: env.base,
        commits: [{
          ...artifact().commits[0]!,
          parent: env.base,
          changes: [{ path: "owned.txt", before: entry("old"), after: entry("new") }]
        }]
      }
      const options = {
        ...env.options,
        run: async (command: string, args: ReadonlyArray<string>) => {
          await exec(command, [...args], { env: { ...process.env, PATH: env.directory + ":" + process.env.PATH } })
        }
      }
      await assert.rejects(prepareCloudHandoff(value, options))
      assert.equal(await readFile(killed, "utf8"), "killed after tracking seeded bytes")
      assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "new")
      assert.equal(await readFile(join(env.repoDirectory, "wip.txt"), "utf8"), "another agent WIP")
      const artifactPath = await retainCloudHandoff(value, env.options)
      const receiptPath = join(artifactPath, "..", "receipt.json")
      const crashed = JSON.parse(await readFile(receiptPath, "utf8"))
      assert.ok(crashed.seeding, "durable seeding intent must exist before any shared path write")
      assert.deepEqual(crashed.commits, [])
      assert.equal(await env.jj("log", "--no-graph", "-r", "@-", "-T", "commit_id"), env.base)
      if (externalOwnedEdit) {
        await writeFile(join(env.repoDirectory, "owned.txt"), "external agent edit after crash")
        await assert.rejects(prepareCloudHandoff(value, options), /rollback|working-copy changed|seed/)
        assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "external agent edit after crash")
        assert.ok(
          JSON.parse(await readFile(receiptPath, "utf8")).seeding,
          "refused rollback must retain its durable intent"
        )
      } else {
        const recovered = await prepareCloudHandoff(value, options)
        assert.equal(await env.jj("file", "show", "-r", recovered.commit, "owned.txt"), "new")
        assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
        assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).status, "prepared")
        assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).seeding, undefined)
      }
      assert.equal(await readFile(join(env.repoDirectory, "wip.txt"), "utf8"), "another agent WIP")
      assert.equal(await readFile(join(env.repoDirectory, "untracked.txt"), "utf8"), "another agent new file")
      assert.equal(await env.jj("log", "--no-graph", "-r", "main", "-T", "commit_id"), env.base)
    } finally {
      await rm(env.directory, { recursive: true, force: true })
    }
  })
}

test("real jj post-split failure restores retained seeded bytes before refusing partial replay", async () => {
  const env = await fixture()
  try {
    const actualJj = (await exec("which", ["jj"])).stdout.trim()
    const shim = join(env.directory, "jj")
    const count = join(env.directory, "split-count")
    await writeFile(
      shim,
      `#!/usr/bin/env python3
import os,pathlib,signal,subprocess,sys
os.environ['PATH']=os.environ['PATH'].split(':',1)[1]
if 'split' in sys.argv[1:]:
 p=pathlib.Path(${JSON.stringify(count)});n=int(p.read_text())+1 if p.exists() else 1;p.write_text(str(n))
 subprocess.run([${JSON.stringify(actualJj)},*sys.argv[1:]],check=True)
 pathlib.Path(${JSON.stringify(join(env.repoDirectory, "owned.txt"))}).write_text('new')
 os.kill(os.getppid(),signal.SIGKILL)
 sys.exit(42)
os.execv(${JSON.stringify(actualJj)},[${JSON.stringify(actualJj)},*sys.argv[1:]])
`
    )
    await chmod(shim, 0o700)
    await writeFile(join(env.repoDirectory, "wip.txt"), "other agent during extraction")
    const value = {
      ...artifact(),
      base: env.base,
      commits: [{
        ...artifact().commits[0]!,
        parent: env.base,
        changes: [{ path: "owned.txt", before: entry("old"), after: entry("new") }]
      }]
    }
    const options = {
      ...env.options,
      run: async (command: string, args: ReadonlyArray<string>) => {
        await exec(command, [...args], { env: { ...process.env, PATH: env.directory + ":" + process.env.PATH } })
      }
    }
    await assert.rejects(prepareCloudHandoff(value, options))
    const artifactPath = await retainCloudHandoff(value, env.options)
    const receiptPath = join(artifactPath, "..", "receipt.json")
    const failed = JSON.parse(await readFile(receiptPath, "utf8"))
    assert.equal(failed.pending.source, source)
    assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "new")
    assert.ok(failed.seeding, "pending extraction retains rollback intent until shared bytes are restored")
    const extracted = await env.jj("log", "--no-graph", "-r", `children(${env.base}) ~ @`, "-T", "commit_id")
    assert.equal(extracted.length, 40)
    await assert.rejects(prepareCloudHandoff(value, options), /partial preparation retained/)
    assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
    assert.equal(await readFile(join(env.repoDirectory, "wip.txt"), "utf8"), "other agent during extraction")
    assert.equal(await readFile(count, "utf8"), "1")
    assert.equal(await env.jj("log", "--no-graph", "-r", `children(${env.base}) ~ @`, "-T", "commit_id"), extracted)
    const archives = (await readdir(join(artifactPath, ".."))).filter((path) => /^recovery-from-.*\.json$/.test(path))
    const archived = await Promise.all(
      archives.map(async (path) => JSON.parse(await readFile(join(artifactPath, "..", path), "utf8")))
    )
    assert.ok(
      archived.some((receipt) => JSON.stringify(receipt) === JSON.stringify(failed)),
      "locked replay archives the original pending and seed evidence before restoring shared bytes"
    )
    const recovered = JSON.parse(await readFile(receiptPath, "utf8"))
    assert.ok(recovered.pending, "partial extraction mapping remains recoverable after rollback")
    assert.equal(recovered.seeding, undefined)
    assert.equal(await env.jj("log", "--no-graph", "-r", "main", "-T", "commit_id"), env.base)
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})

for (const status of ["preparing", "prepared"] as const) {
  test(`Cloud runner failure preserves ${status} receipt bytes and another attempt's recovery intent`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "handoff-receipt-race-"))
    try {
      let retainedDirectory = ""
      const snapshot = JSON.stringify(
        status === "preparing"
          ? {
            status,
            commits: [],
            seeding: { index: 0, source, shared: "e".repeat(32) },
            pending: { source, parent: base, children: [], local: "c".repeat(40) }
          }
          : { status, commits: [{ source, local: "c".repeat(40) }] },
        null,
        2
      ) + "\n"
      await assert.rejects(
        prepareCloudHandoff(artifact(), {
          repository: "smithersai/smithers",
          repoDirectory: directory,
          artifactDirectory: join(directory, "receipts"),
          run: async (_command, args) => {
            retainedDirectory = join(args[2]!, "..")
            // Emulate the next locked attempt persisting its intent before the
            // previous attempt's runner error reaches its unlocked catch.
            await writeFile(join(retainedDirectory, "receipt.json"), snapshot)
            throw new Error("previous lock runner failed")
          }
        }),
        /previous lock runner failed/
      )
      assert.equal(await readFile(join(retainedDirectory, "receipt.json"), "utf8"), snapshot)
      const diagnostics = (await readdir(retainedDirectory)).filter((path) => /^runner-error-.*\.json$/.test(path))
      assert.equal(diagnostics.length, 1)
      assert.equal((await lstat(join(retainedDirectory, diagnostics[0]!))).mode & 0o777, 0o600)
      const diagnostic = JSON.parse(await readFile(join(retainedDirectory, diagnostics[0]!), "utf8"))
      assert.equal(diagnostic.status, "failed")
      assert.equal(diagnostic.receiptPath, join(retainedDirectory, "receipt.json"))
      assert.equal(await readFile(join(retainedDirectory, "receipt.json"), "utf8"), snapshot)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

for (const corruptPending of [false, "owned", "extra", "hidden"] as const) {
  test(`real jj explicit partial recovery ${corruptPending ? `refuses a retained candidate with ${corruptPending === "owned" ? "incorrect owned bytes" : corruptPending === "hidden" ? "a hidden rewritten predecessor" : "an unrelated changed path"}` : "qualifies the existing candidate after unrelated shared changes"}`, async () => {
    const env = await fixture()
    try {
      const actualJj = (await exec("which", ["jj"])).stdout.trim()
      const shim = join(env.directory, "jj")
      const count = join(env.directory, "partial-split-count")
      const mutated = join(env.directory, "partial-unrelated-mutated")
      await writeFile(
        shim,
        `#!/usr/bin/env python3
import os,pathlib,subprocess,sys
os.environ['PATH']=os.environ['PATH'].split(':',1)[1]
if 'split' in sys.argv[1:]:
 p=pathlib.Path(${JSON.stringify(count)});n=int(p.read_text())+1 if p.exists() else 1;p.write_text(str(n))
if 'diffedit' in sys.argv[1:] and not pathlib.Path(${JSON.stringify(mutated)}).exists():
 subprocess.run([${JSON.stringify(actualJj)},*sys.argv[1:]],check=True)
 pathlib.Path(${JSON.stringify(join(env.repoDirectory, "wip.txt"))}).write_text('concurrent unrelated WIP')
 pathlib.Path(${JSON.stringify(mutated)}).write_text('mutated after private diffedit')
 subprocess.run([${JSON.stringify(actualJj)},'st'],check=True)
 sys.exit(0)
os.execv(${JSON.stringify(actualJj)},[${JSON.stringify(actualJj)},*sys.argv[1:]])
`
      )
      await chmod(shim, 0o700)
      const value = {
        ...artifact(),
        base: env.base,
        commits: [{
          ...artifact().commits[0]!,
          parent: env.base,
          changes: [{ path: "owned.txt", before: entry("old"), after: entry("new") }]
        }]
      }
      const options = {
        ...env.options,
        run: async (command: string, args: ReadonlyArray<string>) => {
          await exec(command, [...args], { env: { ...process.env, PATH: env.directory + ":" + process.env.PATH } })
        }
      }
      await assert.rejects(prepareCloudHandoff(value, options), /shared working-copy tree changed/)
      const artifactPath = await retainCloudHandoff(value, env.options)
      const receiptPath = join(artifactPath, "..", "receipt.json")
      const failedBytes = await readFile(receiptPath, "utf8")
      const failed = JSON.parse(failedBytes)
      assert.equal(failed.pending.source, source)
      const candidate = failed.pending.local
      assert.equal(await env.jj("file", "show", "-r", candidate, "owned.txt"), "new")
      assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
      await assert.rejects(prepareCloudHandoff(value, options), /partial preparation retained/)
      assert.equal(
        await readFile(receiptPath, "utf8"),
        failedBytes,
        "default partial refusal preserves original failure evidence byte-for-byte"
      )
      assert.equal(await readFile(count, "utf8"), "1")
      const script = join(env.directory, "later-shared-changes.sh")
      await writeFile(
        script,
        `#!/bin/sh
set -eu
cd ${shellQuote(env.repoDirectory)}
jj --config user.name=Fixture --config user.email=fixture@example.test commit wip.txt -m 'later unrelated preparation'
jj bookmark set later-prepared -r @-
jj bookmark set protected-child -r @
jj edit -r @-
printf later > untracked.txt
jj st
`
      )
      await chmod(script, 0o700)
      await exec("python3", [env.lockPath, "smithers", script])
      const snapshot = async () => ({
        graph: await env.jj(
          "log",
          "--no-graph",
          "-r",
          "::protected-child",
          "-T",
          "commit_id ++ \" \" ++ parents.map(|p| p.commit_id()).join(\" \") ++ \"\\n\""
        ),
        bookmarks: await env.jj("bookmark", "list", "-T", "name ++ \" \" ++ normal_target.commit_id() ++ \"\\n\""),
        working: await env.jj("log", "--no-graph", "-r", "@", "-T", "commit_id")
      })
      const before = await snapshot()
      const recoveryOptions = { ...options, recoverPartial: true }
      if (corruptPending === "hidden") {
        const candidateChange = await env.jj("log", "--no-graph", "-r", candidate, "-T", "change_id")
        const rewrite = join(env.directory, "rewrite-candidate.sh")
        await writeFile(
          rewrite,
          `#!/bin/sh
set -eu
cd ${shellQuote(env.repoDirectory)}
jj --ignore-working-copy metaedit --author 'Rewritten <rewritten@example.test>' ${shellQuote(candidate)}
`
        )
        await chmod(rewrite, 0o700)
        await exec("python3", [env.lockPath, "smithers", rewrite])
        const successor = await env.jj("log", "--no-graph", "-r", candidateChange, "-T", "commit_id")
        assert.notEqual(successor, candidate)
        assert.equal(await env.jj("diff", "--from", candidate, "--to", successor, "--name-only"), "")
        assert.equal(await env.jj("log", "--no-graph", "-r", `${candidate} & ::visible_heads()`, "-T", "commit_id"), "")
        await assert.rejects(prepareCloudHandoff(value, recoveryOptions), /hidden|visible|rewritten|diverg/)
        assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).pending.local, candidate)
      } else if (corruptPending) {
        const candidateChange = await env.jj("log", "--no-graph", "-r", candidate, "-T", "change_id")
        const editor = join(env.directory, "corrupt-candidate.py")
        await writeFile(
          editor,
          `#!/usr/bin/env python3
import pathlib,sys
(pathlib.Path(sys.argv[2])/${
            JSON.stringify(corruptPending === "owned" ? "owned.txt" : "wip.txt")
          }).write_text('corrupt candidate bytes')
`
        )
        await chmod(editor, 0o700)
        const config = join(env.directory, "corrupt-candidate.toml")
        await writeFile(
          config,
          "[merge-tools.corrupt]\nprogram = " + JSON.stringify(editor) + "\nedit-args = [\"$left\", \"$right\"]\n"
        )
        const mutate = join(env.directory, "corrupt-candidate.sh")
        await writeFile(
          mutate,
          `#!/bin/sh
set -eu
cd ${shellQuote(env.repoDirectory)}
jj --ignore-working-copy --config-file ${shellQuote(config)} diffedit --from 'root()' --to ${
            shellQuote(candidate)
          } --tool corrupt
`
        )
        await chmod(mutate, 0o700)
        await exec("python3", [env.lockPath, "smithers", mutate])
        const corrupt = await env.jj("log", "--no-graph", "-r", candidateChange, "-T", "commit_id")
        assert.equal(
          await env.jj("file", "show", "-r", corrupt, corruptPending === "owned" ? "owned.txt" : "wip.txt"),
          "corrupt candidate bytes"
        )
        failed.pending.local = corrupt
        await writeFile(receiptPath, JSON.stringify(failed))
        await assert.rejects(
          prepareCloudHandoff(value, recoveryOptions),
          /pending|tree|parent|mapping|candidate|partial|changes/
        )
        assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).pending.local, corrupt)
      } else {
        const recovered = await prepareCloudHandoff(value, recoveryOptions)
        assert.equal(recovered.commit, candidate)
        assert.deepEqual(recovered.commits, [{ source, local: candidate }])
        assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).status, "prepared")
        assert.deepEqual((await prepareCloudHandoff(value, recoveryOptions)).commits, recovered.commits)
      }
      assert.deepEqual(await snapshot(), before)
      assert.equal(await readFile(count, "utf8"), "1")
      assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
      assert.equal(await readFile(join(env.repoDirectory, "wip.txt"), "utf8"), "concurrent unrelated WIP")
      assert.equal(await readFile(join(env.repoDirectory, "untracked.txt"), "utf8"), "later")
      assert.equal(await env.jj("log", "--no-graph", "-r", "main", "-T", "commit_id"), env.base)
    } finally {
      await rm(env.directory, { recursive: true, force: true })
    }
  })
}

test("real jj prepared receipt replay refuses its hidden predecessor after a metadata-only rewrite", async () => {
  const env = await fixture()
  try {
    const value = {
      ...artifact(),
      base: env.base,
      commits: [{
        ...artifact().commits[0]!,
        parent: env.base,
        changes: [{ path: "owned.txt", before: entry("old"), after: entry("new") }]
      }]
    }
    const prepared = await prepareCloudHandoff(value, env.options)
    const change = await env.jj("log", "--no-graph", "-r", prepared.commit, "-T", "change_id")
    const rewrite = join(env.directory, "rewrite-prepared.sh")
    await writeFile(
      rewrite,
      `#!/bin/sh
set -eu
cd ${shellQuote(env.repoDirectory)}
jj --ignore-working-copy metaedit --author 'Rewritten <rewritten@example.test>' ${shellQuote(prepared.commit)}
`
    )
    await chmod(rewrite, 0o700)
    await exec("python3", [env.lockPath, "smithers", rewrite])
    const successor = await env.jj("log", "--no-graph", "-r", change, "-T", "commit_id")
    assert.notEqual(successor, prepared.commit)
    assert.equal(await env.jj("diff", "--from", prepared.commit, "--to", successor, "--name-only"), "")
    assert.equal(
      await env.jj("log", "--no-graph", "-r", `${prepared.commit} & ::visible_heads()`, "-T", "commit_id"),
      ""
    )
    const receipt = await readFile(prepared.receiptPath, "utf8")
    await assert.rejects(prepareCloudHandoff(value, env.options), /retained local commit is hidden/)
    assert.equal(await readFile(prepared.receiptPath, "utf8"), receipt)
    assert.equal(await env.jj("log", "--no-graph", "-r", change, "-T", "commit_id"), successor)
    assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "old")
    assert.equal(await env.jj("log", "--no-graph", "-r", "main", "-T", "commit_id"), env.base)
  } finally {
    await rm(env.directory, { recursive: true, force: true })
  }
})
