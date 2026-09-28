/**
 * The host's route into a named container, as an injected transport.
 *
 * A task whose interpreter, dependencies, and test runner live in a container
 * makes every command a nested quoting problem: the agent writes
 * `docker exec c bash -lc 'cd /testbed && python - <<EOF … EOF'`, and one layer
 * of that stack eats a quote. The measured cost across the 45-instance program
 * was twelve failed probes, one instance's single most expensive frame
 * (astropy-8707, which produced a probe that never ran), and a class of failure
 * that turns from a broken probe into a broken *edit* the moment the same
 * quoting reaches a writing command.
 *
 * So the transport is the harness's, not the agent's. A caller names the
 * container and passes its program and payload as data; this service turns that
 * into the argv the host actually spawns. `docker` and `podman` share the CLI
 * {@link makeCommand} builds, and a host with a different route supplies its own
 * {@link make} rather than teaching the agent a new incantation.
 *
 * A host that has no container route provides {@link makeNoop}, whose refusal
 * says so plainly. Nothing here shells out on its own: it only decides an argv,
 * and `bash` spawns it through the same permission-aware spawner as everything
 * else.
 *
 * @since 1.0.0
 */

import { Context, Effect, Layer } from "effect"
import * as StdError from "./StdError.ts"

/**
 * One command to run inside a container.
 *
 * @category models
 * @since 1.0.0
 */
export interface Request {
  readonly container: string
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
  readonly env?: Record<string, string> | undefined
  /** Whether the payload arrives on the program's standard input. */
  readonly stdin: boolean
}

/**
 * The argv the host spawns to satisfy a {@link Request}.
 *
 * @category models
 * @since 1.0.0
 */
export interface Plan {
  readonly file: string
  readonly args: ReadonlyArray<string>
  /** Environment overrides for the transport process, never rendered as argv. */
  readonly env?: Record<string, string> | undefined
}

/**
 * The one container transport contract.
 *
 * @category services
 * @since 1.0.0
 */
export interface Container {
  readonly exec: (request: Request) => Effect.Effect<Plan, StdError.StdError>
}

/**
 * The {@link Container} service tag.
 *
 * @category services
 * @since 1.0.0
 */
export const Container: Context.Service<Container, Container> = Context.Service("@smthrs/std/Container")

/**
 * Builds a container transport from its one operation.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (service: Container): Container => Container.of(service)

/**
 * The refusal a host with no container route answers with.
 *
 * @category errors
 * @since 1.0.0
 */
export const unavailable = (container: string): StdError.StdError =>
  new StdError.StdError({
    code: "provider_unavailable",
    message:
      `This host has no container transport, so it cannot run anything in "${container}". Drop the container field and run the command here, or ask the host to bind one.`
  })

/**
 * Builds the transport for a host with no container route.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeNoop = (): Container => make({ exec: (request) => Effect.fail(unavailable(request.container)) })

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerNoop: Layer.Layer<Container> = Layer.succeed(Container, makeNoop())

/** The names a forwarded environment variable may take: a POSIX shell name. */
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The prefix a forwarded variable carries on the host transport process. */
const forwardedPrefix = "SMITHERS_CONTAINER_ENV_"

/** The in-container script that renames each forwarded variable, then runs the program. */
const rename = (names: ReadonlyArray<string>): string =>
  [
    ...names.map((key) => `${key}="$${forwardedPrefix}${key}"; export ${key}; unset ${forwardedPrefix}${key}`),
    `exec "$@"`
  ].join("; ")

/**
 * Builds a transport over a `docker exec`-compatible CLI.
 *
 * `-i` is attached only when the payload arrives on standard input, because a
 * container CLI that holds stdin open for a command that never reads it makes
 * that command hang.
 *
 * Requested environment variables never reach the transport process under
 * their own names. The request's `env` is the caller's, and the transport is a
 * host program: `PATH`, `LD_PRELOAD`, `DOCKER_HOST` or `XDG_CONFIG_HOME` set on
 * it would choose what runs on the host. Each value therefore travels in
 * {@link Plan.env} under `SMITHERS_CONTAINER_ENV_`, is forwarded by that name
 * (`-e SMITHERS_CONTAINER_ENV_KEY`), and a `sh` inside the container renames it
 * to `KEY` before `exec`ing the program. Values stay out of the argv. A name
 * must be a POSIX shell name.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeCommand = (options?: { readonly program?: string | undefined }): Container => {
  const program = options?.program ?? "docker"
  return make({
    exec: (request) => {
      const names = Object.keys(request.env ?? {})
      const invalid = names.find((key) => !environmentName.test(key))
      if (invalid !== undefined) {
        return Effect.fail(
          new StdError.StdError({
            code: "invalid_input",
            message: `Environment variable names must match ${environmentName.source}: ${invalid}`
          })
        )
      }
      if (request.container === "" || request.container.startsWith("-")) {
        return Effect.fail(
          new StdError.StdError({
            code: "invalid_input",
            message: `Container name must be non-empty and cannot start with '-': ${request.container}`,
            path: request.container
          })
        )
      }
      const args = Array.from(request.args)
      if (args.some((arg) => typeof arg !== "string")) {
        return Effect.fail(
          new StdError.StdError({
            code: "invalid_input",
            message: "Container arguments must be a dense array of strings."
          })
        )
      }
      return Effect.succeed({
        file: program,
        args: [
          "exec",
          ...(request.stdin ? ["-i"] : []),
          ...(request.cwd === undefined ? [] : ["-w", request.cwd]),
          ...names.flatMap((key) => ["-e", `${forwardedPrefix}${key}`]),
          "--",
          request.container,
          ...(names.length === 0 ? [] : ["sh", "-c", rename(names), "sh"]),
          request.file,
          ...args
        ],
        ...(request.env === undefined ? {} : {
          env: Object.fromEntries(
            Object.entries(request.env).map(([key, value]) => [`${forwardedPrefix}${key}`, value])
          )
        })
      })
    }
  })
}

/**
 * Provides {@link makeCommand}.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerCommand = (options?: { readonly program?: string | undefined }): Layer.Layer<Container> =>
  Layer.succeed(Container, makeCommand(options))
