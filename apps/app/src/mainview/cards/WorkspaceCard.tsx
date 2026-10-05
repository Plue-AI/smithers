import { Copy } from "lucide-react"
import { ViewSkeleton } from "../ViewSkeleton"
import { flowAction, flowProps } from "../flows/FlowAction"
/*
 * The workspace card (lane citc, ADR 0002; completed by lane L3): one
 * persistent cloud computer, reviewed in the transcript.
 *
 * The header names the repository, the target bookmark, the BOOKMARK's head
 * (labeled as such), and — since plue#446 — the facts the DTO now carries:
 * the sandbox kind, the workspace's OWN head, how far ahead of and behind the
 * bookmark it is, how long it has been up, the Nix environment it was built
 * from, its persistence, the languages it relays a language server for
 * (plue#505, `lsp: typescript`), and its ssh host as a copyable line. Every one of
 * them renders only when the payload carries it: an absent field renders
 * NOTHING, never a placeholder and never a zero that was not on the wire.
 *
 * The body is five facets: the terminal and its sessions, the working copy's
 * files (the same listing component the repository file card uses, imported,
 * with the rows bound to the workspace's own routes), the declared services,
 * snapshots with their acts, and the egress audit — what this computer called
 * and which secret NAMES the proxy swapped in, never a value.
 *
 * Every act binds a registered command through onRunCommand and carries
 * data-flow (parity.test.ts gates this). The one act whose door is the
 * host's — the terminal rides the origin's `/api/cloud-ws/` tunnel, which
 * the Worker does not open until the W4 relay lands — is rendered only when
 * the live registry holds `box.terminal` (parity-hosts.test.ts (a‴)):
 * the pointer path drops an unregistered name silently, so a button bound to
 * it would be a dead control.
 */
import { eq } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { useState } from "react"
import { Button, StatusPill } from "@smthrs/ui"
import { Globe, Play, Server, Square, Trash2 } from "lucide-react"
import { useController } from "../ControllerContext"
import type { Card } from "../state/AppState"
import { describedFailure, FailureNotice } from "../FailureNotice"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { EGRESS_PROXY_UNAVAILABLE } from "../state/seams/WorkspaceSeam"
import { dayLabel } from "../Timestamps"
import { shortId } from "../state/ids"
import { FileListCardBody } from "./FileCards"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { flowArgs } from "../flows/FlowArgs"

/** Why a box failed, typed by what survived on its payload. */
export const BOX_FAILURE_COPY: Readonly<Record<"EgressProxyUnavailable" | "BoxFailed" | "BoxActRefused", UserFailureCopy>> = {
  EgressProxyUnavailable: { fault: "infra", sentence: "This box could not start its network guard. Not your fault.", actions: [] },
  BoxFailed: { fault: "infra", sentence: "This box failed. Not your fault.", actions: [] },
  BoxActRefused: { fault: "infra", sentence: "Smithers could not finish that on this box.", actions: [] }
}

export interface WorkspaceCardActions {
  readonly onRunCommand: RunCommand
}

type WorkspaceCard = Extract<Card, { kind: "workspace" }>
type WorkspacePayload = WorkspaceCard["payload"]

const FACETS = ["files", "services", "egress"] as const

/*
 * Lane L3b — ADR 0002: "three sandbox kinds share one option surface; the kind
 * is the choice." These are plue's own one-line descriptions of the three
 * kinds, in words. There is no environment or image picker beside them; that
 * is ADR 0002's standing default, not an omission.
 */
const KINDS = [
  { kind: "container", says: "legacy OCI image, the default" },
  { kind: "vm", says: "NixOS closure image, systemd PID 1" },
] as const

/**
 * How long the computer has been up, from the DTO's `started_at`. Null when
 * the wire carried no start (the VM has never run) or when the timestamp does
 * not parse — the header then says nothing about uptime rather than guessing.
 */
export const uptimeLabel = (startedAt: string | null | undefined, now: number): string | null => {
  if (startedAt === null || startedAt === undefined || startedAt === "") return null
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return null
  const seconds = Math.floor((now - started) / 1000)
  if (seconds < 0) return null
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `up ${days}d ${hours}h`
  if (hours > 0) return `up ${hours}h ${minutes}m`
  return `up ${minutes}m`
}

