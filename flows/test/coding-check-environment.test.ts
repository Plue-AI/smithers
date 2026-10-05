import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { test } from "node:test"
import { consume, repositoryCheckEnvironment } from "../coding/check-environment.ts"
import { environmentSecrets, redactOutput, runSourceProcess, withImmutableSource } from "../coding/immutable-source.ts"

const cacheUrl = "https://api.example.test/api/repos/o/r/build-cache"

test("the allowlist reaches every repository process; the cache credential is kept apart and leaves the host", () => {
  const environment: Record<string, string | undefined> = {
    PATH: "/usr/bin",
    HOME: "/home/developer",
    HTTPS_PROXY: "http://proxy",
    NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
    SMITHERS_CACHE_URL: cacheUrl,
    SMITHERS_CACHE_TOKEN: "smithers_cache_read",
    SMITHERS_JJHUB_TOKEN: "landing",
    SMITHERS_API_KEY: "gateway",
    NPM_TOKEN: "placeholder"
  }
  assert.deepEqual(consume(environment), {
    environment: {
      PATH: "/usr/bin",
      HOME: "/home/developer",
      HTTPS_PROXY: "http://proxy",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem"
    },
    cache: {
      SMITHERS_CACHE_URL: cacheUrl,
      SMITHERS_CACHE_TOKEN: "smithers_cache_read",
      SMITHERS_CACHE_READ_TOKEN: "smithers_cache_read"
    }
  })
  assert.equal("SMITHERS_CACHE_URL" in environment, false)
  assert.equal("SMITHERS_CACHE_TOKEN" in environment, false)
  assert.equal(environment.SMITHERS_JJHUB_TOKEN, "landing", "the landing credential is landing-config's to consume")
  assert.equal(environment.PATH, "/usr/bin")
})

test("a partial or empty cache provision reaches no process and still leaves the host", () => {
  for (
    const provision of [
      { SMITHERS_CACHE_URL: cacheUrl },
      { SMITHERS_CACHE_TOKEN: "smithers_cache_read" },
      { SMITHERS_CACHE_URL: "", SMITHERS_CACHE_TOKEN: "smithers_cache_read" },
      { SMITHERS_CACHE_URL: cacheUrl, SMITHERS_CACHE_TOKEN: "" },
      {}
    ]
  ) {
    const environment: Record<string, string | undefined> = { PATH: "/usr/bin", ...provision }
    assert.deepEqual(consume(environment), { environment: { PATH: "/usr/bin" }, cache: {} }, JSON.stringify(provision))
    assert.deepEqual(environment, { PATH: "/usr/bin" })
  }
})

test("no process inherits a caller-supplied split read or write token", () => {
  assert.deepEqual(
    consume({ SMITHERS_CACHE_READ_TOKEN: "ambient-read", SMITHERS_CACHE_WRITE_TOKEN: "ambient-write" }),
    { environment: {}, cache: {} }
  )
})

test("only repository checks add the cache credential to the allowlist", () => {
  const { environment, cache } = consume({ PATH: "/usr/bin", SMITHERS_CACHE_URL: cacheUrl, SMITHERS_CACHE_TOKEN: "t" })
  assert.deepEqual(repositoryCheckEnvironment({ checkEnvironment: environment, cacheEnvironment: cache }), {
    PATH: "/usr/bin",
    SMITHERS_CACHE_URL: cacheUrl,
    SMITHERS_CACHE_TOKEN: "t",
    SMITHERS_CACHE_READ_TOKEN: "t"
  })
  assert.equal(repositoryCheckEnvironment({ checkEnvironment: environment, cacheEnvironment: {} }), environment)
  assert.equal(repositoryCheckEnvironment({ checkEnvironment: environment }), environment)
  assert.equal(repositoryCheckEnvironment({}), undefined, "an unset allowlist stays unset")
  assert.deepEqual(repositoryCheckEnvironment({ cacheEnvironment: cache }), cache)
})

