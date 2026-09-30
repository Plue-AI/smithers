import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as LlmLint from "../src/LlmLint.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "credential-review-")))
  await Fs.mkdir(Path.join(root, "src"))
  await Fs.writeFile(Path.join(root, "src/a.ts"), "export const a = 1\n")
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root })
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "base"], { cwd: root })
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

it("masks committed credentials before the model and masks reflected findings", async () => {
  const credential = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
  await Fs.writeFile(Path.join(root, "src/a.ts"), `export const GITHUB_TOKEN = "${credential}"\n`)
  const executable = Path.join(root, "reviewer.mjs")
  const record = Path.join(root, "prompt.txt")
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"\nlet prompt = ""\nfor await (const chunk of process.stdin) prompt += chunk\nwriteFileSync(${
      JSON.stringify(record)
    }, prompt)\nprocess.stdout.write(JSON.stringify({result: JSON.stringify([{file:"src/a.ts",line:1,severity:"warning",message:${
      JSON.stringify(credential)
    }}])}))\n`
  )
  await Fs.chmod(executable, 0o755)
  const failure = await Effect.runPromise(Effect.flip(LlmLint.review({ workspaceRoot: root, executable }, {
    base: "HEAD",
    include: [Input.glob("src/**/*.ts")],
    context: [],
    prompt: "Review",
    rubric: "Credentials",
    engine: "claude",
    model: "test",
    batchSize: 1,
    failOn: "error"
  })))
  const prompt = await Fs.readFile(record, "utf8")
  expect(prompt).not.toContain(credential)
  expect(prompt).toContain("<credential:github-token:1>")
  expect(failure).toBeInstanceOf(LlmLint.FindingsError)
  expect(JSON.stringify(failure)).not.toContain(credential)
  expect((failure as LlmLint.FindingsError).findings).toEqual(expect.arrayContaining([
    expect.objectContaining({
      file: "src/a.ts",
      line: 1,
      severity: "error",
      message: expect.stringContaining("Rotate")
    })
  ]))
})

it("gives the reviewer only selected authorization and a temporary home", async () => {
  const executable = Path.join(root, "environment.mjs")
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nprocess.stdin.resume()\nprocess.stdin.on("end", () => process.stdout.write(JSON.stringify({result: JSON.stringify({home: process.env.HOME, cwd: process.cwd(), marker: process.env.UNRELATED_CREDENTIAL, auth: process.env.ANTHROPIC_API_KEY})})))\n`
  )
  await Fs.chmod(executable, 0o755)
  const previousMarker = process.env["UNRELATED_CREDENTIAL"]
  const previousAuth = process.env["ANTHROPIC_API_KEY"]
  process.env["UNRELATED_CREDENTIAL"] = "must-stay-private"
  process.env["ANTHROPIC_API_KEY"] = "test-model-auth"
  try {
    const answer = await Effect.runPromise(LlmLint.promptEngine(
      { workspaceRoot: root, executable },
      { engine: "claude", model: "test", prompt: "review" }
    ))
    const environment = JSON.parse(answer) as { home: string; cwd: string; marker?: string; auth?: string }
    expect(environment.marker).toBeUndefined()
    expect(environment.auth).toBe("test-model-auth")
    expect(environment.home).not.toBe(process.env["HOME"])
    expect(environment.cwd.replace(/^\/private(?=\/var\/)/, "")).toBe(
      environment.home.replace(/^\/private(?=\/var\/)/, "")
    )
    await expect(Fs.stat(environment.home)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    if (previousMarker === undefined) delete process.env["UNRELATED_CREDENTIAL"]
    else process.env["UNRELATED_CREDENTIAL"] = previousMarker
    if (previousAuth === undefined) delete process.env["ANTHROPIC_API_KEY"]
    else process.env["ANTHROPIC_API_KEY"] = previousAuth
  }
})

