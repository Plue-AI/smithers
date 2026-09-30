import { Effect } from "effect"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import test from "node:test"
import { promisify } from "node:util"
import { cloudDiagnostic, exportCloudCommits, type ReadCommand } from "../cloud-export.ts"
import { validateCloudHandoff } from "../cloud-handoff.ts"

const sha = "a".repeat(40)
const parent = "b".repeat(40)
const oldOid = "1".repeat(40)
const newOid = "2".repeat(40)
const zero = "0".repeat(40)
const entry = (before = "100644", after = "100755", path = "binary", status = "M", old = oldOid, next = newOid) =>
  `:${before} ${after} ${old} ${next} ${status}\0${path}\0`
const metadataCommand = (program: string, args: ReadonlyArray<string>) => program === "git" || args[1]!.includes("git show")
const metadataBytes = (value: string) => Buffer.from(value).toString("base64")
const fake =
  (raw = entry(), data = "AQD/", metadata = `${sha}\0${parent}\0fix: binary\n`): ReadCommand => (program, args) =>
    Effect.succeed(
      metadataCommand(program, args) ? metadataBytes(metadata) : args[1]!.includes("diff-tree") ? Buffer.from(raw).toString("base64") : data
    )
const failure = async (read: ReadCommand, ids = [sha]) => {
  const exit = await Effect.runPromise(Effect.exit(exportCloudCommits("smithersai/smithers", ids, read)))
  assert.equal(exit._tag, "Failure")
  return JSON.stringify(exit)
}

test("Cloud export preserves ordered metadata, raw binary bytes and executable modes", async () => {
  const result = await Effect.runPromise(exportCloudCommits("smithersai/smithers", [sha], (program, args) => {
    if (metadataCommand(program, args)) {
      assert.equal(program, "sh")
      assert.ok(args[1]!.includes("--format=format:%H%x00%P%x00%B"))
      assert.ok(args[1]!.includes(`${sha}^{commit}`))
      return Effect.succeed(metadataBytes(`${sha}\0${parent}\0fix: binary\n\nbody\n`))
    }
    const script = args[1]!
    assert.equal(program, "sh")
    return Effect.succeed(
      script.includes("diff-tree")
        ? Buffer.from(entry()).toString("base64")
        : script.includes(oldOid)
        ? " AP8=\n"
        : "AQD/"
    )
  }))
  assert.deepEqual(result, {
    version: 1,
    repository: "smithersai/smithers",
    base: parent,
    commits: [{
      sha,
      parent,
      message: "fix: binary\n\nbody\n",
      changes: [{
        path: "binary",
        before: { type: "file", mode: "644", data: "AP8=" },
        after: { type: "file", mode: "755", data: "AQD/" }
      }]
    }]
  })
  assert.deepEqual(validateCloudHandoff(result, "smithersai/smithers"), result)
})

for (
  const [name, raw, expected] of [
    ["added", entry("000000", "100644", "new", "A", zero), [["new", true, false]]],
    ["removed", entry("100755", "000000", "old", "D", oldOid, zero), [["old", false, true]]],
    ["symlink", entry("100644", "120000", "link", "T"), [["link", false, false]]],
    ["renamed", entry("100644", "000000", "old", "D", oldOid, zero) + entry("000000", "100644", "new", "A", zero), [[
      "old",
      false,
      true
    ], ["new", true, false]]]
  ] as const
) {
  test(`Cloud export preserves ${name} tree entries`, async () => {
    const result = await Effect.runPromise(exportCloudCommits("smithersai/smithers", [sha], fake(raw, "dGFyZ2V0")))
    assert.deepEqual(
      result.commits[0]!.changes.map((change) => [change.path, change.before === null, change.after === null]),
      expected
    )
    if (name === "symlink") {
      assert.deepEqual(result.commits[0]!.changes[0]!.after, { type: "symlink", mode: "120000", data: "dGFyZ2V0" })
    }
  })
}

