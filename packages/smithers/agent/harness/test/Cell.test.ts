import * as Descriptor from "@smthrs/registry/Descriptor"
import { Option, Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as FlowBinding from "../src/FlowBinding.ts"
import { batchedReply } from "./fixtures/batchedReplies.ts"
import { rejectedCell, rejectedCellNames } from "./fixtures/rejectedCells.ts"

const fenced = (info: string, body: string): string => "```" + info + "\n" + body + "\n```"

describe("Cell.extract", () => {
  it("runs every fenced cell of a reply, in order, as one program", () => {
    // Wave 10's django frame 1 wrote a near-par program as seven blocks and
    // the harness ran block seven — the imagined completion — against a tree
    // where blocks one through six had never run. Every block is the frame now.
    const text = [
      "First I look:",
      fenced("cell", "const files = await ctx.call(\"fs/list\", { path: \".\" })"),
      "then I decide:",
      fenced("cell", "ctx.done(files.length + \" entries\")")
    ].join("\n\n")

    const extracted = Result.getOrThrow(Cell.extract(text))
    expect(extracted.source.text).toBe(
      "const files = await ctx.call(\"fs/list\", { path: \".\" })\n" +
        "ctx.done(files.length + \" entries\")"
    )
    expect(extracted.source.language).toBe("javascript")
    expect(extracted.blocks).toBe(2)
  })

  it("counts one block for the ordinary single-cell reply", () => {
    const extracted = Result.getOrThrow(Cell.extract(fenced("cell", "return 1")))
    expect(extracted.blocks).toBe(1)
    expect(extracted.source.text).toBe("return 1")
  })

  it("drops a byte-identical repeat of a block instead of declaring its names twice", () => {
    // Wave 10's astropy multi-block reply is the same state-echo block twice.
    // A repeat is one program restated, never a second step.
    const echo = "const s = ctx.state\nreturn { intent: \"continue\", state: s, context: [] }"
    const extracted = Result.getOrThrow(Cell.extract([fenced("cell", echo), fenced("cell", echo)].join("\n\n")))
    expect(extracted.source.text).toBe(echo)
    expect(extracted.blocks).toBe(2)
  })

  it("stops at the first block that returns, because a return ends the function", () => {
    // The documented semantics of concatenation, stated as a test rather than
    // as prose: block two is dead code the compiler still has to accept. The
    // blocks keep the old filing surface on purpose. This test is about what a
    // return does to the concatenated program, so it needs a return in it.
    const text = [
      fenced("cell", "return { intent: \"complete\", state: {}, output: \"first\" }"),
      fenced("cell", "return { intent: \"complete\", state: {}, output: \"second\" }")
    ].join("\n\n")
    const extracted = Result.getOrThrow(Cell.extract(text))
    expect(extracted.source.text.indexOf("first")).toBeLessThan(extracted.source.text.indexOf("second"))
  })

  it("reads a program as typescript when any of its blocks declared a typed fence", () => {
    // Both bindings run TypeScript by erasing type-only syntax, so erasure is
    // harmless to a plain-JavaScript block and the mixed reply compiles.
    const text = [fenced("cell", "const a = 1"), fenced("ts", "const b: number = 2\nreturn null")].join("\n\n")
    expect(Result.getOrThrow(Cell.extract(text)).source.language).toBe("typescript")
  })

  it("prioritizes a typed fence token independently of token order", () => {
    expect(Result.getOrThrow(Cell.extract(fenced("cell ts", "const value: number = 1"))).source.language).toBe(
      "typescript"
    )
    expect(Result.getOrThrow(Cell.extract(fenced("ts cell", "const value: number = 1"))).source.language).toBe(
      "typescript"
    )
    expect(Result.getOrThrow(Cell.extract(fenced("cell", "const value = 1"))).source.language).toBe("javascript")
  })

  it("accepts the js and javascript fences a model reaches for", () => {
    expect(Result.getOrThrow(Cell.extract(fenced("js", "return 1"))).source.language).toBe("javascript")
    expect(Result.getOrThrow(Cell.extract(fenced("javascript", "return 1"))).source.language).toBe("javascript")
    expect(Result.getOrThrow(Cell.extract(fenced("ts", "return 1"))).source.language).toBe("typescript")
    expect(Result.getOrThrow(Cell.extract(fenced("typescript", "return 1"))).source.language).toBe("typescript")
  })

  it("reads the fence tag case-insensitively and past decoration the model adds", () => {
    for (const info of ["CELL", "  cell  ", "js title=plan.js", "linenums ts", "Cell showLineNumbers"]) {
      const extracted = Cell.extract(fenced(info, "return 1"))
      expect(extracted._tag, info).toBe("Success")
    }
    expect(Result.getOrThrow(Cell.extract(fenced("linenums ts", "return 1"))).source.language).toBe("typescript")
  })

  it("ignores a fence with no tag at all", () => {
    // An untagged fence is the shape a model reaches for when it is quoting
    // output, not committing to a cell.
    const extracted = Cell.extract(fenced("", "return 1"))
    expect(extracted._tag).toBe("Failure")
    expect((extracted as Result.Failure<never, Cell.Rejected>).failure.code).toBe("no_cell")
  })

  it("ignores a fence tagged as something other than a cell", () => {
    for (const info of ["python", "json", "diff", "sh"]) {
      const extracted = Cell.extract(fenced(info, "return 1"))
      expect(extracted._tag, info).toBe("Failure")
      expect((extracted as Result.Failure<never, Cell.Rejected>).failure.code, info).toBe("no_cell")
    }
  })

  it("takes only the cell fences and leaves every other fence out of the program", () => {
    const text = [
      fenced("cell", "const first = 1"),
      fenced("json", "{ \"not\": \"a cell\" }"),
      fenced("", "untagged"),
      fenced("cell", "return first"),
      fenced("text", "trailing prose block")
    ].join("\n\n")

    const extracted = Result.getOrThrow(Cell.extract(text))
    expect(extracted.source.text).toBe("const first = 1\nreturn first")
    expect(extracted.source.language).toBe("javascript")
    expect(extracted.blocks).toBe(2)
  })

  it("keeps the language of the recognized fence when a later one is unrecognized", () => {
    const text = [fenced("ts", "return 1"), fenced("python", "print(1)")].join("\n\n")
    expect(Result.getOrThrow(Cell.extract(text)).source.language).toBe("typescript")
  })

  it("accepts an empty cell body as an empty cell", () => {
    const extracted = Result.getOrThrow(Cell.extract("```cell\n```"))
    expect(extracted.source.text).toBe("")
    expect(extracted.source.digest).toBe(Cell.source("").digest)
  })

  it("preserves inline backticks in strings and comments through the actual closing fence", () => {
    for (
      const body of [
        "console.log(\"```\");ctx.done(\"ok\")",
        "// inline ``` is not a closing fence\nctx.done(\"ok\")",
        "ctx.done(\"ok\") // inline ```"
      ]
    ) {
      const extracted = Result.getOrThrow(Cell.extract(fenced("cell", body)))
      expect(extracted.source.text).toBe(body)
      expect(extracted.blocks).toBe(1)
    }
  })

  it("keeps inline delimiters in earlier cells without swallowing later cells", () => {
    const first = "const marker = \"```\" // inline ```"
    const second = "ctx.done(marker)"
    const extracted = Result.getOrThrow(Cell.extract([fenced("cell", first), fenced("cell", second)].join("\n\n")))
    expect(extracted.source.text).toBe(first + "\n" + second)
    expect(extracted.blocks).toBe(2)
  })

  it("rejects a fence without a closing line even when its body contains inline backticks", () => {
    const extracted = Cell.extract("```cell\nconsole.log(\"```\");ctx.done(\"ok\")")
    expect(extracted._tag).toBe("Failure")
    if (extracted._tag === "Failure") expect(extracted.failure.code).toBe("output_truncated")
  })

  it("reports truncation in an unterminated fence", () => {
    const extracted = Cell.extract("```cell\nctx.done(\"x\")")
    expect(extracted._tag).toBe("Failure")
    expect((extracted as Result.Failure<never, Cell.Rejected>).failure.code).toBe("output_truncated")
  })

  it("rejects the entire reply when a second cell block is truncated", () => {
    const text = fenced("cell", "await ctx.call(\"edit\", {})") + "\n```cell\nctx.done(\"cut off"
    const extracted = Cell.extract(text)
    expect(extracted._tag).toBe("Failure")
    if (extracted._tag === "Failure") {
      expect(extracted.failure.code).toBe("output_truncated")
      expect(extracted.failure.message).toContain("unterminated")
    }
  })

  it("finds no cell in an empty response", () => {
    expect((Cell.extract("") as Result.Failure<never, Cell.Rejected>).failure.code).toBe("no_cell")
  })

  it("rescans from the start of every response, so one extraction cannot skip the next", () => {
    // The fence pattern is a module-level global regexp, which carries a
    // cursor between calls unless it is reset.
    const text = fenced("cell", "return \"repeatable\"")
    expect(Result.getOrThrow(Cell.extract(text)).source.text).toBe("return \"repeatable\"")
    expect(Result.getOrThrow(Cell.extract(text)).source.text).toBe("return \"repeatable\"")
  })

  it("reports a missing cell as a correctable rejection, not a failure", () => {
    const extracted = Cell.extract("I think we should stop here.")
    expect(extracted._tag).toBe("Failure")
    const rejection = (extracted as Result.Failure<never, Cell.Rejected>).failure
    expect(rejection.code).toBe("no_cell")
    expect(rejection.message).toContain("fenced ```cell block")
  })

  it("reads text and leaves every judgement about syntax to the compiler", () => {
    // Extraction used to match `import` against the raw source, which read a
    // quoted Python import as a module import. Whether a cell uses module
    // syntax is `Sandbox.compile`'s question, answered by parsing.
    for (
      const body of [
        "import { readFile } from \"node:fs\"\nreturn null",
        "const important = ctx.flows\nctx.park(\"waiting-input\", \"who owns this?\")"
      ]
    ) {
      expect(Cell.extract(fenced("cell", body))._tag, body).toBe("Success")
    }
  })
})

describe("Cell.extract on the frames one benchmark wave rejected", () => {
  // Verbatim final cells from SWE-bench wave 5, each recorded in its run's
  // journal beside the `imports_forbidden` rejection it drew. Every one of them
  // only mentions an import inside a bash command or a grep pattern, and the
  // sphinx cell is that instance's opening frame, so the run began by spending
  // a turn on a rule it had not broken.
  for (const name of rejectedCellNames) {
    it(`extracts the cell ${name} carried`, () => {
      const extracted = Cell.extract(rejectedCell(name))
      expect(extracted._tag).toBe("Success")
      expect(Result.getOrThrow(extracted).source.text).toContain("ctx.call")
    })
  }
})

describe("Cell.extract on the two multi-block replies one benchmark wave produced", () => {
  it("reads django's seven-block near-par program as one program of seven blocks", () => {
    const extracted = Result.getOrThrow(Cell.extract(batchedReply("django-16612-seq12")))

    expect(extracted.blocks).toBe(7)
    // Block one is the recon cell and it is now in the program; under the old
    // rule the program was block seven alone, an imagined completion over a
    // tree where nothing before it had run.
    expect(extracted.source.text.startsWith("const site = await ctx.call(\"read\"")).toBe(true)
    expect(extracted.source.text).toContain("force_append_slash=True")
    // Five of the seven blocks open `const st = ctx.state`, so one program
    // declares `st` five times. The compiler names it, which is a durable
    // observation the next frame can act on — unlike silently running one
    // block of seven, which is not observable at all.
    expect(() => new Function(`return (async () => {${extracted.source.text}})()`)).toThrow(
      /Identifier 'st' has already been declared/
    )
  })

  it("reads astropy's duplicated block as the one program it restates", () => {
    const extracted = Result.getOrThrow(Cell.extract(batchedReply("astropy-8707-seq77")))

    expect(extracted.blocks).toBe(2)
    // De-duplication is what keeps this a frame that runs: joining the repeat
    // would declare `s` twice and turn it into a compile failure.
    expect(extracted.source.text.match(/const s = ctx\.state/g)).toHaveLength(1)
    expect(() => new Function(`return (async () => {${extracted.source.text}})()`)).not.toThrow()
  })
})

describe("Cell.source", () => {
  it("digests source stably and separates one character of difference", () => {
    expect(Cell.source("return 1").digest).toBe(Cell.source("return 1").digest)
    expect(Cell.source("return 1").digest).not.toBe(Cell.source("return 2").digest)
    expect(Cell.source("return 1", "javascript").digest).not.toBe(Cell.source("return 1", "typescript").digest)
  })
})

describe("Cell.declarationDigest", () => {
  it("is @smthrs/registry's declaration identity, not a second one", () => {
    // The field set, the capability ordering, the pack exclusion and the
    // golden vector are pinned once, in the package that owns
    // `FlowDescriptor`: `registry/test/Descriptor.test.ts`. What the harness
    // owes the boundary is that it keys on that number and not on one of its
    // own, because `@smthrs/chain` keys its catalog entries on the same one.
    expect(Cell.declarationDigest).toBe(Descriptor.declarationDigest)
  })
})

describe("Cell.FlowProjection", () => {
  const declaration: FlowBinding.Declared = {
    name: "inspect",
    description: "Inspect one value.",
    capabilities: [],
    effects: undefined
  }

  it("defaults a constructed projection to no input document", () => {
    const projection = new Cell.FlowProjection({
      name: "inspect",
      description: "Inspect one value.",
      capabilities: [],
      tier: "sealed",
      placement: Option.none()
    })

    expect(projection.input).toEqual(Option.none())
  })

  it("projects an inline input document", () => {
    const document = { type: "object", properties: { value: { type: "string" } } } as const
    const descriptor = FlowBinding.descriptorOf(declaration, { inputDocument: document })

    expect(Cell.project(descriptor).input).toEqual(Option.some(document))
  })

  it("projects input locators and absent schemas to none", () => {
    const descriptor = FlowBinding.descriptorOf(declaration)
    const inputs: ReadonlyArray<Descriptor.SchemaRef> = [
      descriptor.input,
      new Descriptor.SchemaRefMarkdownArgs(),
      new Descriptor.SchemaRefMarkdownOutput(),
      new Descriptor.SchemaRefNone()
    ]

    for (const input of inputs) {
      expect(Cell.project(new Descriptor.FlowDescriptor({ ...descriptor, input })).input).toEqual(Option.none())
    }
  })
})

describe("Cell.callOf and Cell.displayDescriptor", () => {
  const declaration: FlowBinding.Declared = {
    name: "read",
    description: "Read one file.",
    capabilities: [],
    effects: undefined
  }
  const presentation = {
    verb: { pending: "Reading", success: "Read", failure: "Could not read" },
    subject: "path",
    result: "read"
  } as const
  const identity = new Cell.CallIdentity({
    session: "ses-1",
    frame: 0,
    cell: "cell-digest",
    ordinal: 0,
    declaration: "declaration-digest",
    layers: []
  })
  const call = (options: {
    readonly activity?: Descriptor.FlowActivity
    readonly presentation?: Descriptor.CallPresentation
  }): Cell.Call => Cell.callOf(FlowBinding.descriptorOf(declaration, options), { input: { path: "." }, identity })

  it("copies the declaration's display fields onto the call it builds", () => {
    const built = call({ activity: "reads", presentation })

    expect(built.activity).toBe("reads")
    expect(built.presentation).toEqual(presentation)
  })

  it("carries the tree epoch it was given and nothing when it was given none", () => {
    const descriptor = FlowBinding.descriptorOf(declaration, {})
    const epoch = { frames: 1, calls: 2 }

    expect(Cell.callOf(descriptor, { input: { path: "." }, identity, epoch }).epoch).toEqual(epoch)
    expect(Cell.callOf(descriptor, { input: { path: "." }, identity }).epoch).toBeUndefined()
  })

  it("carries neither display field when the declaration claimed neither", () => {
    const built = call({})

    expect(built.activity).toBeUndefined()
    expect(built.presentation).toBeUndefined()
    expect(Cell.displayDescriptor(built)).toBeUndefined()
  })

  it("projects each claimed display field under the flow's own name", () => {
    expect(Cell.displayDescriptor(call({ activity: "reads" }))).toEqual({ name: "read", activity: "reads" })
    expect(Cell.displayDescriptor(call({ presentation }))).toEqual({ name: "read", presentation })
    expect(Cell.displayDescriptor(call({ activity: "reads", presentation }))).toEqual({
      name: "read",
      activity: "reads",
      presentation
    })
  })
})
