import { ControllerContext } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { ReactNode } from "react"
import { payloadFor } from "../flows/SlashPayload"
import type { Card, WikiIndexRow, WorldDocument } from "../state/AppState"
import { CLOUD_WIKI_PAGE_FAILURES, WIKI_INDEX_FAILURE, WIKI_SPACE_UNREADABLE } from "../wiki/CloudWikiFailure"
import type { CloudWikiState } from "../wiki/CloudWikiState"
import { WikiTree } from "../wiki/WikiNavigation"
import { BROWSER_READ_FAILURE, BrowserCardBody, ConnectCardBody, INTEGRATION_FAILURES, WorldCardBody } from "./ConversationCards"

const wikiAccount = { store: { collections: { identitySessions: new Map([["identity", { state: "signed-in", login: "octo" }]]) } } } as unknown as AppController
const ScopedWorldCard = (props: Parameters<typeof WorldCardBody>[0]) => <ControllerContext.Provider value={wikiAccount}><WorldCardBody {...props} /></ControllerContext.Provider>

GlobalRegistrator.register({ url: "http://127.0.0.1:4920/owner/repo" })
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })

const render = (node: ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(node))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  return host
}

/** The notice's words outside its collapsed Details. */
const sentenceOf = (notice: Element): string => notice.querySelector(":scope > p")?.textContent ?? ""

type Call = { readonly name: string; readonly payload: unknown }
const recorder = () => {
  const calls: Call[] = []
  return { calls, run: (name: string, args?: string) => { const parsed = payloadFor(name as never, args); calls.push({ name, payload: "payload" in parsed ? parsed.payload : parsed }) } }
}

describe("integration rows", () => {
  const connect = (rows: NonNullable<Extract<Card, { kind: "connect" }>["payload"]["integrations"]>["rows"]): Extract<Card, { kind: "connect" }> => ({
    id: "connect-embedded", kind: "connect", title: "Connect", status: "active", createdAt: 1, ordinal: 1,
    payload: { provider: "github", github: { connected: true, login: "octo" }, nativeAvailable: false, integrations: { repo: "acme/app", rows } }
  } as Extract<Card, { kind: "connect" }>)

  test("each service's failure says which service, keeps the server's words in Details, and retries the read", () => {
    const { calls, run } = recorder()
    const host = render(<ConnectCardBody card={connect([
      { id: "slack", state: "error", error: "Reading the Slack channels failed (500)" },
      { id: "linear", state: "error", error: "needs_reauthorization" }
    ])} onConnectGitHub={() => {}} onRunCommand={run} />)
    for (const [id, raw] of [["slack", "Reading the Slack channels failed (500)"], ["linear", "needs_reauthorization"]] as const) {
      const notice = host.querySelector<HTMLElement>(`[data-testid="integration-failure-${id}"]`)!
      expect(notice.getAttribute("role")).toBe("alert")
      expect(notice.dataset.fault).toBe("infra")
      expect(notice.dataset.failure).toBe(`IntegrationFailed.${id}`)
      expect(sentenceOf(notice)).toBe(INTEGRATION_FAILURES[id].sentence)
      expect(sentenceOf(notice)).not.toContain(raw)
      expect(notice.querySelector("details")?.open).toBe(false)
      expect(notice.querySelector("details pre")?.textContent).toBe(raw)
      notice.querySelector<HTMLButtonElement>("button")!.click()
    }
    expect(INTEGRATION_FAILURES.slack.sentence).toContain("Slack")
    expect(INTEGRATION_FAILURES.linear.sentence).toContain("Linear")
    expect(calls).toEqual([
      { name: "integrations.list", payload: { repo: "acme/app" } },
      { name: "integrations.list", payload: { repo: "acme/app" } }
    ])
  })

  test("only a disconnected Slack row offers Connect, and it opens the admission flow for the card's repository", () => {
    const { calls, run } = recorder()
    const host = render(<ConnectCardBody card={connect([{ id: "slack", state: "not-connected" }, { id: "linear", state: "not-connected" }])} onConnectGitHub={() => {}} onRunCommand={run} />)
    expect(host.querySelectorAll('[data-integration] button')).toHaveLength(1)
    const button = host.querySelector<HTMLButtonElement>('[data-integration="slack"] button')!
    expect(button.textContent).toBe("Connect")
    button.click()
    expect(calls).toEqual([{ name: "integrations.admit", payload: { repo: "acme/app" } }])
    for (const state of ["connected", "unavailable", "error"] as const) {
      const other = render(<ConnectCardBody card={connect([{ id: "slack", state, ...(state === "error" ? { error: "x" } : {}) }])} onConnectGitHub={() => {}} onRunCommand={() => {}} />)
      expect(Array.from(other.querySelectorAll('[data-integration="slack"] button')).map(node => node.textContent)).not.toContain("Connect")
    }
  })

  test("a healthy row draws no failure", () => {
    const host = render(<ConnectCardBody card={connect([{ id: "slack", state: "connected", detail: "C123" }])} onConnectGitHub={() => {}} onRunCommand={() => {}} />)
    expect(host.querySelector('[data-testid^="integration-failure-"]')).toBeNull()
  })
})

