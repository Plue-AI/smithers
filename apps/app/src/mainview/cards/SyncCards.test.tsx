import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, jest, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { pillStatus } from "./CardRenderers"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import type { Card } from "../state/AppState"
import { RepoImportCardBody } from "./RepoImportCard"
import { ConnectorSetupCardBody, endpointLabel, rateLimitHeldUntil, SyncOpsCardBody } from "./SyncCards"



GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

type SetupPayload = Extract<Card, { kind: "connector-setup" }>["payload"]
type SyncOpsPayload = Extract<Card, { kind: "sync-ops" }>["payload"]

const setupCard = (overrides: Partial<SetupPayload> = {}): Extract<Card, { kind: "connector-setup" }> => ({
  id: "connector-setup-github-will/smithers",
  kind: "connector-setup",
  title: "Connect GitHub · will/smithers",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    connector: "github",
    repo: "will/smithers",
    phase: "setup",
    steps: [
      { id: "authorize", label: "Authorize in your browser", state: "done", detail: "authorized as Will" },
      { id: "team", label: "Team", state: "active", detail: null },
      { id: "repository", label: "Repository", state: "pending", detail: "will/smithers" },
      { id: "confirm", label: "Confirm", state: "pending", detail: null }
    ],
    ...overrides
  }
})

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

const renderSetup = (
  card: Extract<Card, { kind: "connector-setup" }>,
  controller?: AppController
) => {
  const commands: Array<{ name: string; args?: string }> = []
  const host = document.createElement("div")
  document.body.append(host)
  const body = <ConnectorSetupCardBody card={card} onRunCommand={(name, args) => commands.push({ name, args })} />
  flushSync(() => {
    createRoot(host).render(
      controller === undefined ? body : <ControllerTestProvider controller={controller}>{body}</ControllerTestProvider>
    )
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
const minutesFromNow = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString()

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

describe("ConnectorSetupCardBody — the GitHub card", () => {
  test("not installed offers Open GitHub and Re-check; installed offers Reconcile", () => {
    const missing = renderSetup(
      setupCard({
        connector: "github",
        phase: "setup",
        steps: [],
        installUrl: "https://github.com/apps/smithers/installations/new"
      })
    )
    expect(missing.host.textContent).toContain("The Smithers GitHub App is not installed")
    click(missing.host, "Open GitHub")
    click(missing.host, "Re-check")
    expect(missing.commands).toEqual([
      { name: "github.app.open", args: "will/smithers" },
      { name: "github.app", args: "will/smithers" }
    ])

    const installed = renderSetup(
      setupCard({ connector: "github", phase: "connected", steps: [], installationId: 5511, configured: true })
    )
    expect(installed.host.textContent).toContain("installation 5511 · configured")
    click(installed.host, "Reconcile")
    expect(installed.commands).toEqual([{ name: "github.reconcile", args: "will/smithers" }])
  })

  test("the rate-limit line follows the ADR: a reset ahead reads as time ahead, never as an age", () => {
    /* Review finding 2: the age label clamped a future reset to "resets just now". */
    const ahead = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(12) } })
    )
    expect(ahead.host.textContent).toContain("GitHub rate limit reached · 0 of 5,000 · resets in 12 min · Retry after")
    expect(ahead.host.textContent).not.toContain("just now")

    const later = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(90) } })
    )
    expect(later.host.textContent).toMatch(/resets at \d{1,2}:\d{2}/)

    const behind = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(-4) } })
    )
    expect(behind.host.textContent).toContain("reset 4 min ago")
  })

  test("a refused call holds Re-check and Reconcile until the reset, with the time on them", () => {
    /* Review finding 5: every retry stayed clickable through the window, re-posting and re-failing. */
    const resetAt = minutesFromNow(12)
    const held = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt }, error: "GitHub rate limit exhausted" })
    )
    const clock = new Date(resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    const recheck = buttonNamed(held.host, "Re-check")
    const reconcile = buttonNamed(held.host, "Reconcile")
    expect(recheck.disabled).toBe(true)
    expect(reconcile.disabled).toBe(true)
    expect(recheck.textContent).toContain(`Re-check after ${clock}`)
    expect(reconcile.textContent).toContain(`Reconcile after ${clock}`)
    flushSync(() => recheck.click())
    expect(held.commands).toEqual([])

    /* A low-but-positive budget shows the line and holds nothing; a reset behind us holds nothing. */
    const low = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 40, resetAt } })
    )
    expect(buttonNamed(low.host, "Re-check").disabled).toBe(false)
    const passed = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(-1) } })
    )
    expect(buttonNamed(passed.host, "Re-check").disabled).toBe(false)
    expect(rateLimitHeldUntil({ limit: 5000, remaining: 0, resetAt: null })).toBeNull()
  })
})

