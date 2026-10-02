import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as LlmLint from "../src/LlmLint.ts"

let root: string
let executable: string
const credential = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
const payload: LlmLint.Payload = {
  base: "HEAD",
  include: [Input.glob("src/**/*.ts")],
  context: [],
  prompt: "Review",
  rubric: "Credentials",
  engine: "claude",
  model: "test",
  batchSize: 1,
  failOn: "error"
}
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "credential-delivery-")))
  await Fs.mkdir(Path.join(root, "src"))
  await Fs.writeFile(Path.join(root, "src/a.ts"), "export const a = 1\n")
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root })
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "base"], { cwd: root })
  await Fs.writeFile(Path.join(root, "src/a.ts"), `export const GITHUB_TOKEN = "${credential}"\n`)
  executable = Path.join(root, "reviewer.mjs")
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs'; let p=''; for await(const c of process.stdin)p+=c; appendFileSync(${
      JSON.stringify(Path.join(root, "calls"))
    },p); process.stdout.write(JSON.stringify({result:'[]'}))`
  )
  await Fs.chmod(executable, 0o755)
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

it("delivers every discovery once before the first provider, with only name and location", async () => {
  await Fs.writeFile(Path.join(root, "src/b.ts"), `export const API_TOKEN = "${credential}"\n`)
  const deliveries: Array<ReadonlyArray<LlmLint.CredentialDiscovery>> = []
  const failure = await Effect.runPromise(
    Effect.flip(LlmLint.review({
      workspaceRoot: root,
      executable,
      onCredentials: (discoveries) =>
        Effect.tryPromise(async () => {
          await expect(Fs.stat(Path.join(root, "calls"))).rejects.toMatchObject({ code: "ENOENT" })
          deliveries.push(discoveries)
        })
    }, payload))
  )
  expect(deliveries).toHaveLength(1)
  expect(deliveries[0]).toEqual(expect.arrayContaining([
    expect.objectContaining({ file: "src/a.ts", line: 1 }),
    expect.objectContaining({ file: "src/b.ts", line: 1 })
  ]))
  for (const discovery of deliveries[0]!) expect(Object.keys(discovery).sort()).toEqual(["file", "line", "name"])
  expect(JSON.stringify(deliveries)).not.toContain(credential)
  expect(JSON.stringify(deliveries)).not.toContain("<credential:")
  expect(failure).toBeInstanceOf(LlmLint.FindingsError)
})

it("fails closed with a generic receipt and no automatic delivery retries", async () => {
  let calls = 0
  const failure = await Effect.runPromise(
    Effect.flip(LlmLint.review({
      workspaceRoot: root,
      executable,
      onCredentials: () => {
        calls++
        return Effect.fail(new Error(`callback body ${credential}`))
      }
    }, payload))
  )
  expect(calls).toBe(1)
  expect(failure).toMatchObject({ phase: "review", message: "Private credential rotation delivery failed" })
  expect(JSON.stringify(failure)).not.toContain(credential)
  await expect(Fs.stat(Path.join(root, "calls"))).rejects.toMatchObject({ code: "ENOENT" })
})

it("retries through a real HTTP receiver on a new review and permits host deduplication", async () => {
  const bodies: Array<string> = []
  const accepted = new Set<string>()
  const server = Http.createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    bodies.push(body)
    if (bodies.length === 1) {
      response.writeHead(503)
      response.end("retry")
      return
    }
    accepted.add(body)
    response.writeHead(204)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const options = {
    workspaceRoot: root,
    executable,
    onCredentials: (discoveries: ReadonlyArray<LlmLint.CredentialDiscovery>) =>
      Effect.tryPromise(async (signal) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/rotation`, {
          method: "POST",
          body: JSON.stringify(discoveries),
          signal
        })
        if (!response.ok) throw new Error("Receiver rejected delivery")
      })
  }
  try {
    const first = await Effect.runPromise(Effect.flip(LlmLint.review(options, payload)))
    expect(first).toMatchObject({ phase: "review", message: "Private credential rotation delivery failed" })
    expect(bodies).toHaveLength(1)
    await expect(Fs.stat(Path.join(root, "calls"))).rejects.toMatchObject({ code: "ENOENT" })
    for (let i = 0; i < 2; i++) {
      expect(await Effect.runPromise(Effect.flip(LlmLint.review(options, payload)))).toBeInstanceOf(
        LlmLint.FindingsError
      )
    }
    expect(bodies).toHaveLength(3)
    expect(accepted.size).toBe(1)
    expect(new Set(bodies).size).toBe(1)
    expect(bodies.join("")).not.toContain(credential)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

it("propagates cancellation while delivery is pending without starting inference", async () => {
  let started!: () => void
  const pending = new Promise<void>((resolve) => {
    started = resolve
  })
  const fiber = Effect.runFork(
    LlmLint.review({
      workspaceRoot: root,
      executable,
      onCredentials: () => Effect.flatMap(Effect.sync(started), () => Effect.never)
    }, payload)
  )
  await pending
  await Effect.runPromise(Fiber.interrupt(fiber))
  const exit = await Effect.runPromise(Fiber.await(fiber))
  expect(exit._tag).toBe("Failure")
  await expect(Fs.stat(Path.join(root, "calls"))).rejects.toMatchObject({ code: "ENOENT" })
})

it("does not invoke delivery when no local credential was discovered", async () => {
  await Fs.writeFile(Path.join(root, "src/a.ts"), "export const a = 2\n")
  let calls = 0
  const report = await Effect.runPromise(
    LlmLint.review({
      workspaceRoot: root,
      executable,
      onCredentials: () =>
        Effect.sync(() => {
          calls++
        })
    }, payload)
  )
  expect(calls).toBe(0)
  expect(report.findings).toEqual([])
})

/**
 * The receiver contract. Receivers in other repositories, such as Plue's
 * credential rotation receiver, pin this document and schema byte for byte;
 * changing either is a contract change for them.
 */
const contractDocument =
  `{"revision":"0123456789abcdef0123456789abcdef01234567","discoveries":[{"file":"src/a.ts","line":1,"name":"GITHUB_TOKEN"},{"file":"src/config.ts","line":1,"name":"PLUE_PUSH_CALLBACK_SECRET"},{"file":"src/config.ts","line":2,"name":"stripeSecretKey"},{"file":"src/config.ts","line":3,"name":"url-password"}]}`
const contractSchema = {
  dialect: "draft-2020-12",
  schema: {
    type: "object",
    properties: {
      revision: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
      discoveries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: {
              type: "string",
              pattern:
                "^(?!\\.\\.?(?:\\/|$))(?!.*\\/\\.\\.?(?:\\/|$))[^/\\u0000-\\u001f\\u007f]+(?:\\/[^/\\u0000-\\u001f\\u007f]+)*$",
              maxLength: 16384
            },
            line: { type: "integer", minimum: 1 },
            name: { type: "string", pattern: "^[A-Za-z0-9_:<>-]{1,1024}$" }
          },
          required: ["file", "line", "name"],
          additionalProperties: false
        },
        minItems: 1,
        maxItems: 10000
      }
    },
    required: ["revision", "discoveries"],
    additionalProperties: false
  },
  definitions: {}
}

