import { z } from "zod"
import { ActorSchema } from "@smthrs/rpc/CardPrimitives"
import type { TerminalCard } from "@smthrs/rpc/TerminalCard"
import type { TerminalStream } from "@smthrs/ui/adapters/terminal"
import type { CloudTerminalClient } from "../CloudTerminalClient"

// T-APP-12: serialized branch metadata only; stream callbacks never cross this decoder.
const TerminalMetadata = z.object({ id: z.string().min(1), title: z.string(), owner: ActorSchema,
  agents: z.array(ActorSchema), watchers: z.array(ActorSchema), command: z.string().optional(), frozen: z.boolean() })
const BranchTerminals = z.object({ terminals: z.array(TerminalMetadata),
  rebase: z.object({ state: z.enum(["pending", "rebasing", "conflict"]) }).optional() })

export function terminalModel(data: unknown, branch: string, id: string, viewer: string | undefined): TerminalCard | undefined {
  if (!viewer) return
  const decoded = BranchTerminals.safeParse(data)
  if (!decoded.success) return
  const terminal = decoded.data.terminals.find(row => row.id === id)
  if (!terminal) return
  const owner = terminal.owner
  // Coding/reviewer sessions are never writable, including when acting for the viewer.
  const viewer_is_owner = owner.kind === "person" ? owner.login === viewer
    : owner.kind === "agent" && owner.agent !== "coding" && owner.agent !== "reviewer" && owner.for_member?.login === viewer
  return { ...terminal, branch, viewer_is_owner, frozen: terminal.frozen || decoded.data.rebase?.state === "rebasing" }
}

/** Supplied only by the production provider after T-TRM-01 isolation/authority checks. */
export interface TerminalCardSource {
  readonly branch: (id: string) => string | undefined
  readonly repo: string
  readonly viewer: () => string | undefined
  readonly available: () => boolean
}

/** Uses the existing byte client; rechecks authority even for callbacks retained by the emulator. */
export function createTerminalBinding(options: {
  repo: string; branch: string; id: string; client: CloudTerminalClient
  viewer: () => string | undefined; available: () => boolean; metadata: () => unknown
}) {
  const model = () => options.available() ? terminalModel(options.metadata(), options.branch, options.id, options.viewer()) : undefined
  const writable = () => { const value = model(); return value?.viewer_is_owner && !value.frozen }
  const stream: TerminalStream = write => {
    if (!model()) return
    return options.client.attach(options.repo, options.id, { onOutput: data => { if (model()) write(data) } })
  }
  return { model, stream,
    input: (data: string) => { if (writable()) options.client.input(options.id, data) },
    resize: ({ cols, rows }: { cols: number; rows: number }) => { if (writable()) options.client.resize(options.id, cols, rows) } }
}
