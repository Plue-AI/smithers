/** One React for the renderer and the app, whichever package manager installed it (#2602). */
import { expect, test } from "bun:test"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"

const app = resolve(import.meta.dir, "..")
const root = resolve(app, "..", "..")
const manifest = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>
    readonly devDependencies?: Readonly<Record<string, string>>
  }
const pinned = manifest(resolve(app, "package.json")).dependencies!["react"]!

test("the renderer, its reconciler, the shared UI and the app load one React", () => {
  const from = (require: NodeJS.Require, name: string) => createRequire(realpathSync(require.resolve(name)))
  const tui = createRequire(resolve(app, "src", "app.tsx"))
  const renderer = from(tui, "@opentui/react")
  const loaded = [tui, renderer, from(renderer, "react-reconciler"), from(tui, "@smthrs/ui/package.json")].map(
    (require) => realpathSync(require.resolve("react"))
  )
  expect(new Set(loaded).size).toBe(1)
})

test("a fresh Bun install hoists the React the TUI pins", () => {
  const workspace = manifest(resolve(root, "package.json")).devDependencies!
  expect(workspace["react"]).toBe(pinned)
  expect(workspace["react-dom"]).toBe(pinned)
  const lock = readFileSync(resolve(root, "bun.lock"), "utf8")
  expect(lock).toContain(`\n    "react": ["react@${pinned}",`)
  expect(lock).toContain(`\n    "react-dom": ["react-dom@${pinned}",`)
  // No workspace needs its own copy, so none can load a second dispatcher.
  expect(lock).not.toMatch(/\n    "[^"]+\/react": \["react@/)
})
