import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import * as Integrations from "../src/index.ts"

const root = resolve(import.meta.dirname, "..")
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
const providers = ["linear", "slack", "telegram", "gmail", "googlecalendar", "x"]

describe("integration product scope", () => {
  it("exports GitHub and the shared primitives", () => {
    expect(Object.keys(Integrations).sort()).toEqual(["Core", "GitHub"])
    expect(Object.keys(Integrations.GitHub).sort()).toEqual([
      "Actions",
      "Config",
      "GitHubClient",
      "Payload",
      "Proxy",
      "RateLimit",
      "Repository",
      "Sync"
    ])
    expect(typeof Integrations.Core.Channel.make).toBe("function")
    expect(Integrations.Core.Migrations.set.migrations).toBeDefined()
  })

  it.each(providers)("removes %s implementations and executable exports", (provider) => {
    expect(existsSync(resolve(root, "src", provider))).toBe(false)
    expect(existsSync(resolve(root, "src", provider + ".ts"))).toBe(false)
    for (const map of [manifest.exports, manifest.publishConfig.exports]) {
      const entries = Object.entries(map).filter(([path]) =>
        path === `./${provider}` || path.startsWith(`./${provider}/`)
      )
      expect(entries.every(([, target]) => target === null)).toBe(true)
    }
  })
})