test("a browser card's refusal is one sentence with the page's words behind Details", () => {
  const raw = "HTTP 502 upstream_timeout: fetch https://example.com/ failed"
  const card = {
    id: "browser-x", kind: "browser", title: "page", status: "error", createdAt: 0, ordinal: 0,
    payload: { url: "https://example.com/", finalUrl: null, status: 0, frameable: false, blockReason: null, error: raw }
  } as Extract<Card, { kind: "browser" }>
  const notice = render(<BrowserCardBody card={card} />).querySelector<HTMLElement>('[data-testid="browser-card-failure"]')!
  expect(notice.dataset.failure).toBe("BrowserReadFailed")
  expect(notice.dataset.fault).toBe("infra")
  expect(sentenceOf(notice)).toBe(BROWSER_READ_FAILURE.sentence)
  expect(sentenceOf(notice)).not.toContain("502")
  expect(notice.querySelector("details pre")?.textContent).toBe(raw)
  expect(notice.querySelectorAll("button").length).toBe(0)
})

describe("a Wiki page's sync failure, keyed on its phase", () => {
  const document = (phase: CloudWikiState["phase"], error: string | null): WorldDocument => ({
    id: "wiki:acme/app:7", path: "Home.md", title: "Home", body: "# Home", links: [], tags: [], sources: [], confidence: 1,
    updatedAt: 1, updatedBy: "system", revision: 1,
    cloud: { repo: "acme/app", pageId: 7, slug: "home", remoteRevision: 3, remoteAuthor: "octo", remoteUpdatedAt: "2026-09-29T00:00:00Z",
      state: "published", accountLogin: "octo", branchId: "main", phase, error, pending: [] }
  })
  const card = { id: "wiki-open", kind: "world", title: "Wiki", status: "active", createdAt: 1, ordinal: 1,
    payload: { view: "outline", documents: [{ id: "wiki:acme/app:7", path: "Home.md", title: "Home", confidence: 1 }] } } as unknown as Extract<Card, { kind: "world" }>

  for (const phase of ["offline", "deleted"] as const) {
    test(`${phase}: the phase's sentence, the stored error only in Details`, () => {
      const raw = phase === "offline" ? "503 service_unavailable: wiki backend" : "A different page now uses this Wiki slug."
      const host = render(<ScopedWorldCard card={card} worldDocuments={[document(phase, raw)]} onChangeWorldDocument={() => {}} onRunCommand={() => {}} />)
      const notice = host.querySelector<HTMLElement>('[data-testid="wiki-card-failure"]')!
      expect(notice.getAttribute("role")).toBe("status")
      expect(notice.dataset.failure).toBe(`CloudWikiPage.${phase}`)
      expect(notice.dataset.fault).toBe(CLOUD_WIKI_PAGE_FAILURES[phase].fault)
      expect(sentenceOf(notice)).toBe(CLOUD_WIKI_PAGE_FAILURES[phase].sentence)
      expect(sentenceOf(notice)).not.toContain(raw)
      expect(notice.querySelector("details pre")?.textContent).toBe(raw)
    })
  }

  test("the offline and deleted sentences differ, and only a non-user fault says it is not the person's", () => {
    expect(CLOUD_WIKI_PAGE_FAILURES.offline.sentence).not.toBe(CLOUD_WIKI_PAGE_FAILURES.deleted.sentence)
    for (const copy of Object.values(CLOUD_WIKI_PAGE_FAILURES)) {
      expect(copy.fault).not.toBe("user")
    }
  })

  test("a page with no error draws no notice", () => {
    const host = render(<ScopedWorldCard card={card} worldDocuments={[document("live", null)]} onChangeWorldDocument={() => {}} onRunCommand={() => {}} />)
    expect(host.querySelector('[data-testid="wiki-card-failure"]')).toBeNull()
  })
})

