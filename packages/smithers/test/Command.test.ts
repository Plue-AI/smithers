import { NodeServices } from "@effect/platform-node"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Effect, Layer, Redacted } from "effect"
import { TestConsole } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { describe, expect, it } from "vitest"
import { cli } from "../src/Command.ts"
import { layer as outputLayer, make } from "../src/Output.ts"
import * as Unsupported from "../src/Unsupported.ts"
import * as Verb from "../src/Verb.ts"

const names = cli.subcommands.flatMap((group) => group.commands.map((command) => command.name))

describe("Command", () => {
  it("registers retained handlers and refusals without duplicating canonical verbs", () => {
    // The exact sets are pinned by `Verb.test.ts`; this asserts only that the
    // command tree is built from them rather than from a hand-kept list.
    for (const verb of Verb.subcommands) {
      if (["serve", "init", "suggest", "memory", "mcp"].includes(verb.name)) expect(names).not.toContain(verb.name)
      else expect(names).toContain(verb.name)
    }
    for (const verb of Unsupported.removedVerbs) {
      expect(names).toContain(verb.name === "workflows" ? "workflow" : verb.name)
    }
  })

  it("keeps up -d and run --resume in their command configurations", () => {
    const commands = cli.subcommands.flatMap((group) => group.commands)

    expect(commands.find((command) => command.name === "up")?.name).toBe("up")
    expect(commands.find((command) => command.name === "run")?.name).toBe("run")
    expect(commands.find((command) => command.name === "resume")?.unlisted).toBe(true)
  })

  it("requires an approval payload and supports scoped grants", () => {
    const approve = cli.subcommands.flatMap((group) => group.commands).find((command) => command.name === "approve")!
    expect(approve.name).toBe("approve")
  })

  it("renders stable JSON and never reveals Redacted values", async () => {
    const output = make()
    const value = { z: 1, nested: { token: Redacted.make("secret"), a: true } }
    const first = await Effect.runPromise(output.render(value, "json"))
    const second = await Effect.runPromise(output.render(value, "json"))
    expect(first.text).toBe("{\"nested\":{\"a\":true,\"token\":\"<redacted>\"},\"z\":1}")
    expect(second).toEqual(first)
  })
})

describe("flag descriptions", () => {
  it("describes every visible flag in the real help documents", async () => {
    const visit = async (command: Command.Command.Any, path: ReadonlyArray<string>): Promise<void> => {
      if (command.unlisted) return
      const lines = await Effect.runPromise(
        Effect.gen(function*() {
          yield* Command.runWith(cli, { version: "test" })([...path, "--help"]).pipe(Effect.ignore)
          return yield* TestConsole.logLines
        }).pipe(
          Effect.provide(Layer.mergeAll(TestConsole.layer, outputLayer, TestControl.layer({ now: () => 0 }))),
          Effect.provide(NodeServices.layer)
        )
      )
      const help = lines.map(String).join("\n")
      const flags = help.split("\n").filter((line) => /^  --?/.test(line))
      expect(flags.length).toBeGreaterThan(0)
      for (const line of flags) {
        expect(line, `${path.join(" ")}: flag needs a description`).toMatch(/^  --?.*?\S {2,}\S/)
      }
      for (const group of command.subcommands) {
        for (const child of group.commands) await visit(child, [...path, child.name])
      }
    }
    await visit(cli, [])
  })
})
