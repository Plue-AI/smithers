/**
 * The package's own documentation, against the barrel it documents.
 *
 * `docs/README.md` states that `docs/api.md` covers every runtime export and
 * every type. Hand-written prose cannot hold that claim on its own: the file
 * shipped with `Rgb` missing while `contrastRatioOf` and `mixChannels`, whose
 * parameter and return type it is, were both documented on the same page. This
 * test is the claim, executed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as barrel from "../src/index.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath: string): string => readFileSync(join(packageRoot, relativePath), "utf8");

const apiDoc = read("docs/api.md");
const barrelSource = read("src/index.ts");

describe("consumer theming guides", () => {
  test("palette sources distinguish host overrides from registry regeneration", () => {
    const guide = read("docs/concepts/palette-sources.md").replace(/\s+/g, " ");
    expect(guide).not.toContain("None of these can be fixed by overriding a token in your own sheet");
    expect(guide).not.toContain("the `--check` mode restores");
    expect(guide).toContain("../guides/override-a-token.md");
    expect(guide).toContain("read-only");
  });

  test("embedding documents defaults before optional attribute overrides", () => {
    const guide = read("docs/guides/embed-a-stylesheet.md").replace(/\s+/g, " ");
    expect(guide).not.toContain("The sheet themes nothing until");
    expect(guide).toContain("Paper light");
    expect(guide).toContain("no attributes");
    expect(guide).toContain("`prefers-color-scheme: dark`");
    expect(guide).toContain("optional overrides");
  });
});

/**
 * The type-only names the barrel re-exports.
 *
 * Three forms carry them: a whole `export type { … }` clause, a `type X` entry
 * inside a value clause (`export { contrastRatio, type Rgb }`), and a
 * declaration the barrel makes itself. Types are erased, so no runtime
 * reflection can see any of them.
 */
function exportedTypeNames(source: string): readonly string[] {
  const names = new Set<string>();
  for (const clause of source.matchAll(/export\s+type\s*\{([^}]*)\}/g)) {
    for (const entry of clause[1]!.split(",")) {
      const name = entry.trim();
      if (name.length > 0) names.add(name);
    }
  }
  for (const clause of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const entry of clause[1]!.split(",")) {
      const inline = /^type\s+(\w+)$/.exec(entry.trim());
      if (inline !== null) names.add(inline[1]!);
    }
  }
  for (const declaration of source.matchAll(/export\s+(?:type|interface)\s+(\w+)\s*[=<{]/g)) {
    names.add(declaration[1]!);
  }
  return [...names].sort();
}

describe("docs/api.md", () => {
  const runtimeNames = Object.keys(barrel).sort();
  const typeNames = exportedTypeNames(barrelSource);

  test("the extractors see the surface they are asked to check", () => {
    // Guards the two tests below: an extractor that returned nothing, or that
    // stopped recognizing one of the three type-export forms, would let an
    // empty api.md pass. `Rgb` is the name the shipped page was missing, and it
    // is written in the form regex twice, so it is the one worth naming.
    expect(runtimeNames).toContain("contrastRatioOf");
    expect(runtimeNames.length).toBeGreaterThan(10);
    expect(typeNames).toContain("Rgb");
    expect(typeNames).toContain("ThemeKey");
    expect(typeNames.length).toBeGreaterThan(5);
  });

  for (const name of ["runtime", "type"] as const) {
    test(`documents every ${name} export`, () => {
      for (const exported of name === "runtime" ? runtimeNames : typeNames) {
        // Backticked, and either closed or opening a signature: `themeCss(` and
        // `themeCss` both count, a bare mention in prose does not.
        expect(apiDoc, exported).toMatch(new RegExp(`\`${exported}[\`(]`));
      }
    });
  }

  test("README.md points at the package-owned pages rather than restating them", () => {
    const readme = read("README.md");
    for (const page of ["docs/api.md", "docs/theming.md"]) expect(readme).toContain(page);
  });
});
