import { NodeServices } from "@effect/platform-node"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Option, Path } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Bash from "../src/Bash.ts"
import * as Container from "../src/Container.ts"

const request = (container: string): Container.Request => ({
  container,
  file: "bash",
  args: ["-lc", "echo ready"],
  cwd: "/work",
  env: { MODE: "test" },
  stdin: true
})

describe("Container.makeCommand", () => {
  it("places the option terminator before a normal container name", async () => {
    const plan = await Effect.runPromise(Container.makeCommand().exec(request("worker-1")))

    expect(plan).toEqual({
      file: "docker",
      args: [
        "exec",
        "-i",
        "-w",
        "/work",
        "-e",
        "SMITHERS_CONTAINER_ENV_MODE",
        "--",
        "worker-1",
        "sh",
        "-c",
        `MODE="$SMITHERS_CONTAINER_ENV_MODE"; export MODE; unset SMITHERS_CONTAINER_ENV_MODE; exec "$@"`,
        "sh",
        "bash",
        "-lc",
        "echo ready"
      ],
      env: { SMITHERS_CONTAINER_ENV_MODE: "test" }
    })
  })

  it("runs the program without a shell when the request carries no env, and says a shell is required otherwise", async () => {
    // An image without `/bin/sh` (distroless, scratch) can serve only requests
    // that carry no env; the renaming step is the one place a shell is needed.
    const plan = await Effect.runPromise(
      Container.makeCommand().exec({ ...request("worker-1"), env: undefined, file: "/app/server", args: [] })
    )
    expect(plan.args).toEqual(["exec", "-i", "-w", "/work", "--", "worker-1", "/app/server"])
    const guide = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8")
    expect(guide).toMatch(/A request that\s+carries `env` therefore requires `sh` on the container's `PATH`/)
  })

  it("forwards a requested variable by name, never by value", async () => {
    // `docker exec -e KEY` and `podman exec -e KEY` read the value from their
    // own environment, which is what `Plan.env` is for. A value written into
    // the argv would sit in the process table for every local reader and in
    // every rendering of that argv.
    const plan = await Effect.runPromise(
      Container.makeCommand().exec({
        ...request("worker-1"),
        env: { DATABASE_PASSWORD: "s3cret-value" }
      })
    )

    expect(plan.args).toContain("SMITHERS_CONTAINER_ENV_DATABASE_PASSWORD")
    expect(plan.args.join(" ")).not.toContain("s3cret-value")
    expect(plan.env).toEqual({ SMITHERS_CONTAINER_ENV_DATABASE_PASSWORD: "s3cret-value" })
  })

  it("never lets a requested variable configure the host transport process", async () => {
    // A containerised caller's `env` used to land on the host `docker` process
    // under its own name, so `PATH` chose which host binary ran as the
    // transport. The planted transport below is reachable only through that
    // PATH; it must never run.
    const planted = mkdtempSync(join(tmpdir(), "std-container-path-"))
    const marker = join(planted, "ran-on-host")
    try {
      writeFileSync(join(planted, "smithers-planted-transport"), `#!/bin/sh\n/usr/bin/touch '${marker}'\n`, {
        mode: 0o755
      })
      await Effect.runPromise(
        Effect.exit(Bash.run({
          mode: "unhermetic",
          container: "worker-1",
          env: { PATH: planted, LD_PRELOAD: join(planted, "evil.so") },
          command: "true"
        })).pipe(
          Effect.provide(Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(Container.Container)(Container.makeCommand({ program: "smithers-planted-transport" }))
          ))
        )
      )
      expect(existsSync(marker)).toBe(false)
      const plan = await Effect.runPromise(
        Container.makeCommand().exec({
          ...request("worker-1"),
          env: { PATH: planted, LD_PRELOAD: "evil.so" }
        })
      )
      expect(Object.keys(plan.env ?? {})).toEqual(["SMITHERS_CONTAINER_ENV_PATH", "SMITHERS_CONTAINER_ENV_LD_PRELOAD"])
    } finally {
      rmSync(planted, { recursive: true, force: true })
    }
  })

  it("renames each forwarded variable inside the container before the program runs", async () => {
    const plan = await Effect.runPromise(
      Container.makeCommand().exec({
        container: "worker-1",
        file: "sh",
        args: ["-c", `printf '%s|%s|%s' "$MODE" "$NOTE" "\${SMITHERS_CONTAINER_ENV_MODE-unset}"`],
        env: { MODE: "a b\nc", NOTE: "$(touch nothing)" },
        stdin: false
      })
    )
    // Everything after the container name is what `docker exec` runs in it.
    const inside = plan.args.slice(plan.args.indexOf("worker-1") + 1)
    const output = execFileSync(inside[0]!, inside.slice(1), {
      env: { PATH: process.env["PATH"] ?? "", ...plan.env },
      encoding: "utf8"
    })
    expect(output).toBe("a b\nc|$(touch nothing)|unset")
  })

  it.each(["-privileged", "A=B", "1A", "", "A B"])("refuses environment name %j before spawning", async (name) => {
    const error = await Effect.runPromise(Effect.flip(
      Container.makeCommand().exec({
        ...request("worker-1"),
        env: { [name]: "value" }
      })
    ))
    expect(error).toMatchObject({ code: "invalid_input" })
  })

  it.each(["--privileged", ""])("refuses container name %j before spawning", async (container) => {
    let spawns = 0
    const spawner = ChildProcessSpawner.makeNoop({
      spawn: () => {
        spawns++
        return Effect.fail(new Error("unexpected spawn") as never)
      }
    })
    const exit = await Effect.runPromise(
      Effect.exit(Bash.run({ mode: "unhermetic", container, command: "echo ready" })).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner),
          Layer.succeed(Container.Container)(Container.makeCommand()),
          Path.layer
        ))
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.getOrUndefined(failure)).toMatchObject({ code: "invalid_input", path: container })
    }
    expect(spawns).toBe(0)
  })
})
