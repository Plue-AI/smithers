import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Container from "../src/Container.ts"

const baseRequest = {
  container: "worker",
  file: "printf",
  args: ["ready"],
  stdin: false
} satisfies Omit<Container.Request, "env">

describe("Container.makeCommand environment snapshot", () => {
  it("owns added, deleted, and changed entries before the effect runs", async () => {
    const env: Record<string, string> = { KEEP: "kept", REMOVE: "removed", CHANGE: "before" }
    const execution = Container.makeCommand().exec({ ...baseRequest, env })

    env["ADDED"] = "later"
    delete env["REMOVE"]
    env["CHANGE"] = "after"

    expect(await Effect.runPromise(execution)).toEqual({
      file: "docker",
      args: [
        "exec",
        "-e",
        "SMITHERS_CONTAINER_ENV_KEEP",
        "-e",
        "SMITHERS_CONTAINER_ENV_REMOVE",
        "-e",
        "SMITHERS_CONTAINER_ENV_CHANGE",
        "--",
        "worker",
        "sh",
        "-c",
        `KEEP="$SMITHERS_CONTAINER_ENV_KEEP"; export KEEP; unset SMITHERS_CONTAINER_ENV_KEEP; ` +
        `REMOVE="$SMITHERS_CONTAINER_ENV_REMOVE"; export REMOVE; unset SMITHERS_CONTAINER_ENV_REMOVE; ` +
        `CHANGE="$SMITHERS_CONTAINER_ENV_CHANGE"; export CHANGE; unset SMITHERS_CONTAINER_ENV_CHANGE; exec "$@"`,
        "sh",
        "printf",
        "ready"
      ],
      env: {
        SMITHERS_CONTAINER_ENV_KEEP: "kept",
        SMITHERS_CONTAINER_ENV_REMOVE: "removed",
        SMITHERS_CONTAINER_ENV_CHANGE: "before"
      }
    })
  })

  it("reads request.env once so forwarded names and values come from the same record", async () => {
    let reads = 0
    const request: Container.Request = {
      ...baseRequest,
      get env(): Record<string, string> {
        reads++
        return reads === 1 ? { FIRST: "accepted" } : { SECOND: "later" }
      }
    }

    const execution = Container.makeCommand().exec(request)
    const plan = await Effect.runPromise(execution)

    expect(plan).toEqual({
      file: "docker",
      args: [
        "exec",
        "-e",
        "SMITHERS_CONTAINER_ENV_FIRST",
        "--",
        "worker",
        "sh",
        "-c",
        `FIRST="$SMITHERS_CONTAINER_ENV_FIRST"; export FIRST; unset SMITHERS_CONTAINER_ENV_FIRST; exec "$@"`,
        "sh",
        "printf",
        "ready"
      ],
      env: { SMITHERS_CONTAINER_ENV_FIRST: "accepted" }
    })
    expect(reads).toBe(1)
  })

  it("distinguishes omitted env from an empty env snapshot", async () => {
    const omitted = Container.makeCommand().exec(baseRequest)
    const empty = Container.makeCommand().exec({ ...baseRequest, env: {} })

    expect(await Effect.runPromise(omitted)).toEqual({
      file: "docker",
      args: ["exec", "--", "worker", "printf", "ready"]
    })
    expect(await Effect.runPromise(empty)).toEqual({
      file: "docker",
      args: ["exec", "--", "worker", "printf", "ready"],
      env: {}
    })
  })
})
