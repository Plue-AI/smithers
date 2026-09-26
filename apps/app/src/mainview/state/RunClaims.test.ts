import { describe, expect, test } from "bun:test"
import { canonicalCommandName } from "@smthrs/ui/command-line"
import { RUN_LAUNCH_COMMANDS, runLaunchCommandOf, renderedRunTurnText, toolResultLaunchedRun } from "./RunClaims"

const call = (name: string): string => JSON.stringify({ action: "execute", name, args: "x" })

test("a requested launch arms claim suppression without claiming a run has started", () => {
  expect(toolResultLaunchedRun("run-requested workflow=review request=r1 repo=o/r")).toBe(true)
  expect(toolResultLaunchedRun("failed: run-requested")).toBe(false)
  expect(renderedRunTurnText("flow.run", "The run has completed.")).toBe("Run requested.")
  expect(renderedRunTurnText("flow.run", "The run is now running.")).toBe("Run requested.")
  expect(renderedRunTurnText("flow.create", "The flow has been created.")).toBe("Run requested.")
})

/*
 * ui-state-store/api-design/1: execution (agentTools.ts) trims and strips a
 * leading slash before matching, so every spelling it launches from must
 * classify as the same launch, or the deterministic claim gate stays unarmed
 * for a run that really started.
 */
describe("runLaunchCommandOf classifies every spelling execution accepts", () => {
  test("bare, slash-prefixed, and whitespace-padded launches all classify", () => {
    for (const command of ["flow.run", "flow.create"]) {
      for (const spelling of [command, `/${command}`, ` ${command} `, `  //${command}`]) {
        expect(runLaunchCommandOf("commands", call(spelling))).toBe(command)
        expect(canonicalCommandName(spelling)).toBe(command)
      }
    }
  })

  test("every launch command is a registry-bare name, so canonicalization is a no-op on it", () => {
    for (const command of RUN_LAUNCH_COMMANDS) expect(canonicalCommandName(command)).toBe(command)
  })

  test("non-launch commands stay undefined in every spelling", () => {
    for (const spelling of ["world", "/world", " flow.list ", "/flow.run.stop", "flow.runner"]) {
      expect(runLaunchCommandOf("commands", call(spelling))).toBeUndefined()
    }
    expect(runLaunchCommandOf("commands", JSON.stringify({ action: "list", name: "/flow.run" }))).toBeUndefined()
    expect(runLaunchCommandOf("commands", "not json")).toBeUndefined()
    expect(runLaunchCommandOf("browser", call("/flow.run"))).toBeUndefined()
  })

  test("a direct launch tool name is still accepted", () => {
    expect(runLaunchCommandOf("flow.run", "")).toBe("flow.run")
  })
})
