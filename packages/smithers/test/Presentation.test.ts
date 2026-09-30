import * as Audience from "@smthrs/build-cli/Audience"
import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import { Cli } from "incur"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { agentArguments, formattedLogArguments, legacyArguments } from "../src/cli/Compatibility.ts"
import * as Presentation from "../src/cli/Presentation.ts"
import { createEvalCli } from "../src/evaluation/EvalCli.ts"
import { createCredentialsCli } from "../src/operator/Credentials.ts"
import { createIntegrationsCli } from "../src/operator/Integrations.ts"
import { createMemoryCli } from "../src/operator/Memory.ts"
import { createTriggersCli } from "../src/operator/Triggers.ts"

const fixture = (audience: "human" | "agent", tty = true, silent = false) => {
  const output: Array<string> = []
  const progress: Array<string> = []
  const presentation = Audience.resolve({ audience, env: {}, stdout: tty, stderr: tty, stdin: tty, silent })
  const runtime: RuntimeConfig = {
    environment: {},
    presentation,
    stdout: {
      write: (text) => {
        output.push(text)
      },
      isTTY: tty,
      columns: 80
    },
    stderr: {
      write: (text) => {
        progress.push(text)
      },
      isTTY: tty,
      columns: 80
    }
  }
  return { runtime, output, progress }
}
const ok = (data: unknown, meta?: unknown): never => ({ data, meta }) as never
const flowNext = [
  { command: "flow show review", description: "Inspect a discovered flow" },
  { command: "flow plan --help", description: "See how to preview a flow before starting it" }
]

describe("diagnostic redaction", () => {
  it("redacts diagnostic credential spellings in terminal fields and failure sentences", () => {
    expect(Presentation.clean("sshpass -p ZqSynthetic7Secret4Value9 ssh host")).toBe("sshpass -p [REDACTED] ssh host")
    let message = ""
    const context = {
      error: (error: { message: string }): never => {
        message = error.message
        throw new Error("failed")
      }
    } as unknown as Presentation.Failing
    expect(() => Presentation.fail(context, new Error("Authorization: Token ZqSynthetic7Secret4Value9"))).toThrow()
    expect(message).toBe("Authorization: [REDACTED]")
  })
})

