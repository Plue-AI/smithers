import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import * as Cli from "../src/cli.ts"

it("shows help without validating the workspace or starting a model", () => {
  expect(Cli.parse(["--help", "/missing"], "/")).toEqual({ help: true })
  const result = spawnSync("bun", [resolve(import.meta.dir, "../src/main.tsx"), "-h"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH }
  })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain("Usage: smithers-tui")
  expect(result.stdout).toContain("--approve")
  expect(result.stderr).toBe("")
})

it("refuses invalid options and ignored extra inputs before changing directory", () => {
  for (
    const args of [["--unknown"], ["--model"], ["/", "/tmp"], ["-c", "-r"], ["-p", "hi", "-c"], ["-m", ""], ["-p", " "]]
  ) {
    expect(Cli.parse(args, "/")).toHaveProperty("error")
  }
  expect(Cli.parse(["/missing-tui-directory-1987"], "/")).toEqual({
    error: "Cannot open directory: /missing-tui-directory-1987"
  })
  expect(Cli.parse([import.meta.filename], "/")).toEqual({ error: `Not a directory: ${import.meta.filename}` })
  const result = spawnSync("bun", [resolve(import.meta.dir, "../src/main.tsx"), "--unknown"], { encoding: "utf8" })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("--help")
  expect(result.stderr).not.toMatch(/\n\s+at /)
})

it("resolves a relative workspace and keeps prompt and model flags", () => {
  expect(Cli.parse(["tmp", "-m", "replay:recording", "-p", "hello", "--budget-tokens", "5000"], "/")).toMatchObject({
    cwd: "/tmp",
    values: { model: "replay:recording", print: "hello", "budget-tokens": "5000" }
  })
})

it("refuses redirected interactive streams while print mode still works", () => {
  const app = resolve(import.meta.dir, "../src/main.tsx")
  const env = { PATH: process.env.PATH, SMITHERS_TUI_REPLAY: resolve(import.meta.dir, "fixtures/pong.jsonl") }
  const interactive = spawnSync("bun", [app], { encoding: "utf8", env, timeout: 3000 })
  expect(interactive.error).toBeUndefined()
  expect(interactive.status).toBe(1)
  expect(interactive.stdout).toBe("")
  expect(interactive.stderr).toBe("Interactive mode requires a terminal. Use --print <prompt>.\n")
  const printed = spawnSync("bun", [app, "--print", "ping"], { encoding: "utf8", env, timeout: 10_000 })
  expect(printed.status, printed.stderr).toBe(0)
  expect(printed.stdout.trim()).toBe("pong")
  expect(printed.stderr).toBe("")
  // The test's own bound covers both child bounds; Bun's 5 s default did not,
  // and killed a print run that was still inside its 10 s allowance.
}, 15_000)

it.each([{ args: ["--help"] }, { args: ["--print", "ping"] }])(
  "does not load terminal libraries for %j",
  ({ args }) => {
    const app = resolve(import.meta.dir, "../src/main.tsx")
    const probe =
      `Bun.plugin({name:"refuse-terminal",setup(build){build.onLoad({filter:/\\/@opentui\\//},()=>{throw new Error("terminal library must not load")})}});process.argv=${
        JSON.stringify(["bun", app, ...args])
      };await import(${JSON.stringify(app)})`
    const result = spawnSync("bun", ["-e", probe], {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH, SMITHERS_TUI_REPLAY: resolve(import.meta.dir, "fixtures/pong.jsonl") }
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(args[0] === "--help" ? "Usage: smithers-tui" : "pong")
    expect(result.stderr).toBe("")
  },
  12_000
)

it("refuses an invalid budget before starting a model", () => {
  const app = resolve(import.meta.dir, "../src/main.tsx")
  const result = spawnSync("bun", [app, "--budget-tokens", "ten", "--print", "ping"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, SMITHERS_TUI_REPLAY: resolve(import.meta.dir, "fixtures/pong.jsonl") },
    timeout: 10_000
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toBe("--budget-tokens must be a positive whole number, 0, or none\n")
})

it("refuses an invalid daily cap before starting a model", () => {
  const app = resolve(import.meta.dir, "../src/main.tsx")
  const result = spawnSync("bun", [app, "--budget-daily-tokens", "ten", "--print", "ping"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, SMITHERS_TUI_REPLAY: resolve(import.meta.dir, "fixtures/pong.jsonl") },
    timeout: 10_000
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toBe("--budget-daily-tokens must be a positive whole number, 0, or none\n")
})

it("disables both caps with 0 or none and still answers", () => {
  const app = resolve(import.meta.dir, "../src/main.tsx")
  const result = spawnSync("bun", [app, "--budget-tokens", "none", "--budget-daily-tokens", "0", "--print", "ping"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, SMITHERS_TUI_REPLAY: resolve(import.meta.dir, "fixtures/pong.jsonl") },
    timeout: 10_000
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe("pong")
})

it("takes a Smithers Cloud workspace for worker tools and refuses a malformed one", () => {
  expect(Cli.parse(["--box", "acme/app/ws_01"], "/")).toMatchObject({ values: { box: "acme/app/ws_01" } })
  expect(Cli.parse(["--box", "acme/app"], "/")).toEqual({ error: "--box needs owner/repo/workspace-id" })
  expect(Cli.parse(["--box", "acme/app/ws;rm"], "/")).toEqual({ error: "--box needs owner/repo/workspace-id" })
})

it("takes a harness workspace for the Claude Code seat and refuses a malformed one", () => {
  expect(Cli.parse(["--harness", "acme/harness/ws_02"], "/")).toMatchObject({
    values: { harness: "acme/harness/ws_02" }
  })
  expect(Cli.parse(["--harness", "acme"], "/")).toEqual({ error: "--harness needs owner/repo/workspace-id" })
})
