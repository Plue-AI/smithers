import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import { ControllerTestProvider } from "../ControllerContext"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import type { AppController } from "../state/AppController"
import type { Card } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import {
  EnvironmentImagesCardBody,
  headerFacts,
  uptimeLabel,
  WorkspaceCardBody
} from "./WorkspaceCard"

/*
 * The workspace card (lane citc, completed by lane L3): the header names the
 * repo, the bookmark, the BOOKMARK's head (labeled as such), and — since
 * plue#446 — the DTO's own kind, head, ahead/behind, uptime, environment,
 * persistence and ssh host, each rendered ONLY when the payload carries it.
 * The five facets render their facts; every act rides onRunCommand with a
 * complete invocation; the delete act asks for the workspace's name typed
 * back.
 */

/* No test here wants a real network fetch out of the Desktop facet's iframe. */
GlobalRegistrator.register({ settings: { disableIframePageLoading: true } })

/*
 * Every root this file mounts. The Desktop facet SUBSCRIBES to the module-level
 * desktop-stream holder, so a root left mounted would still be listening when
 * a later suite in the same process mints one — and would then re-render
 * against a window happy-dom has already unregistered. Unmounting closes the
 * subscription, which is the same guarantee the product relies on.
 */
const roots: Array<{ readonly unmount: () => void }> = []

afterAll(async () => {
  for (const root of roots) root.unmount()
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

/*
 * The card reads the live registry for the one act whose door is the host's
 * (the terminal rides the origin's tunnel), so it renders under a controller:
 * the native app and web hosts with and without the terminal relay.
 */
const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


const controllerFor = async (bootstrap: AppBootstrap): Promise<AppController> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return createAppController(store, unavailableAgent, { bootstrap })
}

const NATIVE = await controllerFor({
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "local",
  capabilities: localCapabilities({ agent: true, identity: true, cloud: true }),
  authFlow: "native-handoff",
  sandbox: { platform: "darwin", mode: "enforced" }
})

const WEB_WITHOUT_RELAY = await controllerFor({
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: false }),
  authFlow: "redirect",
  sandbox: null
})

const workspaceCard = (
  overrides: Partial<Extract<Card, { kind: "workspace" }>["payload"]> = {}
): Extract<Card, { kind: "workspace" }> => ({
  id: "workspace-ws-1",
  kind: "workspace",
  title: "review · will/smithers",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    workspaceId: "ws-1",
    repo: "will/smithers",
    name: "review",
    targetBookmark: "main",
    status: "running",
    provisioningStage: null,
    suspendedAt: null,
    bookmarkHead: { changeId: "qupxosqw", commitId: "c0ffee1" },

    sessions: [],
    ...overrides
  }
})

/*
 * `attach: false` keeps the host out of the document, which is how the Desktop
 * facet's tests avoid happy-dom trying to LOAD the iframe's src: an iframe
 * only navigates once it is connected. Every assertion here reads attributes
 * and text, so a detached tree is the same tree.
 */
const render = (
  card: Extract<Card, { kind: "workspace" }>,
  options: { readonly attach?: boolean; readonly controller?: AppController } = {}
) => {
  const commands: Array<{ name: string; args?: string }> = []
  const host = document.createElement("div")
  if (options.attach !== false) document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  flushSync(() => {
    root.render(
      <ControllerTestProvider controller={options.controller ?? NATIVE}>
        <WorkspaceCardBody card={card} onRunCommand={(name, args) => commands.push({ name, args })} />
      </ControllerTestProvider>
    )
  })
  return { host, commands, unmount: () => flushSync(() => root.unmount()) }
}