/**
 * The header facts the DTO carries, in the order the brief names them. Only
 * what the payload holds: a null field contributes no entry at all, so a
 * workspace answered without a head shows no head line rather than an empty
 * one.
 */
export const headerFacts = (payload: WorkspacePayload, now: number): ReadonlyArray<string> => {
  const facts: Array<string> = []
  if (payload.workspaceKind != null && payload.workspaceKind !== "") facts.push(payload.workspaceKind)
  const head = payload.head
  if (head != null && (head.changeId != null || head.commitId != null)) {
    const ids = [head.changeId, head.commitId].filter((id): id is string => id != null && id !== "").map(shortId)
    facts.push(`box head @ ${ids.join(" ")}`)
  }
  if (payload.ahead != null) facts.push(`${payload.ahead} ahead`)
  if (payload.behind != null) facts.push(`${payload.behind} behind`)
  const uptime = uptimeLabel(payload.startedAt, now)
  if (uptime !== null) facts.push(uptime)
  const environment = payload.environment
  if (environment != null && environment.source !== "") {
    facts.push(
      environment.revision != null && environment.revision !== ""
        ? `${environment.source} @ ${shortId(environment.revision)}`
        : environment.source
    )
  }
  if (payload.persistence != null && payload.persistence !== "") facts.push(payload.persistence)
  /* Lane L6 (plue #505): the languages the workspace relays a language server for; an empty or absent list says nothing. */
  if (payload.lspLanguages != null && payload.lspLanguages.length > 0) facts.push(`lsp: ${payload.lspLanguages.join(", ")}`)
  return facts
}

/**
 * The TAG of a registry reference — the part after the last `:` — never the
 * whole path. A reference with no `:` at all, or one whose colon belongs to a
 * host port (`host:5000/base`), carries no tag and renders nothing.
 */
const imageTag = (image: string | null | undefined): string | null => {
  if (image === null || image === undefined || image === "") return null
  const cut = image.lastIndexOf(":")
  if (cut < 0) return null
  const tag = image.slice(cut + 1)
  return tag === "" || tag.includes("/") ? null : tag
}

const listingCard = (payload: WorkspacePayload): Extract<Card, { kind: "file-list" }> => {
  const path = payload.filesPath ?? ""
  return {
    id: `workspace-files-${payload.workspaceId}`,
    kind: "file-list",
    title: `${path === "" ? "/" : path} · ${payload.name}`,
    status: "active",
    createdAt: 0,
    ordinal: 0,
    payload: {
      repo: payload.repo,
      path,
      entries: (payload.files ?? []).map((entry) => ({
        name: entry.name,
        kind: entry.type === "dir" ? ("dir" as const) : ("file" as const)
      })),
      /* The address names the computer, so the reader knows this is not the repository's copy. */
      address: `${payload.repo} · ${payload.name} · ${path === "" ? "/" : path}`
    }
  }
}

