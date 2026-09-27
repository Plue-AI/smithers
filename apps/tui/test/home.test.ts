import { expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Home from "../src/home.ts"

const directory = (home?: string): string => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-home-"))
  if (home !== undefined) {
    mkdirSync(join(cwd, ".smithers"), { recursive: true })
    writeFileSync(join(cwd, ".smithers", "home.json"), home)
  }
  return cwd
}

it("reads the app blocks of .smithers/home.json in order and nothing else", () => {
  const cwd = directory(JSON.stringify({
    blocks: [
      { type: "prompt", title: "What should we work on?" },
      { type: "app", flow: "issue.implement", title: "Fix an issue", picture: "issue" },
      { type: "text", text: "After" },
      { type: "app", flow: "review", title: "Review a PR", picture: "review" },
      { type: "app", flow: "", title: "Nameless" },
      { type: "app", flow: "wiki", picture: "wiki" }
    ]
  }))
  expect(Home.read(cwd)).toEqual([
    { flow: "issue.implement", title: "Fix an issue", picture: "issue" },
    { flow: "review", title: "Review a PR", picture: "review" }
  ])
})

it("declares nothing for a directory without a homepage, or with a malformed one", () => {
  expect(Home.read(directory())).toEqual([])
  expect(Home.read(directory("{"))).toEqual([])
  expect(Home.read(directory(JSON.stringify({ blocks: "app" })))).toEqual([])
  expect(Home.read(directory(JSON.stringify([{ type: "app", flow: "review", title: "Review" }])))).toEqual([])
})
