import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { consume, repositoryCheckEnvironment } from "../coding/check-environment.ts"
import { environmentSecrets, redactOutput, runSourceProcess } from "../coding/immutable-source.ts"

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
