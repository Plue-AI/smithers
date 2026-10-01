/*
 * Half one of the flow-graph e2e stack: the gateway, and the relay in front of
 * it.
 *
 * Run `bun scripts/flow-graph-e2e-host.ts` instead of this file. That is the
 * one command; it starts this process, reads the URL printed below, and points
 * the local origin at it.
 *
 * Why two processes. `@smthrs/database` `NodeDatabase` refuses Bun, and the
 * local origin is a Bun server, so the gateway cannot live in the same process
 * as the thing that serves the SPA. This half runs under tsx/Node and holds:
 *
 *   - the bridged stack (`packages/smithers/test/BridgedEngineRun.ts`): a real
 *     control plane, a real engine over two SQLite files, and the
 *     `EngineJournalSupervisor` bridge a deployed host wires;
 *   - `NodeGateway` on a loopback port, behind a bearer this process mints;
 *   - a local stand-in for the box's flow route (`scripts/workerRelay.ts`,
 *     frames in `scripts/gatewayFrames.ts`), which holds that bearer.
 *
 * The relay answers `provision` as ready and `/api/user` as the scoped
 * test user, so nothing here needs a GitHub session, a Cloud workspace, or a
 * provider key. Both halves die with the command that started them.
 *
 * It also stands in for the two product routes the Worker serves beside the
 * RPC seam, because the app calls them on its own origin and the local origin
 * forwards both here (`src/bun/server.ts` PRODUCT_PROXY_PREFIXES):
 *
 *   - `GET /api/repos/{owner}/{repo}/contents[/path][?ref=]`, answered from
 *     the checkout this stack is running out of. The fixture flow is a file
 *     in this repository and a node record says which line of it the action
 *     was declared on, so the file a reader opens from a node is that real
 *     file. With `ref` it is the file AT that revision, read out of jj or
 *     git rather than off disk, which is what the Code tab asks for: the
 *     working tree moves, and this suite itself edits it;
 *   - `GET /api/repos/{owner}/{repo}/repository-jobs` and
 *     `GET /api/billing/balance`, the two routes a signed-in app reads on its
 *     own at boot. Left unanswered they were 404s, and the balance one put a
 *     red "Your balance couldn't be refreshed right now." toast over the page
 *     for the whole session. Both answer this stack's own truth below.
 *
 * `GET /api/repos` and `GET /api/harnesses` never arrive here: the local
 * origin proxies `/api/repos/` (with the slash) and nothing under
 * `/api/harnesses`, so both are its own 404 — the same answer the native
 * shell gives, because the local backend that served them was retired
 * (`apps/app/docs/LOCAL-BACKEND-RETIREMENT.md`). Neither is a failure the app
 * surfaces: `loadRepos` and `loadHarnesses` drop a non-ok answer in silence.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import { BILLING_BALANCE_PATH } from "@smthrs/rpc/AgentApiRoutes"
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import * as SyncServer from "@smthrs/sync/SyncServer"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { randomUUID } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { relayRpc, writeResponse } from "./workerRelay"
import { execFileSync } from "node:child_process"
import { repositoryRoot, stackWith } from "../../../packages/smithers/test/BridgedEngineRun.ts"
import { GRAPH_BOX, GRAPH_FLOW, GRAPH_REPO, GRAPH_SCHEDULE } from "../e2e/graph/workspace.ts"
import { AUTHENTICATED_USER_PATH } from "@smthrs/rpc/ApplicationAuth"
import { SCOPED_TEST_USER } from "../e2e/playwright/identity.ts"

/** The workspace name the app addresses this gateway by. */
export const REPO = GRAPH_REPO

/**
 * What this stack has ever charged the scoped test user: nothing.
 *
 * The app reads the balance on its own as soon as a session answers signed-in
 * (`state/controller/auth-billing.ts` `refreshBalanceSilently`), and any
 * answer that is not a well-formed 200 raises a failure toast that stays up
 * until it is dismissed. So the relay answers, and what it answers is the
 * truth about this host: there is no billing service behind it, no provider
 * key, and nothing it runs costs money, so the account holds nothing, has
 * never been charged, and no launch is gated on dollars it does not need.
 * `allowedToStartWork` is the one field a launch reads
 * (`state/controller/workflows.ts` `zeroBalanceGuard`).
 */
const BALANCE = {
  user: SCOPED_TEST_USER.login,
  state: "empty",
  allowedToStartWork: true,
  balance: { totalUsd: "0", totalNanos: 0, lifetimeChargedUsd: "0", chargeCount: 0 },
  credits: []
} as const

/**
 * The bearer the relay holds and the browser never can.
 *
 * One per process and never written down: a stack that outlives this process
 * is a stack nothing here started.
 */
const CREDENTIAL = randomUUID()