it("does not classify source placeholders and environment names as credentials", async () => {
  const source = "export const bunToken = \"{smthrs:bun}\"\nexport const defaultTokenEnv = \"SMITHERS_CACHE_TOKEN\"\n"
  await Fs.writeFile(Path.join(root, "src/a.ts"), source)
  const executable = Path.join(root, "plain-reviewer.mjs")
  const record = Path.join(root, "plain-prompt.txt")
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"\nlet prompt = ""\nfor await (const chunk of process.stdin) prompt += chunk\nwriteFileSync(${
      JSON.stringify(record)
    }, prompt)\nprocess.stdout.write(JSON.stringify({result:"[]"}))\n`
  )
  await Fs.chmod(executable, 0o755)
  const report = await Effect.runPromise(LlmLint.review({ workspaceRoot: root, executable }, {
    base: "HEAD",
    include: [Input.glob("src/**/*.ts")],
    context: [],
    prompt: "Review",
    rubric: "Credentials",
    engine: "claude",
    model: "test",
    batchSize: 1,
    failOn: "error"
  }))
  expect(report.findings).toEqual([])
  expect(await Fs.readFile(record, "utf8")).toContain(source)
})

it("masks a mixed-case password without a provider prefix", async () => {
  const credential = "Xk9fQ2mTz81LpR7vWc"
  await Fs.writeFile(Path.join(root, "src/a.ts"), `export const DB_PASSWORD = "${credential}"\n`)
  const executable = Path.join(root, "password-reviewer.mjs")
  const record = Path.join(root, "password-prompt.txt")
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"\nlet prompt = ""\nfor await (const chunk of process.stdin) prompt += chunk\nwriteFileSync(${
      JSON.stringify(record)
    }, prompt)\nprocess.stdout.write(JSON.stringify({result:"[]"}))\n`
  )
  await Fs.chmod(executable, 0o755)
  const failure = await Effect.runPromise(Effect.flip(LlmLint.review({ workspaceRoot: root, executable }, {
    base: "HEAD",
    include: [Input.glob("src/**/*.ts")],
    context: [],
    prompt: "Review",
    rubric: "Credentials",
    engine: "claude",
    model: "test",
    batchSize: 1,
    failOn: "error"
  })))
  expect(await Fs.readFile(record, "utf8")).not.toContain(credential)
  expect(JSON.stringify(failure)).not.toContain(credential)
  expect((failure as LlmLint.FindingsError).findings).toHaveLength(1)
})