test("Cloud export rejects invalid READY IDs before any VM reads", async () => {
  for (const ids of [[], ["partial"], Array(21).fill(sha)]) {
    assert.match(await failure(() => Effect.die("must not read"), ids), /one to twenty full READY/)
  }
})

test("Cloud export rejects malformed metadata and non-single-parent commits before tree reads", async () => {
  for (
    const metadata of [
      "invalid",
      "",
      `${sha}\0\0message`,
      `${sha}\0${parent} ${oldOid}\0message`,
      `${parent}\0${parent}\0message`,
      `${sha}\0short\0message`
    ]
  ) {
    let reads = 0
    await failure(() => {
      reads++
      return Effect.succeed(metadataBytes(metadata))
    })
    assert.equal(reads, 1)
  }
})

test("Cloud export reads a linear two-commit chain and refuses a non-linear next READY commit", async () => {
  const next = "c".repeat(40)
  for (const linear of [true, false]) {
    let reads = 0
    const read: ReadCommand = (program, args) => {
      if (metadataCommand(program, args)) {
        return Effect.succeed(metadataBytes(reads++ === 0 ? `${sha}\0${parent}\0first` : `${next}\0${linear ? sha : parent}\0second`))
      }
      return Effect.succeed(args[1]!.includes("diff-tree") ? Buffer.from(entry()).toString("base64") : "AP8=")
    }
    if (linear) {
      const result = await Effect.runPromise(exportCloudCommits("smithersai/smithers", [sha, next], read))
      assert.deepEqual(result.commits.map((commit) => commit.parent), [parent, sha])
    } else assert.match(await failure(read, [sha, next]), /ordered/)
    assert.equal(reads, 2)
  }
})

test("Cloud export refuses unsafe paths, unsupported modes and malformed raw records", async () => {
  for (
    const raw of [
      "",
      "broken",
      entry().slice(0, -1),
      entry("160000"),
      entry("100644", "160000"),
      entry("100644", "100644", "x", "R"),
      ...["../escape", ".jj/secret", ".git/config", "/absolute", "a\\b", "a\n", "a//b", "x".repeat(4097)].map((path) =>
        entry("100644", "100755", path)
      )
    ]
  ) {
    let blobs = 0
    await failure((program, args) => {
      if (metadataCommand(program, args)) return Effect.succeed(metadataBytes(`${sha}\0${parent}\0message`))
      if (args[1]!.includes("diff-tree")) return Effect.succeed(Buffer.from(raw).toString("base64"))
      blobs++
      return Effect.succeed("AP8=")
    })
    assert.equal(blobs, 0)
  }
})

test("Cloud export permits versioned factory configuration and shell metacharacters in paths", async () => {
  for (const path of [".smithers/factory.json", "quotes' $(touch nope) café"]) {
    const result = await Effect.runPromise(
      exportCloudCommits("smithersai/smithers", [sha], fake(entry("100644", "100755", path)))
    )
    assert.equal(result.commits[0]!.changes[0]!.path, path)
  }
})

test("Cloud export preserves the exact changed-path count boundary", async () => {
  for (const count of [1000, 1001]) {
    const raw = Array.from({ length: count }, (_, i) => entry("000000", "100644", `file-${i}`, "A", zero)).join("")
    if (count === 1000) {
      assert.equal(
        (await Effect.runPromise(exportCloudCommits("smithersai/smithers", [sha], fake(raw)))).commits[0]!.changes
          .length,
        count
      )
    } else assert.match(await failure(fake(raw)), /changed-path/)
  }
})

