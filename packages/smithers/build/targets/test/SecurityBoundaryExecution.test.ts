import * as Effect from "effect/Effect"
import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Smithers } from "../src/index.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as SecurityReview from "../src/SecurityReview.ts"
import * as Target from "../src/Target.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const git = (...args: ReadonlyArray<string>): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, encoding: "utf8" },
      (error) => (error === null ? resolve() : reject(error))
    )
  })

interface FakeCall {
  readonly args: ReadonlyArray<string>
  readonly stdin: string
}

const scriptCli = async (name: string, body: string): Promise<string> => {
  const executable = NodePath.join(root, `${name}.mjs`)
  await Fs.writeFile(executable, `#!/usr/bin/env node\n${body}\n`, "utf8")
  await Fs.chmod(executable, 0o755)
  return executable
}

const codexEnvelope = (findings: string): string =>
  [
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "reasoning", text: "[ignored]" }
    }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: findings }
    }),
    JSON.stringify({ type: "turn.completed", usage: { output_tokens: 5 } }),
    ""
  ].join("\n")

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-security-boundary-")))
  await git("init", "--initial-branch=main")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("SecurityReview boundary execution", () => {
  it("runs for a backend-only edit and reads the full boundary in every batch", async () => {
    const files = {
      "packages/web/src/caller.ts": "caller fixture: sends tenant request\n",
      "packages/auth/src/authorize.ts": "authorization fixture: checks tenant identity\n",
      "packages/backend/src/service.ts": "service fixture: performs authorized action\n",
      "packages/storage/src/write.ts": "storage fixture: writes tenant data\n"
    }
    for (const [path, content] of Object.entries(files)) await write(path, content)
    await git("add", ".")
    await git("commit", "-m", "boundary fixture")

    const boundary: SecurityReview.Boundary = {
      id: "tenant-write",
      actors: ["Tenant member"],
      assets: ["Tenant data"],
      entryPoints: ["Browser request"],
      identityTransformations: ["Session becomes tenant identity"],
      enforcementPoints: ["Authorize tenant before write"],
      deploymentAssumptions: ["Storage uses tenant-scoped credentials"],
      path: {
        caller: ["src/caller.ts"],
        authorization: ["//packages/auth/src/authorize.ts"],
        service: ["//packages/backend/src/service.ts"],
        storageOrEgress: ["//packages/storage/src/write.ts"]
      }
    }
    const target = Smithers.SecurityReview({
      cwd: "packages/web",
      checks: [],
      boundaries: [boundary],
      workspaceRoot: root,
      base: "HEAD",
      batchSize: 1
    }).security
    const attrs = Target.metadata(target).attrs as LlmLint.Attrs
    const reviewPayload: LlmLint.Payload = {
      base: attrs.changes.base,
      include: attrs.include,
      context: attrs.context,
      prompt: attrs.prompt,
      rubric: attrs.rubric,
      engine: attrs.engine,
      model: attrs.model,
      batchSize: attrs.batchSize,
      failOn: attrs.failOn,
      securityChecks: attrs.securityChecks,
      scope: attrs.scope
    }
    const answer = JSON.stringify({
      status: "completed",
      coverage: attrs.securityChecks?.map((checkId) => ({
        checkId,
        status: "completed",
        evidence: "Inspected this boundary across all supplied files."
      })),
      missingContext: [],
      findings: []
    })
    const record = NodePath.join(root, "boundary-review.calls")
    const executable = await scriptCli(
      "boundary-review",
      "import { appendFileSync } from 'node:fs'\n" +
        "let stdin = ''\n" +
        "for await (const chunk of process.stdin) stdin += chunk\n" +
        `appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), stdin }) + '\\n')\n` +
        `process.stdout.write(process.argv.includes('exec') ? ${JSON.stringify(codexEnvelope(answer))} : ${
          JSON.stringify(
            JSON.stringify({
              type: "result",
              subtype: "success",
              is_error: false,
              stop_reason: "end_turn",
              result: answer
            })
          )
        })\n`
    )
    await write("packages/backend/src/service.ts", "service fixture: rejects a foreign tenant\n")
    const backendOnly = await Effect.runPromise(
      LlmLint.review({ workspaceRoot: root, executable }, reviewPayload)
    )
    expect(backendOnly.files).toEqual(["packages/backend/src/service.ts"])

    await write("packages/auth/src/authorize.ts", "authorization fixture: checks the current tenant\n")
    const twoBatches = await Effect.runPromise(
      LlmLint.review({ workspaceRoot: root, executable }, reviewPayload)
    )
    expect(twoBatches.files).toEqual(["packages/auth/src/authorize.ts", "packages/backend/src/service.ts"])
    const calls = (await Fs.readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as FakeCall)
    expect(calls).toHaveLength(9)
    expect(calls.filter((call) => call.args.includes("exec"))).toHaveLength(3)
    expect(calls.filter((call) => call.args.includes("-p"))).toHaveLength(6)
    for (const [index, call] of calls.entries()) {
      for (
        const [path, content] of Object.entries({
          ...files,
          "packages/auth/src/authorize.ts": index < 3
            ? files["packages/auth/src/authorize.ts"]
            : "authorization fixture: checks the current tenant\n",
          "packages/backend/src/service.ts": "service fixture: rejects a foreign tenant\n"
        })
      ) {
        expect(call.stdin).toContain(`--- CONTEXT FILE: ${JSON.stringify(path)} ---`)
        expect(call.stdin).toContain(content.trimEnd())
      }
      expect(call.stdin).toContain("tenant-write")
    }
    expect(calls[0]?.stdin).toContain("--- CHANGED FILE: \"packages/backend/src/service.ts\" ---")

    const incompleteAnswer = JSON.stringify({
      status: "completed",
      coverage: [{ checkId: "general", status: "completed", evidence: "Inspected the general check." }],
      missingContext: [],
      findings: []
    })
    const incompleteCli = await scriptCli(
      "missing-boundary-coverage",
      `process.stdout.write(process.argv.includes('exec') ? ${JSON.stringify(codexEnvelope(incompleteAnswer))} : ${
        JSON.stringify(JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          stop_reason: "end_turn",
          result: incompleteAnswer
        }))
      })`
    )
    const incomplete = await Effect.runPromise(Effect.flip(
      LlmLint.review({ workspaceRoot: root, executable: incompleteCli }, reviewPayload)
    ))
    expect(incomplete).toMatchObject({ phase: "parse" })
    expect(incomplete.message).toContain("incomplete coverage")
  })
})
