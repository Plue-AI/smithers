import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/*
 * A custom property nobody declares paints nothing.
 *
 * `var(--x)` with no declaration and no fallback makes its whole declaration
 * invalid at computed-value time, so the property silently takes its initial
 * value: `.view-skeleton > span` read `--paper-300` (the raw scale stops at
 * `--paper-3`) and every loading skeleton was transparent (#3418). This reads
 * every stylesheet under src/mainview, component sheets included.
 */

const mainview = fileURLToPath(new URL("..", import.meta.url))

/** Comments carry token-looking prose, so the scans read the code alone. */
const code = (path: string): string => readFileSync(`${mainview}${path}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

/** Every custom property a sheet declares, in any block. */
const declared = (css: string): ReadonlySet<string> =>
  new Set([...css.matchAll(/(?:^|[{;\s])(--[\w-]+)\s*:/g)].map((match) => match[1]!))

/** The properties a sheet reads with no fallback that neither it nor the palette declares. */
const undeclared = (css: string, palette: ReadonlySet<string>): Array<string> => {
  const own = declared(css)
  return [...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)]
    .map((match) => match[1]!)
    .filter((name) => !palette.has(name) && !own.has(name))
}

/**
 * Properties a stylesheet reads but another file writes, each naming that
 * writer. The writer must still write it, so an entry cannot outlive its reason.
 */
const WRITTEN_ELSEWHERE: Readonly<Record<string, { readonly by: string; readonly why: string }>> = {
  "--flow-run-fill": { by: "cards/FlowRunGraphSurface.tsx", why: "the node's run progress, set inline on its bar" },
  "--toast-height": {
    by: "ModalPopover.tsx",
    why: "the free modal region, set with data-modal-placement; with no region the stack hides instead"
  },
  "--ghc-head-bg": {
    by: "styles/github-cards.css",
    why: "declared on .ghc; the repository update card renders its action row inside .ghc"
  }
}

const sheets = (): Array<string> => [...new Bun.Glob("**/*.css").scanSync({ cwd: mainview })].sort()

describe("every custom property a stylesheet reads is declared somewhere it can resolve", () => {
  test("the scan reports a bare read of an undeclared property, and only that", () => {
    const palette = new Set(["--paper-3", "--text"])
    // A longer name is not declared by its prefix, and a fallback or a same-sheet declaration resolves.
    expect(undeclared(".bar { background: var(--paper-300); color: var(--text); }", palette)).toEqual(["--paper-300"])
    expect(undeclared(".bar { background: var(--paper-300, var(--paper-3)); }", palette)).toEqual([])
    expect(undeclared(".bar { --paper-300: red; background: var( --paper-300 ); }", palette)).toEqual([])
    expect(undeclared(".bar { background: var(--surface, var(--paper-300)); }", palette)).toEqual(["--paper-300"])
  })

  test("no stylesheet under src/mainview reads a property nobody declares", () => {
    const palette = declared(code("styles/tokens.css"))
    expect(palette.has("--surface-2")).toBe(true)
    const found = sheets()
    expect(found).toEqual(expect.arrayContaining(["styles/cards.css", "HelpBubble.css"]))
    const missing = found.flatMap((sheet) =>
      undeclared(code(sheet), palette).filter((name) => !(name in WRITTEN_ELSEWHERE)).map((name) => `${sheet}: ${name}`))
    // Reported all at once, so one sweep fixes every miss.
    expect(missing).toEqual([])
  })

  test("every allowed property is still written by the file it names and still read bare", () => {
    const reads = new Set(sheets().flatMap((sheet) => undeclared(code(sheet), declared(code("styles/tokens.css")))))
    for (const [name, { by }] of Object.entries(WRITTEN_ELSEWHERE)) {
      const writes = by.endsWith(".css") ? declared(code(by)).has(name) : readFileSync(`${mainview}${by}`, "utf8").includes(`"${name}"`)
      expect({ name, writes, read: reads.has(name) }).toEqual({ name, writes: true, read: true })
    }
  })
})