describe("rate-limit clock subscriptions", () => {
  test.each([180_000, 150_000, 30_000])("releases every mounted retry at a reset %i ms away without a store update", (remaining) => {
    jest.useFakeTimers({ now: Date.parse("2026-09-06T12:00:00Z") })
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const rateLimit = { limit: 5000, remaining: 0, resetAt: new Date(Date.now() + remaining).toISOString() }
    try {
      flushSync(() => root.render(
        <>
          <ConnectorSetupCardBody card={setupCard({ connector: "github", steps: [], rateLimit })} onRunCommand={() => {}} />
          <RepoImportCardBody
            card={{
              id: "repo-import-will/flows",
              kind: "repo-import",
              title: "Import · will/flows",
              status: "error",
              createdAt: 0,
              ordinal: 0,
              payload: { repo: "will/flows", jobId: null, phase: "failed", detail: "GitHub rate limit exhausted", rateLimit }
            }}
            onRunCommand={() => {}}
          />
        </>
      ))
      const buttons = ["Re-check", "Reconcile", "Try again"].map((name) => buttonNamed(host, name))
      const expectCountdown = (label: string) => {
        expect([...host.querySelectorAll("p")].filter((line) => line.textContent?.includes(label))).toHaveLength(2)
        expect(buttons.map((button) => button.disabled)).toEqual([true, true, true])
      }
      expectCountdown(remaining < 60_000 ? "resets in under a minute" : `resets in ${Math.ceil(remaining / 60_000)} min`)
      let left = remaining
      while (left > 60_000) {
        const step = left % 60_000 || 60_000
        flushSync(() => jest.advanceTimersByTime(step))
        left -= step
        expectCountdown(`resets in ${left / 60_000} min`)
      }
      flushSync(() => jest.advanceTimersByTime(left - 1))
      expect(buttons.map((button) => button.disabled)).toEqual([true, true, true])
      flushSync(() => jest.advanceTimersByTime(1))
      expect(buttons.map((button) => button.disabled)).toEqual([false, false, false])
      expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Re-check", "Reconcile", "Try again"])
      expect(host.textContent).toContain("reset just now")
      expect(jest.getTimerCount()).toBe(0)
      flushSync(() => jest.advanceTimersByTime(60_000))
      expect(buttons.map((button) => button.disabled)).toEqual([false, false, false])
    } finally {
      flushSync(() => root.unmount())
      host.remove()
      jest.useRealTimers()
    }
  })

  test("unmount cancels the timer re-armed after a countdown tick", () => {
    jest.useFakeTimers({ now: Date.parse("2026-09-06T12:00:00Z") })
    const host = document.createElement("div")
    const root = createRoot(host)
    try {
      flushSync(() => root.render(
        <ConnectorSetupCardBody
          card={setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(3) } })}
          onRunCommand={() => {}}
        />
      ))
      flushSync(() => jest.advanceTimersByTime(60_000))
      expect(host.textContent).toContain("resets in 2 min")
      expect(jest.getTimerCount()).toBeGreaterThan(0)
    } finally {
      flushSync(() => root.unmount())
      const pending = jest.getTimerCount()
      jest.useRealTimers()
      expect(pending).toBe(0)
    }
  })
})

