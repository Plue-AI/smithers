import { TerminalView } from "../tabs/TerminalView"
import { Copy } from "lucide-react"
import type { Refusal } from "@smthrs/rpc/Refusal"
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
import { useState, useSyncExternalStore } from "react"
import { Button, Spinner, StatusPill } from "@smthrs/ui"
import { Globe, Monitor, Play, RefreshCw, Server, Square, Trash2 } from "lucide-react"
import { useController } from "../ControllerContext"
import type { Card } from "../state/AppState"
import { readDesktopStream, subscribeDesktopStream } from "../state/seams/DesktopStream"
import { refusalFromStored } from "@smthrs/rpc/Refusal"
import { refusalDoors, refusalLead } from "@smthrs/rpc/RefusalCopy"
import { dayLabel, timeLabel } from "../Timestamps"
import { shortId } from "../state/ids"
import { FileListCardBody } from "./FileCards"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { flowArgs } from "../flows/FlowArgs"

/** THE SEAM: the upgrade door uses the same typed flow as the plans card. */
/*
 * The plan an upgrade door buys. The backend names it for a plan limit; an
 * out-of-credit refusal names none (Plue sends only `upgrade: "/billing"`), and
 * Pro is the one plan on sale, so that door buys Pro.
 */
export const upgradePlanKey = (refusal: Refusal): string | null =>
  refusal.upgrade_plan_key ?? (refusal.code === "out_of_credit" ? "pro" : null)

export const UpgradeDoor = ({ refusal, onRunCommand, disabled = false }: {
  readonly refusal: Refusal; readonly onRunCommand: RunCommand; readonly disabled?: boolean
}) => {
  const plan = upgradePlanKey(refusal)
  return refusalDoors(refusal).includes("upgrade") && plan ? (
    <Button size="sm" variant="outline" disabled={disabled}
      {...flowAction(onRunCommand, "billing.upgrade", flowArgs("billing.upgrade", { plan }))}>
      Upgrade
    </Button>
  ) : null
}

export interface WorkspaceCardActions {
  readonly onRunCommand: RunCommand
}

type WorkspaceCard = Extract<Card, { kind: "workspace" }>
type WorkspacePayload = WorkspaceCard["payload"]

const FACETS = ["terminal", "files", "services", "egress", "desktop"] as const

/*
 * Lane L3b — ADR 0002: "three sandbox kinds share one option surface; the kind
 * is the choice." These are plue's own one-line descriptions of the three
 * kinds, in words. There is no environment or image picker beside them; that
 * is ADR 0002's standing default, not an omission.
 */
