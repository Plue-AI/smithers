/** `/smithers` is the factory's issue list: the stack read from Cloud as the signed-in person, under its metrics. */
import { expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
const at = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
const item = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id,
  state,
  attempt: 1,
  runs: {},
  dependsOn: [],
  updatedAt: at(1),
  issue: { number: Number(id), title: `Issue ${id}`, url: `https://github.com/o/r/issues/${id}` },
  ...extra
})
const stack = {
  repository: "o/r",
  state: "active",
  generation: 3,
  mainBehind: false,
  changes: [],
  items: [
    item("2431", "blocked", {
      reason: "very hard 3/3",
      todo: { replans: 2, veryHard: true },
      issue: { number: 2431, title: "ctx.help", url: "https://github.com/o/r/issues/2431" }
    }),
    item("2412", "running", {
      lane: 0,
      todo: { replans: 2, veryHard: true },
      issue: { number: 2412, title: "Resume loses prompt cache", url: "https://github.com/o/r/issues/2412" }
    }),
    item("2388", "landed", {
      createdAt: at(3),
      humanEdited: false,
      costNanos: 2_000_000_000,
      route: { as: "close", landed: "change" },
      issue: { number: 2388, title: "Tab overflow", url: "https://github.com/o/r/issues/2388" }
    })
  ],
  lanes: [],
  limits: { maxParallel: 3 }
}

it("reads the repository's stack from Cloud and lists its issues by group under the measured numbers", async () => {
  const seen: Array<string | null> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      seen.push(request.headers.get("authorization"))
      return new URL(request.url).pathname === "/api/repos/o/r/mythical"
        ? Response.json(stack)
        : new Response("{}", { status: 404 })
    }
  })
  const root = mkdtempSync(join(tmpdir(), "tui-factory-"))
  let tui: Tui | undefined
  try {
    tui = await Tui.start({
      cwd: root,
      cols: 150,
      rows: 30,
      command: `bun ${join(app, "e2e", "tabs-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        XDG_CONFIG_HOME: root,
        SMITHERS_TUI_SESSION_DIR: join(root, "s"),
        SMITHERS_API_ORIGIN: `http://127.0.0.1:${server.port}`,
        SMITHERS_TOKEN: "tok_e2e",
        SMITHERS_REPO: "o/r"
      }
    })
    await tui.until((screen) => screen.includes("Ask Smithers"), 20_000, "first draw")
    await tui.type("/smithers")
    await tui.press(key.enter)
    await tui.until(
      (screen) =>
        screen.includes(
          "1/2 landed · 100% landed unedited · 2h p50 · $2.00/landed · 0 reverts · 1 misroute · 4 replans · 1 very hard"
        ) && screen.includes("Needs you 1") &&
        screen.includes("#2431 ctx.help · blocked") &&
        screen.includes("#2412 Resume loses prompt cache · implementing · plan 3 of 3 · very hard") &&
        screen.includes("Done 1"),
      10_000,
      "the issue list"
    )
    expect(seen.at(-1)).toBe("token tok_e2e")
  } finally {
    await tui?.stop()
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

for (const status of [401, 403]) {
  it(`shows the sign-in row when Cloud returns HTTP ${status}`, async () => {
    const seen: Array<string | null> = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        seen.push(request.headers.get("authorization"))
        return new Response("Unauthorized", { status })
      }
    })
    const root = mkdtempSync(join(tmpdir(), "tui-factory-"))
    let tui: Tui | undefined
    try {
      tui = await Tui.start({
        cwd: root,
        cols: 150,
        rows: 30,
        command: `bun ${join(app, "e2e", "tabs-fixture.tsx")}`,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          XDG_CONFIG_HOME: root,
          SMITHERS_TUI_SESSION_DIR: join(root, "s"),
          SMITHERS_API_ORIGIN: `http://127.0.0.1:${server.port}`,
          SMITHERS_TOKEN: "tok_e2e",
          SMITHERS_REPO: "o/r"
        }
      })
      await tui.until((screen) => screen.includes("Ask Smithers"), 20_000, "first draw")
      await tui.type("/smithers")
      await tui.press(key.enter)
      await tui.until(
        (screen) => screen.includes("Sign in to see the factory: smthrs auth login"),
        10_000,
        "the sign-in row"
      )
      expect(seen).toContain("token tok_e2e")
    } finally {
      await tui?.stop()
      server.stop(true)
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
}
