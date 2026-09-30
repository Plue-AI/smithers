import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  awaitDeployment,
  describeWait,
  MIN_READ_MS,
  readIsSettled,
  SETTLE_INTERVAL_MS,
  SETTLE_MS
} from "./BuildPropagation.ts"
import type { DeploymentRead, SettleDeps, SettleOptions } from "./BuildPropagation.ts"
import { BUILD_STAMP_META, BUILD_STAMP_PATH } from "./BuildStamp.ts"
import { DEFAULT_APP_DOCUMENT_PATH } from "../../src/appDocument.ts"

/**
 * CN-1's propagation window.
 *
 * On 2026-09-14 the autodeploy runner deployed 83a400d9, probed
 * canary.smithers.sh four seconds later, read the previous build's stamp
 * (22316c30) and rolled the good deploy back; smithers.sh, probed seconds
 * after that, already served the new one. The deployment was right and the
 * probe was early, so these tests fix both halves of the contract: a
 * disagreement that resolves inside the window is not a verdict, and a
 * disagreement that outlives the window still is.
 *
 * The loop's clock, sleep and fetch are injected, so a ninety-second window
 * runs in no time and never touches the network. The shell tests below spawn
 * the real probe against a loopback stand-in whose answers change between
 * reads, which is the race itself in miniature.
 */

const NEW = "83a400d91ddf877aced2654a0b47e63b0c24713e"
const OLD = "22316c3055c4cc5404e673e31d608ee60138b441"

const stampBody = (sha: string) => JSON.stringify({ worker: "smithers-mvp-web", gitSha: sha, builtAt: "2026-09-14T11:59:40.558Z" })
const htmlBody = (sha: string | null) =>
  `<!DOCTYPE html><html><head>${
    sha === null ? "" : `<meta name="${BUILD_STAMP_META}" content="${sha}">`
  }<title>Smithers</title></head><body><div id="root"></div></body></html>`

/** One state of the deployment, as the two URLs the probe reads would answer it. */
interface Serving {
  readonly stamp?: string
  readonly html?: string | null
  /** The deployment answers nothing at all: DNS, TLS, a reset connection. */
  readonly transportError?: string
  readonly stampStatus?: number
  readonly htmlStatus?: number
}

const OPTIONS: SettleOptions = {
  origin: "https://canary.smithers.sh",
  documentPath: DEFAULT_APP_DOCUMENT_PATH,
  expectedSha: NEW,
  allowUnstampedHtml: false,
  settleMs: SETTLE_MS,
  intervalMs: SETTLE_INTERVAL_MS
}

/**
 * A deployment that walks through `states`, one state per read, and stays on
 * the last one forever. The clock only moves when the loop sleeps, so the
 * wait the test asserts is the wait the loop asked for and nothing else.
 */
const deployment = (states: ReadonlyArray<Serving>) => {
  const urls: Array<string> = []
  const inits: Array<RequestInit> = []
  const sleeps: Array<number> = []
  const budgets: Array<number> = []
  let clock = 0
  let reads = 0
  const deps: SettleDeps = {
    fetch: (url, init) => {
      urls.push(url)
      inits.push(init)
      /* Two fetches per read: the stamp asset, then the app document. */
      const state = states[Math.min(Math.floor(reads / 2), states.length - 1)]!
      reads += 1
      if (state.transportError !== undefined) return Promise.reject(new Error(state.transportError))
      if (url.includes(BUILD_STAMP_PATH)) {
        return Promise.resolve(
          new Response(stampBody(state.stamp ?? OLD), { status: state.stampStatus ?? 200 })
        )
      }
      return Promise.resolve(
        new Response(htmlBody(state.html === undefined ? state.stamp ?? OLD : state.html), {
          status: state.htmlStatus ?? 200
        })
      )
    },
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms)
      clock += ms
      return Promise.resolve()
    },
    /* The fake deployment always answers, so its deadline never fires; the budget each read got is recorded. */
    abortAfter: (ms) => {
      budgets.push(ms)
      return new AbortController().signal
    }
  }
  return { deps, urls, inits, sleeps, budgets }
}