describe("shared command presentation", () => {
  it("keeps agent PTY output structured with bounded contextual Incur CTAs", async () => {
    const host = fixture("agent")
    let result: unknown
    await Presentation.scope({ command: "flow start", globals: { audience: "auto" } }, host.runtime, async () => {
      result = Presentation.finish({ ok, options: { root: "/project", credential: "never-echo-this" } }, {
        runId: "run-1",
        _tag: "Accepted"
      })
    })
    expect(host.output).toEqual([])
    expect(host.progress).toEqual([])
    expect(result).toMatchObject({
      data: { runId: "run-1" },
      meta: {
        cta: {
          commands: [
            { command: "runs show run-1 --root /project" },
            { command: "runs logs run-1 --format jsonl --root /project" }
          ]
        }
      }
    })
    expect(JSON.stringify(result)).not.toContain("never-echo-this")
  })
  it("renders human results even when silent, without returning a second Incur document", async () => {
    const host = fixture("human", true, true)
    let result: unknown
    await Presentation.scope({ command: "runs show" }, host.runtime, async () => {
      result = Presentation.finish({ ok }, { runId: "run-1", status: "completed" })
    })
    expect(host.output.join("")).toContain("status: completed")
    expect(host.output.join("")).not.toContain("\u001b")
    expect(host.progress).toEqual([])
    expect(result).toMatchObject({ data: undefined })
  })
  it("omits undefined members from the human summary and keeps null, false, zero and empty values", async () => {
    const host = fixture("human", true, true)
    await Presentation.scope({ command: "workspace exec" }, host.runtime, async () => {
      Presentation.finish({ ok }, {
        exit_code: 0,
        stdout: undefined,
        stderr: undefined,
        parent: null,
        flag: false,
        text: "",
        nested: { gone: undefined, kept: 0 }
      })
    })
    const text = host.output.join("")
    expect(text).toContain("exit_code: 0")
    expect(text).toContain("parent: null")
    expect(text).toContain("flag: false")
    expect(text).toContain("kept: 0")
    expect(text).not.toMatch(/undefined|stdout|stderr|gone/)
  })
  it("prints a supplied human body in place of the summary and keeps the next actions", async () => {
    const host = fixture("human", true, true)
    let result: unknown
    await Presentation.scope({ command: "flow list" }, host.runtime, async () => {
      result = Presentation.finish({ ok }, { _tag: "flows", items: [{ flowId: "review", description: "Reviews." }] }, {
        human: "* review  Review the change.\n",
        next: flowNext
      })
    })
    expect(host.output.join("")).toBe(
      "flow list\n* review  Review the change.\nNext:\nsmthrs flow show review\nsmthrs flow plan --help\n"
    )
    expect(result).toMatchObject({ data: undefined })
  })
  it("ignores a human body for agents and keeps the document with its CTAs", async () => {
    const host = fixture("agent")
    let result: unknown
    const page = { _tag: "flows", items: [{ flowId: "review", description: "Reviews." }] }
    await Presentation.scope({ command: "flow list" }, host.runtime, async () => {
      result = Presentation.finish({ ok }, page, { human: "* review  Review the change.\n", next: flowNext })
    })
    expect(host.output).toEqual([])
    expect(result).toMatchObject({
      data: page,
      meta: { cta: { commands: [{ command: "flow show review" }, { command: "flow plan --help" }] } }
    })
  })
  it("never changes explicit JSON data or array response shapes", async () => {
    const host = fixture("human")
    const list = [{ key: "hello", value: "world" }]
    await Presentation.scope({ command: "memory facts list", formatExplicit: true }, host.runtime, async () => {
      expect(Presentation.finish({ ok }, list)).toBe(list)
    })
    expect(host.output).toEqual([])
  })
  it("isolates concurrent invocations without mutating terminal or environment state", async () => {
    const human = fixture("human", true, true)
    const agent = fixture("agent")
    await Promise.all([
      Presentation.scope({ command: "doctor" }, human.runtime, async () => {
        await Promise.resolve()
        expect(Presentation.current()?.policy.audience).toBe("human")
        Presentation.finish({ ok }, { root: "/human", checks: [] })
      }),
      Presentation.scope({ command: "flow list" }, agent.runtime, async () => {
        await Promise.resolve()
        expect(Presentation.current()?.policy.audience).toBe("agent")
        Presentation.finish({ ok }, { items: [] })
      })
    ])
    expect(Presentation.current()).toBeUndefined()
    expect(human.output.join("")).toContain("/human")
    expect(agent.output).toEqual([])
  })
  it("does not put credentials or whole approval payloads in next actions", () => {
    const actions = Presentation.nextActions({ approval: { secret: "private" } }, {
      options: { remote: "https://user:secret@example.invalid/?token=secret", credential: "private" }
    }, [{ command: "approvals approve --help", description: "Approve" }, {
      command: "flow execute --help",
      description: "Execute"
    }])
    expect(actions).toHaveLength(2)
    expect(JSON.stringify(actions)).not.toMatch(/secret|private|example/)
  })

  it("derives follow-ups from a declared function and bounds them to three", () => {
    const declared: Presentation.FollowUps = (data) =>
      ["a", "b", "c", "d"].map((name) => ({ command: `${name} ${String(data["flowId"])}`, description: name }))
    expect(Presentation.nextActions({ flowId: "review" }, {}, declared).map((action) => action.command))
      .toEqual(["a review", "b review", "c review"])
  })

  it.each(
    [
      [{ runId: "run-1" }, {}, ["runs show run-1", "runs logs run-1 --format jsonl"]],
      [{}, { run: "run-2" }, ["runs show run-2", "runs logs run-2 --format jsonl"]],
      [{}, {}, ["runs list"]]
    ] as const
  )("names a run from its result or arguments before falling back (%j %j)", (data, args, expected) => {
    const next = Presentation.runs({ otherwise: [{ command: "runs list", description: "List" }] })
    expect(Presentation.nextActions(data, { args }, next).map((action) => action.command)).toEqual(expected)
  })

  it("quotes run and connection arguments without exposing authenticated URLs", () => {
    const actions = Presentation.nextActions({ status: "waiting-approval" }, {
      args: { run: "run one's" },
      options: { root: "/a project", remote: "https://example.invalid/api" }
    }, Presentation.runs({ show: false }))
    expect(actions.map((action) => action.command)).toEqual([
      "runs logs 'run one'\\''s' --format jsonl --root '/a project' --remote https://example.invalid/api",
      "approvals list --root '/a project' --remote https://example.invalid/api"
    ])
    for (const remote of ["not a url", "https://example.invalid/#secret", "https://example.invalid/?key=secret"]) {
      expect(Presentation.nextActions({ runId: "run-1" }, { options: { remote } }, Presentation.runs({ show: false })))
        .toEqual([{ command: "runs logs run-1 --format jsonl", description: "Read detailed events only when needed" }])
    }
  })

  it("retains bounded approval guidance for a parked run and ignores non-record results", () => {
    expect(Presentation.nextActions({ runId: "run-1", _tag: "Parked" }).map((action) => action.command))
      .toEqual(["runs show run-1", "runs logs run-1 --format jsonl", "approvals list"])
    for (const value of [null, undefined, [], "run-1", 0]) {
      expect(Presentation.nextActions(value)).toEqual([])
    }
  })

  it.each(
    [
      [{ _tag: "/cli/UsageError", message: "bad flag" }, {}, "UsageError", 2],
      [
        { _tag: "/cli/UsageError", message: "bad flag" },
        { code: "operator_failed", exitCode: 5 },
        "operator_failed",
        2
      ],
      [{ _tag: "/control/Unavailable", message: "down" }, {}, "Unavailable", 1],
      [new Error("Authorization: Bearer private-fixture"), { code: "history_failed" }, "history_failed", 1],
      ["plain", { exitCode: 5 }, "command_failed", 5]
    ] as const
  )("reports %j through the one guard with a stable code and exit status", async (cause, refusal, code, exitCode) => {
    const errors: Array<unknown> = []
    const error = (value: unknown): never => {
      errors.push(value)
      return undefined as never
    }
    await Presentation.guard({ ok, error }, () => Promise.reject(cause), refusal)
    expect(errors).toEqual([{ code, exitCode, message: expect.not.stringContaining("private-fixture") }])
  })

  it.each(
    [
      [
        new TypeError("Cannot read properties of undefined (reading 'id')"),
        "Something went wrong on our side. Not your fault."
      ],
      [
        Object.assign(new Error("EACCES: permission denied, open '/etc/x'"), { syscall: "open", errno: -13 }),
        "Something went wrong on our side. Not your fault."
      ],
      [{ reason: "opaque" }, "Something went wrong on our side. Not your fault."],
      [new Error("No flows found in /work"), "No flows found in /work"]
    ] as const
  )("prints an undesigned failure as the generic sentence, never its raw text (%#)", async (cause, message) => {
    const errors: Array<unknown> = []
    const error = (value: unknown): never => {
      errors.push(value)
      return undefined as never
    }
    await Presentation.guard({ ok, error }, () => Promise.reject(cause))
    expect(errors).toEqual([{ code: "command_failed", exitCode: 1, message }])
  })

  it("preserves raw results outside a rendering invocation or without an ok adapter", async () => {
    const value = { runId: "run-1" }
    expect(Presentation.finish({ ok }, value)).toBe(value)
    const host = fixture("human", true, true)
    await Presentation.scope({ command: "runs show" }, host.runtime, async () => {
      expect(Presentation.finish({}, value)).toBe(value)
      expect(Presentation.finish({ ok }, undefined)).toBeUndefined()
    })
    expect(host.output).toEqual([])
  })

  it("keeps structured results intact when no continuation applies", async () => {
    const host = fixture("agent")
    const value = { version: "1.0.0" }
    await Presentation.scope({ command: "info" }, host.runtime, async () => {
      expect(Presentation.finish({ ok }, value)).toBe(value)
    })
    expect(host.output).toEqual([])
  })

  it("limits human summaries by entry count and depth while retaining complete JSON results", async () => {
    const host = fixture("human", true, true)
    const details = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`key${index}`, index]))
    const value = { details, empty: [], nested: { deeper: { leaf: { secret: "not-rendered" }, array: [1, 2] } } }
    await Presentation.scope({ command: "info" }, host.runtime, async () => {
      Presentation.finish({ ok }, value)
    })
    expect(host.output.join("")).toBe(
      "info\ndetails\n" +
        Array.from({ length: 18 }, (_, index) => `  key${index}: ${index}`).join("\n") +
        "\n  … 2 more; use --json for full details\nempty: none\nnested\n  deeper\n    leaf\n" +
        "      Use --json for full details\n    array\n      2 items\n"
    )
    expect(value.details["key19"]).toBe(19)
    expect(value.nested.deeper.array).toEqual([1, 2])
  })

  it("sanitizes terminal controls and limits a primitive result to 500 characters", async () => {
    const host = fixture("human", true, true)
    await Presentation.scope({ command: "info" }, host.runtime, async () => {
      Presentation.finish({ ok }, "\u001b[31mred\u001b[0m\u0007\u202e" + "x".repeat(600))
    })
    expect(host.output.join("")).toBe(`info\nred ${"x".repeat(496)}\n`)
  })

  it("renders an empty result as Done and formats top-level arrays consistently", async () => {
    const host = fixture("human", true, true)
    await Presentation.scope({ command: "info" }, host.runtime, async () => {
      Presentation.finish({ ok }, {})
      Presentation.finish({ ok }, ["first", null])
    })
    expect(host.output.join("")).toBe("info\nDone\ninfo\n1: first\n2: null\n")
  })

  it("normalizes MCP command names and releases context after a failed invocation", async () => {
    const host = fixture("human")
    const failure = new Error("command failed")
    await expect(Presentation.scope({ command: "runs_show", request: {} }, host.runtime, async () => {
      expect(Presentation.current()?.command).toBe("runs show")
      expect(Presentation.current()?.policy.structured).toBe(true)
      throw failure
    })).rejects.toBe(failure)
    expect(Presentation.current()).toBeUndefined()
    expect(host.output).toEqual([])
  })
})

