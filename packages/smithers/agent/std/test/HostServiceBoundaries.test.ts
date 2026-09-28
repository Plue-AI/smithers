import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Container from "../src/Container.ts"
import * as Search from "../src/Search.ts"

describe("public host service plans and unavailable routes", () => {
  const plans = ["docker", "podman"].flatMap((program) =>
    [false, true].flatMap((stdin) =>
      [false, true].flatMap((cwd) =>
        (["absent", "empty", "values"] as const).map((env) => ({ program, stdin, cwd, env }))
      )
    )
  )
  it.each(plans)(
    "plans $program stdin=$stdin cwd=$cwd env=$env without shell quoting or credential argv",
    async ({ program, stdin, cwd, env }) => {
      const environment = env === "values"
        ? { TOKEN: "dummy secret with spaces", MODE: "a=b" }
        : env === "empty"
        ? {}
        : undefined
      const request: Container.Request = {
        container: "worker name",
        file: "python3",
        args: ["-c", "print('quoted $value;')"],
        stdin,
        ...(cwd ? { cwd: "/work tree" } : {}),
        ...(environment === undefined ? {} : { env: environment })
      }
      const output = await Effect.runPromise(Container.makeCommand({ program }).exec(request))
      expect(output).toEqual({
        file: program,
        args: [
          "exec",
          ...(stdin ? ["-i"] : []),
          ...(cwd ? ["-w", "/work tree"] : []),
          ...(env === "values" ? ["-e", "TOKEN", "-e", "MODE"] : []),
          "--",
          "worker name",
          "python3",
          "-c",
          "print('quoted $value;')"
        ],
        ...(environment === undefined ? {} : { env: environment })
      })
      expect(output.args.join(" ")).not.toContain("dummy secret with spaces")
    }
  )

  it.each(["constructor", "layer"] as const)(
    "unavailable container %s refuses each request with the named route and no payload leak",
    async (binding) => {
      const results = await Effect.runPromise(
        Effect.gen(function*() {
          const service = binding === "constructor" ? Container.makeNoop() : yield* Container.Container
          return yield* Effect.forEach(["first-worker", "second-worker"], (container) =>
            Effect.flip(service.exec({
              container,
              file: "private-program",
              args: ["private-argument"],
              stdin: false,
              env: { SECRET: "dummy-secret-value" }
            })))
        }).pipe(Effect.provide(Container.layerNoop))
      )
      expect(results).toMatchObject([
        {
          code: "provider_unavailable",
          message:
            "This host has no container transport, so it cannot run anything in \"first-worker\". Drop the container field and run the command here, or ask the host to bind one."
        },
        {
          code: "provider_unavailable",
          message:
            "This host has no container transport, so it cannot run anything in \"second-worker\". Drop the container field and run the command here, or ask the host to bind one."
        }
      ])
      for (const result of results) {
        expect(result.message).not.toContain("private-program")
        expect(result.message).not.toContain("private-argument")
        expect(result.message).not.toContain("dummy-secret-value")
      }
    }
  )

  it("the command layer supplies the requested CLI and preserves the program payload as distinct argv", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* (yield* Container.Container).exec({
          container: "worker",
          file: "printf",
          args: ["%s", "a b"],
          stdin: false
        })
      }).pipe(Effect.provide(Container.layerCommand({ program: "podman" })))
    )
    expect(result).toEqual({ file: "podman", args: ["exec", "--", "worker", "printf", "%s", "a b"] })
  })

  it.each(["constructor", "layer"] as const)(
    "unavailable search %s refuses both public operations without returning empty success",
    async (binding) => {
      const results = await Effect.runPromise(
        Effect.gen(function*() {
          const service = binding === "constructor" ? Search.makeNoop() : yield* Search.Search
          return {
            grep: yield* Effect.flip(service.grep({
              pattern: "private-pattern",
              root: "/private-root",
              fixedStrings: true,
              ignoreCase: false,
              smartCase: false,
              globs: [],
              beforeContext: 0,
              afterContext: 0,
              filesWithMatches: false,
              hidden: false,
              symbols: false,
              limit: 10
            })),
            glob: yield* Effect.flip(
              service.glob({ pattern: "*.txt", root: "/private-root", hidden: false, limit: 10 })
            )
          }
        }).pipe(Effect.provide(Search.layerNoop))
      )
      expect(results).toMatchObject({
        grep: { code: "provider_unavailable", message: "No search implementation is configured" },
        glob: { code: "provider_unavailable", message: "No search implementation is configured" }
      })
    }
  )
})