const KINDS = [
  { kind: "container", says: "legacy OCI image, the default" },
  { kind: "vm", says: "NixOS closure image, systemd PID 1" },
  { kind: "desktop", says: "NixOS closure image, systemd PID 1, plus XFCE streamed over VNC" }
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

/**
 * When the minted desktop session lapses, in the app's one timestamp
 * vocabulary. A session the mint gave no expiry for says nothing — a guessed
 * deadline is worse than none, because the iframe simply dies at the real one.
 */
export const sessionUntil = (expiresAt: string | null, now: number = Date.now()): string | null => {
  if (expiresAt === null || expiresAt === "") return null
  const at = Date.parse(expiresAt)
  return Number.isNaN(at) ? null : `session until ${timeLabel(at, now)}`
}

/** What `/desktop` is doing right now, in the product's words (box, never computer). */
const DESKTOP_STAGE_LINE: Record<NonNullable<WorkspacePayload["desktopStage"]>, string> = {
  creating: "creating the box",
  resuming: "resuming the box",
  starting: "starting the box",
  activating: "the box is up, its desktop is still activating",
  streaming: "starting the stream"
}

/*
 * Lane L3b — the Desktop facet: plue's NixOS VM streamed over VNC, embedded in
 * the card (THE EMBED LAW; maximize is the card's own act, and the frame fills
 * it through cards.css).
 *
 * The iframe's `src` is the absolute, already-credentialed `stream_url` the
 * session POST minted: it embeds a live machine's token and VNC password. It
 * is therefore read from module memory (state/seams/DesktopStream.ts) through
 * `useSyncExternalStore` — React's own external-store hook, so no `useEffect`
 * and no lifecycle synchronisation — and never from the card payload, because
 * everything a payload holds is written to disk by the persistence backend.
 * Leaving the facet drops the mint, so nothing outlives the unmounted iframe.
 */
const WorkspaceDesktopBody = ({
  payload,
  onRunCommand
}: {
  readonly payload: WorkspacePayload
  readonly onRunCommand: WorkspaceCardActions["onRunCommand"]
}) => {
  const stream = useSyncExternalStore(
    subscribeDesktopStream,
    () => readDesktopStream(payload.workspaceId),
    () => null
  )
  if (stream === null) {
    const stored = payload.desktopRefusal ?? null
    const refusal = stored === null ? null : refusalFromStored(stored)
    const stage = payload.desktopStage ?? null
    if (refusal === null && stage === null) return null
    /*
     * The lead line, then plue's own words verbatim underneath — never a
     * spinner in their place, and never a rewrite of them. The lead is chosen
     * by FAULT from the one copy table (`@smthrs/rpc/RefusalCopy`), because
     * "service unavailable" reads identically whether the caller asked for
     * something they may not have, whether the box simply is not up yet, or
     * whether the whole fleet is full — and only the last of those is the one
     * where a person needs to be told, plainly, that it is not their fault.
     *
     * plue sanitizes a 5xx message to the status text but keeps `code`, so
     * the code is printed beside the message: without it "service
     * unavailable" would be the whole of what a person is told.
     */
    const doors = refusal === null ? [] : refusalDoors(refusal)
    return (
      <div className="world-card-list">
        {/* The one-command open's own line: where the box got to, and the way out of the wait. */}
        {stage === null ? null : <p className="world-card-path" role="status"><Spinner size="sm" aria-label="Starting desktop" />{payload.desktopProgress ?? DESKTOP_STAGE_LINE[stage]}</p>}
        {refusal === null ? null : (
          <>
            <p className="world-card-empty" data-refusal-fault={refusal.fault}>{refusalLead(refusal)}</p>
            <p className="world-card-path">
              {refusal.rawCode != null ? `${refusal.rawCode} — ` : ""}
              {refusal.message}
            </p>
          </>
        )}
        {refusal !== null && refusal.fault === "wait" && refusal.retryAfter != null ?
          <p className="world-card-path">{`the server asked for ${refusal.retryAfter}s`}</p> :
          null}
        {stage === null ? null : (
          <Button
            size="sm"
            variant="outline"
            aria-label="Stop waiting for the desktop box"
            {...flowAction(onRunCommand, "box.desktop.stop", payload.workspaceId)}
          >
            Stop waiting
          </Button>
        )}
        {refusal === null ? null : <UpgradeDoor refusal={refusal} onRunCommand={onRunCommand} />}
        {doors.includes("resume") ?
          (
            <Button
              size="sm"
              variant="outline"
              aria-label="Resume the box and open its desktop"
              {...flowAction(onRunCommand, "box.resume", payload.workspaceId)}
            >
              <Play size={12} aria-hidden="true" /> Resume
            </Button>
          ) :
          null}
        {doors.includes("retry") ?
          (
            <Button
              size="sm"
              variant="outline"
              aria-label="Try the desktop session again"
              {...flowAction(onRunCommand, "box.desktop", payload.workspaceId)}
            >
              <RefreshCw size={12} aria-hidden="true" /> Retry
            </Button>
          ) :
          null}
        {/*
         * The door for a refusal plue calls terminal for THIS box — today,
         * `desktop_tools_unavailable`, a box whose image predates the desktop
         * helpers. Neither Retry nor Resume can ever satisfy it: the tools are
         * not in the closure it booted. Opening a new box is the same act the
         * failed-provisioning row offers, on the same kind, so the current
         * image comes with it.
         */}
        {doors.includes("new-box") ?
          (
            <Button
              size="sm"
              variant="outline"
              aria-label="Open a new desktop box with the current image"
              {...flowAction(onRunCommand, "box.open", flowArgs("box.open", { bookmark: payload.targetBookmark ?? undefined, repo: payload.repo, kind: "desktop" }))}
            >
              <Play size={12} aria-hidden="true" /> Open a new box
            </Button>
          ) :
          null}
        {/*
         * THE SEAM for a "Tell @fucory" door. `doors` already carries
         * `report` for every infra and bug refusal in the app; nothing renders
         * it because whether that door FILES something or merely says
         * something is the product owner's call and has not been made. When it
         * is, one case here — and the same case on the terminal facet — gives
         * every such refusal the affordance at once.
         */}
      </div>
    )
  }
  const until = sessionUntil(stream.expiresAt)
  return (
    <div className="workspace-desktop">
      <iframe
        className="workspace-desktop-frame"
        title={`Desktop of ${payload.name}`}
        src={stream.url}
        allow="clipboard-read; clipboard-write"
        sandbox="allow-scripts allow-same-origin allow-forms"
        /* Control focus: a cross-origin frame is detected as window blur + activeElement === this iframe. */
        data-control-focus-id={`desktop:${payload.workspaceId}`}
        data-control-focus-kind="desktop"
      />
      <p className="world-card-row">
        {until === null ? null : <span className="world-card-path">{until}</span>}
        <Button
          size="sm"
          variant="outline"
          {...flowAction(onRunCommand, "box.desktop.rotate", payload.workspaceId)}
        >
          Rotate session
        </Button>
      </p>
    </div>
  )
}

/** plue's file listing carries three types; the shared listing row knows two. A symlink lists as a file. */
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
  canTerminal,
  terminalUnavailableOnWeb,
  onRunCommand
}: {
  readonly card: WorkspaceCard
  readonly facet: (typeof FACETS)[number]
  /** Whether this host registers `box.terminal` (its tunnel is open); false renders the fact, not a button. */
  readonly canTerminal: boolean
  readonly terminalUnavailableOnWeb: boolean
  readonly onRunCommand: WorkspaceCardActions["onRunCommand"]
}) => {
  const { payload } = card
  if (card.loading) return <ViewSkeleton />
  if (card.status === "error" && card.body) return <p className="world-card-empty">{card.body}</p>
  if (facet === "desktop") return <WorkspaceDesktopBody payload={payload} onRunCommand={onRunCommand} />
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
  /* The terminal facet: the attachment, then every session the workspace holds. */
  const storedTerminalRefusal = payload.terminalRefusal ?? null
  const terminalRefusal = storedTerminalRefusal === null ? null : refusalFromStored(storedTerminalRefusal)
  return (
    <div className="world-card-list">
      {payload.terminalSessionId !== undefined ?
        (
          <div className="workspace-terminal-embed" style={{ height: 320 }}>
            <TerminalView repo={payload.repo} sessionId={payload.terminalSessionId} />
          </div>
        ) :
        <p className="world-card-empty">No terminal attached.</p>}
      {/*
       * The lead line for this fault, then plue's own words for a refused
       * session POST, verbatim (plue#504). plue sanitizes a 5xx message to the
       * status text but keeps `code`, so the code is printed beside it:
       * without it "service unavailable" would be the whole of what a person
       * is told. A `wait` fault — `guest_not_ready` is one — is ALSO retried
       * by the seam on the server's own pacing, so the button is the human's
       * way to stop waiting for that clock, not the only way forward. (The
       * `report` door for an infra refusal has no control yet; see the desktop
       * facet's seam note.)
       */}
      {terminalRefusal !== null ?
        (
          <>
            <UpgradeDoor refusal={terminalRefusal} onRunCommand={onRunCommand} />
            <p className="world-card-empty" data-refusal-fault={terminalRefusal.fault}>{refusalLead(terminalRefusal)}</p>
            <p className="world-card-path">
              {terminalRefusal.rawCode != null ? `${terminalRefusal.rawCode} — ` : ""}
              {terminalRefusal.message}
            </p>
            {terminalRefusal.fault === "wait" && terminalRefusal.retryAfter != null ?
              <p className="world-card-path">{`the server asked for ${terminalRefusal.retryAfter}s`}</p> :
              null}
          </>
        ) :
        null}
      {canTerminal ?
        (
          <Button
            size="sm"
            {...(terminalRefusal === null ? {} : { variant: "outline" as const, "aria-label": "Try the terminal again" })}
            {...flowAction(onRunCommand, "box.terminal", payload.workspaceId)}
          >
            {terminalRefusal === null ? "Open terminal" : <><RefreshCw size={12} aria-hidden="true" /> Retry</>}
          </Button>
        ) :
        terminalUnavailableOnWeb ? <p className="world-card-empty">Terminals are not on the web yet.</p> : null}
      {payload.sessions.length === 0 ?
        null :
        (
          <ul className="world-card-list">
            {payload.sessions.map((session) => (
              <li key={session.id} className="world-card-row">
                <Monitor size={14} aria-hidden="true" />
                <span className="world-card-title">{session.id}</span>
                <StatusPill status={session.status} />
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Destroy session ${session.id}`}
                  {...flowAction(onRunCommand, "box.session.destroy", flowArgs("box.session.destroy", { sessionId: session.id, workspaceId: payload.workspaceId }))}
                >
                  Destroy
                </Button>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

export const WorkspaceCardBody = ({
  card,
  onRunCommand
}: { readonly card: WorkspaceCard } & WorkspaceCardActions) => {
  const { payload } = card
  const facet = payload.facet ?? "terminal"
  /* The registry is the truth about the terminal door: the Worker registers box.terminal only once its relay is on. */
  const controller = useController()
  const canTerminal = controller.commands.find("box.terminal") !== undefined
  const terminalUnavailableOnWeb = controller.bootstrap?.host === "cloud"
    && !controller.bootstrap.capabilities.includes("cloud.terminal")
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
        plue's own contract code for a worker that could not start the
        per-sandbox egress proxy and refused to boot the computer without its
        credential boundary. The card says the code, exactly.
      */}
      {payload.egressProxyUnavailable === true ? <p className="world-card-empty">egress_proxy_unavailable</p> : null}
      {/*
        plue#482: why a failed computer failed, in the provider's own words.
        The code is a machine verdict and survives plue's 5xx message
        sanitizer, so both are shown and neither is paraphrased.
      */}
      {payload.failureCode != null || payload.failureMessage != null ?
        (
          <p className="world-card-empty">
            {payload.failureCode ?? ""}
            {payload.failureCode != null && payload.failureMessage != null ? " — " : ""}
            {payload.failureMessage ?? ""}
          </p>
        ) :
        null}
      {payload.error !== undefined ? <p className="world-card-empty">{payload.error}</p> : null}
      {/*
        The card's create affordance (ADR 0002): one option surface, three
        kinds, each in plue's own words. The kind rides the invocation so it
        reaches the POST body; there is no environment or image picker.
      */}
      {payload.status === "failed" ?
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
      {/*
        Lane L3b: the Desktop tab exists only for a desktop workspace — a
        container and a vm have no display to stream. Opening it runs
        `box.desktop`, which MINTS a session (a live machine's password),
        so it is its own confirmed act rather than a facet switch.
      */}
      <div className="world-card-row" role="tablist" aria-label="Box facets">
        {FACETS.filter((name) => name !== "desktop" || payload.workspaceKind === "desktop").map((name) => (
          <Button
            key={name}
            size="sm"
            variant={name === facet ? "default" : "outline"}
            role="tab"
            aria-selected={name === facet}
            {...flowProps(name === "desktop" ? "box.desktop" : "box.facet")}
            onClick={() =>
              name === "desktop"
                ? onRunCommand("box.desktop", payload.workspaceId)
                : onRunCommand("box.facet", flowArgs("box.facet", { workspaceId: payload.workspaceId, facet: name }))}
          >
            {name[0]!.toUpperCase()}{name.slice(1)}
          </Button>
        ))}
      </div>
      <WorkspaceFacetBody card={card} facet={facet} canTerminal={canTerminal} terminalUnavailableOnWeb={terminalUnavailableOnWeb} onRunCommand={onRunCommand} />
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
