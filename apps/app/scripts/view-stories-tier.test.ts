import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

test("View stories are collected only with SMITHERS_VIEW_STORIES=1", () => {
  for (const enabled of [false, true]) {
    const env = { ...process.env }
    delete env.SMITHERS_VIEW_STORIES
    if (enabled) env.SMITHERS_VIEW_STORIES = "1"
    const result = spawnSync("npx", ["playwright", "test", "--list"], { cwd: resolve(import.meta.dir, ".."), env, encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stdout.includes("view-stories.spec.ts")).toBe(enabled)
  }
}, 30_000)
