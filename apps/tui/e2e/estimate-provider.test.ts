/** Which model estimates novel work, through the real terminal (#2059). */
import { afterEach, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Models from "../src/models.ts"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
const drawn = (screen: string) => /↑\S+ ↓\S+/.test(screen)
let tui: Tui | undefined
afterEach(async () => {
  await tui?.stop()
  tui = undefined
})

interface Prediction {
  readonly type: string
  readonly prediction?: { readonly kind: string; readonly method: string; readonly subject: string }
}

const start = async (env: Readonly<Record<string, string>>) => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-estimate-provider-"))
  writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => a - b\n")
  const sessions = mkdtempSync(join(tmpdir(), "tui-estimate-sessions-"))
  const calls = join(mkdtempSync(join(tmpdir(), "tui-estimate-calls-")), "calls.txt")
  tui = await Tui.start({
    cwd,
    command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SMITHERS_TUI_SESSION_DIR: sessions,
      SMITHERS_FIXTURE_COMPLETE: calls,
      ...env
    }
  })
  await tui.until(drawn, 20_000, "first draw")
  // A finished worker is the history a class estimate needs.
  await tui.type("delegate fix")
  await tui.press(key.enter)
  await tui.until((screen) => screen.includes("Fixer done"), 10_000, "worker done")
  await tui.type("investigate")
  await tui.press(key.enter)
  await tui.until((screen) => screen.includes("Requested the investigation."), 10_000, "worker requested")
  const ledger = (): ReadonlyArray<Prediction> => {
    const folder = readdirSync(sessions, { withFileTypes: true }).find((entry) => entry.isDirectory())
    const file = folder === undefined ? undefined : join(sessions, folder.name, "evals", "estimates.jsonl")
    return file === undefined || !existsSync(file)
      ? []
      : readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Prediction)
  }
  const delegated = () =>
    ledger().filter((entry) =>
      entry.type === "prediction" && entry.prediction?.subject.startsWith("Investigation") === true
    )
  await tui.until(() => delegated().length === 1, 10_000, "delegate prediction")
  return {
    method: () => delegated()[0]!.prediction!.method,
    calls: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []
  }
}

/** Chat still answers after the estimate settled. */
const chats = async () => {
  await tui!.type("hello")
  await tui!.press(key.enter)
  await tui!.until((screen) => screen.includes("Still here."), 10_000, "chat answer")
}

it.each([
  ["no provider", ""],
  ["Anthropic only", "anthropic"]
])("with %s, novel work is estimated from its class and no model is asked", async (_, models) => {
  const run = await start({ SMITHERS_FIXTURE_MODELS: models })
  expect(run.method()).toBe("class")
  await chats()
  expect(run.calls()).toEqual([])
  expect(tui!.screen()).not.toContain("No estimate for this work")
}, 45_000)

it("with an OpenAI route, Luna estimates novel work", async () => {
  const run = await start({ SMITHERS_FIXTURE_MODELS: "anthropic,openai" })
  expect(run.method()).toBe("model")
  expect(new Set(run.calls())).toEqual(new Set([Models.delegateModels.luna]))
  await chats()
  expect(tui!.screen()).not.toContain("No estimate for this work")
}, 45_000)

it("a configured estimator's failure falls back to the class quietly and chat stays usable", async () => {
  const run = await start({ SMITHERS_FIXTURE_MODELS: "openai", SMITHERS_FIXTURE_COMPLETE_FAILS: "1" })
  expect(new Set(run.calls())).toEqual(new Set([Models.delegateModels.luna]))
  expect(run.method()).toBe("class")
  await chats()
  expect(tui!.screen()).not.toContain("No estimate for this work")
}, 45_000)
