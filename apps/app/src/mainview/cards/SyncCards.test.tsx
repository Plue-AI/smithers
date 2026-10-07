import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { pillStatus } from "./CardRenderers"
import type { Card } from "../state/AppState"
import { endpointLabel, SyncOpsCardBody } from "./SyncCards"



GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

type SyncOpsPayload = Extract<Card, { kind: "sync-ops" }>["payload"]

const syncOpsCard = (overrides: Partial<SyncOpsPayload> = {}): Extract<Card, { kind: "sync-ops" }> => ({
  id: "sync-ops-mirror-7",
  kind: "sync-ops",
  title: "Sync · Mirror · will/smithers",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    subject: "Mirror · will/smithers",
    source: "github-mirror",
    repo: "will/smithers",
    runState: null,
    ops: [],
    ...overrides
  }
})

const render = (node: React.ReactNode) => {
  const commands: Array<{ name: string; args?: string }> = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<>{node}</>)
  })
  return { host, commands }
}

const buttonNamed = (host: HTMLElement, text: string): HTMLButtonElement => {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text))
  if (button === undefined) throw new Error(`no button named ${text}`)
  return button
}

const click = (host: HTMLElement, text: string): void => {
  flushSync(() => buttonNamed(host, text).click())
}

/** An ISO stamp a number of minutes from now — the rate-limit line reads against the real clock. */

describe("the frame pill of a sync-ops card", () => {
  test("a null run state (nothing has answered yet) is never done, and a wire word is never renamed", () => {
    /* Review finding 3: null fell into "done", so a sync that had just started wore a finished pill. */
    expect(pillStatus(syncOpsCard({ runState: null, trigger: "sync started · run 41" }))).toBe("pending")
    
    expect(pillStatus(syncOpsCard({ runState: "pending" }))).toBe("pending")
    expect(pillStatus(syncOpsCard({ runState: "running" }))).toBe("running")
    expect(pillStatus(syncOpsCard({ runState: "completed" }))).toBe("completed")
    expect(pillStatus(syncOpsCard({ runState: "queued" }))).toBe("queued")
    expect(pillStatus(syncOpsCard({ runState: "succeeded" }))).toBe("succeeded")
    expect(pillStatus(syncOpsCard({ runState: "failed" }))).toBe("failed")
    expect(pillStatus(syncOpsCard({ runState: null, error: "Starting the sync failed (500)" }))).toBe("failed")
  })
})