it("pre-scans every batch before sending a shared credential in an earlier file", async () => {
  const credential = "Xk9fQ2mTz81LpR7vWc"
  await Fs.writeFile(Path.join(root, "src/a.ts"), `export const fallback = "${credential}"\n`)
  await Fs.writeFile(Path.join(root, "src/b.ts"), `export const API_TOKEN = "${credential}"\n`)
  const executable = Path.join(root, "ordered-reviewer.mjs")
  const record = Path.join(root, "ordered-prompts.txt")
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs"\nlet prompt = ""\nfor await (const chunk of process.stdin) prompt += chunk\nappendFileSync(${
      JSON.stringify(record)
    }, JSON.stringify(prompt) + "\\n")\nprocess.stdout.write(JSON.stringify({result:"[]"}))\n`
  )
  await Fs.chmod(executable, 0o755)
  const failure = await Effect.runPromise(Effect.flip(LlmLint.review({ workspaceRoot: root, executable }, {
    base: "HEAD",
    include: [Input.glob("src/**/*.ts")],
    context: [],
    prompt: "Review",
    rubric: "Credentials",
    engine: "claude",
    model: "test",
    batchSize: 1,
    failOn: "error"
  })))
  const prompts = (await Fs.readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string)
  expect(prompts).toHaveLength(2)
  expect(prompts[0]).not.toContain(credential)
  expect(prompts[0]).toContain("<credential:api-token:1>")
  expect(JSON.stringify(failure)).not.toContain(credential)
})

it.each([
  ["quoted JSON API key", "export const headers = {\"api_key\": \"tiny42\"}\n", "tiny42"],
  ["object literal token", "export const config = {token: \"objtok42\"}\n", "objtok42"],
  ["nested call argument", "export const config = makeConfig({api_key: \"liveSecret42\"})\n", "liveSecret42"],
  ["uppercase password", "export const DB_PASSWORD = \"UPPERCASE42\"\n", "UPPERCASE42"],
  ["short password", "export const DB_PASSWORD = \"p4ss\"\n", "p4ss"],
  ["dotenv key", "API_KEY=short-secret\n", "short-secret"]
])("masks %s before provider delivery", async (_label, source, credential) => {
  await Fs.writeFile(Path.join(root, "src/a.ts"), source)
  const executable = Path.join(root, "short-reviewer.mjs")
  const record = Path.join(root, "short-prompt.txt")
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs'; let p=''; for await(const c of process.stdin)p+=c; writeFileSync(${
      JSON.stringify(record)
    },p); process.stdout.write(JSON.stringify({result:'[]'}))`
  )
  await Fs.chmod(executable, 0o755)
  const outcome = await Effect.runPromise(Effect.result(LlmLint.review({ workspaceRoot: root, executable }, {
    base: "HEAD",
    include: [Input.glob("src/**/*.ts")],
    context: [],
    prompt: "Review",
    rubric: "Credentials",
    engine: "claude",
    model: "test",
    batchSize: 1,
    failOn: "error"
  })))
  expect(await Fs.readFile(record, "utf8")).not.toContain(credential)
  expect(JSON.stringify(outcome)).not.toContain(credential)
  expect(outcome._tag).toBe("Failure")
})

it.each([
  ["a sample-prefixed value", "export const API_KEY = \"test-live-secret42\"\n", "Review", "test-live-secret42"],
  ["a path-like value", "export const DB_PASSWORD = \"/liveSecret42\"\n", "Review", "/liveSecret42"],
  [
    "review instructions",
    "export const a = 2\n",
    "Review GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
  ]
])("masks %s without reporting a location", async (_label, source, prompt, credential) => {
  await Fs.writeFile(Path.join(root, "src/a.ts"), source)
  const executable = Path.join(root, "sample-reviewer.mjs")
  const record = Path.join(root, "sample-prompt.txt")
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs'; let p=''; for await(const c of process.stdin)p+=c; writeFileSync(${
      JSON.stringify(record)
    },p); process.stdout.write(JSON.stringify({result:'[]'}))`
  )
  await Fs.chmod(executable, 0o755)
  const outcome = await Effect.runPromise(Effect.result(LlmLint.review({ workspaceRoot: root, executable }, {
    base: "HEAD",
    include: [Input.glob("src/**/*.ts")],
    context: [],
    prompt,
    rubric: "Credentials",
    engine: "claude",
    model: "test",
    batchSize: 1,
    failOn: "error"
  })))
  const sent = await Fs.readFile(record, "utf8")
  expect(sent).not.toContain(credential)
  expect(sent).toContain("<credential:")
  expect(JSON.stringify(outcome)).not.toContain(credential)
  expect(outcome._tag).toBe("Success")
})

const reviewPayload: LlmLint.Payload = {
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

it("masks context credentials in source, instructions, and subprocess diagnostics", async () => {
  const credential = "ghp_contextabcdefghijklmnopqrstuvwxyz1234567890"
  await Fs.writeFile(Path.join(root, "src/a.ts"), `export const echoed = "${credential}"\n`)
  await Fs.writeFile(Path.join(root, "settings.txt"), `GITHUB_TOKEN=${credential}\n`)
  const executable = Path.join(root, "diagnostic-reviewer.mjs")
  const record = Path.join(root, "diagnostic-prompt.txt")
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';let p='';for await(const c of process.stdin)p+=c;writeFileSync(${
      JSON.stringify(record)
    },p);process.stderr.write(${JSON.stringify(credential)});process.stdout.write(${
      JSON.stringify(credential)
    });process.exitCode=1`
  )
  await Fs.chmod(executable, 0o755)
  const failure = await Effect.runPromise(Effect.flip(LlmLint.review({ workspaceRoot: root, executable }, {
    ...reviewPayload,
    context: [Input.glob("settings.txt")],
    prompt: `Review ${credential}`,
    rubric: credential
  })))
  expect(failure).toBeInstanceOf(LlmLint.LlmReviewError)
  expect(JSON.stringify(failure)).not.toContain(credential)
  const prompt = await Fs.readFile(record, "utf8")
  expect(prompt).not.toContain(credential)
  expect(prompt).toContain("<credential:")
})