const served = NodeGateway.layer(
  { workspaceHash: "flow-graph", gatewayId: "flow-graph-gateway", protocolVersion: "1", version: "1.0.0-rc.0" },
  { host: "127.0.0.1", port: 0, credential: CREDENTIAL }
).pipe(
  Layer.provideMerge(Layer.merge(SyncServer.layer, SyncAuth.layer)),
  Layer.provideMerge(stackWith({ authoring: true })),
  Layer.provideMerge(NodeCrypto.layer)
)

const json = (response: import("node:http").ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

/** The contents route's address: owner, repository, and the path inside it. */
const CONTENTS = /^\/api\/repos\/([^/]+)\/([^/]+)\/contents(?:\/(.*))?$/

/**
 * One path inside the repository, or nothing.
 *
 * A caller's path is spent on a file read, so it is checked the way the app
 * checks it before spending one on a URL (`FilesSeam.unsafePath`): a `.` or
 * `..` segment, an absolute path and a backslash are all refused, and the
 * resolved target must still be under the root. Refused is `undefined`, which
 * the caller answers as not found: a traversal is not a file, and naming it
 * would say which files exist outside the repository.
 */
export const insideRepository = (root: string, path: string): string | undefined => {
  const decoded = path.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return undefined
    }
  })
  if (decoded.some((segment) => segment === undefined)) return undefined
  const segments = decoded as ReadonlyArray<string>
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\u0000"))) {
    return undefined
  }
  const target = resolve(root, segments.filter((segment) => segment !== "").join("/"))
  return target === root || target.startsWith(`${root}/`) ? target : undefined
}

/**
 * One file as a revision holds it, or nothing.
 *
 * jj first, because it is what can name a working copy: `jj log -r @` commits
 * the tree on every command, so the revision a host records is usually a
 * working-copy commit that only jj holds. A checkout served by git alone
 * records a git commit, which `git show` reads. Either tool failing — a
 * revision it does not have, a path not in it, no tool at all — is nothing,
 * and the caller answers not found.
 *
 * The revision is checked before either tool is spawned, for the reason the
 * path is (`insideRepository`): it arrives on a URL. `git show <rev>:<path>`
 * joins it into ONE argument, so a revision beginning with `-` is read by git
 * as an option — `--output=<file>` writes a file — and this route is reachable
 * from the page under test. Every revision a host records is an object id
 * (`SourceRevision.objectId`), so anything that is not one is refused here and
 * answered as not found at that revision, which is what it is.
 */
export const fileAtRevision = (revision: string, path: string): Buffer | undefined => {
  if (!/^[0-9a-f]{7,64}$/.test(revision)) return undefined
  const read = (file: string, args: ReadonlyArray<string>): Buffer | undefined => {
    try {
      return execFileSync(file, [...args], {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024
      })
    } catch {
      return undefined
    }
  }
  return read("jj", ["file", "show", "-r", revision, "--", path]) ?? read("git", ["show", `${revision}:${path}`])
}

/**
 * The contents route, answered from the checkout this stack runs out of.
 *
 * The Worker's own route answers GitHub: an array of `{name, path, type}` for
 * a directory, and one `{path, content, encoding, size, type}` record for a
 * file, whose content is base64. This answers the same two shapes from disk,
 * because the repository the fixture's flow is declared in is the repository
 * this process is running from, and a node record names the file and the line
 * it was declared at. A path that is not there is a 404, which is what "this
 * mirror holds no such file" already means to every reader of the route.
 */
const contents = async (repo: string, path: string, ref?: string): Promise<{ status: number; body: unknown }> => {
  if (repo !== REPO) {
    return { status: 404, body: { status: "error", code: "not_found", message: `No repository ${repo}.` } }
  }
  const target = insideRepository(repositoryRoot, path)
  const missing = { status: 404, body: { status: "error", code: "not_found", message: `No ${path} in ${repo}.` } }
  if (target === undefined) return missing
  /*
   * A read AT a revision, which is what the graph drawer's Code tab asks for
   * (D-068): the bytes the version control system holds at that revision, and
   * never the ones on disk. The working tree moves — the suite itself edits
   * this checkout — and answering from it would label bytes nobody recorded
   * as the source a node was keyed or driven from. A revision this checkout
   * cannot read is not found, at that revision, which is what it is.
   */
  if (ref !== undefined) {
    const bytes = fileAtRevision(ref, path)
    return bytes === undefined
      ? { status: 404, body: { status: "error", code: "not_found", message: `No ${path} in ${repo} at ${ref}.` } }
      : {
        status: 200,
        body: { path, type: "file", size: bytes.byteLength, encoding: "base64", content: bytes.toString("base64") }
      }
  }
  const found = await stat(target).catch(() => undefined)
  if (found === undefined) return missing
  if (found.isDirectory()) {
    const entries = await readdir(target, { withFileTypes: true })
    return {
      status: 200,
      body: entries.map((entry) => ({
        name: entry.name,
        path: path === "" ? entry.name : `${path}/${entry.name}`,
        type: entry.isDirectory() ? "dir" : "file"
      }))
    }
  }
  if (!found.isFile()) return missing
  const bytes = await readFile(target)
  return {
    status: 200,
    body: { path, type: "file", size: bytes.byteLength, encoding: "base64", content: bytes.toString("base64") }
  }
}