test("Cloud export rejects malformed base64 and oversized file blobs", async () => {
  for (const data of ["not-base64!", Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64")]) {
    assert.match(await failure(fake(entry(), data)), /file bytes/)
  }
})

test("Cloud export enforces portable symlink target bounds", async () => {
  const raw = entry("000000", "120000", "link", "A", zero)
  assert.equal(
    (await Effect.runPromise(
      exportCloudCommits("smithersai/smithers", [sha], fake(raw, Buffer.alloc(1023, 120).toString("base64")))
    )).commits[0]!.changes[0]!.after!.mode,
    "120000"
  )
  assert.match(await failure(fake(raw, Buffer.alloc(1024, 120).toString("base64"))), /symlink/)
})

test("Cloud export enforces aggregate byte bounds across individually valid files", async () => {
  const data = Buffer.alloc(8 * 1024 * 1024).toString("base64")
  for (const count of [4, 5]) {
    const raw = Array.from({ length: count }, (_, i) => entry("100644", "100755", `file-${i}`)).join("")
    if (count === 4) {
      assert.equal(
        (await Effect.runPromise(exportCloudCommits("smithersai/smithers", [sha], fake(raw, data)))).commits[0]!.changes
          .length,
        4
      )
    } else assert.match(await failure(fake(raw, data)), /total-byte/)
  }
})

test("Git-only Cloud VM exports binary, executable and symlink blobs without jj", async () => {
  const oldOid = "1".repeat(40)
  const newOid = "2".repeat(40)
  const linkOid = "3".repeat(40)
  const zero = "0".repeat(40)
  const raw = `:100644 100755 ${oldOid} ${newOid} M\0binary\0:000000 120000 ${zero} ${linkOid} A\0link\0`
  const result = await Effect.runPromise(exportCloudCommits("smithersai/smithers", [sha], (program, args) => {
    assert.notEqual(program, "jj", "Cloud VM only has a healthy Git repository")
    if (metadataCommand(program, args)) return Effect.succeed(metadataBytes(`${sha}\0${parent}\0fix: binary\n`))
    const script = args[1]!
    if (script.includes("diff-tree")) return Effect.succeed(Buffer.from(raw).toString("base64"))
    return Effect.succeed(script.includes(oldOid) ? "AP8=" : script.includes(newOid) ? "AQD/" : "Li4vdGFyZ2V0")
  }))
  assert.deepEqual(result.commits[0]!.changes, [
    {
      path: "binary",
      before: { type: "file", mode: "644", data: "AP8=" },
      after: { type: "file", mode: "755", data: "AQD/" }
    },
    { path: "link", before: null, after: { type: "symlink", mode: "120000", data: "Li4vdGFyZ2V0" } }
  ])
})

test("Cloud export rejects malformed tree transport, duplicate paths and inconsistent status/object modes", async () => {
  assert.match(
    await failure((program, args) => Effect.succeed(metadataCommand(program, args) ? metadataBytes(`${sha}\0${parent}\0message`) : "invalid!")),
    /metadata/
  )
  const invalidUtf8 = Buffer.concat([Buffer.from(entry().slice(0, -7)), Buffer.from([255, 0])])
  assert.match(
    await failure((program, args) =>
      Effect.succeed(metadataCommand(program, args) ? metadataBytes(`${sha}\0${parent}\0message`) : invalidUtf8.toString("base64"))
    ),
    /unsafe/
  )
  for (
    const raw of [
      entry() + entry(),
      "\0",
      entry() + "extra\0",
      entry("100644", "100755", ""),
      entry("000000", "100644", "x", "A", oldOid),
      entry("100644", "100755", "x", "M", zero),
      entry("100644", "100755", "x", "A"),
      entry("000000", "000000", "x", "A", zero, zero),
      entry("000000", "000000", "x", "D", zero, zero),
      entry("100644", "100755", "x", "D"),
      entry("000000", "100644", "x", "M", zero),
      entry("100644", "000000", "x", "T", oldOid, zero)
    ]
  ) await failure(fake(raw))
})

test("Cloud export propagates read failures from metadata, tree and blob boundaries", async () => {
  for (const failAt of [1, 2, 3]) {
    let reads = 0
    const read: ReadCommand = (program, args) =>
      ++reads === failAt ? Effect.fail(`VM read ${failAt} failed`) : fake()(program, args)
    assert.match(await failure(read), new RegExp(`VM read ${failAt} failed`))
    assert.equal(reads, failAt)
  }
})

test("Cloud export accepts twenty ordered commits and empty regular-file blobs", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => (i + 10).toString(16).padStart(40, "0"))
  let commit = 0
  const result = await Effect.runPromise(exportCloudCommits("smithersai/smithers", ids, (program, args) => {
    if (metadataCommand(program, args)) {
      const index = commit++
      return Effect.succeed(metadataBytes(`${ids[index]}\0${index === 0 ? parent : ids[index - 1]}\0commit ${index}`))
    }
    return Effect.succeed(
      args[1]!.includes("diff-tree")
        ? Buffer.from(entry("000000", "100644", `empty-${commit}`, "A", zero)).toString("base64")
        : ""
    )
  }))
  assert.equal(result.commits.length, 20)
  assert.ok(result.commits.every((item) => item.changes[0]!.after!.data === ""))
  assert.deepEqual(validateCloudHandoff(result, "smithersai/smithers"), result)
})