it("isolates codex configuration and excludes other provider authorization", async () => {
  const names = [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "ANTHROPIC_API_KEY",
    "CODEX_HOME",
    "NODE_OPTIONS",
    "UNRELATED_CREDENTIAL"
  ]
  const previous = names.map((name) => process.env[name])
  Object.assign(process.env, {
    OPENAI_API_KEY: "selected-openai",
    CODEX_API_KEY: "selected-codex",
    ANTHROPIC_API_KEY: "other-provider",
    CODEX_HOME: root,
    UNRELATED_CREDENTIAL: "private-host",
    NODE_OPTIONS: "--no-warnings"
  })
  const executable = Path.join(root, "codex-environment.mjs")
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nlet p='';for await(const c of process.stdin)p+=c;process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({home:process.env.HOME,codex:process.env.CODEX_HOME,openai:process.env.OPENAI_API_KEY,key:process.env.CODEX_API_KEY,other:process.env.ANTHROPIC_API_KEY,marker:process.env.UNRELATED_CREDENTIAL,nodeOptions:process.env.NODE_OPTIONS,cwd:process.cwd()})}})+'\\n')`
  )
  await Fs.chmod(executable, 0o755)
  try {
    const environment = JSON.parse(
      await Effect.runPromise(
        LlmLint.promptEngine({ workspaceRoot: root, executable }, { engine: "codex", model: "test", prompt: "Review" })
      )
    ) as Record<string, string>
    expect(environment["openai"]).toBe("selected-openai")
    expect(environment["key"]).toBe("selected-codex")
    expect(environment["other"]).toBeUndefined()
    expect(environment["marker"]).toBeUndefined()
    expect(environment["nodeOptions"]).toBeUndefined()
    expect(environment["home"]).not.toBe(root)
    expect(environment["codex"]).toBe(Path.join(environment["home"]!, ".codex"))
    expect(environment["cwd"]!.replace(/^\/private(?=\/var\/)/, "")).toBe(
      environment["home"]!.replace(/^\/private(?=\/var\/)/, "")
    )
    await expect(Fs.stat(environment["home"]!)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    })
  }
})

// Inject only the remote transport: local snapshot loading, policy rendering,
// redaction, request encoding, response decoding and findings remain real.
it.each(["claude", "codex"] as const)(
  "redacts snapshot credentials from %s user and system requests",
  async (engine) => {
    const credential = "ghp_snapshotabcdefghijklmnopqrstuvwxyz1234567890"
    const authName = engine === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
    const previous = process.env[authName]
    process.env[authName] = "synthetic-auth"
    const requests: Array<Record<string, unknown>> = []
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array)
      requests.push(JSON.parse(body) as Record<string, unknown>)
      const events = engine === "claude" ?
        [
          { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "[]" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" }
        ] :
        [{ type: "response.output_text.delta", item_id: "t", delta: "[]" }, {
          type: "response.completed",
          response: { id: "r" }
        }]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" }
      })
    }
    try {
      const failure = await Effect.runPromise(
        Effect.flip(
          LlmLint.review({
            workspaceRoot: root,
            snapshot: [{ path: "src/a.ts", contents: `export const API_KEY = "${credential}"\n`, changed: true }]
          }, { ...reviewPayload, engine, prompt: `Review ${credential}`, rubric: `Check ${credential}` }).pipe(
            Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
          )
        )
      )
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(requests)).not.toContain(credential)
      expect(JSON.stringify(requests)).toContain("<credential:")
      expect(failure).toBeInstanceOf(LlmLint.FindingsError)
      expect(JSON.stringify(failure)).not.toContain(credential)
    } finally {
      if (previous === undefined) delete process.env[authName]
      else process.env[authName] = previous
    }
  }
)

it("blocks security completion on locally detected credentials even when every reviewer clears it", async () => {
  const credential = "ghp_securityabcdefghijklmnopqrstuvwxyz1234567890"
  await Fs.writeFile(Path.join(root, "src/a.ts"), `export const GITHUB_TOKEN = "${credential}"\n`)
  const executable = Path.join(root, "security-reviewer.mjs")
  const answer = JSON.stringify({
    status: "completed",
    coverage: [{ checkId: "general", status: "completed", evidence: credential }],
    missingContext: [],
    findings: []
  })
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nlet p='';for await(const c of process.stdin)p+=c;const answer=${
      JSON.stringify(answer)
    };process.stdout.write(process.argv.includes('exec')?JSON.stringify({type:'item.completed',item:{type:'agent_message',text:answer}})+'\\n'+JSON.stringify({type:'turn.completed'})+'\\n':JSON.stringify({type:'result',subtype:'success',is_error:false,result:answer}))`
  )
  await Fs.chmod(executable, 0o755)
  const failure = await Effect.runPromise(
    Effect.flip(LlmLint.review({ workspaceRoot: root, executable }, { ...reviewPayload, securityChecks: ["general"] }))
  )
  expect(failure).toBeInstanceOf(LlmLint.FindingsError)
  const findings = (failure as LlmLint.FindingsError).findings
  expect(findings).toEqual([
    expect.objectContaining({
      file: "src/a.ts",
      line: 1,
      severity: "error",
      security: expect.objectContaining({ impact: "high", releaseRecommendation: "block" })
    })
  ])
  expect(JSON.stringify(failure)).not.toContain(credential)
})

