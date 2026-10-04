import { describe, expect, test } from "bun:test"
import {
  COMMANDS_SELECT_PATH,
  CommandSelectError,
  commandSelectRequest,
  disclosedCommandNames,
  httpCommandSelector,
  parseSelection,
  pinnedCommandNames,
  selectFailureOf,
  selectFailureText,
  selectFailureToolResult,
  SELECT_MESSAGE_MAX_CHARS
} from "./CommandSelection"
import type { CommandSelectFailureReason } from "./CommandSelection"
import { STANDING_INSTRUCTION_TEXT } from "./Instructions"

const offered = [
  { name: "theme", summary: "Switch to light or dark mode" },
  { name: "runs.list", summary: "List runs" }
]

const reasonOf = async (promise: Promise<unknown>): Promise<CommandSelectFailureReason> => {
  try {
    await promise
  } catch (error) {
    if (error instanceof CommandSelectError) return error.reason
    throw error
  }
  throw new Error("expected a CommandSelectError")
}

describe("parseSelection", () => {
  test("keeps the server's order, drops names the request never offered and repeats", () => {
    expect(parseSelection({ commands: [
      { name: "runs.list", probability: 0.6 },
      { name: "rm.rf", probability: 0.3 },
      { name: "theme", probability: 0.1 },
      { name: "runs.list", probability: 0.05 }
    ] }, offered)).toEqual([{ name: "runs.list", probability: 0.6 }, { name: "theme", probability: 0.1 }])
  })

  test("an empty selection is an answer, not a failure", () => {
    expect(parseSelection({ commands: [] }, offered)).toEqual([])
  })

  test.each([
    ["no body", null],
    ["no commands", {}],
    ["commands not a list", { commands: "runs.list" }],
    ["a row without a probability", { commands: [{ name: "runs.list" }] }],
    ["a non-finite probability", { commands: [{ name: "runs.list", probability: Number.NaN }] }],
    ["a row that is not an object", { commands: ["runs.list"] }]
  ])("%s is the empty-decision failure", (_label, body) => {
    expect(() => parseSelection(body, offered)).toThrow(CommandSelectError)
    try { parseSelection(body, offered) } catch (error) { expect((error as CommandSelectError).reason).toBe("empty") }
  })
})

describe("selectFailureOf", () => {
  test.each([
    [401, "sign_in"], [403, "sign_in"], [402, "credit"], [429, "rate_limited"], [504, "timeout"],
    [404, "unavailable"], [503, "unavailable"], [400, "http"], [500, "http"], [502, "http"]
  ] as const)("HTTP %i is %s", (status, reason) => {
    expect(selectFailureOf(status)).toBe(reason)
  })
})

