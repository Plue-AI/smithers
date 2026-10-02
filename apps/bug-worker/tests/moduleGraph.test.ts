import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

/**
 * The worker's module graph, read from source: every module under `src/` maps
 * to the `src/` modules it imports, type-only imports included.
 */
const src = new URL("../src/", import.meta.url);
const graph = new Map(readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => {
    const url = new URL(file, src);
    const imports = [...readFileSync(url, "utf8").matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)]
      .map((match) => new URL(match[1]!, url).href.slice(src.href.length));
    return [file, imports] as const;
  }));

const importers = (target: string) => [...graph].filter(([, imports]) => imports.includes(target)).map(([file]) => file).sort();

/** The first import cycle found, as the path that closes it, or null. */
function findCycle(): string[] | null {
  const acyclic = new Set<string>();
  const visit = (file: string, path: string[]): string[] | null => {
    if (path.includes(file)) return [...path.slice(path.indexOf(file)), file];
    if (acyclic.has(file)) return null;
    for (const next of graph.get(file) ?? []) {
      const cycle = visit(next, [...path, file]);
      if (cycle) return cycle;
    }
    acyclic.add(file);
    return null;
  };
  for (const file of graph.keys()) {
    const cycle = visit(file, []);
    if (cycle) return cycle;
  }
  return null;
}

describe("worker module graph", () => {
  test("no module imports the entry point back", () => {
    expect(importers("worker.ts")).toEqual([]);
  });

  test("has no import cycles", () => {
    expect(findCycle()).toBeNull();
  });
});