test("a check's retained output never carries its cache credential", async () => {
  const token = "smithers_0123456789abcdef"
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    SMITHERS_CACHE_TOKEN: token,
    SMITHERS_CACHE_READ_TOKEN: token
  }
  const measured = await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return yield* runSourceProcess(
        { repositoryPath: "/", fs, environment },
        [
          "/bin/sh",
          "-c",
          "echo \"token=$SMITHERS_CACHE_TOKEN\"; echo \"$SMITHERS_CACHE_READ_TOKEN\" >&2; echo \"$PATH\""
        ],
        "/",
        10_000
      )
    }).pipe(Effect.provide(NodeServices.layer))
  )
  assert.equal(measured.exitCode, 0)
  assert.equal(measured.stdout.text, `token=[redacted]\n${environment.PATH}\n`, "the PATH is not a credential")
  assert.equal(measured.stderr.text, "[redacted]\n")
})

test("a check's tree is exported inside the workspace root's .jj by the configured exporter, never under HOME", async (t) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "coding-check-export-")))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "workspace"), home = join(temporary, "home")
  const exporter = join(temporary, "exporter.sh"), recorded = join(temporary, "argv")
  await mkdir(root)
  await mkdir(home)
  const revision = {
    changeId: "k".repeat(32),
    commitId: "a".repeat(40),
    treeId: "b".repeat(40),
    operationId: "c".repeat(128),
    parentCommitIds: []
  }
  // `<exporter> <repository> <commit> <output>`: record the call, write one file, answer the identity.
  await writeFile(
    exporter,
    `#!/bin/sh
printf '%s\\n' "$0" "$@" > '${recorded}'
mkdir "$3/tree" && printf 'export {}\\n' > "$3/tree/index.ts"
printf '{"commitId":"%s","changeId":"${revision.changeId}","treeId":"${revision.treeId}","path":"%s/tree","fileCount":1}' "$2" "$3"
`
  )
  await chmod(exporter, 0o755)
  const seen = await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return yield* withImmutableSource(
        {
          repositoryPath: root,
          fs,
          exporterPath: exporter,
          environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }
        },
        revision,
        (tree, exported) =>
          Effect.promise(async () => ({ tree, exported, source: await readFile(join(exported, "index.ts"), "utf8") }))
      )
    }).pipe(Effect.provide(NodeServices.layer))
  )
  const [program, repository, commit, output] = (await readFile(recorded, "utf8")).trimEnd().split("\n")
  assert.equal(program, exporter, "the host-configured exporter runs, not the guest's fixed path")
  assert.deepEqual([repository, commit], [root, revision.commitId])
  // A confined check reads and writes only inside the root; jj never snapshots .jj.
  const checks = join(root, ".jj", "smithers-checks")
  assert.equal(dirname(output!), checks)
  assert.match(basename(output!), /^smithers-check-/)
  assert.equal(seen.exported, join(output!, "tree"))
  assert.equal(seen.tree.commitId, revision.commitId)
  assert.equal(seen.source, "export {}\n")
  assert.deepEqual(await readdir(checks), [], "the scoped export is removed once the check returns")
  assert.equal(existsSync(join(home, ".cache")), false, "nothing is exported under HOME")
})

test("redaction covers every credential name, overlapping values and a truncated tail", () => {
  assert.deepEqual(
    environmentSecrets({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/developer",
      SMITHERS_CACHE_TOKEN: "smithers_cache",
      NPM_TOKEN: "smithers_cache_longer",
      DEPLOY_KEY: "key-material",
      DB_PASSWORD: "hunter22",
      GH_SECRET: "short",
      SMITHERS_CACHE_URL: "https://api.example.test/api/repos/o/r/build-cache"
    }),
    ["smithers_cache_longer", "smithers_cache", "key-material", "hunter22"],
    "the longest first, so an overlapping value is never half-replaced; short values are left"
  )
  assert.deepEqual(environmentSecrets(undefined), [])
  const secrets = ["smithers_cache_longer", "smithers_cache"]
  assert.deepEqual(redactOutput({ text: "a smithers_cache_longer b smithers_cache c", truncated: false }, secrets), {
    text: "a [redacted] b [redacted] c",
    truncated: false
  })
  assert.deepEqual(redactOutput({ text: "ends smithers_ca", truncated: true }, secrets), {
    text: "ends [redacted]",
    truncated: true
  })
  assert.deepEqual(
    redactOutput({ text: "ends smithers_ca", truncated: false }, secrets),
    { text: "ends smithers_ca", truncated: false },
    "complete output keeps a mere prefix"
  )
  assert.deepEqual(redactOutput({ text: "ends smi", truncated: true }, secrets), { text: "ends smi", truncated: true })
})