test("Cloud export counts changed paths across the entire ordered commit chain", async () => {
  const next = "c".repeat(40)
  let commits = 0
  const result = await failure((program, args) => {
    if (metadataCommand(program, args)) {
      return Effect.succeed(metadataBytes(commits++ === 0 ? `${sha}\0${parent}\0first` : `${next}\0${sha}\0second`))
    }
    const raw = Array.from(
      { length: commits === 1 ? 500 : 501 },
      (_, i) => entry("000000", "100644", `commit-${commits}-${i}`, "A", zero)
    ).join("")
    return Effect.succeed(args[1]!.includes("diff-tree") ? Buffer.from(raw).toString("base64") : "")
  }, [sha, next])
  assert.match(result, /changed-path/)
  assert.equal(commits, 2)
})

test("Cloud export maps VM tree and blob guard overflows to precise limit errors", async () => {
  for (const kind of ["tree", "blob"] as const) {
    const read: ReadCommand = (program, args) => {
      if (metadataCommand(program, args)) return Effect.succeed(metadataBytes(`${sha}\0${parent}\0message`))
      if (args[1]!.includes("diff-tree")) {
        return Effect.succeed(kind === "tree" ? "#oversized" : Buffer.from(entry()).toString("base64"))
      }
      return Effect.succeed("#oversized")
    }
    assert.match(
      await failure(read),
      kind === "tree" ? /Cloud handoff exceeds changed-path limit/ : /Cloud handoff file bytes are invalid or oversized/
    )
  }
})

test("Cloud export runs VM byte guards before transporting oversized Git output", async () => {
  const execute = promisify(execFile)
  for (const kind of ["tree", "blob"] as const) {
    let guards = 0
    const result = await failure((program, args) => {
      if (metadataCommand(program, args)) return Effect.succeed(metadataBytes(`${sha}\0${parent}\0message`))
      if (kind === "blob" && args[1]!.includes("diff-tree")) {
        return Effect.succeed(Buffer.from(entry()).toString("base64"))
      }
      guards++
      // Replace only the Git producer: execute the exact VM guard/transport shell.
      const script = args[1]!.replace(
        /^git .+ > "\$t"(?:.*)?$/m,
        `"${process.execPath}" -e 'process.stdout.write(Buffer.alloc(17 * 1024 * 1024))' > "$t"`
      )
      return Effect.tryPromise({
        try: async () => (await execute("sh", ["-c", script], { maxBuffer: 32 * 1024 * 1024 })).stdout,
        catch: () => "VM command exited without a typed size receipt"
      })
    })
    assert.match(
      result,
      kind === "tree" ? /Cloud handoff exceeds changed-path limit/ : /Cloud handoff file bytes are invalid or oversized/
    )
    assert.equal(guards, 1)
  }
})