describe("RepoImportCardBody — the job card (ADR 0005 \"Import a GitHub repository\")", () => {
  const importCard = (
    payload: Partial<Extract<Card, { kind: "repo-import" }>["payload"]>
  ): Extract<Card, { kind: "repo-import" }> => ({
    id: "repo-import-acme/web",
    kind: "repo-import",
    title: "Import · acme/web",
    status: "active",
    createdAt: 0,
    ordinal: 0,
    payload: { repo: "acme/web", jobId: "job-1", phase: "running", detail: null, ...payload }
  })

  test("the card header says starting until the launch receipt arrives", () => {
    expect(pillStatus(importCard({ jobId: null, phase: "starting" }))).toBe("starting")
    expect(pillStatus(importCard({ phase: "running" }))).toBe("running")
  })

  test("ADR 0005 importing: the counts and the raw stage word, with no act while it runs", () => {
    const { host } = render(
      <RepoImportCardBody
        card={importCard({
          phase: "running",
          detail: "Provisioning workspace…",
          stage: "provisioning_workspace",
          counts: {
            refs: { done: 214, total: 214 },
            objects: { done: 88_210, total: 91_004 },
            issues: { done: 0, total: 312 }
          }
        })}
        onRunCommand={() => {}}
      />
    )

    expect(host.textContent).toContain("refs 214 of 214 · objects 88210 of 91004 · issues 0 of 312")
    /* plue's own stage word, never translated into one of this app's. */
    expect(host.textContent).toContain("stage · provisioning_workspace")
    expect(host.querySelectorAll("button")).toHaveLength(0)
  })

  test("ADR 0005 failed import: the job's error verbatim, with Retry naming the job", () => {
    const commands: Array<{ name: string; args?: string }> = []
    const { host } = render(
      <RepoImportCardBody
        card={importCard({
          phase: "failed",
          detail: "github: repository acme/web not found or not accessible",
          stage: "cloning_github",
          error: "github: repository acme/web not found or not accessible"
        })}
        onRunCommand={(name, args) => commands.push({ name, args })}
      />
    )

    expect(host.textContent).toContain("github: repository acme/web not found or not accessible")
    const retry = buttonNamed(host, "Try again")
    expect(retry.disabled).toBe(false)
    click(host, "Try again")
    expect(commands).toEqual([{ name: "repos.import.retry", args: "job-1" }])
  })

  test("a done import opens repository issues through the product session", () => {
    const commands: Array<{ name: string; args?: string }> = []
    const { host } = render(
      <RepoImportCardBody
        card={importCard({
          phase: "done",
          detail: null,
          repository: { owner: "acme", name: "web" },
          workspaceId: "ws-9"
        })}
        onRunCommand={(name, args) => commands.push({ name, args })}
      />
    )

    expect(host.textContent).toContain("acme/web")
    click(host, "Show issues")
    expect(commands).toEqual([{ name: "issues.list", args: "open acme/web" }])
  })
})

test("a completed import without a workspace receipt still offers the next repository action", () => {
  const commands: Array<{ name: string; args?: string }> = []
  const { host } = render(<RepoImportCardBody card={{ id: "repo-import-acme/web", kind: "repo-import", title: "Import", status: "acted", createdAt: 0, ordinal: 0,
    payload: { repo: "acme/web", jobId: "job-1", phase: "done", detail: null } }}
    onRunCommand={(name, args) => commands.push({ name, args })} />)
  click(host, "Show issues")
  expect(commands).toEqual([{ name: "issues.list", args: "open acme/web" }])
})

describe("RepoImportCardBody — the rate-limited retry", () => {
  test("a structured 429 holds Try again until the reset, with the time on it", () => {
    const resetAt = minutesFromNow(12)
    const commands: Array<{ name: string; args?: string }> = []
    const { host } = render(
      <RepoImportCardBody
        card={{
          id: "repo-import-will/flows",
          kind: "repo-import",
          title: "Import · will/flows",
          status: "error",
          createdAt: 0,
          ordinal: 0,
          payload: {
            repo: "will/flows",
            jobId: null,
            phase: "failed",
            detail: "GitHub rate limit exhausted",
            rateLimit: { limit: 5000, remaining: 0, resetAt }
          }
        }}
        onRunCommand={(name, args) => commands.push({ name, args })}
      />
    )

    const clock = new Date(resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    const retry = buttonNamed(host, "Try again")
    expect(retry.disabled).toBe(true)
    expect(retry.textContent).toContain(`Try again after ${clock}`)
    expect(host.textContent).toContain("resets in 12 min")
    flushSync(() => retry.click())
    expect(commands).toEqual([])
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
