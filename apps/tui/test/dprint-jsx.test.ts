import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")

const format = (source: string): string => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, "node_modules/dprint/bin.cjs"),
      "fmt",
      "--config",
      resolve(root, "dprint.json"),
      "--stdin",
      "fixture.tsx"
    ],
    { cwd: root, encoding: "utf8", input: source }
  )
  if (result.status !== 0) throw new Error(result.stderr || String(result.error))
  return result.stdout
}

test("dprint keeps explicit JSX edge spaces until dprint/dprint-plugin-typescript#476 is fixed", () => {
  const cases = [
    ["<span>{m} </span>", "<span>{m}{\" \"}</span>"],
    ["<span> {m}</span>", "<span>{\" \"}{m}</span>"]
  ] as const

  for (const [raw, explicit] of cases) {
    const source = (jsx: string) => `export const A = ({ m }: { m: string }) => ${jsx}\n`
    expect(format(source(raw))).toBe(source("<span>{m}</span>"))
    expect(format(source(explicit))).toBe(source(explicit))
  }
}, 30_000)
