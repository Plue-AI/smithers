import { describe, expect, test } from "vitest"
import { commandsToolSpec, decodeCommandsCall, unknownCommandResult, unknownToolResult } from "../src/AgentCommands.ts"

describe("the app agent's one tool", () => {
  test("is the commands tool with its list and execute actions", () => {
    expect(commandsToolSpec.name).toBe("commands")
    expect(commandsToolSpec.parameters).toMatchObject({
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: { action: { enum: ["list", "execute"] } }
    })
  })

  test("decodes a list with its namespace and query bare", () => {
    expect(decodeCommandsCall(JSON.stringify({ action: "list" }))).toEqual({ action: "list", namespace: "", query: "" })
    expect(decodeCommandsCall(JSON.stringify({ action: "list", namespace: " /files. ", query: "  read a file " })))
      .toEqual({ action: "list", namespace: "files", query: "read a file" })
    expect(decodeCommandsCall(JSON.stringify({ action: "list", namespace: 7, query: false })))
      .toEqual({ action: "list", namespace: "", query: "" })
  })

  test("decodes an execute with the model's slash stripped and its argument text kept", () => {
    expect(decodeCommandsCall(JSON.stringify({ action: "execute", name: "//files.read ", args: " JOURNEY.md" })))
      .toEqual({ action: "execute", name: "files.read", args: " JOURNEY.md" })
    expect(decodeCommandsCall(JSON.stringify({ action: "execute", name: "files.read", args: 3 })))
      .toEqual({ action: "execute", name: "files.read", args: undefined })
  })

  test("answers the failure the model reads for anything else", () => {
    for (
      const [raw, failure] of [
        ["not json", "failed: the commands tool arguments were not valid JSON"],
        ["null", "failed: the commands tool arguments must be an object"],
        ["[]", "failed: the commands tool arguments must be an object"],
        ["\"list\"", "failed: the commands tool arguments must be an object"],
        [JSON.stringify({ action: "run" }), "failed: the commands tool action must be \"list\" or \"execute\""],
        [JSON.stringify({}), "failed: the commands tool action must be \"list\" or \"execute\""],
        [JSON.stringify({ action: "execute" }), "failed: the execute action requires a command name"],
        [JSON.stringify({ action: "execute", name: " / " }), "failed: the execute action requires a command name"],
        [JSON.stringify({ action: "execute", name: 5 }), "failed: the execute action requires a command name"]
      ] as const
    ) {
      expect(decodeCommandsCall(raw)).toEqual({ failure })
    }
  })

  test("names an unknown tool and an unknown command with the way back", () => {
    expect(unknownToolResult("shell")).toBe("unknown-tool: shell")
    expect(unknownCommandResult("files.write")).toBe(
      "unknown-command: files.write — no command has that name; use the list action for every command callable right now"
    )
  })
})