for (const stage of ["metadata", "tree", "blob"] as const) {
  test(`Cloud export retains real producer ${stage} failure diagnostics with bounded redaction`, async () => {
    const execute = promisify(execFile)
    const secret = "explicit-cloud-credential"
    const stderr = `fatal: missing object https://user:password@api.jjhub.tech/?token=hidden ${secret}\n${"x".repeat(12000)}`
    let executions = 0
    const read: ReadCommand = (program, args) => {
      const current = metadataCommand(program, args) ? "metadata" : args[1]!.includes("diff-tree") ? "tree" : "blob"
      if (current !== stage) return fake()(program, args)
      executions++
      const producer = `"${process.execPath}" -e '${"process.stderr.write(Buffer.from(\"" + Buffer.from(stderr).toString("base64") + "\",\"base64\"));process.exit(128)"}'`
      // Run the exported VM shell exactly, replacing only its Git producer.
      const script = args[1]!.replace(/^git ([^\n]+?) > "\$t"/m, `${producer} > "$t"`)
      assert.notEqual(script, args[1], "must execute the real guard around the substituted producer")
      return Effect.tryPromise({
        try: async () => (await execute("sh", ["-c", script])).stdout,
        catch: () => "Cloud committed-tree export command failed"
      })
    }
    const exit = await Effect.runPromise(Effect.exit(exportCloudCommits("smithersai/smithers", [sha], read, { redactions: [secret] })))
    assert.equal(exit._tag, "Failure")
    const result = JSON.stringify(exit)
    assert.match(result, new RegExp(stage))
    assert.match(result, new RegExp(sha))
    assert.match(result, /128/)
    assert.match(result, /missing object/)
    assert.doesNotMatch(result, /explicit-cloud-credential|user:password|token=hidden/)
    assert.ok(result.length < 6000, "failure diagnostics must remain bounded")
    assert.equal(executions, 1)
  })

  test(`Cloud export annotates ${stage} transport errors separately from Git exits`, async () => {
    const secret = "transport-secret"
    let reads = 0
    const read: ReadCommand = (program, args) => {
      reads++
      const current = metadataCommand(program, args) ? "metadata" : args[1]!.includes("diff-tree") ? "tree" : "blob"
      return current === stage ? Effect.fail(`SSH grant timed out ${secret}`) : fake()(program, args)
    }
    const exit = await Effect.runPromise(Effect.exit(exportCloudCommits("smithersai/smithers", [sha], read, { redactions: [secret] })))
    assert.equal(exit._tag, "Failure")
    const result = JSON.stringify(exit)
    assert.match(result, new RegExp(stage))
    assert.match(result, new RegExp(sha))
    assert.match(result, /SSH grant timed out/)
    assert.doesNotMatch(result, /transport-secret/)
    assert.equal(reads, stage === "metadata" ? 1 : stage === "tree" ? 2 : 3)
  })
}


test("Cloud export rejects invalid or oversized metadata before tree reads", async () => {
  for (const [receipt, expected] of [["invalid!", /metadata is invalid/], ["#oversized", /metadata is oversized/]] as const) {
    let reads = 0
    assert.match(await failure(() => { reads++; return Effect.succeed(receipt) }), expected)
    assert.equal(reads, 1)
  }
})

test("Cloud diagnostics redact known token families and strip terminal control bytes", () => {
  const raw = "Bearer abc-secret ghp_fake github_pat_fake sk-fake eyJfake.payload.signature \u0000safe\u001b tail"
  const redacted = cloudDiagnostic(raw, [""])
  assert.equal(redacted, "[redacted] [redacted] [redacted] [redacted] [redacted] safe tail")
  assert.equal(cloudDiagnostic("x".repeat(2049)).length, 2048)
  assert.equal(cloudDiagnostic("private private", ["private"]), "[redacted] [redacted]")
})
