import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  startPackagedWebSelfhost,
  webSelfhostResources,
  type CommandExecutor,
  type CommandResult
} from "./docker-web-selfhost"

const roots: string[] = []
const revision = "a".repeat(40)
const temporary = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-mode-launcher-"))
  roots.push(root)
  return root
}

afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe("packaged web-selfhost launcher", () => {
  const absentInspect = (args: readonly string[]): CommandResult => ({
    exitCode: 1,
    stdout: "",
    stderr: args[1] === "network"
      ? `Error response from daemon: network ${args.at(-1)} not found`
      : `Error: No such ${args[1]}: ${args.at(-1)}`
  })

  test("uses one collision-resistant namespace for every disposable resource", () => {
    const one = webSelfhostResources("A fixed launch/id with an intentionally very long suffix for PostgreSQL")
    const two = webSelfhostResources("another launch")
    expect(one.runId).toHaveLength(40)
    expect(new Set([
      one.image, one.network, one.postgresContainer, one.appContainer,
      one.postgresVolume, one.dataVolume, one.database, one.hostPort
    ]).size).toBe(8)
    expect(one.hostPort).toBeGreaterThanOrEqual(20_000)
    expect(one.hostPort).toBeLessThan(60_000)
    expect(Buffer.byteLength(one.database)).toBeLessThanOrEqual(63)
    expect(Object.values(one).every((value) => !String(value).includes("another-launch"))).toBe(true)
    expect(two.network).not.toBe(one.network)
  })

  test("a build failure removes only resources the launcher actually created and records the command failure", async () => {
    const calls: string[][] = []
    const executor: CommandExecutor = async (args) => {
      calls.push([...args])
      if (args.includes("inspect")) return absentInspect(args)
      if (args[1] === "build") return { exitCode: 17, stdout: "", stderr: "packaged compile failed" }
      return { exitCode: 0, stdout: "created\n", stderr: "" }
    }
    const outputDir = temporary()
    await expect(startPackagedWebSelfhost({ rootDir: outputDir, revision, outputDir, executor })).rejects.toThrow("build packaged product image failed")

    const report = JSON.parse(readFileSync(join(outputDir, "web-selfhost.launch.json"), "utf8")) as {
      readonly status: string
      readonly failure: string
      readonly commands: ReadonlyArray<{ readonly label: string; readonly status: string }>
    }
    expect(report.status).toBe("failed")
    expect(report.failure).toContain("packaged compile failed")
    expect(report.commands).toContainEqual(expect.objectContaining({ label: "build packaged product image", status: "failed" }))
    expect(calls.find((args) => args[1] === "build")).toContain(`BUILD_SHA=${revision}`)
    expect(calls.some((args) => args[1] === "volume" && args[2] === "rm")).toBe(true)
    expect(calls.some((args) => args[1] === "network" && args[2] === "rm")).toBe(true)
    expect(calls.some((args) => args[1] === "container" && args[2] === "rm")).toBe(false)
    expect(calls.some((args) => args[1] === "image" && args[2] === "rm")).toBe(false)
  })

  test("fails closed when Docker inspection cannot establish that resources are absent", async () => {
    const calls: string[][] = []
    const executor: CommandExecutor = async (args) => {
      calls.push([...args])
      return {
        exitCode: 1,
        stdout: "",
        stderr: "permission denied while trying to connect to the Docker daemon socket"
      }
    }
    const outputDir = temporary()
    await expect(startPackagedWebSelfhost({ rootDir: outputDir, revision, outputDir, executor })).rejects.toThrow(
      "prove app container is fresh failed"
    )

    const report = JSON.parse(readFileSync(join(outputDir, "web-selfhost.launch.json"), "utf8")) as {
      readonly status: string
      readonly failure: string
      readonly commands: ReadonlyArray<{ readonly label: string; readonly status: string; readonly detail?: string }>
    }
    expect(report.status).toBe("failed")
    expect(report.failure).toContain("permission denied")
    expect(report.commands).toContainEqual(expect.objectContaining({
      label: "prove app container is fresh",
      status: "failed",
      detail: expect.stringContaining("permission denied")
    }))
    expect(calls.some((args) => args.includes("create") || args.includes("build") || args.includes("run"))).toBe(false)
  })

})

test("temporary PostgreSQL socket readiness cannot start a TCP-dependent app", async () => {
  const outputDir = temporary()
  let tcpReady = false
  let waits = 0
  let earlyAppStarts = 0
  const executor: CommandExecutor = async args => {
    if (args.includes("inspect")) return { exitCode: 1, stdout: "", stderr: `Error: No such ${args[1]}: ${args.at(-1)}` }
    if (args.includes("pg_isready")) {
      // The initialization server accepts sockets before the final server accepts TCP.
      const tcp = args.includes("-h") && args[args.indexOf("-h") + 1] === "127.0.0.1"
      return { exitCode: !tcp || tcpReady ? 0 : 1, stdout: "", stderr: "" }
    }
    if (args.includes("SMITHERS_AUTH_MODE=selfhost")) {
      if (!tcpReady) earlyAppStarts += 1
      return { exitCode: 17, stdout: "", stderr: "stop after checking database readiness" }
    }
    return { exitCode: 0, stdout: "created\n", stderr: "" }
  }
  await expect(startPackagedWebSelfhost({ rootDir: outputDir, revision, outputDir, executor,
    wait: async () => { waits += 1; tcpReady = true }
  })).rejects.toThrow("stop after checking database readiness")
  expect(earlyAppStarts).toBe(0)
  expect(waits).toBe(1)
})

test("coding-account acceptance requires an explicit opt-in recorded in the receipt", async () => {
  for (const subscriptionConnections of [undefined, false, true]) {
    const outputDir = temporary()
    let appArguments: readonly string[] = []
    const executor: CommandExecutor = async args => {
      if (args.includes("inspect")) return { exitCode: 1, stdout: "", stderr: `Error: No such ${args[1]}: ${args.at(-1)}` }
      if (args.includes("SMITHERS_AUTH_MODE=selfhost")) {
        appArguments = args
        return { exitCode: 17, stdout: "", stderr: "stop after checking self-host configuration" }
      }
      return { exitCode: 0, stdout: "created\n", stderr: "" }
    }
    await expect(startPackagedWebSelfhost({ rootDir: outputDir, revision, outputDir, executor, subscriptionConnections })).rejects.toThrow("stop after checking self-host configuration")
    expect(appArguments.includes("SMITHERS_FEATURE_FLAGS_SUBSCRIPTION_CONNECTIONS=true")).toBe(subscriptionConnections === true)
    const report = JSON.parse(readFileSync(join(outputDir, "web-selfhost.launch.json"), "utf8"))
    expect(report.subscriptionConnections).toBe(subscriptionConnections === true)
  }
})