describe("httpCommandSelector", () => {
  const request = commandSelectRequest({ message: "switch to dark mode", earlier: [], repo: null, commands: offered })

  test("posts the request to the select route and answers the parsed selection", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const select = httpCommandSelector(async (url, init) => {
      calls.push({ url, init })
      return Response.json({ commands: [{ name: "theme", probability: 0.99 }], model: "typesafe-ai/jev" })
    }, "https://smithers.example")
    expect(await select(request)).toEqual([{ name: "theme", probability: 0.99 }])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://smithers.example${COMMANDS_SELECT_PATH}`)
    expect(calls[0]!.init?.method).toBe("POST")
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(request)
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
  })

  test.each([[401, "sign_in"], [402, "credit"], [504, "timeout"], [502, "http"], [503, "unavailable"]] as const)(
    "a %i answer rejects as %s", async (status, reason) => {
      const select = httpCommandSelector(async () => Response.json({ status: "error" }, { status }), "")
      expect(await reasonOf(select(request))).toBe(reason)
    })

  test("a body that is not JSON is the empty-decision failure", async () => {
    const select = httpCommandSelector(async () => new Response("<html>", { status: 200 }), "")
    expect(await reasonOf(select(request))).toBe("empty")
  })

  test("a network failure is http, and the client deadline is timeout", async () => {
    expect(await reasonOf(httpCommandSelector(async () => { throw new TypeError("fetch failed") }, "")(request))).toBe("http")
    const hanging = httpCommandSelector((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
    }), "", 20)
    const started = Date.now()
    expect(await reasonOf(hanging(request))).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe("commandSelectRequest", () => {
  test("the tail is the earlier conversation without act lines, the repo only a hosted owner/name", () => {
    const built = commandSelectRequest({
      message: "  and now dark mode  ",
      earlier: [
        { role: "user", text: "hi", act: undefined },
        { role: "smithers", text: "Smithers ran /runs.list", act: "Smithers ran /runs.list" },
        { role: "smithers", text: "Hello.", act: undefined }
      ],
      repo: "smithersai/smithers",
      commands: [...offered, { name: "x.y", summary: "s", args: "<a>" }]
    })
    expect(built.message).toBe("and now dark mode")
    expect(built.tail).toEqual([{ role: "user", text: "hi" }, { role: "assistant", text: "Hello." }])
    expect(built.repo).toBe("smithersai/smithers")
    expect(built.commands.at(-1)).toEqual({ name: "x.y", summary: "s" })
    expect(commandSelectRequest({ message: "x", earlier: [], repo: "/Users/me/checkout", commands: [] }).repo).toBeNull()
  })

  test("an over-long message keeps its newest characters", () => {
    const message = `${"a".repeat(SELECT_MESSAGE_MAX_CHARS)}TAIL`
    const built = commandSelectRequest({ message, earlier: [], repo: null, commands: [] })
    expect(built.message).toHaveLength(SELECT_MESSAGE_MAX_CHARS)
    expect(built.message.endsWith("TAIL")).toBe(true)
  })
})

describe("pinnedCommandNames", () => {
  const catalog = [
    { name: "auth.prompt" }, { name: "debug.errors" }, { name: "chat" }, { name: "wiki" },
    { name: "theme" }, { name: "files.read" }, { name: "auth" }
  ]

  test("the real standing instructions pin the commands they name, and only dotted names", () => {
    const pinned = pinnedCommandNames(STANDING_INSTRUCTION_TEXT, catalog)
    expect(pinned).toContain("auth.prompt")
    expect(pinned).toContain("debug.errors")
    expect(pinned).toContain("files.read")
    expect(pinned).not.toContain("chat")
    expect(pinned).not.toContain("wiki")
    expect(pinned).not.toContain("auth")
    expect(pinned).not.toContain("theme")
  })

  test("a name matches whole: a prefix or a longer dotted name is not a mention", () => {
    expect(pinnedCommandNames("execute files.read.all and auth.prompts", catalog)).toEqual([])
    expect(pinnedCommandNames("run /files.read, then auth.prompt.", catalog)).toEqual(["auth.prompt", "files.read"])
  })
})

describe("disclosedCommandNames", () => {
  test("newest user message first, deduplicated, smithers rows ignored, bounded", () => {
    const messages = [
      { role: "user" as const, disclosed: ["runs.list", "a.b"] },
      { role: "smithers" as const, disclosed: ["never.read"] },
      { role: "user" as const },
      { role: "user" as const, disclosed: ["c.d", "runs.list"] }
    ]
    expect(disclosedCommandNames(messages)).toEqual(["c.d", "runs.list", "a.b"])
    expect(disclosedCommandNames(messages, 2)).toEqual(["c.d", "runs.list"])
    expect(disclosedCommandNames([])).toEqual([])
  })
})

describe("failure copy", () => {
  test("the transcript line names the class and the retry door; the tool result carries the code", () => {
    expect(selectFailureText(new CommandSelectError("timeout"))).toBe(
      "Smithers could not choose commands for this message: the decision model did not answer in time. Nothing ran. Retry with /chat.retry.")
    expect(selectFailureText(new Error("boom"))).toContain("could not be reached")
    expect(selectFailureToolResult(new CommandSelectError("credit"))).toMatch(/^failed: commands_select_failed \(credit\):/)
  })
})