describe("a Wiki space whose index could not be read", () => {
  const index = (error?: string): WikiIndexRow => ({
    id: "acme/app#private", repo: "acme/app", space: "private", pages: [], folders: [], tags: [], loadedAt: 1, ...(error === undefined ? {} : { error })
  })

  test("says the pages could not load, keeps the refusal in Details, and Retry re-reads that space", () => {
    const { calls, run } = recorder()
    const raw = "CloudWikiError: 500 internal: index query failed"
    const host = render(<WikiTree scope={{ repo: "acme/app", space: "private", index: index(raw) }} documents={[]} selectedId={undefined} onRunCommand={run} />)
    const notice = host.querySelector<HTMLElement>('[data-testid="wiki-tree-error"]')!
    expect(notice.getAttribute("role")).toBe("alert")
    expect(notice.dataset.failure).toBe("WikiIndexFailed")
    expect(sentenceOf(notice)).toBe(WIKI_INDEX_FAILURE.sentence)
    expect(sentenceOf(notice)).not.toContain("500")
    expect(notice.querySelector("details pre")?.textContent).toBe(raw)
    const retry = notice.querySelector<HTMLButtonElement>("button")!
    expect(retry.textContent).toBe("Retry")
    retry.click()
    expect(calls).toEqual([{ name: "wiki.space", payload: { space: "private", repo: "acme/app" } }])
  })

  test("a private space the viewer cannot read says so as the person's fault, with no Retry", () => {
    const raw = "the private wiki needs repository access"
    const row: WikiIndexRow = { ...index(raw), errorCode: "wiki_space_unreadable" }
    const host = render(<WikiTree scope={{ repo: "acme/app", space: "private", index: row }} documents={[]} selectedId={undefined} onRunCommand={() => {}} />)
    const notice = host.querySelector<HTMLElement>('[data-testid="wiki-tree-error"]')!
    expect(notice.dataset.failure).toBe("WikiSpaceUnreadable")
    expect(notice.dataset.fault).toBe("user")
    expect(sentenceOf(notice)).toBe(WIKI_SPACE_UNREADABLE.sentence)
    expect(sentenceOf(notice)).not.toBe(WIKI_INDEX_FAILURE.sentence)
    expect(notice.querySelector("details pre")?.textContent).toBe(raw)
    expect(notice.querySelector("button")).toBeNull()
  })

  test("another refusal code keeps the generic retryable notice", () => {
    const row: WikiIndexRow = { ...index("permission denied"), errorCode: "forbidden" }
    const host = render(<WikiTree scope={{ repo: "acme/app", space: "private", index: row }} documents={[]} selectedId={undefined} onRunCommand={() => {}} />)
    const notice = host.querySelector<HTMLElement>('[data-testid="wiki-tree-error"]')!
    expect(notice.dataset.failure).toBe("WikiIndexFailed")
    expect(notice.querySelector("button")?.textContent).toBe("Retry")
  })

  test("a read index draws no notice", () => {
    const host = render(<WikiTree scope={{ repo: "acme/app", space: "private", index: index() }} documents={[]} selectedId={undefined} onRunCommand={() => {}} />)
    expect(host.querySelector('[data-testid="wiki-tree-error"]')).toBeNull()
  })
})