describe("SyncOpsCardBody", () => {
  test("a started run with no run DTO yet claims no state and no counts", () => {
    const { host } = render(
      <SyncOpsCardBody card={syncOpsCard({ runId: "41", trigger: "sync started · run 41" })} onRunCommand={() => {}} />
    )

    expect(host.textContent).toContain("Mirror · will/smithers")
    expect(host.textContent).toContain("sync started · run 41")
    /* Nothing has answered yet, so nothing claims a state or a count. */
    expect(host.textContent).not.toContain("of ")
    expect(host.querySelectorAll("button")).toHaveLength(0)
  })

  test("ADR 0005 active: the live run wears the wire's own state word and its summed counts", () => {
    const { host } = render(
      <SyncOpsCardBody
        card={syncOpsCard({
          runId: "41",
          runState: "running",
          counts: { total: 12, done: 10, failed: 1 },
          ops: [
            {
              id: "12",
              source: "github-mirror",
              target: "smithers-cloud",
              entity: "issue",
              entityId: "ENG-482",
              action: "create",
              status: "success",
              retryable: false,
              at: new Date(Date.now() - 2_000).toISOString()
            }
          ]
        })}
        onRunCommand={() => {}}
      />
    )

    expect(host.textContent).toContain("Running")
    expect(host.textContent).toContain("10 of 12 · 1 failed")
    expect(host.textContent).toContain("github-mirror → Smithers Cloud issue ENG-482 create")
    /* ADR row: "… action, age". */
    expect(host.textContent).toContain("just now")
    /* Nothing succeeded may offer a Retry. */
    expect(host.querySelectorAll("button")).toHaveLength(0)
  })

  test("the cloud endpoint reads Smithers Cloud on screen, whichever name the wire used", () => {
    /*
     * The backend's own payloads still say `jjhub`, an internal name. The row
     * renders the product name for it and leaves every other endpoint alone.
     */
    expect(endpointLabel("jjhub")).toBe("Smithers Cloud")
    expect(endpointLabel("smithers-cloud")).toBe("Smithers Cloud")
    expect(endpointLabel("github")).toBe("github")
    expect(endpointLabel("github")).toBe("github")

    const { host } = render(
      <SyncOpsCardBody
        card={syncOpsCard({
          runState: "completed",
          ops: [
            {
              id: "77",
              source: "jjhub",
              target: "github",
              entity: "issue",
              entityId: "77",
              action: "update",
              status: "success",
              retryable: false,
              at: null
            }
          ]
        })}
        onRunCommand={() => {}}
      />
    )

    expect(host.textContent).toContain("Smithers Cloud → github issue 77 update")
    expect(host.textContent).not.toContain("jjhub")
  })

  test("a mirror run renders one row per ref and the repository's own mirror_status word", () => {
    const { host } = render(
      <SyncOpsCardBody
        card={{
          ...syncOpsCard(),
          id: "sync-ops-mirror-will/smithers",
          payload: {
            subject: "will/smithers → GitHub",
            source: "github-mirror",
            repo: "will/smithers",
            runId: "88",
            runState: "succeeded",
            mirrorStatus: "unconfigured",
            ops: [
              {
                id: "refs/heads/main",
                source: "b775d9",
                target: "3f2a1b",
                entity: "ref",
                entityId: "refs/heads/main",
                action: "push",
                status: "succeeded",
                retryable: false,
                at: null
              }
            ]
          }
        }}
        onRunCommand={() => {}}
      />
    )

    expect(host.textContent).toContain("will/smithers → GitHub")
    expect(host.textContent).toContain("unconfigured")
    expect(host.textContent).toContain("b775d9 → 3f2a1b ref refs/heads/main push")
    /* plue#491 retries only a FAILED ref, so a succeeded one offers nothing. */
    expect(host.querySelectorAll("button")).toHaveLength(0)
  })

  test("a behind mirror reads plue#491's ref counts, and a failed ref retries through the per-ref route", () => {
    const commands: Array<{ name: string; args?: string }> = []
    const { host } = render(
      <SyncOpsCardBody
        card={{
          ...syncOpsCard(),
          id: "sync-ops-mirror-will/smithers",
          payload: {
            subject: "will/smithers → GitHub",
            source: "github-mirror",
            repo: "will/smithers",
            runId: "88",
            runState: "failed",
            mirrorStatus: "behind",
            behindRefs: 3,
            failedRefs: 1,
            ops: [
              {
                id: "refs/heads/wip",
                source: "—",
                target: "aa11bb",
                entity: "ref",
                entityId: "refs/heads/wip",
                action: "push",
                status: "failed",
                error: "remote rejected: non-fast-forward",
                retryable: true,
                at: null
              }
            ]
          }
        }}
        onRunCommand={(name, args) => commands.push({ name, args })}
      />
    )

    /* ADR 0005's header line, with the count plue now states. */
    expect(host.textContent).toContain("behind GitHub · 3 refs · 1 failed")
    expect(host.textContent).toContain("remote rejected: non-fast-forward")
    
    click(host, "Retry")
    expect(commands).toEqual([{ name: "github.mirror.retry-ref", args: '{"ref":"refs/heads/wip","repo":"will/smithers"}' }])
  })

  test("a mirror card whose repository stated no counts shows the word alone", () => {
    const { host } = render(
      <SyncOpsCardBody
        card={{
          ...syncOpsCard(),
          id: "sync-ops-mirror-will/smithers",
          payload: {
            subject: "will/smithers → GitHub",
            source: "github-mirror",
            repo: "will/smithers",
            runState: null,
            mirrorStatus: "behind",
            ops: []
          }
        }}
        onRunCommand={() => {}}
      />
    )

    expect(host.textContent).toContain("behind")
    expect(host.textContent).not.toContain("refs")
  })

  test("past the cut, Show more widens the window", () => {
    const commands: Array<{ name: string; args?: string }> = []
    const ops = Array.from({ length: 12 }, (_, index) => ({
      id: `op-${index}`,
      source: "github-mirror",
      target: "smithers-cloud",
      entity: "issue",
      entityId: `ENG-${index}`,
      action: "update",
      status: "success",
      retryable: false,
      at: null
    }))
    const { host } = render(
      <SyncOpsCardBody
        card={syncOpsCard({ ops })}
        onRunCommand={(name, args) => commands.push({ name, args })}
      />
    )

    expect(host.textContent).not.toContain("ENG-11")
    click(host, "Show more")
    expect(commands).toEqual([
      { name: "sync.ops.show-more", args: "sync-ops-mirror-7" },
    ])
  })
})
