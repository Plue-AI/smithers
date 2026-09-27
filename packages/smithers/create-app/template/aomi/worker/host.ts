/**
 * The turn host a session's turns and flow runs execute on.
 *
 * `@smthrs/create-app/worker` owns the run: seat resolution, the judge, the
 * QuickJS sandbox, the in-memory flow engine, and the NDJSON frames. This file
 * only says what differs for this app: the three tool sources a Worker rebinds
 * per run, the fork endpoint the chain tool needs, and the observer that
 * writes a run's cards, cells, and answer back into the session as the run
 * produces them, whether or not anyone is reading the stream.
 *
 * Nothing here is a mock. A missing seat key or fork endpoint is a
 * typed 503 refusal decided before any stream opens.
 */
import type { ToolsSpec } from "@smthrs/create-app/app"
import type { AppCard, TurnFrame } from "@smthrs/create-app/ui"
import type { SeatProvider } from "@smthrs/create-app/runtime"
import type { TurnHost, TurnRefusal, TurnRoute } from "@smthrs/create-app/worker"
import type * as Evaluator from "@smthrs/model/Evaluator"
import type * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import { type ExecutedCell, type SessionFlows, sessionSource } from "../tools/promote.ts"
import { layerTevm, type Service as TevmService, Tevm, tevmSource } from "../tools/tevm.ts"
import { turnSource } from "../tools/ui.ts"
import type { Env } from "./env.ts"

export type { SessionFlows }

/**
 * What a caller may replace. The Worker passes nothing and gets the workerd
 * QuickJS build, the generated routes, the provider seats and completion judge
 * read from `env`, and the real Tevm fork over `TEVM_FORK_RPC_URL`. A Node test
 * passes the Node QuickJS build, a recorded seat, a scripted judge, and a
 * deterministic chain.
 */
export interface HostSeams {
  readonly sandboxVariant?: Layer.Layer<QuickJSSandbox.Variant> | undefined
  readonly routes?: (() => Promise<ReadonlyArray<TurnRoute>>) | undefined
  readonly paneNames?: ReadonlyArray<string> | undefined
  readonly seats?: SeatProvider | undefined
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  readonly chain?: TevmService | undefined
}

/** What a run's frames write back, as the run produces them. */
export interface FrameSink {
  readonly card: (card: AppCard) => void
  readonly delta: (text: string) => void
  /** The terminal frame, exactly once, even when the reader hung up first. */
  readonly end: (frame: Extract<TurnFrame, { type: "done" | "error" }>) => void
}

const generated = async (): Promise<{ flows: ReadonlyArray<TurnRoute>; paneNames: ReadonlyArray<string> }> => {
  const routes = await import("../routes.gen.ts")
  return { flows: routes.flows as unknown as ReadonlyArray<TurnRoute>, paneNames: routes.paneNames }
}

/**
 * Builds the host for one run, or the refusal that says which binding is
 * missing. The seat and judge refusals come from the shared host once the
 * route is known; the fork endpoint is this app's own, so it is checked here.
 */
export const hostFor = async (
  env: Env,
  session: SessionFlows,
  sink: FrameSink,
  seams: HostSeams = {}
): Promise<TurnHost | TurnRefusal> => {
  const rpcUrl = env.TEVM_FORK_RPC_URL
  if (seams.chain === undefined && (rpcUrl === undefined || rpcUrl.length === 0)) {
    return {
      status: 503,
      error: "host_unconfigured",
      message: "Set the TEVM_FORK_RPC_URL secret so the chain tool has a fork to read"
    }
  }
  const chain = seams.chain ?? await Effect.runPromise(Effect.provide(Tevm, layerTevm({ rpcUrl: rpcUrl! })))
  const chainSource = tevmSource(Context.make(Tevm, chain))
  const table = seams.routes === undefined
    ? await generated()
    : { flows: await seams.routes(), paneNames: seams.paneNames ?? [] }
  const sandboxVariant = seams.sandboxVariant ?? (await import("./sandbox.ts")).sandboxVariant
  const cells: Array<ExecutedCell> = []
  const origin = chain.rpcUrl === undefined ? undefined : new URL(chain.rpcUrl).origin

  const tools = (route: TurnRoute, cards: Parameters<NonNullable<TurnHost["tools"]>>[1]): ToolsSpec => ({
    ...route.tools,
    sources: route.tools.sources.map((source) => {
      switch (source.name) {
        case "ui":
          return turnSource(cards, table.paneNames)
        case "flows":
          return sessionSource(session, cells)
        case "tevm":
          return chainSource
        default:
          return source
      }
    }),
    // The real chain declares `net:post` on its configured origin, so the run
    // grants exactly that origin and nothing wider.
    grant: origin === undefined
      ? route.tools.grant
      : [...route.tools.grant, { action: "net:post", resource: `${origin}/*` }]
  })

  // `flows/show-script` reads `cells` while the run is still going, so a cell
  // is recorded when the run produces it, not when a reader gets to it.
  const observe = (frame: TurnFrame): void => {
    switch (frame.type) {
      case "cell":
        cells.push({ ordinal: frame.ordinal, source: frame.source })
        return
      case "card":
      case "card.update":
        sink.card(frame.card)
        return
      case "delta":
        sink.delta(frame.text)
        return
      case "done":
      case "error":
        sink.end(frame)
        return
      default:
        return
    }
  }

  return {
    flows: table.flows,
    env: {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
    },
    sandboxVariant,
    tools,
    observe,
    ...(seams.seats === undefined ? {} : { seats: seams.seats }),
    ...(seams.evaluator === undefined ? {} : { evaluator: seams.evaluator })
  }
}