describe("the propagation window", () => {
  test("a deployment already serving the expected sha passes on the first read, without sleeping", async () => {
    const world = deployment([{ stamp: NEW }])
    const result = await awaitDeployment(world.deps, OPTIONS)
    expect(result.settled).toBe(true)
    expect(result.reads).toBe(1)
    expect(result.waitedMs).toBe(0)
    expect(world.sleeps).toEqual([])
    expect(describeWait(result)).toBe("on the first read")
  })

  /* The 2026-09-14 race: the edge answered the previous stamp, then caught up. */
  test("a stale sha that catches up inside the window settles, and says how long it waited", async () => {
    const world = deployment([{ stamp: OLD }, { stamp: OLD }, { stamp: NEW }])
    const result = await awaitDeployment(world.deps, OPTIONS)
    expect(result.settled).toBe(true)
    expect(result.reads).toBe(3)
    expect(world.sleeps).toEqual([SETTLE_INTERVAL_MS, SETTLE_INTERVAL_MS])
    expect(result.waitedMs).toBe(2 * SETTLE_INTERVAL_MS)
    expect(describeWait(result)).toBe("after 6.0 s and 3 reads")
    expect(typeof result.read.stamp === "string" ? "" : result.read.stamp.gitSha).toBe(NEW)
  })

  /* Waiting is not weakening: the deploy that really is wrong still fails. */
  test("a stale sha that never catches up fails at the deadline, with the last read to report", async () => {
    const world = deployment([{ stamp: OLD }])
    const result = await awaitDeployment(world.deps, OPTIONS)
    expect(result.settled).toBe(false)
    expect(result.waitedMs).toBe(SETTLE_MS)
    expect(world.sleeps.reduce((total, ms) => total + ms, 0)).toBe(SETTLE_MS)
    expect(result.reads).toBe(SETTLE_MS / SETTLE_INTERVAL_MS + 1)
    expect(typeof result.read.stamp === "string" ? "" : result.read.stamp.gitSha).toBe(OLD)
  })

  test("the last sleep is trimmed to the deadline, so the window is a ceiling and not a floor", async () => {
    const world = deployment([{ stamp: OLD }])
    const result = await awaitDeployment(world.deps, { ...OPTIONS, settleMs: 700, intervalMs: 300 })
    expect(world.sleeps).toEqual([300, 300, 100])
    expect(result.waitedMs).toBe(700)
  })

  test("--settle-ms 0 reads exactly once, which is the behaviour before the window existed", async () => {
    const world = deployment([{ stamp: OLD }, { stamp: NEW }])
    const result = await awaitDeployment(world.deps, { ...OPTIONS, settleMs: 0 })
    expect(result.reads).toBe(1)
    expect(result.settled).toBe(false)
    expect(world.sleeps).toEqual([])
  })

  /*
   * Mid-rollout the two assets can come from different versions, so the
   * HTML-vs-asset disagreement is a propagation symptom before it is a
   * verdict — in both directions, and including HTML carrying no stamp at all.
   */
  test("HTML and asset from different builds is waited out, then settles", async () => {
    const world = deployment([{ stamp: NEW, html: OLD }, { stamp: NEW, html: NEW }])
    const result = await awaitDeployment(world.deps, OPTIONS)
    expect(result.settled).toBe(true)
    expect(result.reads).toBe(2)
  })

  test("HTML carrying no stamp at all is waited out, and still fails when it persists", async () => {
    const world = deployment([{ stamp: NEW, html: null }])
    const result = await awaitDeployment(world.deps, { ...OPTIONS, settleMs: 300, intervalMs: 100 })
    expect(result.settled).toBe(false)
    expect(result.read.html.metaSha).toBeNull()
  })

  test("--allow-unstamped-html parks that row rather than burning the window on it", async () => {
    const world = deployment([{ stamp: NEW, html: null }])
    const result = await awaitDeployment(world.deps, { ...OPTIONS, allowUnstampedHtml: true })
    expect(result.settled).toBe(true)
    expect(result.reads).toBe(1)
  })

  /*
   * An app document that answers 404 is a row `htmlAgreementVerdict` declines
   * to grade, today and after this change. Waiting ninety seconds for a skip
   * to become a pass would slow every deploy to buy nothing.
   */
  test("an app document that cannot be read is a skip, not something to wait for", async () => {
    const world = deployment([{ stamp: NEW, htmlStatus: 404 }])
    const result = await awaitDeployment(world.deps, OPTIONS)
    expect(result.settled).toBe(true)
    expect(result.reads).toBe(1)
  })

  /*
   * A transport error during the window is the same event as a stale read, one
   * layer down: an edge mid-rollout, or DNS that has not caught up with a
   * freshly attached custom domain. It is retried, never swallowed.
   */
  test("a transport error inside the window is retried", async () => {
    const world = deployment([{ transportError: "connect ECONNREFUSED" }, { stamp: NEW }])
    const result = await awaitDeployment(world.deps, OPTIONS)
    expect(result.settled).toBe(true)
    expect(result.reads).toBe(2)
  })

  test("a transport error that outlives the window fails, naming what never answered", async () => {
    const world = deployment([{ transportError: "getaddrinfo ENOTFOUND canary.smithers.sh" }])
    const result = await awaitDeployment(world.deps, { ...OPTIONS, settleMs: 300, intervalMs: 100 })
    expect(result.settled).toBe(false)
    expect(result.read.stamp).toContain("getaddrinfo ENOTFOUND")
    expect(result.read.html.transportError).toContain("getaddrinfo ENOTFOUND")
  })

  test("every read is uncached and separately busted, so the window measures the edge and not a cache", async () => {
    const world = deployment([{ stamp: OLD }, { stamp: NEW }])
    await awaitDeployment(world.deps, OPTIONS)
    expect(world.urls).toHaveLength(4)
    for (const url of world.urls) expect(url).toContain("?t=")
    /* The clock advances between reads, so the buster does too. */
    expect(new Set(world.urls.map((url) => url.split("?t=")[1])).size).toBe(2)
    for (const init of world.inits) {
      expect(init.cache).toBe("no-store")
      expect((init.headers as Record<string, string>)["cache-control"]).toBe("no-cache")
    }
  })

  test("each read is bounded by the rest of the window, never less than one interval", async () => {
    const world = deployment([{ stamp: OLD }])
    await awaitDeployment(world.deps, { ...OPTIONS, settleMs: 700, intervalMs: 300 })
    /* One deadline per read, shared by the stamp and the document; the read at the deadline keeps one interval. */
    expect(world.budgets).toEqual([700, 400, 300, 300])
    const once = deployment([{ stamp: OLD }])
    await awaitDeployment(once.deps, { ...OPTIONS, settleMs: 0, intervalMs: 0 })
    expect(once.budgets).toEqual([MIN_READ_MS])
    for (const init of [...world.inits, ...once.inits]) expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  /*
   * A stalled edge: headers that never come, or a body that stops mid-stream.
   * The deadline aborts the read even when the fetch ignores its signal, and
   * the window closes on a bounded failure naming what never finished.
   */
  for (const stall of ["headers", "body"] as const) {
    test(`a read stalled in its ${stall} is cut at the deadline and graded as a failure`, async () => {
      const world = deployment([{ stamp: NEW }])
      const stalled: SettleDeps = {
        ...world.deps,
        fetch: () =>
          stall === "headers"
            ? new Promise<Response>(() => {})
            : Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")) } }))),
        abortAfter: (ms) => {
          world.budgets.push(ms)
          const controller = new AbortController()
          queueMicrotask(() => controller.abort(new Error("deadline")))
          return controller.signal
        }
      }
      const result = await awaitDeployment(stalled, { ...OPTIONS, settleMs: 300, intervalMs: 100 })
      expect(result.settled).toBe(false)
      expect(result.read.stamp).toBe(`GET ${BUILD_STAMP_PATH} never answered: no complete answer within 100 ms`)
      expect(result.read.html.transportError).toBe("no complete answer within 100 ms")
      expect(world.budgets).toEqual([300, 200, 100, 100])
    })
  }

  test("with no expected sha there is nothing for the window to wait for", () => {
    const read: DeploymentRead = {
      stamp: { worker: "smithers-mvp-web", gitSha: OLD, builtAt: "2026-09-14T11:42:28.586Z" },
      html: { status: 200, metaSha: OLD }
    }
    expect(readIsSettled(read, undefined, false)).toBe(true)
    expect(readIsSettled(read, NEW, false)).toBe(false)
    expect(readIsSettled(read, OLD, false)).toBe(true)
  })
})

/*
 * The end-to-end pin. The unit tests above run a fake clock; these run the real
 * probe as a subprocess against a server whose answers change between reads,
 * so what is asserted is the exit code the autodeploy runner reads — the one
 * that decided to roll 83a400d9 back.
 */
describe("the probe's exit code under a propagating deployment", () => {
  const probePath = fileURLToPath(new URL("./build-probe.ts", import.meta.url))

  /** Serves the previous build for the first `staleReads` reads, then the new one. */
  const serve = (staleReads: number) => {
    let stampReads = 0
    return Bun.serve({
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        if (path === BUILD_STAMP_PATH) {
          const sha = stampReads < staleReads ? OLD : NEW
          stampReads += 1
          return new Response(stampBody(sha), { headers: { "content-type": "application/json" } })
        }
        if (path === DEFAULT_APP_DOCUMENT_PATH) {
          return new Response(htmlBody(stampReads <= staleReads ? OLD : NEW), {
            headers: { "content-type": "text/html" }
          })
        }
        return new Response("Not found", { status: 404 })
      }
    })
  }

  const runProbe = async (staleReads: number, extraArgs: ReadonlyArray<string>, env: Record<string, string> = {}) => {
    const server = serve(staleReads)
    try {
      const startedAt = Date.now()
      const proc = Bun.spawn(["bun", probePath, server.url.origin, "--sha", NEW, ...extraArgs], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env }
      })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text()
      ])
      return { exitCode: await proc.exited, stdout, stderr, elapsedMs: Date.now() - startedAt }
    } finally {
      server.stop(true)
    }
  }

  test("a deployment that propagates during the window exits 0 and says it waited", async () => {
    const result = await runProbe(2, ["--settle-ms", "10000", "--settle-interval-ms", "20"])
    expect(result.stdout).toContain("settled after")
    expect(result.stdout).toContain("CN-1 PASS")
    expect(result.exitCode).toBe(0)
  })

  test("a deployment that never propagates still exits 1, after the window and not before", async () => {
    const result = await runProbe(Number.MAX_SAFE_INTEGER, ["--settle-ms", "400", "--settle-interval-ms", "50"])
    expect(result.stdout).toContain("propagation window closed")
    expect(result.stdout).toContain("FAIL: the deployed sha matches the expected sha")
    expect(result.stdout).toContain("CN-1 FAILED")
    expect(result.exitCode).toBe(1)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(400)
  })

  test("$CANARY_SETTLE_MS sets the window when no flag does", async () => {
    const result = await runProbe(2, ["--settle-interval-ms", "20"], { CANARY_SETTLE_MS: "10000" })
    expect(result.stdout).toContain("propagation window 10000 ms")
    expect(result.exitCode).toBe(0)
  })

  /* Exit 2, never 1: a malformed flag is a mistake in the invocation, not a verdict about the deployment. */
  test("a window that is not a number exits 2 without probing", async () => {
    const result = await runProbe(0, ["--settle-ms", "soon"])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("--settle-ms takes milliseconds")
    expect(result.stdout).not.toContain("CN-1")
  })

  /*
   * A real stalled edge: the loopback server holds the stamp's headers, or
   * sends one byte of its body and holds the rest, until the test releases
   * it. The probe must fail with its JSON receipt inside the window while the
   * connection is still held.
   */
  for (const stall of ["headers", "body"] as const) {
    test(`a stamp stalled in its ${stall} still fails inside --settle-ms and writes its receipt`, async () => {
      const releases: Array<() => void> = []
      const server = Bun.serve({
        port: 0,
        fetch: (request) => {
          const path = new URL(request.url).pathname
          if (path !== BUILD_STAMP_PATH) return new Response(htmlBody(NEW), { headers: { "content-type": "text/html" } })
          if (stall === "headers") return new Promise<Response>((resolve) => releases.push(() => resolve(new Response(stampBody(NEW)))))
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"))
              releases.push(() => {
                try {
                  controller.close()
                } catch {
                  /* The probe already hung up. */
                }
              })
            }
          }), { headers: { "content-type": "application/json" } })
        }
      })
      const dir = mkdtempSync(join(tmpdir(), "build-probe-stall-"))
      const receipt = join(dir, "receipt.json")
      try {
        const startedAt = Date.now()
        const proc = Bun.spawn(["bun", probePath, server.url.origin, "--sha", NEW, "--settle-ms", "100", "--settle-interval-ms", "25", "--json", receipt], {
          stdout: "pipe",
          stderr: "pipe"
        })
        const exitCode = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "still running" as const)])
        const elapsedMs = Date.now() - startedAt
        if (exitCode === "still running") proc.kill()
        expect(exitCode).toBe(1)
        expect(releases.length).toBeGreaterThan(0)
        expect(elapsedMs).toBeLessThan(5_000)
        expect(existsSync(receipt)).toBe(true)
        const report = JSON.parse(readFileSync(receipt, "utf8")) as { stamp: unknown; settle: { settleMs: number; waitedMs: number; settled: boolean }; checks: Array<{ label: string; status: string; detail: string }> }
        expect(report.stamp).toBeNull()
        expect(report.settle.settleMs).toBe(100)
        expect(report.settle.settled).toBe(false)
        expect(report.settle.waitedMs).toBeLessThan(1_000)
        expect(report.checks[0]).toEqual({ label: "the deployment carries a build stamp", status: "FAIL", detail: expect.stringContaining("no complete answer within") })
      } finally {
        for (const release of releases) release()
        server.stop(true)
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test("--settle-ms 0 grades the first read, the behaviour before the window existed", async () => {
    const result = await runProbe(1, ["--settle-ms", "0"])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).not.toContain("propagation window closed")
    expect(result.elapsedMs).toBeLessThan(5_000)
  })
})