it("pins the receiver contract that the scanner's discoveries encode to", async () => {
  const values = ["c2VjcmV0LXZhbHVlLWZvci1maXh0dXJl", "q8Zr2LmN4pW7xT1v", "hunter2pass"]
  await Fs.writeFile(
    Path.join(root, "src/config.ts"),
    `export const PLUE_PUSH_CALLBACK_SECRET = "${values[0]}"\nexport const stripeSecretKey = "${values[1]}"\n` +
      `export const dsn = "postgres://admin:${values[2]}@db.internal/app"\n`
  )
  const deliveries: Array<ReadonlyArray<LlmLint.CredentialDiscovery>> = []
  await Effect.runPromise(Effect.flip(LlmLint.review({
    workspaceRoot: root,
    executable,
    onCredentials: (discoveries) => Effect.sync(() => deliveries.push(discoveries))
  }, payload)))
  expect(deliveries).toHaveLength(1)
  const document = Schema.encodeSync(LlmLint.CredentialDelivery)({
    revision: "0123456789abcdef0123456789abcdef01234567",
    discoveries: deliveries[0]!
  })
  expect(JSON.stringify(document)).toBe(contractDocument)
  for (const value of [credential, ...values]) expect(contractDocument).not.toContain(value)
  expect(Schema.toJsonSchemaDocument(LlmLint.CredentialDelivery, { onExcessProperty: "error" })).toEqual(contractSchema)
  const [first] = document.discoveries
  for (
    const refused of [
      { ...document, value: credential },
      { ...document, discoveries: [{ ...first, value: credential }] },
      { ...document, discoveries: [] },
      { ...document, revision: "HEAD" },
      { ...document, discoveries: [{ ...first, file: "../outside.ts" }] },
      { ...document, discoveries: [{ ...first, file: "/etc/passwd" }] },
      { ...document, discoveries: [{ ...first, line: 0 }] },
      { ...document, discoveries: [{ ...first, name: "token value" }] }
    ]
  ) {
    expect(() => Schema.decodeUnknownSync(LlmLint.CredentialDelivery)(refused, { onExcessProperty: "error" }))
      .toThrow()
  }
})
