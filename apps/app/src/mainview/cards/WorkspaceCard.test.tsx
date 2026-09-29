import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import { INFRA_NOT_YOUR_FAULT } from "@smthrs/rpc/RefusalCopy"
import { ControllerTestProvider } from "../ControllerContext"
import { bindFlowPreloading } from "../flows/FlowAction"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import type { AppController } from "../state/AppController"
import type { Card } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { dropDesktopStream, holdDesktopStream } from "../state/seams/DesktopStream"
import {
  EnvironmentImagesCardBody,
  headerFacts,
  sessionUntil,
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

  test("the terminal facet offers the open act and lists sessions with destroy", () => {
    const { host, commands } = render(
      workspaceCard({ sessions: [{ id: "sess-1", status: "running", createdAt: null }], terminalSessionId: "sess-1" })
    )
    expect(host.querySelector('.workspace-terminal-embed [data-testid="terminal-sess-1"]')).not.toBeNull()
    expect(NATIVE.commands.find("box.terminal")).toBeDefined()
    click(host, "Open terminal")
    expect(commands[0]).toEqual({ name: "box.terminal", args: "ws-1" })
    click(host, "Destroy session sess-1")
    expect(commands[1]).toEqual({ name: "box.session.destroy", args: "sess-1 ws-1" })
    expect(host.textContent).not.toContain("Terminals are not on the web yet")
    host.remove()
  })

  test("a 503 guest_not_ready prints plue's code beside its sanitized message on the terminal facet, and offers Retry (plue#504)", () => {
    const { host, commands } = render(
      workspaceCard({
        /*
         * plue's own 503 body (routes/workspace_terminal_test.go):
         * writeRouteError replaces a 5xx message with the status text and
         * KEEPS the code, so without the code a person would be told only
         * "service unavailable".
         */
        terminalRefusal: {
          status: 503,
          message: "service unavailable",
          code: "guest_not_ready",
          retryAfterSeconds: 3
        }
      })
    )
    expect(host.querySelector("details pre")?.textContent).toBe("guest_not_ready — service unavailable")
    expect(host.textContent).toContain("the server asked for 3s")
    click(host, "Try the terminal again")
    expect(commands[0]).toEqual({ name: "box.terminal", args: "ws-1" })
    host.remove()
  })

  test("any other terminal refusal reads the server's own words with Retry and no wait line", () => {
    const { host, commands } = render(
      workspaceCard({ terminalRefusal: { status: 409, message: "workspace is not running", code: null, retryAfterSeconds: null } })
    )
    expect(host.textContent).toContain("workspace is not running")
    expect(host.textContent).not.toContain("the server asked for")
    /* No code on the wire, so none is printed — and no separator is invented for one. */
    expect(host.textContent).not.toContain(" — workspace is not running")
    click(host, "Try the terminal again")
    expect(commands[0]).toEqual({ name: "box.terminal", args: "ws-1" })
    host.remove()
  })

  /*
   * An origin without `cloud.terminal` has no relay, so
   * `box.terminal` is not in the web registry (parity-hosts (c)) and a
   * button bound to it would be a dead control: the pointer path drops an
   * unregistered name silently. The card reads the registry and renders the
   * fact instead; the sessions and their destroy act are unaffected.
   */
  test("the web relay offers the existing terminal flow without unavailable copy", async () => {
    const controller = await controllerFor({
      ...WEB_WITHOUT_RELAY.bootstrap!,
      capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: true })
    })
    const { host, commands, unmount } = render(workspaceCard({}), { controller })
    try {
      expect(host.textContent).not.toContain("Terminals are not on the web yet.")
      click(host, "Open terminal")
      expect(commands).toEqual([{ name: "box.terminal", args: "ws-1" }])
    } finally {
      unmount()
      host.remove()
      controller.dispose()
    }
  })

  test("on an origin without the terminal relay the terminal facet offers no Open terminal control and says so", () => {
    expect(WEB_WITHOUT_RELAY.commands.find("box.terminal")).toBeUndefined()
    const { host, commands } = render(
      workspaceCard({ sessions: [{ id: "sess-1", status: "running", createdAt: null }] }),
      { controller: WEB_WITHOUT_RELAY }
    )
    expect(host.querySelector('[data-flow="box.terminal"]')).toBeNull()
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).not.toContain("Open terminal")
    expect(host.textContent).toContain("No terminal attached.")
    expect(host.textContent).toContain("Terminals are not on the web yet.")
    click(host, "Destroy session sess-1")
    expect(commands).toEqual([{ name: "box.session.destroy", args: "sess-1 ws-1" }])
    // Every rendered control still names a flow this registry has.
    const rendered = [...host.querySelectorAll("[data-flow]")].map((el) => el.getAttribute("data-flow") ?? "")
    expect(rendered.filter((name) => WEB_WITHOUT_RELAY.commands.find(name) === undefined)).toEqual([])
    host.remove()
  })

  /*
   * plue#449: the Files facet reuses the repository file card's listing
   * component, so a directory and a file read the same way here as there —
   * with the rows retargeted at the workspace's own routes.
   */
  test("the Files facet lists the workspace's own copy; a directory and a file each open through the workspace routes", () => {
    const { host, commands } = render(
      workspaceCard({
        facet: "files",
        filesPath: "",
        files: [
          { name: "src", path: "src", type: "dir", size: 0 },
          { name: "README.md", path: "README.md", type: "file", size: 42 },
          { name: "latest", path: "latest", type: "symlink", size: 8 }
        ]
      })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("will/smithers · review · /")
    expect(text).toContain("src")
    expect(text).toContain("README.md")
    // plue's third type has no row of its own in the shared listing; it lists as a file.
    expect(text).toContain("latest")
    const preloads: Array<{ name: string; args?: string }> = []
    const unbind = bindFlowPreloading(document, async (name, args) => { preloads.push({ name, args }) })
    try {
      for (const [label, name] of [["src", "box.files"], ["README.md", "box.file"], ["latest", "box.file"]] as const) {
        const button = Array.from(host.querySelectorAll("button")).find((row) => row.textContent === label)!
        const invocation = { name, args: `${label} ws-1` }
        expect(button.getAttribute("data-flow")).toBe(invocation.name)
        expect(button.getAttribute("data-flow-args")).toBe(invocation.args)
        button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
        expect(preloads.at(-1)).toEqual(invocation)
        click(host, label)
        expect(commands.at(-1)).toEqual(invocation)
      }
    } finally {
      unbind()
    }
    host.remove()
  })

  test("a Files facet the card has not read renders nothing rather than an empty directory", () => {
    const { host } = render(workspaceCard({ facet: "files" }))
    expect(host.textContent).not.toContain("Nothing under")
    host.remove()
  })

  test("the Services facet lists the name, the state, and plue#483's port and url", () => {
    const { host, commands } = render(
      workspaceCard({
        facet: "services",
        services: [
          { name: "postgres", state: "running", port: 5432, url: null },
          { name: "web", state: "running", port: 3000, url: "https://ws-1.workspaces.smithers-cloud.test" }
        ]
      })
    )
    // The row is the name and the state pill, adjacent: "postgres" then its state.
    expect(host.textContent).toContain("postgresRunning")
    expect(host.textContent).toContain("port 5432")
    expect(host.textContent).toContain("https://ws-1.workspaces.smithers-cloud.test")
    click(host, "Terminal")
    expect(commands[0]).toEqual({ name: "box.facet", args: "ws-1 terminal" })
    host.remove()
    const empty = render(workspaceCard({ facet: "services", services: [] }))
    expect(empty.host.textContent).toContain("review declares no services.")
    empty.host.remove()
  })

  test("a service that publishes no port and no url shows neither — an absent field is absence", () => {
    const { host } = render(
      workspaceCard({ facet: "services", services: [{ name: "worker", state: "running", port: null, url: null }] })
    )
    expect(host.textContent).toContain("workerRunning")
    expect(host.textContent).not.toContain("port")
    host.remove()
  })

  test("a failed workspace names plue's failure code and message (plue#482)", () => {
    const { host } = render(
      workspaceCard({
        status: "failed",
        failureCode: "image_pull_failed",
        failureMessage: "pulling nixos-2405-9f2b1c0d timed out after 300s"
      })
    )
    const failed = host.querySelector<HTMLElement>('[data-failure="BoxFailed"]')!
    expect(failed.querySelector("p")?.textContent).toBe("This box failed. Not your fault.")
    expect(failed.querySelector("details pre")?.textContent).toBe("image_pull_failed — pulling nixos-2405-9f2b1c0d timed out after 300s")
    host.remove()
  })

  test("a failed workspace the platform gave no reason for states no reason", () => {
    const { host } = render(workspaceCard({ status: "failed", failureCode: null, failureMessage: null }))
    /* No empty reason line stands where the platform recorded none. */
    expect([...host.querySelectorAll(".world-card-empty")].map((row) => row.textContent)).toEqual([
      "No terminal attached."
    ])
    host.remove()
  })

  test("a Files facet that lists only .git renders exactly that (plue#497)", () => {
    /*
     * plue#497: a fresh repository clones empty, so the workspace's working
     * copy holds `.git` and nothing else. The listing states what is there;
     * no empty-repository copy is invented for it.
     */
    const { host } = render(
      workspaceCard({ facet: "files", filesPath: "", files: [{ name: ".git", path: ".git", type: "dir", size: 0 }] })
    )
    const text = host.textContent ?? ""
    expect(text).toContain(".git")
    expect(text).not.toContain("empty")
    host.remove()
  })

  test("the Egress facet names the call and the secret NAMES, never a value, and offers the older page", () => {
    const { host, commands } = render(
      workspaceCard({
        facet: "egress",
        egress: [
          {
            occurredAt: "2026-09-02T09:15:00Z",
            host: "api.github.com",
            method: "POST",
            path: "/graphql",
            status: 200,
            allowed: true,
            swappedSecretNames: ["GITHUB_TOKEN"]
          },
          {
            occurredAt: "2026-09-02T08:00:00Z",
            host: "registry.npmjs.org",
            method: "GET",
            path: "/left-pad",
            status: 403,
            allowed: false,
            swappedSecretNames: []
          }
        ],
        egressCursor: "eyJpZCI6MX0"
      })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("POST api.github.com/graphql")
    expect(text).toContain("allowed")
    expect(text).toContain("secrets GITHUB_TOKEN")
    expect(text).toContain("GET registry.npmjs.org/left-pad")
    expect(text).toContain("blocked")
    // The row with no swap says nothing about secrets at all.
    expect(text).not.toContain("secrets ,")
    click(host, "Load older")
    expect(commands[0]).toEqual({ name: "box.egress", args: "ws-1 eyJpZCI6MX0" })
    host.remove()
  })

  test("an exhausted audit offers no older page, and an empty one says the computer called nothing", () => {
    const { host } = render(workspaceCard({ facet: "egress", egress: [], egressCursor: null }))
    expect(host.textContent).toContain("review made no recorded calls.")
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Load older"))).toBe(false)
    host.remove()
  })

  test("the egress facet is reachable from the facet strip", () => {
    const { host, commands } = render(workspaceCard())
    click(host, "Egress")
    expect(commands[0]).toEqual({ name: "box.facet", args: "ws-1 egress" })
    host.remove()
  })

  test("a creation the worker refused for the missing egress proxy names plue's code, exactly", () => {
    const { host } = render(workspaceCard({ status: "failed", egressProxyUnavailable: true, error: "service unavailable" }))
    const failed = host.querySelector<HTMLElement>('[data-failure="EgressProxyUnavailable"]')!
    expect(failed.querySelector("p")?.textContent).toBe("This box could not start its network guard. Not your fault.")
    expect(failed.querySelector("details pre")?.textContent).toBe("egress_proxy_unavailable — service unavailable")
    expect(host.querySelectorAll("[data-failure]")).toHaveLength(1)
    host.remove()
    const ordinary = render(workspaceCard())
    expect(ordinary.host.textContent).not.toContain("egress_proxy_unavailable")
    ordinary.host.remove()
  })

  test("suspend shows on a running workspace, resume on a suspended one", () => {
    const running = render(workspaceCard())
    click(running.host, "Suspend")
    expect(running.commands[0]).toEqual({ name: "box.suspend", args: "ws-1" })
    running.host.remove()
    const suspended = render(workspaceCard({ status: "suspended" }))
    click(suspended.host, "Resume")
    expect(suspended.commands[0]).toEqual({ name: "box.resume", args: "ws-1" })
    suspended.host.remove()
  })

  test("the delete act asks for the workspace's name typed back", () => {
    const { host, commands } = render(workspaceCard())
    click(host, "Delete")
    const confirm = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Delete permanently"))
    expect(confirm?.disabled).toBe(true)
    const input = host.querySelector("input")
    expect(input).not.toBeNull()
    // React tracks the value through the native setter — assign through it or onChange never fires.
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "review")
      input!.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const confirmNow = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Delete permanently"))
    expect(confirmNow?.disabled).toBe(false)
    click(host, "Delete permanently")
    // The typed name travels with the act: the flow's payload and the seam's gate both see it.
    expect(commands[0]).toEqual({ name: "box.delete", args: "ws-1 review" })
    host.remove()
  })

  test("an act's refusal stays on the card", () => {
    const { host } = render(workspaceCard({ error: "driver exploded" }))
    const refused = host.querySelector<HTMLElement>('[data-failure="BoxActRefused"]')!
    expect(refused.querySelector("p")?.textContent).toBe("Smithers could not finish that on this box.")
    expect(refused.querySelector("p")?.textContent).not.toContain("driver exploded")
    expect(refused.querySelector("details pre")?.textContent).toBe("driver exploded")
    host.remove()
  })

  /*
   * Lane L3b (ADR 0002: "three sandbox kinds share one option surface; the
   * kind is the choice"): the card's only create affordance — the failed
   * workspace's re-open — offers the three kinds in plue's own words, and the
   * kind rides the invocation so it reaches the POST body.
   */
  test("the create affordance offers the three kinds in plue's words and each carries its kind", () => {
    const { host, commands } = render(workspaceCard({ status: "failed", provisioningStage: "boot" }))
    expect(host.textContent).toContain("Failed at boot.")
    const text = host.textContent ?? ""
    expect(text).toContain("legacy OCI image")
    expect(text).toContain("NixOS closure image, systemd PID 1")
    expect(text).toContain("XFCE streamed over VNC")
    click(host, "Open a container box")
    click(host, "Open a vm box")
    click(host, "Open a desktop box")
    expect(commands).toEqual([
      { name: "box.open", args: JSON.stringify({ bookmark: "main", repo: "will/smithers", kind: "container" }) },
      { name: "box.open", args: JSON.stringify({ bookmark: "main", repo: "will/smithers", kind: "vm" }) },
      { name: "box.open", args: JSON.stringify({ bookmark: "main", repo: "will/smithers", kind: "desktop" }) }
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

/*
 * Lane L3b — the Desktop facet (plue's NixOS compute path). The facet exists
 * only for a desktop workspace; the iframe carries EXACTLY the attributes
 * plue's relay needs and nothing else; the credential is read from the
 * ephemeral holder, never from the card payload.
 */
describe("the workspace card's desktop facet", () => {
  const desktopCard = (overrides: Partial<Extract<Card, { kind: "workspace" }>["payload"]> = {}) =>
    workspaceCard({
      workspaceKind: "desktop",
      environment: {
        source: ".smithers/environment.nix",
        revision: "b3f21c9d4e5a6b7c",
        closureHash: "9f2b1c0d4e5a6b7c8d9e0f1a",
        image: "registry.smithers-cloud.test/environments/smithersai/smithers:nixos-2405-9f2b1c0d"
      },
      desktop: { streamUrl: "/api/workspaces/ws-1/desktop/stream", session: null },
      ...overrides
    })

  const streamUrl = "https://api.smithers-cloud.test/api/workspaces/ws-1/desktop/dtok-8f3a2b1c/vnc.html?autoconnect=1"

  const holdStream = (expiresAt: string | null = "2026-09-03T09:12:00Z", url = streamUrl): void =>
    holdDesktopStream({ workspaceId: "ws-1", url, sessionId: "dsess-1", expiresAt })

  test("the Desktop tab is offered only for a desktop workspace, and it mints through box.desktop", () => {
    dropDesktopStream()
    const container = render(workspaceCard())
    expect([...container.host.querySelectorAll("[role=tab]")].map((tab) => tab.textContent)).not.toContain("Desktop")
    container.host.remove()

    const { host, commands } = render(desktopCard())
    expect([...host.querySelectorAll("[role=tab]")].map((tab) => tab.textContent)).toContain("Desktop")
    click(host, "Desktop")
    expect(commands[0]).toEqual({ name: "box.desktop", args: "ws-1" })
    host.remove()
  })

  test("the iframe carries exactly the allow and sandbox attributes plue's relay needs", () => {
    dropDesktopStream()
    holdStream()
    const { host } = render(desktopCard({ facet: "desktop" }), { attach: false })
    const frame = host.querySelector("iframe")
    expect(frame?.getAttribute("src")).toBe(streamUrl)
    expect(frame?.getAttribute("allow")).toBe("clipboard-read; clipboard-write")
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms")
    host.remove()
    dropDesktopStream()
  })

  test("the status line says when the session lapses, and Rotate session rides its own flow", () => {
    dropDesktopStream()
    holdStream()
    const { host, commands } = render(desktopCard({ facet: "desktop" }), { attach: false })
    const line = sessionUntil("2026-09-03T09:12:00Z")
    expect(line).toStartWith("session until ")
    expect(host.textContent).toContain(line as string)
    click(host, "Rotate session")
    expect(commands[0]).toEqual({ name: "box.desktop.rotate", args: "ws-1" })
    host.remove()
    dropDesktopStream()
  })

  test("a rotate swaps the src: the facet renders whatever the holder holds now", () => {
    dropDesktopStream()
    holdStream()
    const { host } = render(desktopCard({ facet: "desktop" }), { attach: false })
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe(streamUrl)
    const rotated = streamUrl.replace("dtok-8f3a2b1c", "dtok-rotated")
    flushSync(() => {
      holdDesktopStream({ workspaceId: "ws-1", url: rotated, sessionId: "dsess-2", expiresAt: null })
    })
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe(rotated)
    // No expiry on the wire is no line about one, never a guessed time.
    expect(host.textContent).not.toContain("session until")
    host.remove()
    dropDesktopStream()
  })

  test("a facet with nothing minted renders no frame at all", () => {
    dropDesktopStream()
    const { host } = render(desktopCard({ facet: "desktop" }), { attach: false })
    expect(host.querySelector("iframe")).toBeNull()
    expect(host.textContent).not.toContain("session until")
    host.remove()
  })

  test("another workspace's mint is not this card's — the holder is read by workspace id", () => {
    dropDesktopStream()
    holdDesktopStream({ workspaceId: "ws-2", url: streamUrl, sessionId: "dsess-1", expiresAt: null })
    const { host } = render(desktopCard({ facet: "desktop" }), { attach: false })
    expect(host.querySelector("iframe")).toBeNull()
    host.remove()
    dropDesktopStream()
  })

  /*
   * The product ruling, on the surface: an infra failure says plainly that it
   * is not the user's fault and that the fix is more infra, by name. A user
   * fault — their own quota, a bad bookmark — never does, because saying it
   * there would be a lie that also stops them fixing the thing they can fix.
   */
  test("a full fleet says it is not your fault and names @fucory, with plue's own words kept underneath", () => {
    dropDesktopStream()
    const { host } = render(
      desktopCard({
        facet: "desktop",
        status: "running",
        desktopRefusal: {
          status: 503,
          message: "no sandbox slots are free",
          code: "no_capacity",
          fault: "infra",
          origin: "plue",
          retryAfterSeconds: 30
        }
      })
    )
    expect(host.textContent).toContain(INFRA_NOT_YOUR_FAULT)
    expect(host.textContent).toContain("@fucory")
    /* Verbatim, underneath — never replaced by the lead line. */
    expect(host.querySelector("details pre")?.textContent).toBe("no_capacity — no sandbox slots are free")
    /* An infra refusal is not a wait: no clock is offered, because no clock will empty the fleet. */
    expect(host.textContent).not.toContain("the server asked for 30s")
    expect(host.querySelector("[data-fault=\"infra\"]")).not.toBeNull()
    host.remove()
  })

  test("an account at its own cap gets NO infra line — that one is theirs to clear", () => {
    dropDesktopStream()
    const { host } = render(
      desktopCard({
        facet: "desktop",
        status: "running",
        desktopRefusal: {
          status: 429,
          message: "you already have 5 boxes running",
          code: "quota_exceeded",
          fault: "user",
          origin: "plue",
          retryAfterSeconds: null
        }
      })
    )
    expect(host.textContent).not.toContain("@fucory")
    expect(host.textContent).not.toContain(INFRA_NOT_YOUR_FAULT)
    expect(host.textContent).toContain("Your account is at its cap")
    expect(host.textContent).toContain("you already have 5 boxes running")
    expect(host.querySelector("[data-fault=\"user\"]")).not.toBeNull()
    host.remove()
  })

  test("a card persisted before the registry landed still gets a verdict, from its code", () => {
    dropDesktopStream()
    /* No `fault` and no `origin` on the row — re-derived from `no_capacity`. */
    const { host } = render(
      desktopCard({
        facet: "desktop",
        status: "running",
        desktopRefusal: { status: 503, message: "no sandbox slots are free", code: "no_capacity" }
      })
    )
    expect(host.textContent).toContain(INFRA_NOT_YOUR_FAULT)
    host.remove()
  })

  /*
   * The other 409 on this facet, and the opposite verdict: the box is running
   * fine, its IMAGE predates the desktop helpers, and plue calls that terminal
   * for this box. So the reader is not told they asked wrongly, not told the
   * fleet is full, and not handed a Retry that fails the same way forever. The
   * door is the one act that works — a new box, on the current image.
   */
  test("a box whose image predates the desktop tools offers a new box, not a Retry, and blames nobody", () => {
    dropDesktopStream()
    const { host, commands } = render(
      desktopCard({
        facet: "desktop",
        status: "running",
        desktopRefusal: {
          status: 409,
          message: "this box's image has no desktop tools; open a new box to get them",
          code: "desktop_tools_unavailable",
          fault: "infra",
          origin: "plue",
          retryAfterSeconds: null
        }
      })
    )
    expect(host.textContent).toContain("Not your fault")
    expect(host.textContent).not.toContain("@fucory")
    expect(host.textContent).not.toContain(INFRA_NOT_YOUR_FAULT)
    /* plue's own words, verbatim, underneath. */
    expect(host.textContent).toContain("desktop_tools_unavailable — this box's image has no desktop tools; open a new box to get them")
    const labels = [...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))
    expect(labels).not.toContain("Try the desktop session again")
    expect(labels).not.toContain("Resume the box and open its desktop")
    click(host, "Open a new desktop box with the current image")
    expect(commands[0]).toEqual({ name: "box.open", args: JSON.stringify({ bookmark: "main", repo: "will/smithers", kind: "desktop" }) })
    host.remove()
  })

  test("a 409 reads the server's own words and offers Resume", () => {
    dropDesktopStream()
    const { host, commands } = render(
      desktopCard({
        facet: "desktop",
        status: "suspended",
        desktopRefusal: { status: 409, message: "workspace is suspended; resume it before opening the desktop" }
      })
    )
    expect(host.textContent).toContain("workspace is suspended; resume it before opening the desktop")
    click(host, "Resume the box and open its desktop")
    expect(commands[0]).toEqual({ name: "box.resume", args: "ws-1" })
    host.remove()
  })

  test("a 400 reads the server's own words and offers no Resume — only Retry", () => {
    dropDesktopStream()
    const { host, commands } = render(
      desktopCard({ facet: "desktop", desktopRefusal: { status: 400, message: "workspace kind container has no desktop" } })
    )
    expect(host.textContent).toContain("workspace kind container has no desktop")
    expect(
      [...host.querySelectorAll("button")].some((button) =>
        button.getAttribute("aria-label") === "Resume the box and open its desktop")
    ).toBe(false)
    /* Every refusal offers the human a way to ask again; only a 409 offers a Resume. */
    click(host, "Try the desktop session again")
    expect(commands[0]).toEqual({ name: "box.desktop", args: "ws-1" })
    host.remove()
  })

  /*
   * `/desktop` — the one-command open — names where the box has got to while
   * nothing streams yet, and offers the way out of the wait. plue's own words
   * still read beside the stage when it refused: the stage is what the app is
   * doing, the refusal is what the server said, and neither stands in for the
   * other.
   */
  test("the wait names its stage and offers Stop, with no frame and no Retry until the server refuses", () => {
    dropDesktopStream()
    const { host, commands } = render(desktopCard({ facet: "desktop", status: "starting", desktopStage: "starting", desktopProgress: "Booting the box · 8s elapsed · usually about 20s" }))
    expect(host.textContent).toContain("Booting the box · 8s elapsed · usually about 20s")
    expect(host.querySelector('[aria-label="Starting desktop"]')).not.toBeNull()
    expect(host.querySelector("iframe")).toBeNull()
    /* Nothing was refused, so the facet offers no Retry and no Resume — only a wait to stop. */
    const labels = (): Array<string | null> => [...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))
    expect(labels()).toContain("Stop waiting for the desktop box")
    expect(labels()).not.toContain("Try the desktop session again")
    expect(labels()).not.toContain("Resume the box and open its desktop")
    click(host, "Stop waiting for the desktop box")
    expect(commands[0]).toEqual({ name: "box.desktop.stop", args: "ws-1" })
    host.remove()
  })

  test("once the mint has answered, the wait's stage is gone: plue's words stand alone", () => {
    dropDesktopStream()
    /*
     * The seam clears the stage the moment the mint owns the card
     * (WorkspaceSeam mintDesktopSession), so a refusal never reads under a
     * line claiming the stream is starting. This is the card half of that:
     * with no stage, the facet is plue's words and the acts they license.
     */
    const { host } = render(
      desktopCard({
        facet: "desktop",
        status: "running",
        desktopRefusal: { status: 503, message: "service unavailable", code: "desktop_not_ready", retryAfterSeconds: 3 }
      })
    )
    expect(host.textContent).toContain("desktop_not_ready — service unavailable")
    for (const stale of ["starting the stream", "starting the box", "creating the box"]) {
      expect(host.textContent).not.toContain(stale)
    }
    const labels = [...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))
    expect(labels).toContain("Try the desktop session again")
    expect(labels).not.toContain("Stop waiting for the desktop box")
    /* Only a 409 says the box is not running, so only a 409 offers a Resume. */
    expect(labels).not.toContain("Resume the box and open its desktop")
    host.remove()
  })

  test("a 503 desktop_not_ready prints plue's code beside its sanitized message, and offers Retry (plue#496)", () => {
    dropDesktopStream()
    const { host, commands } = render(
      desktopCard({
        facet: "desktop",
        status: "starting",
        /*
         * plue's own 503 body: writeRouteError replaces a 5xx message with
         * the status text and KEEPS the code, so without the code a person
         * would be told only "service unavailable".
         */
        desktopRefusal: {
          status: 503,
          message: "service unavailable",
          code: "desktop_not_ready",
          retryAfterSeconds: 2
        }
      })
    )
    expect(host.textContent).toContain("desktop_not_ready — service unavailable")
    expect(host.textContent).toContain("the server asked for 2s")
    /* Never a spinner in place of the server's answer. */
    expect(host.querySelector("iframe")).toBeNull()
    click(host, "Try the desktop session again")
    expect(commands[0]).toEqual({ name: "box.desktop", args: "ws-1" })
    host.remove()
  })

  test("a desktop the DTO says is not ready still renders no frame and no invented status line", () => {
    dropDesktopStream()
    const { host } = render(
      desktopCard({ facet: "desktop", status: "starting", desktop: { ready: false, streamUrl: "/api/workspaces/ws-1/desktop/stream", session: null } })
    )
    expect(host.querySelector("iframe")).toBeNull()
    expect(host.textContent).not.toContain("still starting")
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
