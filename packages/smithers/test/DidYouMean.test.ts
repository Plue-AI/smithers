/**
 * The suggestion an unknown command earns, the cases that withhold it, and the
 * line a Jev failure leaves in its place.
 *
 * The decision runs on `Evaluator.layerScripted`, so no case needs a gateway
 * key or a socket. The scripted layer records the request, which is how the
 * outbound state and the offered options are pinned: they are what Jev reads.
 * The last two cases drive the real command tree with no key configured, so
 * the wiring at the call site is exercised too.
 */
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, type Layer } from "effect"
import { Cli as Incur } from "incur"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { cli as compatibility } from "../src/Command.ts"
import { commands, didYouMean } from "../src/DidYouMean.ts"
import * as Unsupported from "../src/Unsupported.ts"
import * as Verb from "../src/Verb.ts"

const tree = makeCli({ environment: {} })
await Promise.all(Incur.toPending.get(tree as never) ?? [])
const candidates = commands(tree)

const asked: Array<Evaluator.Request> = []

const scripted = (answer: Evaluator.ScriptedAnswer) =>
  Evaluator.layerScripted((request) => {
    asked.push(request)
    return Object.fromEntries(
      Object.entries(request.questions).map(([key, question]) => {
        const choice = "choice" in answer ? answer.choice : undefined
        return [
          key,
          choice === "none" || choice !== undefined && Object.hasOwn(question.criteria ?? {}, choice)
            ? answer :
            { choice: "none", probabilities: { none: 0.99 } }
        ]
      })
    )
  })

const ask = (
  typed: string,
  args: ReadonlyArray<string>,
  evaluator: Layer.Layer<Evaluator.Evaluator>
): Promise<string | undefined> => {
  asked.length = 0
  return Effect.runPromise(didYouMean(typed, args, candidates).pipe(Effect.provide(evaluator)))
}

describe("didYouMean", () => {
  it("suggests the verb Jev names when it is sure enough", async () => {
    const line = await ask(
      "stauts",
      ["run-42"],
      scripted({ choice: "runs show", probabilities: { "runs show": 0.93 } })
    )

    expect(line).toBe("Did you mean: smthrs runs show?")
  })

  it("sends the typed verb and the rest of the command line as the state", async () => {
    await ask("stauts", ["run-42", "--json"], scripted({ choice: "none" }))

    expect(asked).toHaveLength(1)
    expect(asked[0]!.state).toEqual({ typed: "stauts", args: "run-42 --json" })
  })

  it("offers every canonical command, described by its own help line, plus none", async () => {
    await ask("stauts", [], scripted({ choice: "none" }))

    const questions = Object.values(asked[0]!.questions)
    for (const question of questions) {
      expect(question.type).toBe("choice")
      expect(Object.keys(question.criteria ?? {}).length).toBeLessThanOrEqual(255)
    }
    const criteria = Object.assign({}, ...questions.map((question) => question.criteria)) as Record<string, string>
    expect(Object.keys(criteria).filter((key) => key !== "none")).toEqual(candidates.map((command) => command.name))
    expect(criteria["runs show"]).toBe(candidates.find((command) => command.name === "runs show")!.description)
  })

  it("offers exactly the canonical manifest's commands and no hidden spelling", async () => {
    let manifest = ""
    await makeCli({ environment: {} }).serve(["--llms-full", "--format", "json"], {
      env: {},
      stdout: (text) => {
        manifest += text
      },
      exit: () => {}
    })
    const canonical = (JSON.parse(manifest) as { commands: ReadonlyArray<{ name: string }> }).commands
      .map((command) => command.name)
    const topLevel = new Set(canonical.map((name) => name.split(" ")[0]!))
    const hidden = [
      ...Verb.shipped.flatMap((verb) => [verb.name, ...verb.aliases]),
      ...compatibility.subcommands.flatMap((group) => group.commands.map((command) => command.name)),
      ...Unsupported.removedVerbs.map((verb) => verb.name)
    ].filter((name) => !topLevel.has(name))

    expect(hidden).toEqual(expect.arrayContaining(["ls", "ps", "up", "approve", "status", "logs"]))
    const names = candidates.map((command) => command.name)
    expect(new Set(names)).toEqual(new Set(canonical))
    expect(names.filter((name) => hidden.includes(name.split(" ")[0]!))).toEqual([])
  })

  it("says nothing when Jev answers none", async () => {
    expect(await ask("qqqq", [], scripted({ choice: "none", probabilities: { none: 0.99 } }))).toBeUndefined()
  })

  it("says nothing below the confidence floor", async () => {
    const unsure = scripted({ choice: "doctor", probabilities: { doctor: 0.5, gc: 0.5 } })

    expect(await ask("stauts", [], unsure)).toBeUndefined()
  })

  it("names the failure when Jev cannot be asked", async () => {
    const line = await ask("stauts", [], Evaluator.layerUnavailable())

    expect(line).toBe("Could not ask Jev for a suggestion: unreachable")
    expect(asked).toHaveLength(0)
  })

  it("never asks about a removed verb, whose migration prose stands alone", async () => {
    const refused = Unsupported.refusal(["rewind"])!

    expect(refused.message).toContain("smthrs rewind was removed in 1.0.0-rc.0")
    expect(await ask("rewind", [], scripted({ choice: "doctor", probabilities: { doctor: 0.99 } }))).toBeUndefined()
    expect(asked).toHaveLength(0)
  })

  it("never asks about a command the tree serves", async () => {
    const confident = scripted({ choice: "doctor", probabilities: { doctor: 0.99 } })

    expect(await ask("doctor", [], confident)).toBeUndefined()
    expect(asked).toHaveLength(0)
  })
})

const invoke = async (argv: Array<string>) => {
  const codes: Array<number> = []
  let stdout = ""
  await makeCli({ environment: {}, exit: (code) => codes.push(code) }).serve(argv, {
    env: {},
    exit: (code) => codes.push(code),
    stdout: (text) => {
      stdout += text
    }
  })
  return { codes, stdout }
}

describe("the unknown verb the parser refuses", { timeout: 120_000 }, () => {
  /**
   * The wiring, on the real command tree, with no gateway key: the parser's
   * refusal keeps its code and its exit status, the line names the transport
   * it could not reach, and no handler ran to print it.
   */
  it("gains one line under the refusal, and the exit code is the parser's", async () => {
    const { codes, stdout } = await invoke(["stauts"])

    expect(stdout).toContain("COMMAND_NOT_FOUND")
    expect(stdout.trimEnd().endsWith("Could not ask Jev for a suggestion: unreachable")).toBe(true)
    expect(codes).toEqual([1])
  })

  it("leaves a command that runs alone", async () => {
    const { codes, stdout } = await invoke(["--version"])

    expect(stdout).not.toContain("Jev")
    expect(codes).toEqual([])
  })
})