describe("agent-friendly compatibility spellings", () => {
  it("routes familiar bot commands to canonical results", () => {
    expect(agentArguments(["up", "hello", "--silent"])).toEqual(["flow", "start", "hello", "--silent"])
    expect(formattedLogArguments(["logs", "run-1", "--format", "jsonl", "--after", "4", "--limit", "2"]))
      .toEqual(["runs", "logs", "run-1", "--format", "jsonl", "--after", "4", "--limit", "2"])
    expect(formattedLogArguments(["--audience", "human", "--format=jsonl", "logs", "run-1"]))
      .toEqual(["runs", "logs", "--audience", "human", "--format=jsonl", "run-1"])
    expect(formattedLogArguments(["logs", "run-1"])).toBeUndefined()
    expect(formattedLogArguments(["logs", "run-1", "--json"])).toBeUndefined()
    expect(formattedLogArguments(["logs", "run-1", "--format", "jsonl", "--backend=sqlite"])).toBeUndefined()
    expect(formattedLogArguments(["--backend", "sqlite", "logs", "run-1", "--format", "jsonl"])).toBeUndefined()
    expect(legacyArguments(["init", "change", "--global"])).toBeUndefined()
    expect(agentArguments(["--audience", "agent", "ps"])).toEqual(["runs", "list", "--audience", "agent"])
    expect(legacyArguments(["--audience", "human", "up", "hello", "--silent"])).toBeDefined()
  })
  it("preserves explicit legacy machine contracts and removed-option diagnostics", () => {
    expect(agentArguments(["up", "hello", "--json"])).toBeUndefined()
    expect(agentArguments(["ps", "--quiet"])).toBeUndefined()
    expect(agentArguments(["up", "hello", "--serve"])).toBeUndefined()
    expect(agentArguments(["internal", "claude", "tick"])).toBeUndefined()
    expect(agentArguments(["up", "--help"])).toBeUndefined()
    // `bug` with no words is the 0.x spelling the legacy parser still owns.
    expect(legacyArguments(["bug"])).toEqual(["bug"])
    expect(legacyArguments(["bug", "it", "broke"])).toBeUndefined()
    // An alias missing its positional keeps the legacy parser's typed usage
    // error instead of becoming a canonical one.
    expect(agentArguments(["resume"])).toBeUndefined()
    expect(agentArguments(["resume", "--verbose"])).toBeUndefined()
  })
})

describe("declared follow-ups per command group", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-presentation-next-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  it.each(
    [
      [["credentials", "list"], "smthrs credentials list --root"],
      [["integrations", "list"], "smthrs integrations list --root"],
      [["triggers", "list"], "smthrs triggers list --root"],
      [["memory", "list", "--namespace", "user:alpha"], "smthrs memory recall --help --root"],
      [["eval", "list"], "smthrs eval compare --help --root"]
    ] as const
  )("%j shows the group's declared follow-up", async (argv, expected) => {
    const host = fixture("human", true, true)
    const codes: Array<number> = []
    let document = ""
    const cli = Cli.create("smthrs")
      .command(createCredentialsCli())
      .command(createIntegrationsCli())
      .command(createTriggersCli())
      .command(createMemoryCli())
      .command(createEvalCli(host.runtime))
    cli.use((context, next) => Presentation.scope(context, host.runtime, next))
    await cli.serve([...argv, "--root", root], {
      stdout: (text) => {
        document += text
      },
      exit: (code) => {
        codes.push(code)
      }
    })
    expect(codes, document).toEqual([])
    expect(host.output.join("")).toContain(`Next:\n${expected} ${root}`)
  })
})
