import { Data } from "effect"
import { APP_BOOTSTRAP_PATH, AppBootstrapSchema, hasCapability } from "@smthrs/rpc/AppBootstrap"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { FetchLike, StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"

import type { AgentPort } from "./AgentPort"
import { createWebAgent } from "../native/WebAgent"

export type ShellPort =
  | { readonly kind: "browser" }
  | { readonly kind: "native"; readonly openExternal: (url: string) => Promise<boolean> }

export interface AppRuntime {
  readonly bootstrap: AppBootstrap
  readonly http: FetchLike
  /*
   * Only the ports a consumer holds. Everything else the host advertises stays
   * on `bootstrap.capabilities`, read through `hasCapability` at the site that
   * cares, rather than mirrored here as a descriptor nobody reads.
   */
  readonly backend: {
    readonly agent?: AgentPort
  }
  readonly shell: ShellPort
}

export const unavailableAgent = (): AgentPort => ({
  available: false,
  startTurn: async (): Promise<StartAgentTurnResult> => ({
    status: "error",
    message: "No agent provider is available in this runtime."
  }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
})


export type BootstrapFailureKind = "unreachable" | "missing" | "server" | "invalid"

export class BootstrapFailure extends Data.TaggedError("BootstrapFailure")<{
  readonly kind: BootstrapFailureKind
  readonly status?: number
  readonly message: string
}> {
  constructor(kind: BootstrapFailureKind, status?: number) {
    super({
      kind,
      ...(status === undefined ? {} : { status }),
      message: kind === "unreachable" ? "Backend is unreachable."
        : kind === "missing" ? "Backend does not provide Smithers bootstrap."
        : kind === "server" ? "Backend could not start Smithers."
        : "Backend returned an invalid Smithers bootstrap."
    })
  }
}

export const loadBootstrap = async (http: FetchLike): Promise<AppBootstrap> => {
  let response: Response
  try {
    response = await http(APP_BOOTSTRAP_PATH, { headers: { accept: "application/json" } })
  } catch {
    throw new BootstrapFailure("unreachable")
  }
  if (!response.ok) throw new BootstrapFailure(response.status === 404 ? "missing" : "server", response.status)
  const parsed = AppBootstrapSchema.safeParse(await response.json().catch(() => undefined))
  if (!parsed.success) throw new BootstrapFailure("invalid")
  return parsed.data
}

// One bootstrap per document, shared by idle preloading and controller boot.
let bootstrapRead: Promise<AppBootstrap> | undefined

export const warmBootstrap = (http: FetchLike): Promise<AppBootstrap> => {
  if (bootstrapRead !== undefined) return bootstrapRead
  bootstrapRead = loadBootstrap(http)
  void bootstrapRead.catch(() => { bootstrapRead = undefined })
  return bootstrapRead
}

export const createRuntime = (options: {
  readonly bootstrap: AppBootstrap
  readonly http: FetchLike
  readonly nativeOpenExternal?: (url: string) => Promise<boolean>
}): AppRuntime => {
  const { bootstrap, http } = options
  const native = options.nativeOpenExternal === undefined
    ? ({ kind: "browser" } as const)
    : ({ kind: "native", openExternal: options.nativeOpenExternal } as const)
  return {
    bootstrap,
    http,
    backend: {
      ...(hasCapability(bootstrap, "agent") || hasCapability(bootstrap, "model.turn")
        ? { agent: { ...createWebAgent({ fetchImpl: http }), available: hasCapability(bootstrap, "agent") } } : {})
    },
    shell: native
  }
}
