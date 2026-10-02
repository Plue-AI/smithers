import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/*
 * One focus ring (#3421).
 *
 * Keyboard focus outlines had drifted across seven colours (`--ring-border`,
 * `--brand`, `--g-accent`, `--ring`, `--primary`, `--action-primary` and
 * `currentColor`), so the same Tab landed in a different colour per surface.
 * Every `:focus-visible` outline is `2px solid var(--ring-border)`, each rule
 * keeping its own offset. A rule that draws focus another way may say
 * `outline: none`; box-shadow halos on `--ring` are not outlines.
 */

const mainview = fileURLToPath(new URL("..", import.meta.url))
const RING = "2px solid var(--ring-border)"

/** Comments carry selector-looking prose, so the scans read the code alone. */
const code = (path: string): string => readFileSync(`${mainview}${path}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

const sheets = (): Array<string> => [...new Bun.Glob("**/*.css").scanSync({ cwd: mainview })].sort()

/** Every outline a `:focus-visible` rule sets, innermost blocks included. */
const focusOutlines = (css: string): Array<{ readonly selector: string; readonly property: string; readonly value: string }> =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((rule) => rule[1]!.includes(":focus-visible"))
    .flatMap((rule) =>
      [...rule[2]!.matchAll(/(?:^|;)\s*(outline(?:-color)?)\s*:\s*([^;]+)/g)].map((declaration) => ({
        selector: rule[1]!.trim().replace(/\s+/g, " "),
        property: declaration[1]!,
        value: declaration[2]!.trim()
      })))

describe("keyboard focus draws one ring", () => {
  test("the scan reads outlines in media blocks, selector lists and multi-line rules", () => {
    const sheet = "@media (hover: none) {\n  .a:focus-visible {\n    color: red;\n    outline: 2px solid var(--brand);\n    outline-offset: 2px;\n  }\n}\n.b:hover, .b:focus-visible { outline-color: currentColor }\n.c:hover { outline: 1px solid red }"
    expect(focusOutlines(sheet)).toEqual([
      { selector: ".a:focus-visible", property: "outline", value: "2px solid var(--brand)" },
      { selector: ".b:hover, .b:focus-visible", property: "outline-color", value: "currentColor" }
    ])
  })

  test(`every :focus-visible outline under src/mainview is ${RING} or none`, () => {
    const found = sheets().flatMap((sheet) => focusOutlines(code(sheet)).map((outline) => ({ sheet, ...outline })))
    // The global default ring alone proves base.css was read; the count proves the rest were.
    expect(found.filter((outline) => outline.sheet === "styles/base.css" && outline.selector === ":focus-visible")).toHaveLength(1)
    expect(found.length).toBeGreaterThan(40)
    const strays = found
      .filter(({ property, value }) => !(property === "outline" && (value === RING || value === "none")))
      .map(({ sheet, selector, property, value }) => `${sheet} ${selector} { ${property}: ${value} }`)
    // Reported all at once, so one sweep fixes every stray.
    expect(strays).toEqual([])
  })
})
