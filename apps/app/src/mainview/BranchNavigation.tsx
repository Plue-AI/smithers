import { useRef, useState } from "react"
import type { Collection, NonSingleResult } from "@tanstack/db"
import type { Branch } from "./state/AppState"
import { useLiveQuery } from "@tanstack/react-db"
import { Markdown } from "@smthrs/ui"
import { useController } from "./ControllerContext"
import { BranchTree } from "./BranchTree"
import { EarlierArchive } from "./EarlierArchive"
import { accountOwnerOf } from "./state/AccountOwner"

/** The shell's projections read saved state; an archive has no command callbacks. */
export function BranchNavigation() {
  const controller = useController()
  const [saving, setSaving] = useState(false)
  const pending = useRef(0)
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const { data: identities } = useLiveQuery(controller.store.collections.identitySessions)
  const { data: branches } = useLiveQuery<Branch, string, Record<string, never>>(controller.store.collections.branches as unknown as Collection<Branch, string, Record<string, never>> & NonSingleResult)
  const view = sessions[0]?.branchNavigation
  const owner = accountOwnerOf(identities[0]) ?? null
  if (!view?.open || view.owner !== owner) return null
  const available = branches.filter(branch => (!branch.archiveOwner || branch.archiveOwner === owner) && branch.snapshot && branch.snapshot.messages.length + branch.snapshot.cards.length > 0)
  const journalIds = new Set(available.filter(branch => branch.archiveOwner === owner && branch.id.startsWith("earlier:journal:")).map(branch => branch.id.slice("earlier:journal:".length)))
  const archives = available.filter(branch => !journalIds.has(branch.id))
    .map(branch => ({ id: branch.id, title: branch.title, entries: [
      ...branch.snapshot!.messages.map(message => ({ id: message.id, ordinal: message.ordinal, content: <Markdown key={message.id} content={message.text} /> })),
      ...branch.snapshot!.cards.map(card => ({ id: card.id, ordinal: card.ordinal, content: <article key={card.id} data-archive-card={card.kind}><strong>{card.title}</strong></article> }))
    ].sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id)).map(entry => entry.content) }))
  const earlier = { id: "earlier", name: "Earlier", kind: "earlier" as const, archive_count: archives.length, present: [], children: [] }
  const update = (patch: Partial<typeof view>) => {
    const request = ++pending.current
    setSaving(true)
    void controller.setBranchNavigationView(patch)
      .catch(() => { /* The store owns persistence failure and recovery. */ })
      .finally(() => { if (request === pending.current) setSaving(false) })
  }
  return <div data-branch-navigation aria-busy={saving}>
    <BranchTree nodes={[...view.nodes, earlier]} view={view}
      onAction={(tag, args) => { void controller.commands.submit({ name: tag, payload: args ?? {}, actor: "user" }) }}
      onView={patch => update({ ...patch, ...(patch.selected_branch === "earlier" ? { previous_branch: view.selected_branch } : {}) })} />
    {view.selected_branch === "earlier" ? <EarlierArchive model={{ node: earlier, archives, read_only: true }} view={view} onView={update} /> : null}
  </div>
}