/**
 * The box's flow route, stood in locally: the procedure set production
 * relays, the gateway frames, and the credential the browser cannot hold.
 *
 * Shared with `gateway-run-proof.ts`. An unregistered procedure is refused,
 * so a spec cannot reach a procedure production would not relay.
 */
const startRelay = (gatewayUrl: string): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise((listening) => {
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        // Every rejection is answered. A malformed body or a refused upstream
        // fetch is an unhandled rejection otherwise, which takes the whole
        // gateway process down and leaves the host serving a dead relay.
        void (async () => {
          try {
            const url = new URL(request.url ?? "/", "http://relay.local")
            if (url.pathname === AUTHENTICATED_USER_PATH) return json(response, 200, { id: 1, username: SCOPED_TEST_USER.login, is_admin: false })
            if (url.pathname === "/api/auth/scopes") return json(response, 200, { scopes: [] })
            if (url.pathname === "/api/workflow/provision") {
              return json(response, 200, { status: "ready", repo: REPO })
            }
            if (url.pathname === BILLING_BALANCE_PATH) return json(response, 200, BALANCE)
            // The current backend schedule listing consumed by TriggersSeam.
            const jobs = /^\/api\/repos\/([^/]+)\/([^/]+)\/repository-jobs$/.exec(url.pathname)
            if (jobs !== null) {
              const repo = `${decodeURIComponent(jobs[1]!)}/${decodeURIComponent(jobs[2]!)}`
              const next = new Date()
              next.setUTCHours(3, 0, 0, 0)
              if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1)
              return json(response, 200, repo !== REPO ? [] : [{
                id: GRAPH_SCHEDULE.id, job: `flow:${GRAPH_SCHEDULE.slug}`, flow_id: GRAPH_FLOW,
                schedule: GRAPH_SCHEDULE.cron, enabled: true, next_fire_at: next.toISOString()
              }])
            }
            // The one box of the repository: every flow call names it.
            if (url.pathname === "/api/user/workspaces") {
              const [owner, name] = REPO.split("/")
              return json(response, 200, { workspaces: [{ workspace_id: GRAPH_BOX, repository_owner: owner, repository_name: name,
                workspace_title: "Graph", state: "running", created_at: null }], total: 1 })
            }
            const addressed = CONTENTS.exec(url.pathname)
            if (addressed !== null) {
              const asked = url.searchParams.get("ref")
              const answer = await contents(
                `${decodeURIComponent(addressed[1]!)}/${decodeURIComponent(addressed[2]!)}`,
                addressed[3] ?? "",
                asked === null ? undefined : asked
              )
              return json(response, answer.status, answer.body)
            }
            if (url.pathname !== "/api/workflow/rpc") {
              return json(response, 404, { status: "error", message: `The relay has no route for ${url.pathname}.` })
            }
            await writeResponse(await relayRpc(new Request(url, { method: "POST", body: Buffer.concat(chunks).toString("utf8") }), gatewayUrl, CREDENTIAL), response)
          } catch (error) {
            json(response, 502, { status: "error", message: String(error) })
          }
        })()
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("the relay took no address")
      listening({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) })
    })
  })

const program = Effect.gen(function*() {
  const address = (yield* HttpServer.HttpServer).address
  if (address._tag !== "InetAddressV4" && address._tag !== "InetAddressV6") {
    return yield* Effect.die("the gateway bound a unix socket, which the relay cannot reach")
  }
  const relay = yield* Effect.promise(() => startRelay(`http://127.0.0.1:${address.port}`))
  yield* Effect.addFinalizer(() => Effect.promise(relay.close))
  // The host reads this line. One JSON object, one line, nothing before it that
  // a parser has to skip.
  console.log(JSON.stringify({ relayUrl: relay.url, repo: REPO }))
  // Hold the stack open until this process is killed. The host owns that:
  // `flow-graph-e2e-host.ts` kills this child when it stops.
  yield* Effect.never
}).pipe(Effect.provide(served), Effect.scoped)

// `runMain` interrupts the program on SIGINT and SIGTERM rather than exiting
// under it. That is what closes the scope: `process.exit` inside a signal
// handler skips every finalizer, and `BridgedEngineRun`'s database directory is
// one of them, so each run of this command would leave a
// `$TMPDIR/smthrs-flow-graph-*` holding `control.db` and `engine.db` behind.
NodeRuntime.runMain(program)
