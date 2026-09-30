import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FlowEngine } from "@smthrs/engine"
import { Action } from "@smthrs/flow"
import { Effect, FileSystem, Layer } from "effect"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as Prompt from "../src/Prompt.ts"
import { Fragment, jsx, render } from "../src/Prompt/jsx-runtime.ts"
import * as Registry from "../src/Registry.ts"

describe("typed MDX prompts", () => {
  it("keeps a refreshed external skill's missing agent refusal visible in the catalog", async () => {
    const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)
    const host = Layer.mergeAll(platform, FlowEngine.layerMemory, Action.layerImplementations)
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({
          directory: fileURLToPath(new URL("./fixtures", import.meta.url)),
          prefix: ".mdx-refresh-"
        })
        yield* fs.makeDirectory(`${root}/flows`, { recursive: true })
        yield* Effect.gen(function*() {
          const catalog = yield* Executable.Catalog
          const refresh = yield* Executable.Refresh
          expect(catalog.executables).toEqual([])
          yield* fs.makeDirectory(`${root}/flows/missing`, { recursive: true })
          yield* fs.writeFileString(
            `${root}/flows/missing/SKILL.md`,
            "---\nname: missing\ndescription: An external skill.\n---\nDo the work."
          )
          const outcome = yield* refresh.flow("missing")
          expect(outcome._tag).toBe("Refused")
          expect(catalog.executables).toEqual([])
          expect(catalog.refused).toMatchObject([{ flow: "missing", code: "missing_delegate", delegate: "agent" }])
        }).pipe(Effect.provide(
          Executable.layer({ delegates: [] }).pipe(
            Layer.provideMerge(Registry.layerProject({ root }).pipe(Layer.provide(host))),
            Layer.provideMerge(host)
          )
        ))
      }).pipe(Effect.scoped, Effect.provide(platform))
    )
  })
  it("pins MDX imports, loads compiled siblings, and refuses malformed or remapped prompts", async () => {
    const platform = Layer.mergeAll(
      NodeFileSystem.layer,
      NodePath.layer,
      NodeCrypto.layer,
      Action.layerImplementations,
      FlowEngine.layerMemory
    )
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url))
        const root = yield* fs.makeTempDirectoryScoped({ directory: fixtures, prefix: ".mdx-unit-" })
        yield* fs.copy(`${fixtures}/mdx`, `${root}/mdx`)
        const discovery = yield* Discovery.Discovery
        const scan = () => discovery.scan({ root, source: "project", naming: "path" })
        const descriptor = (yield* scan()).entries[0]!
        const loaded = yield* Executable.fromDescriptor(descriptor, { delegates: [] })
        expect(loaded.declaredTag).toBe("mdx")
        yield* fs.writeFileString(`${root}/mdx/prompt.mdx`, "No imports.")
        const simple = yield* Executable.fromDescriptor((yield* scan()).entries[0]!, { delegates: [] })
        expect(simple.declaredTag).toBe("mdx")
        yield* fs.writeFileString(`${root}/mdx/prompt.mdx`, "<Unclosed>")
        const failure = yield* Effect.flip(Executable.fromDescriptor((yield* scan()).entries[0]!, { delegates: [] }))
        expect(failure.code).toBe("body_unavailable")
        expect(failure.message).toContain("could not be compiled as MDX")
        yield* fs.copyFile(`${fixtures}/mdx/prompt.mdx`, `${root}/mdx/prompt.mdx`)
        yield* fs.writeFileString(
          `${root}/mdx/tsconfig.json`,
          JSON.stringify({
            compilerOptions: {
              paths: {
                "@smthrs/registry/Prompt/jsx-runtime": ["./component.ts"]
              }
            }
          })
        )
        const remapped = yield* Effect.flip(Executable.fromDescriptor((yield* scan()).entries[0]!, { delegates: [] }))
        expect(remapped.message).toContain("maps the MDX text runtime to project files")
      }).pipe(
        Effect.scoped,
        Effect.provide(Discovery.layer.pipe(Layer.provide(platform))),
        Effect.provide(platform)
      )
    )
  })
  it.each([process.execPath, "bun"])("loads and executes captured prompt imports through %s", async (runtime) => {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        runtime,
        [fileURLToPath(new URL("./fixtures/mdx-runner.mjs", import.meta.url))],
        { timeout: 30_000 },
        (error, stdout, stderr) => error === null ? resolve(stdout) : reject(new Error(stderr))
      )
    })
    expect(JSON.parse(output)).toMatchObject({ assertions: "passed" })
  })
  it("compiles expressions and imported components without evaluating them", () => {
    const source =
      `import { Greeting } from "./component.ts"\n\n# Hello {props.name}\n\n<Greeting name={props.name} />\n\n{(() => { throw new Error("must not run during compilation") })()}`
    const compiled = Prompt.compile(source)
    expect(compiled).toContain("\"./component.ts\"")
    expect(compiled).toContain("props.name")
    expect(compiled).toContain("must not run during compilation")
    expect(compiled).toContain("@smthrs/registry/Prompt/jsx-runtime")
  })

  it("refuses malformed MDX", () => {
    expect(() => Prompt.compile("<Unclosed>")).toThrow()
  })

  it("compiles empty prompts, layouts, and conflicting authored helper names", () => {
    expect(Prompt.compile("")).toContain("export default props")
    expect(Prompt.compile("export default function Layout({children}) { return children }\n\n# Layout")).toContain(
      "Layout"
    )
    expect(Prompt.compile("export const _smithersRenderPrompt = 1\n\nHello")).toContain(
      "render as _smithersRenderPrompt_"
    )
  })

  it("renders Markdown structure and preserves literal fenced JSON", () => {
    expect(render(jsx(Fragment, {
      children: [
        jsx("h2", { children: "Review" }),
        jsx("p", {
          children: ["Use ", jsx("strong", { children: "evidence" }), " and ", jsx("em", { children: "care" }), "."]
        }),
        jsx("ol", { start: 3, children: [jsx("li", { children: "Read" }), jsx("li", { children: "Check" })] }),
        jsx("pre", { children: jsx("code", { className: "language-json", children: "{\"ok\":true}\n" }) }),
        jsx("p", { children: jsx("a", { href: "https://example.com", children: "Source" }) })
      ]
    }))).toBe(
      "## Review\n\nUse **evidence** and *care*.\n\n3. Read\n4. Check\n\n```json\n{\"ok\":true}\n```\n\n[Source](https://example.com)"
    )
  })

  it("renders components, fragments, empty expressions, and nested lists", () => {
    const Component = (props: { children?: Prompt.Content }) => jsx("blockquote", { children: props.children })
    expect(render(jsx(Component, { children: [jsx("p", { children: [null, false, undefined, 42] })] }))).toBe("> 42")
    expect(
      render(
        jsx("ul", {
          children: jsx("li", { children: ["Parent", jsx("ul", { children: jsx("li", { children: "Child" }) })] })
        })
      )
    ).toBe("- Parent\n  - Child")
  })

  it("renders inline Markdown, quotations, and robust code delimiters", () => {
    expect(
      render(
        jsx("p", {
          children: [jsx("del", { children: "old" }), jsx("br", {}), jsx("img", { alt: "Chart", src: "chart.png" })]
        })
      )
    ).toBe("~~old~~\n![Chart](chart.png)")
    expect(render(jsx("a", { href: "https://example.com", title: "Source", children: "Read" }))).toBe(
      "[Read](https://example.com \"Source\")"
    )
    expect(render(jsx("a", {}))).toBe("[]()")
    expect(render(jsx("img", {}))).toBe("![]()")
    expect(render(jsx("hr", {}))).toBe("---")
    expect(render(jsx("span", { children: "Plain" }))).toBe("Plain")
    expect(render(jsx("code", { children: "a`b" }))).toBe("``a`b``")
    expect(render(jsx("code", { children: "`boundary`" }))).toBe("`` `boundary` ``")
    expect(render(jsx("code", { children: "ends`" }))).toBe("`` ends` ``")
    expect(render(jsx("code", { children: " padded " }))).toBe("`  padded  `")
    expect(render(jsx("code", { children: "  " }))).toBe("`  `")
    expect(render(jsx("code", {}))).toBe("")
    expect(render(jsx("a", { href: "a (b)<c>.md", children: "Read" }))).toBe("[Read](a%20%28b%29%3Cc%3E.md)")
    expect(render(jsx("img", { src: "a b.png", alt: "[Chart]", title: "Results" }))).toBe(
      "![\\[Chart\\]](a%20b.png \"Results\")"
    )
    expect(render(jsx("pre", { children: "```\n" }))).toBe("````\n```\n````")
    expect(render(jsx("pre", { children: jsx("code", { children: "plain" }) }))).toBe("```\nplain\n```")
    expect(render(jsx("blockquote", { children: "one\n\ntwo\n" }))).toBe("> one\n> \n> two")
  })

  it("handles boundaries, fragment separators, and empty lists", () => {
    expect(render(jsx(Fragment, { children: "one" }))).toBe("one")
    expect(render(jsx(Fragment, { children: ["one", "\n", "two\n", "\n", "three\n\n", "\n", "four"] }))).toBe(
      "one\n\ntwo\n\nthree\n\nfour"
    )
    expect(render(jsx("ol", { children: ["\n", null, undefined, jsx("li", { children: "first" })] }))).toBe("1. first")
    expect(render(jsx("ul", {}))).toBe("")
    expect(render(jsx("ul", { children: jsx("li", { children: "single" }) }))).toBe("- single")
    expect(
      render(
        jsx("ul", {
          children: jsx("li", { children: ["parent", jsx("ol", { children: jsx("li", { children: "child" }) })] })
        })
      )
    ).toBe("- parent\n  1. child")
    for (const level of [1, 6]) {
      expect(render(jsx(`h${level}`, { children: "Title" }))).toBe(`${"#".repeat(level)} Title`)
    }
    expect(render(jsx("h7", { children: "Plain" }))).toBe("Plain")
  })
})
