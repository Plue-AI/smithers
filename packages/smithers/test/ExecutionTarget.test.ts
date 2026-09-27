import { describe, expect, it } from "vitest"
import { executionRunId } from "../src/history/ExecutionTarget.ts"

describe("execution target routing", () => {
  it.each(["resume", "cancel", "signal", "steer"])(
    "routes %s through flags without treating their values as IDs",
    (verb) => {
      expect(executionRunId(["--root", "other-run", verb, "--mcp-config=servers.json", "fork-run", "--json"]))
        .toBe("fork-run")
      expect(executionRunId([verb, "--root", "other-run", "fork-run"]))
        .toBe("fork-run")
    }
  )

  it("routes a presentation flag the command accepts, wherever it appears", () => {
    // `--silent`, `--verbose` and `--audience` are shared globals the legacy
    // parser accepts; treating them as unknown dropped the fork's worktree.
    expect(executionRunId(["resume", "fork-run", "--json", "--silent"])).toBe("fork-run")
    expect(executionRunId(["--audience", "human", "resume", "fork-run"])).toBe("fork-run")
    expect(executionRunId(["--audience=agent", "steer", "fork-run", "--message", "go", "--verbose"])).toBe("fork-run")
    expect(executionRunId(["run", "fork-run", "--resume", "--json", "--verbose"])).toBe("fork-run")
    expect(executionRunId(["resume", "--quiet", "false", "fork-run"])).toBe("fork-run")
    expect(executionRunId(["resume", "--no-silent", "fork-run"])).toBe("fork-run")
  })

  it("only routes the resume form of legacy run", () => {
    expect(executionRunId(["run", "fork-run", "--resume"])).toBe("fork-run")
    expect(executionRunId(["run", "--resume=true", "fork-run"])).toBe("fork-run")
    expect(executionRunId(["run", "fork-run", "--resume=false"])).toBeUndefined()
    expect(executionRunId(["run", "plan-payload"])).toBeUndefined()
  })

  it.each(["approve", "deny"])("routes %s only for a complete node approval payload", (verb) => {
    const payload = {
      target: {
        _tag: "Node",
        runId: "fork-run",
        requestId: "ask",
        digest: "reviewed",
        envelope: { capabilities: [], flows: [], budget: {} }
      },
      scope: "once",
      idempotencyKey: "decision"
    }
    expect(executionRunId([verb, JSON.stringify(payload), "--scope", "once"])).toBe("fork-run")
    expect(executionRunId([verb, JSON.stringify({ target: payload.target })])).toBeUndefined()
    expect(
      executionRunId([
        verb,
        JSON.stringify({ ...payload, target: { ...payload.target, _tag: "Plan", planId: "plan" } })
      ])
    )
      .toBeUndefined()
    expect(executionRunId([verb, "not-json"])).toBeUndefined()
  })

  it("does not guess at documents, removed flags, missing values, or unknown commands", () => {
    expect(executionRunId(["resume", "fork-run", "--help"])).toBeUndefined()
    expect(executionRunId(["resume", "--unknown", "fork-run"])).toBeUndefined()
    expect(executionRunId(["resume", "--json=maybe", "fork-run"])).toBeUndefined()
    expect(executionRunId(["steer", "fork-run", "--takeover"])).toBeUndefined()
    expect(executionRunId(["resume", "--root"])).toBeUndefined()
    // A verb flag that takes a value: written with `=`, and written last with
    // nothing after it to take.
    expect(executionRunId(["steer", "fork-run", "--message=go"])).toBe("fork-run")
    expect(executionRunId(["steer", "fork-run", "--message"])).toBeUndefined()
    // A verb switch only carries a boolean.
    expect(executionRunId(["run", "fork-run", "--resume=maybe"])).toBeUndefined()
    expect(executionRunId(["status", "fork-run"])).toBeUndefined()
    expect(executionRunId(["resume", "--", "-fork-run"])).toBe("-fork-run")
  })
})
