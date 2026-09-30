import assert from "node:assert/strict"
import { chmod, lstat, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { prepareCloudHandoff, retainCloudHandoff, validateCloudHandoff } from "../burndown/cloud-handoff.ts"

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

test("Cloud handoff retains artifact and failed receipt when lock execution fails", async () => {
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
    assert.equal(JSON.parse(await readFile(join(artifactPath, "..", "receipt.json"), "utf8")).status, "failed")
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
    assert.deepEqual(await readFile(join(env.repoDirectory, "binary.bin")), Buffer.from(bytes, "base64"))
    assert.equal((await lstat(join(env.repoDirectory, "run.sh"))).mode & 0o111, 0o111)
    assert.equal(await readlink(join(env.repoDirectory, "link")), "owned.txt")
    assert.equal(
      await env.jj("file", "list", "-r", result.commit, "-T", "file_type ++ \" \" ++ executable", "run.sh"),
      "file true"
    )
    assert.equal(await env.jj("file", "list", "-r", result.commit, "-T", "file_type", "link"), "symlink")
    await assert.rejects(readFile(join(env.repoDirectory, "gone.txt")), { code: "ENOENT" })
    const replay = await prepareCloudHandoff(value, env.options)
    assert.deepEqual(replay.commits, result.commits)
    assert.equal(await env.jj("log", "--no-graph", "-r", "@-", "-T", "commit_id"), result.commit)
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

test("real jj failure retains completed mappings and unfinished bytes, and refuses duplicate partial replay", async () => {
  const env = await fixture()
  try {
    const actualJj = (await exec("which", ["jj"])).stdout.trim()
    const shim = join(env.directory, "jj")
    const count = join(env.directory, "commit-count")
    await writeFile(
      shim,
      `#!/usr/bin/env python3\nimport os,pathlib,sys\nif 'commit' in sys.argv[1:]:\n p=pathlib.Path(${
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
    assert.equal(await env.jj("log", "--no-graph", "-r", "@-", "-T", "commit_id"), receipt.commits[0].local)
    assert.equal(await readFile(join(env.repoDirectory, "owned.txt"), "utf8"), "first")
    assert.deepEqual(JSON.parse(await readFile(join(directory, "artifact.json"), "utf8")), value)
    await assert.rejects(prepareCloudHandoff(value, options), /partial preparation retained/)
    assert.equal(await readFile(count, "utf8"), "2")
    assert.equal(await env.jj("log", "--no-graph", "-r", "main", "-T", "commit_id"), env.base)
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

test("prepared receipt replay survives a changed reconstruction script and a failing runner", async () => {
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
    const replay = await prepareCloudHandoff(artifact(), {
      ...options,
      run: async () => {
        calls++
        throw new Error("jj st failed")
      }
    })
    assert.equal(calls, 1)
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
      assert.equal(await readlink(join(env.repoDirectory, `link-${i}`)), targets[i])
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
          attribution,
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