const WorkspaceFacetBody = ({
  card,
  facet,
  onRunCommand
}: {
  readonly card: WorkspaceCard
  readonly facet: (typeof FACETS)[number]
  readonly onRunCommand: WorkspaceCardActions["onRunCommand"]
}) => {
  const { payload } = card
  if (card.loading) return <ViewSkeleton />
  if (card.status === "error" && card.body) return <p className="world-card-empty">{card.body}</p>
  if (facet === "files") {
    if (payload.files === undefined) return null
    return (
      <FileListCardBody
        card={listingCard(payload)}
        navigation={{ list: "box.files", read: "box.file", scope: payload.workspaceId }}
        onRunCommand={onRunCommand}
      />
    )
  }
  if (facet === "services") {
    if (payload.services === undefined) return null
    return (
      <ul className="world-card-list">
        {payload.services.length === 0 ?
          <li className="world-card-empty">{payload.name} declares no services.</li> :
          payload.services.map((service) => (
            <li key={service.name} className="world-card-row">
              <Server size={14} aria-hidden="true" />
              <span className="world-card-title">{service.name}</span>
              <StatusPill status={service.state} />
              {/* plue#483: the port and the url the service publishes; a service that publishes neither shows neither. */}
              {service.port != null ? <span className="world-card-path">{`port ${service.port}`}</span> : null}
              {service.url != null ? <span className="world-card-path">{service.url}</span> : null}
            </li>
          ))}
      </ul>
    )
  }
  if (facet === "egress") {
    if (payload.egress === undefined) return null
    return (
      <div className="world-card-list">
        <ul className="world-card-list">
          {payload.egress.length === 0 ?
            <li className="world-card-empty">{payload.name} made no recorded calls.</li> :
            payload.egress.map((row, index) => (
              <li key={`${row.occurredAt}-${index}`} className="world-card-row">
                <Globe size={14} aria-hidden="true" />
                <span className="world-card-path">{row.occurredAt}</span>
                <span className="world-card-title">{row.method} {row.host}{row.path}</span>
                <span className="world-card-path">{row.status}</span>
                <span className="world-card-path">{row.allowed ? "allowed" : "blocked"}</span>
                {/* Which binding the proxy substituted — the NAME, never the value. */}
                {row.swappedSecretNames.length === 0 ?
                  null :
                  <span className="world-card-path">secrets {row.swappedSecretNames.join(", ")}</span>}
                {/* #2653: a blocked host joins the repository's allowlist; running sandboxes reload it. */}
                {row.allowed ?
                  null :
                  (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Allow ${row.host}`}
                      {...flowAction(onRunCommand, "egress.allow", flowArgs("egress.allow", { host: row.host, repo: payload.repo }))}
                    >
                      Allow
                    </Button>
                  )}
              </li>
            ))}
        </ul>
        {payload.egressCursor != null && payload.egressCursor !== "" ?
          (
            <Button
              size="sm"
              variant="outline"
              {...flowAction(onRunCommand, "box.egress", flowArgs("box.egress", { workspaceId: payload.workspaceId, cursor: payload.egressCursor ?? undefined }))}
            >
              Load older
            </Button>
          ) :
          null}
      </div>
    )
  }
  return null
}

export const WorkspaceCardBody = ({
  card,
  onRunCommand
}: { readonly card: WorkspaceCard } & WorkspaceCardActions) => {
  const { payload } = card
  const facet = payload.facet === "files" || payload.facet === "services" || payload.facet === "egress" ? payload.facet : "files"
  /* The registry is the truth about the terminal door: the Worker registers box.terminal only once its relay is on. */
  const controller = useController()
  const { data: recoveryRows } = useLiveQuery(q => q.from({ workspace: controller.store.collections.cloudWorkspaces })
    .where(({ workspace }) => eq(workspace.id, payload.workspaceId))
    .select(({ workspace }) => ({ recovery: workspace.recovery, kind: workspace.kind })))
  const { data: owners } = useLiveQuery(q => q.from({ cloud: controller.store.collections.cloudSessions }))
  const { data: identities } = useLiveQuery(q => q.from({ identity: controller.store.collections.identitySessions }))
  const offered = recoveryRows[0]?.recovery
  const owner = owners[0]
  const identity = identities[0]
  const recovery = offered !== undefined && owner?.state === "signed-in" && owner.username === offered.owner
    && (owner.ownerRevision ?? owner.revision) === offered.ownerRevision
    && (identity?.ownerRevision ?? identity?.revision) === offered.identityOwnerRevision ? offered : undefined
  const recoveryKind = recoveryRows[0]?.kind
  const recoveryPending = recovery?.request?.state === "requested" || recovery?.request?.state === "running"
  /* The delete act's typed confirm: the draft is transient chrome state, never a store fact. */
  const [deleteDraft, setDeleteDraft] = useState<string | null>(null)
  /* Uptime is derived at render from the payload's start time — no lifecycle, no timer, no stored duration. */
  const facts = headerFacts(payload, Date.now())
  const sshHost = payload.sshHost ?? null
  return (
    <div className="world-card-list">
      <p className="world-card-row">
        <span className="world-card-path">
          {payload.repo}
          {payload.targetBookmark !== null ? ` · ${payload.targetBookmark}` : ""}
          {payload.bookmarkHead?.changeId != null ?
            ` · bookmark ${payload.targetBookmark ?? ""} head @ ${payload.bookmarkHead.changeId.slice(0, 8)}` :
            ""}
        </span>
        <StatusPill status={payload.status} />
      </p>
      {facts.length === 0 ? null : <p className="world-card-path">{facts.join(" · ")}</p>}
      {/*
        RFD-004: the agent session that drove this computer. It is stated, not
        opened: this app has no agent-session surface, and binding "Open the
        agent session" to a flow that means something else would mislabel it.
      */}
      {payload.agentSessionId === null || payload.agentSessionId === undefined || payload.agentSessionId === "" ?
        null :
        <p className="world-card-path">agent session {payload.agentSessionId}</p>}
      {sshHost === null || sshHost === "" ?
        null :
        (
          <p className="world-card-row">
            <span className="world-card-path">{sshHost}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Copy ${sshHost}`}
              {...flowAction(onRunCommand, "chat.copy-message", sshHost)}
            >
              <Copy size={12} aria-hidden="true" /> Copy
            </Button>
          </p>
        )}
      {payload.provisioningStage !== null && (payload.status === "pending" || payload.status === "starting") ?
        <p className="world-card-path">Provisioning: {payload.provisioningStage}</p> :
        null}
      {payload.suspendedAt != null && payload.status === "suspended" ?
        <p className="world-card-path">Suspended {dayLabel(payload.suspendedAt)}</p> :
        null}
      {/*
        Why a box failed or refused an act: the egress proxy the worker would
        not boot without (plue's contract code), the provider's failure
        (plue#482), or an act's refusal. The code and the provider's own words
        stay behind Details; the sentence says what happened.
      */}
      {payload.egressProxyUnavailable === true ?
        <FailureNotice className="world-card-empty" failure={describedFailure("EgressProxyUnavailable", BOX_FAILURE_COPY.EgressProxyUnavailable,
          [EGRESS_PROXY_UNAVAILABLE, payload.error].filter(part => part !== undefined).join(" — "))} /> :
        payload.error !== undefined ?
        <FailureNotice className="world-card-empty" failure={describedFailure("BoxActRefused", BOX_FAILURE_COPY.BoxActRefused, payload.error)} /> :
        null}
      {payload.failureCode != null || payload.failureMessage != null ?
        <FailureNotice className="world-card-empty" failure={describedFailure("BoxFailed", BOX_FAILURE_COPY.BoxFailed,
          [payload.failureCode, payload.failureMessage].filter(part => part != null).join(" — "))} /> :
        null}
      {recovery === undefined ? null : <p className="world-card-row">
        {recovery.snapshotId === undefined ? null : <Button size="sm" variant="outline" disabled={recoveryPending}
          aria-label="Restore snapshot"
          {...flowAction(onRunCommand, "box.open", flowArgs("box.open", { repo: payload.repo,
            snapshot: recovery.snapshotId, recoveryOf: payload.workspaceId,
            ...(recoveryKind === "container" || recoveryKind === "vm" ? { kind: recoveryKind } : {}) }))}>Restore</Button>}
        {recovery.createFresh ? <Button size="sm" variant="outline" disabled={recoveryPending}
          aria-label="Create fresh box"
          {...flowAction(onRunCommand, "box.open", flowArgs("box.open", { repo: payload.repo, recoveryOf: payload.workspaceId,
            ...(recoveryKind === "container" || recoveryKind === "vm" ? { kind: recoveryKind } : {}) }))}>Create</Button> : null}
      </p>}
      {recovery?.request?.error === undefined ? null : <FailureNotice className="world-card-empty"
        failure={describedFailure("BoxActRefused", BOX_FAILURE_COPY.BoxActRefused, recovery.request.error)} />}
      {/*
        The card's create affordance (ADR 0002): one option surface, three
        kinds, each in plue's own words. The kind rides the invocation so it
        reaches the POST body; there is no environment or image picker.
      */}
      {payload.status === "failed" && recovery === undefined ?
        (
          <p className="world-card-row">
            {payload.provisioningStage !== null ?
              <span className="world-card-path">Failed at {payload.provisioningStage}.</span> :
              null}
            {KINDS.map(({ kind, says }) => (
              <Button
                key={kind}
                size="sm"
                variant="outline"
                aria-label={`Open a ${kind} box`}
                {...flowAction(onRunCommand, "box.open", flowArgs("box.open", { bookmark: payload.targetBookmark ?? undefined, repo: payload.repo, kind: kind }))}
              >
                {kind} — {says}
              </Button>
            ))}
          </p>
        ) :
        null}
      <div className="world-card-row" role="tablist" aria-label="Box facets">
        {FACETS.map((name) => (
          <Button
            key={name}
            size="sm"
            variant={name === facet ? "default" : "outline"}
            role="tab"
            aria-selected={name === facet}
            {...flowProps("box.facet")}
            onClick={() =>
              onRunCommand("box.facet", flowArgs("box.facet", { workspaceId: payload.workspaceId, facet: name }))}
          >
            {name[0]!.toUpperCase()}{name.slice(1)}
          </Button>
        ))}
      </div>
      <WorkspaceFacetBody card={card} facet={facet} onRunCommand={onRunCommand} />
      <div className="world-card-row">
        {payload.status === "running" ?
          (
            <Button
              size="sm"
              variant="outline"
              {...flowAction(onRunCommand, "box.suspend", payload.workspaceId)}
            >
              <Square size={12} aria-hidden="true" /> Suspend
            </Button>
          ) :
          null}
        {payload.status === "suspended" || payload.status === "stopped" ?
          (
            <Button
              size="sm"
              variant="outline"
              {...flowAction(onRunCommand, "box.resume", payload.workspaceId)}
            >
              <Play size={12} aria-hidden="true" /> Resume
            </Button>
          ) :
          null}
        <Button
          size="sm"
          variant="outline"
          {...flowProps("box.delete")}
          onClick={() => setDeleteDraft((draft) => (draft === null ? "" : null))}
        >
          <Trash2 size={12} aria-hidden="true" /> Delete
        </Button>
      </div>
      {deleteDraft !== null ?
        (
          <p className="world-card-row">
            <span className="world-card-path">
              Type {payload.name} to delete {payload.workspaceId} permanently:
            </span>
            <input
              aria-label={`Type ${payload.name} to confirm the delete`}
              value={deleteDraft}
              onInput={(event) => setDeleteDraft(event.currentTarget.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={deleteDraft !== payload.name}
              {...flowAction(onRunCommand, "box.delete", flowArgs("box.delete", { workspaceId: payload.workspaceId, confirmName: deleteDraft }))}
            >
              Delete permanently
            </Button>
          </p>
        ) :
        null}
    </div>
  )
}

/*
 * Lane L3b — the environment images a repository has built (ADR 0002: the
 * environment is stated, never chosen, so this card lists and offers nothing
 * to press). Each row is what plue answered: the sandbox kind the closure
 * boots, the closure's first eight, the image TAG, and the status. plue's
 * `repository_id 0` reads as the platform base image; an image with no golden
 * snapshot says its first boot pays the registry pull, which is the only
 * reason a reader would care.
 */
export const EnvironmentImagesCardBody = ({
  card
}: {
  readonly card: Extract<Card, { kind: "environment-images" }>
}) => {
  const { repo, images } = card.payload
  return (
    <ul className="world-card-list">
      {images.length === 0 ?
        <li className="world-card-empty">{repo} has built no environment images.</li> :
        images.map((image) => (
          <li key={image.id} className="world-card-row">
            <Server size={14} aria-hidden="true" />
            <span className="world-card-title">{image.kind}</span>
            {image.closureHash === null ? null : <span className="world-card-path">{image.closureHash.slice(0, 8)}</span>}
            {imageTag(image.image) === null ? null : <span className="world-card-path">{imageTag(image.image)}</span>}
            <StatusPill status={image.status} />
            {image.platformBase ? <span className="world-card-path">platform base</span> : null}
            {image.coldPull ? <span className="world-card-path">first boot is a cold pull</span> : null}
          </li>
        ))}
    </ul>
  )
}

export const workspaceCardFamily: CardFamily<"workspace" | "environment-images"> = {
  /* Lane citc: the workspace's own status is the pill. */
  workspace: {
    render: (card, actions) => <WorkspaceCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: (card) => card.payload.status
  },
  /* The catalogue is a read: the seam upserts it once, already settled, so it never waits on an act. */
  "environment-images": { render: (card) => <EnvironmentImagesCardBody card={card} />, pill: settledPill }
}