const click = (host: HTMLElement, testIdOrText: string): void => {
  const button = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(testIdOrText) || candidate.getAttribute("aria-label") === testIdOrText)
  if (button === undefined) throw new Error(`no button named ${testIdOrText}`)
  flushSync(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

describe("the workspace card", () => {
  test("the header names the repo, the bookmark, and the bookmark's head — labeled, distinct from the workspace's own", () => {
    const { host } = render(workspaceCard())
    const text = host.textContent ?? ""
    expect(text).toContain("will/smithers · main")
    expect(text).toContain("bookmark main head @ qupxosqw")
    host.remove()
  })

  /*
   * plue#446: the header facts. Each is rendered from the payload and from
   * nothing else — the absent case below is the one that matters, because a
   * missing field used to be a degraded sentence and must now be silence.
   */
  test("the header states the kind, the workspace's own head, ahead/behind, the environment and the persistence", () => {
    const { host } = render(
      workspaceCard({
        workspaceKind: "container",
        head: { changeId: "zzsxlmno", commitId: "deadbeefcafe1234" },
        ahead: 2,
        behind: 1,
        environment: { source: ".smithers/environment.nix", revision: "b3f21c9d4e5a6b7c", closureHash: "sha256-abc" },
        persistence: "persistent"
      })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("container")
    expect(text).toContain("box head @ zzsxlmno deadbeef")
    expect(text).toContain("2 ahead")
    expect(text).toContain("1 behind")
    expect(text).toContain(".smithers/environment.nix @ b3f21c9d")
    expect(text).toContain("persistent")
    host.remove()
  })

  test("every header fact the payload does not carry renders nothing at all", () => {
    const { host } = render(workspaceCard())
    const text = host.textContent ?? ""
    for (const invented of ["container", "workspace head", "ahead", "behind", "up ", "environment.nix", "persistent", "ssh", "lsp"]) {
      expect(text).not.toContain(invented)
    }
    host.remove()
  })

  /* Lane L6 (plue#505): the languages the workspace relays a language server for, on the header's facts line. */
  test("the header states `lsp: typescript` from the DTO's lsp.languages, and nothing when the DTO named none", () => {
    expect(headerFacts(workspaceCard({ lspLanguages: ["typescript"] }).payload, 0)).toEqual(["lsp: typescript"])
    expect(headerFacts(workspaceCard({ workspaceKind: "vm", persistence: "persistent", lspLanguages: ["typescript", "rust"] }).payload, 0))
      .toEqual(["vm", "persistent", "lsp: typescript, rust"])
    expect(headerFacts(workspaceCard({ lspLanguages: [] }).payload, 0)).toEqual([])
    expect(headerFacts(workspaceCard({ lspLanguages: null }).payload, 0)).toEqual([])
    const { host } = render(workspaceCard({ lspLanguages: ["typescript"] }))
    expect(host.textContent).toContain("lsp: typescript")
    host.remove()
  })

  test("a zero ahead and a zero behind are facts the wire stated, so they render", () => {
    expect(headerFacts(workspaceCard({ ahead: 0, behind: 0 }).payload, 0)).toEqual(["0 ahead", "0 behind"])
    expect(headerFacts(workspaceCard().payload, 0)).toEqual([])
  })

  test("uptime reads from started_at, and a workspace that never started has none", () => {
    const now = Date.parse("2026-09-02T12:00:00Z")
    expect(uptimeLabel("2026-09-02T10:30:00Z", now)).toBe("up 1h 30m")
    expect(uptimeLabel("2026-08-31T09:00:00Z", now)).toBe("up 2d 3h")
    expect(uptimeLabel("2026-09-02T11:58:00Z", now)).toBe("up 2m")
    expect(uptimeLabel(null, now)).toBeNull()
    expect(uptimeLabel("not a time", now)).toBeNull()
    // A clock that disagrees with the server is not an uptime of "-3h".
    expect(uptimeLabel("2026-09-02T15:00:00Z", now)).toBeNull()
  })

  test("a running workspace shows its uptime on the card", () => {
    const startedAt = new Date(Date.now() - 90 * 60 * 1000).toISOString()
    const { host } = render(workspaceCard({ startedAt }))
    expect(host.textContent).toContain("up 1h 30m")
    host.remove()
  })

  test("the ssh host is a copyable line; without one there is no line and no button", () => {
    const { host, commands } = render(workspaceCard({ sshHost: "vm-77@ssh.smithers-cloud.test" }))
    expect(host.textContent).toContain("vm-77@ssh.smithers-cloud.test")
    click(host, "Copy vm-77@ssh.smithers-cloud.test")
    expect(commands[0]).toEqual({ name: "chat.copy-message", args: "vm-77@ssh.smithers-cloud.test" })
    host.remove()
    const without = render(workspaceCard())
    expect([...without.host.querySelectorAll("button")].some((button) => button.getAttribute("aria-label")?.startsWith("Copy "))).toBe(false)
    without.host.remove()
  })

  test("a provisioning workspace states its stage; a suspended one its date", () => {
    const { host } = render(workspaceCard({ status: "starting", provisioningStage: "allocating" }))
    expect(host.textContent).toContain("Provisioning: allocating")
    host.remove()
    const suspended = render(workspaceCard({ status: "suspended", suspendedAt: "2026-08-30T10:00:00Z" }))
    expect(suspended.host.textContent).toContain("Suspended 2026-08-30")
    suspended.host.remove()
  })

  test("historical workspace terminal payloads expose no terminal renderer or controls", () => {
    for (const controller of [NATIVE, WEB_WITHOUT_RELAY]) {
      const { host, commands } = render(workspaceCard({ facet: "terminal", sessions: [{ id: "sess-1", status: "running", createdAt: null }], terminalSessionId: "sess-1",
        terminalRefusal: { status: 409, message: "workspace is not running", code: null, retryAfterSeconds: null } }), { controller })
      expect(host.querySelector(".workspace-terminal-embed")).toBeNull()
      expect(host.querySelector('[data-flow="box.terminal"]')).toBeNull()
      expect(host.querySelector('[data-flow="box.session.destroy"]')).toBeNull()
      expect(host.textContent).not.toContain("No terminal attached")
      expect(commands).toEqual([])
      host.remove()
    }
  })

  /*
   * Lane L3b (ADR 0002: "three sandbox kinds share one option surface; the
   * kind is the choice"): the card's only create affordance — the failed
   * workspace's re-open — offers the two kinds in plue's own words, and the
   * kind rides the invocation so it reaches the POST body.
   */
  test("the create affordance offers the two kinds in plue's words and each carries its kind", () => {
    const { host, commands } = render(workspaceCard({ status: "failed", provisioningStage: "boot" }))
    expect(host.textContent).toContain("Failed at boot.")
    const text = host.textContent ?? ""
    expect(text).toContain("legacy OCI image")
    expect(text).toContain("NixOS closure image, systemd PID 1")
    expect(text).not.toContain("XFCE streamed over VNC")
    click(host, "Open a container box")
    click(host, "Open a vm box")
    expect(commands).toEqual([
      { name: "box.open", args: JSON.stringify({ bookmark: "main", repo: "will/smithers", kind: "container" }) },
      { name: "box.open", args: JSON.stringify({ bookmark: "main", repo: "will/smithers", kind: "vm" }) },
    ])
    host.remove()
  })

  test("a workspace with no target bookmark re-opens on its repository alone", () => {
    const { host, commands } = render(workspaceCard({ status: "failed", provisioningStage: null, targetBookmark: null }))
    click(host, "Open a vm box")
    expect(commands[0]).toEqual({ name: "box.open", args: JSON.stringify({ repo: "will/smithers", kind: "vm" }) })
    host.remove()
  })
})

  test("routine workspace cards omit environment provenance", () => {
    const { host } = render(
      workspaceCard({
        workspaceKind: "vm",
        environment: {
          source: ".smithers/environment.nix",
          revision: null,
          closureHash: "9f2b1c0d4e5a6b7c",
          image: "registry.smithers-cloud.test/environments/base:nixos-2405"
        }
      })
    )
    expect(host.textContent).not.toContain("env · ")
    expect(host.textContent).not.toContain("9f2b1c0d")
    expect(host.textContent).not.toContain("nixos-2405")
    host.remove()
    const plain = render(workspaceCard())
    expect(plain.host.textContent).not.toContain("env · ")
    plain.host.remove()
  })

/*
 * Lane L3b addendum (RFD-004): the computer an agent run executed in. The kind
 * label already renders through headerFacts; the session that drove it is
 * stated as an id, because this app has no agent-session surface to open.
 */
describe("the workspace card's agent workspaces", () => {
  test("an agent workspace names its kind and the session that drove it", () => {
    const { host } = render(workspaceCard({ workspaceKind: "agent", agentSessionId: "asess-7f3c" }))
    const text = host.textContent ?? ""
    expect(text).toContain("agent")
    expect(text).toContain("agent session asess-7f3c")
    host.remove()
  })

  test("a workspace no agent drove says nothing about a session", () => {
    const { host } = render(workspaceCard({ workspaceKind: "container" }))
    expect(host.textContent).not.toContain("agent session")
    host.remove()
  })
})

/*
 * Lane L3b — the environment images a repository has built (ADR 0002: the
 * environment is stated, never chosen).
 */
describe("the environment images card", () => {
  const imagesCard = (
    images: Extract<Card, { kind: "environment-images" }>["payload"]["images"]
  ): Extract<Card, { kind: "environment-images" }> => ({
    id: "environment-images-will/smithers",
    kind: "environment-images",
    title: "Environment images · will/smithers",
    status: "active",
    createdAt: 0,
    ordinal: 0,
    payload: { repo: "will/smithers", images }
  })

  const renderImages = (card: Extract<Card, { kind: "environment-images" }>) => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    flushSync(() => {
      root.render(<EnvironmentImagesCardBody card={card} />)
    })
    return host
  }

  test("a row names its kind, the closure short, the image tag and its status", () => {
    const host = renderImages(
      imagesCard([
        {
          id: "4",
          kind: "desktop",
          source: ".smithers/environment.nix",
          sourceRevision: "b3f21c9d4e5a6b7c",
          closureHash: "9f2b1c0d4e5a6b7c8d9e0f1a",
          image: "registry.smithers-cloud.test/environments/smithersai/smithers:nixos-2405-9f2b1c0d",
          status: "ready",
          platformBase: false,
          coldPull: false
        }
      ])
    )
    const text = host.textContent ?? ""
    expect(text).toContain("desktop")
    expect(text).toContain("9f2b1c0d")
    expect(text).toContain("nixos-2405-9f2b1c0d")
    /* The shared StatusPill title-cases plue's own word. */
    expect(text).toContain("Ready")
    // The whole registry path is never printed — the tag is what identifies the build.
    expect(text).not.toContain("registry.smithers-cloud.test")
    expect(text).not.toContain("cold pull")
    host.remove()
  })

  test("an image with nothing baked warns that its first boot is a cold pull, and the platform base says so", () => {
    const host = renderImages(
      imagesCard([
        {
          id: "1",
          kind: "vm",
          source: "platform",
          sourceRevision: null,
          closureHash: "1122334455667788",
          image: "registry.smithers-cloud.test/environments/base:nixos-2405",
          status: "building",
          platformBase: true,
          coldPull: true
        }
      ])
    )
    const text = host.textContent ?? ""
    expect(text).toContain("platform base")
    expect(text).toContain("first boot is a cold pull")
    host.remove()
  })

  test("a repository that has built nothing says so", () => {
    const host = renderImages(imagesCard([]))
    expect(host.textContent).toContain("will/smithers has built no environment images.")
    host.remove()
  })
})

describe("missing VM recovery actions", () => {
  test("snapshot and fresh creation use the existing public flow with keyboard-accessible buttons", async () => {
    const controller = await controllerFor({ apiVersion: 1, host: "local", version: "test", buildSha: "test",
      capabilities: localCapabilities({ agent: true, identity: true, cloud: true }), authFlow: "native-handoff", sandbox: { platform: "darwin", mode: "enforced" } })
    try {
      await controller.store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "owner", expiresAt: null, scopes: null }).isPersisted.promise
      const cloud = controller.store.collections.cloudSessions.get("cloud")!
      await controller.store.dispatch({ type: "workspace.updated", actor: "system", workspace: {
        id: "ws-1", repoId: "will/smithers", name: "old", targetBookmark: "main", status: "suspended", kind: "container",
        provisioningStage: null, suspendedAt: null, createdAt: null,
        recovery: { owner: "owner", ownerRevision: cloud.ownerRevision ?? cloud.revision, identityOwnerRevision: controller.store.collections.identitySessions.get("identity")?.ownerRevision ?? controller.store.collections.identitySessions.get("identity")?.revision, createFresh: true, snapshotId: "snapshot-retained" }
      } }).isPersisted.promise
      const view = render(workspaceCard({ status: "suspended", error: "workspace_vm_missing" }), { controller })
      const restore = view.host.querySelector<HTMLButtonElement>('button[aria-label="Restore snapshot"]')!
      const fresh = view.host.querySelector<HTMLButtonElement>('button[aria-label="Create fresh box"]')!
      expect(restore.tagName).toBe("BUTTON");expect(fresh.tagName).toBe("BUTTON")
      restore.focus();expect(document.activeElement).toBe(restore)
      click(view.host,"Restore snapshot")
      expect(view.commands[0]).toEqual({ name: "box.open", args: JSON.stringify({ repo: "will/smithers", snapshot: "snapshot-retained", recoveryOf: "ws-1", kind: "container" }) })
      fresh.focus();expect(document.activeElement).toBe(fresh)
      click(view.host,"Create fresh box")
      expect(view.commands[1]).toEqual({ name: "box.open", args: JSON.stringify({ repo: "will/smithers", recoveryOf: "ws-1", kind: "container" }) })
      const row = controller.store.collections.cloudWorkspaces.get("ws-1")!
      await controller.store.dispatch({ type: "workspace.updated", actor: "system", workspace: { ...row,
        recovery: { ...row.recovery!, request: { id: "intent", name: "retained", actor: "user", bookmark: "main", state: "requested", snapshotId: "snapshot-retained" } } } }).isPersisted.promise
      await new Promise(resolve => setTimeout(resolve,0))
      expect(view.host.querySelector<HTMLButtonElement>('button[aria-label="Restore snapshot"]')?.disabled).toBe(true)
      expect(view.host.querySelector<HTMLButtonElement>('button[aria-label="Create fresh box"]')?.disabled).toBe(true)
      view.unmount()
      await controller.store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "another-owner", expiresAt: null, scopes: null }).isPersisted.promise
      const stale = render(workspaceCard({ status: "suspended" }), { controller })
      expect(stale.host.querySelector('button[aria-label="Restore snapshot"]')).toBeNull()
      expect(stale.host.querySelector('button[aria-label="Create fresh box"]')).toBeNull()
      stale.unmount()
    } finally {await controller.dispose(); await controller.store.dispose?.()}
  })
  test("fresh-only typed recovery exposes no restore action", async () => {
    const controller = await controllerFor({ apiVersion: 1, host: "local", version: "test", buildSha: "test",
      capabilities: localCapabilities({ agent: true, identity: true, cloud: true }), authFlow: "native-handoff", sandbox: { platform: "darwin", mode: "enforced" } })
    try {
      await controller.store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "owner", expiresAt: null, scopes: null }).isPersisted.promise
      const cloud = controller.store.collections.cloudSessions.get("cloud")!
      await controller.store.dispatch({ type: "workspace.updated", actor: "system", workspace: {
        id: "ws-1", repoId: "will/smithers", name: "old", targetBookmark: "main", status: "suspended",
        provisioningStage: null, suspendedAt: null, createdAt: null,
        recovery: { owner: "owner", ownerRevision: cloud.ownerRevision ?? cloud.revision, identityOwnerRevision: controller.store.collections.identitySessions.get("identity")?.ownerRevision ?? controller.store.collections.identitySessions.get("identity")?.revision, createFresh: true }
      } }).isPersisted.promise
      const view = render(workspaceCard({ status: "suspended" }), { controller })
      expect(view.host.querySelector('button[aria-label="Restore snapshot"]')).toBeNull()
      expect(view.host.querySelector('button[aria-label="Create fresh box"]')).not.toBeNull()
      view.unmount()
    } finally {await controller.dispose(); await controller.store.dispose?.()}
  })
})