it("redacts multiline private keys including JSON escaped reflected findings", async () => {
  const credential = "-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=\n-----END PRIVATE KEY-----"
  await Fs.writeFile(Path.join(root, "src/a.ts"), `export const signingKey = ${JSON.stringify(credential)}\n`)
  // Supply the actual multiline PEM in context as well as its JSON source representation.
  await Fs.writeFile(Path.join(root, "signing.pem"), credential)
  const executable = Path.join(root, "pem-reviewer.mjs")
  const record = Path.join(root, "pem-prompt.txt")
  const answer = JSON.stringify([{ file: "src/a.ts", line: 1, severity: "warning", message: credential }])
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';let p='';for await(const c of process.stdin)p+=c;writeFileSync(${
      JSON.stringify(record)
    },p);process.stdout.write(JSON.stringify({result:${JSON.stringify(answer)}}))`
  )
  await Fs.chmod(executable, 0o755)
  const failure = await Effect.runPromise(
    Effect.flip(
      LlmLint.review({ workspaceRoot: root, executable }, { ...reviewPayload, context: [Input.glob("signing.pem")] })
    )
  )
  const prompt = await Fs.readFile(record, "utf8")
  expect(prompt).not.toContain("YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=")
  expect(failure).toBeInstanceOf(LlmLint.FindingsError)
  expect(JSON.stringify(failure)).not.toContain("YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=")
  expect((failure as LlmLint.FindingsError).findings).toEqual(
    expect.arrayContaining([expect.objectContaining({ file: "signing.pem", line: 1, severity: "error" })])
  )
})
