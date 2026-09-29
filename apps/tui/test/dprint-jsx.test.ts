import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")

const format = (source: string): string => {
  const result = spawnSync(
    resolve(root, "node_modules/.bin/dprint"),
    ["fmt", "--config", resolve(root, "dprint.json"), "--stdin", "fixture.tsx"],
    { cwd: root, encoding: "utf8", input: source }
  )
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
  return result.stdout
}

test("dprint keeps explicit JSX edge spaces until upstream #476 is fixed", () => {
  const cases = [
    ["<span>{m} </span>", "<span>{m}{\" \"}</span>"],
    ["<span> {m}</span>", "<span>{\" \"}{m}</span>"]
  ] as const

  for (const [raw, explicit] of cases) {
    const source = (jsx: string) => `export const A = ({ m }: { m: string }) => ${jsx}\n`
    expect(format(source(raw))).not.toBe(source(raw))
    expect(format(source(explicit))).toBe(source(explicit))
  }
}, 30_000)
