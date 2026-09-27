import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { relayFetch } from "../RelayFetch"
import { GRAPH_BOX } from "../workspace"
import * as SourceRevision from "../../../../../packages/smithers/src/internal/SourceRevision.ts"

const APP_DIR = fileURLToPath(new URL("../../../", import.meta.url))

/** The fixture flow's own file, repo-relative: what the contents route is asked for below. */
const FIXTURE_SOURCE = "packages/smithers/test/BridgedEngineRun.ts"

/**
 * The database directories the bridged stack made, inside one scratch TMPDIR.
 *
 * `BridgedEngineRun`'s `databaseDirectory` is an `Effect.acquireRelease` over
 * `mkdtemp(tmpdir(), "smthrs-flow-graph-")`, and `os.tmpdir()` reads `TMPDIR`,
 * so a child given its own `TMPDIR` can be watched without touching the
 * machine's.
 */
const stacks = (root: string): ReadonlyArray<string> =>
  readdirSync(root).filter((entry) => entry.startsWith("smthrs-flow-graph-"))

/** Reads the child's stdout until its first newline, which is the address line. */
const addressLine = async (child: Bun.Subprocess<"ignore", "pipe", "inherit">): Promise<string> => {
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error("the gateway exited before it printed an address")
    buffered += decoder.decode(chunk.value, { stream: true })
    const newline = buffered.indexOf("\n")
    if (newline >= 0) {
      reader.releaseLock()
      return buffered.slice(0, newline)
    }
  }
}

test("the gateway answers a malformed relay call and removes its SQLite directory when it is stopped", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-graph-gateway-stop-"))
  const child = Bun.spawn(["node", "--import", import.meta.resolve("tsx"), "scripts/flow-graph-e2e-gateway.mts"], {
    cwd: APP_DIR,
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, TMPDIR: root }
  })
  try {
    const address = JSON.parse(await addressLine(child)) as { relayUrl: string; repo: string }
    const request = relayFetch(address.relayUrl, fetch)
    expect(address.repo).toBe("codeplanesmithers/smithers-demo")
    // The address line means the stack is up, so `control.db` and `engine.db`
    // are on disk under this TMPDIR.
    expect(stacks(root)).toHaveLength(1)

    // A body the relay cannot parse is one refused call, not an unhandled
    // rejection that takes the process down and leaves the host in front of a
    // dead relay.
    const refused = await request(`${address.relayUrl}/api/workflow/rpc`, { method: "POST", body: "{not json" })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ status: "error", code: "request_body_not_json" })
    const inherited = await request(`${address.relayUrl}/api/workflow/rpc`, { method: "POST", body: JSON.stringify({ repo: address.repo, procedure: "constructor", workspaceId: GRAPH_BOX }) })
    expect(inherited.status).toBe(400)
    expect(await inherited.json()).toMatchObject({ code: "procedure_not_relayed" })
    // A call that names no box is refused before it reaches the gateway.
    const boxless = await request(`${address.relayUrl}/api/workflow/rpc`, { method: "POST", body: JSON.stringify({ repo: address.repo, procedure: "List", payload: { _tag: "flows" } }) })
    expect(boxless.status).toBe(400)
    expect(await boxless.json()).toMatchObject({ code: "request_invalid" })
    const alive = await request(`${address.relayUrl}/api/workflow/provision`, { method: "POST", body: "{}" })
    expect(alive.status).toBe(200)
    // The Bun origin must not retain a Node relay socket that can expire
    // between choosing it from the pool and sending the next provision call.
    expect(alive.headers.get("connection")).toBe("close")
    expect(await alive.json()).toEqual({ status: "ready", repo: address.repo })

    // The repository's one box, and its one registered schedule, the way
    // Smithers Cloud lists them.
    const boxes = await request(`${address.relayUrl}/api/user/workspaces`)
    expect(boxes.status).toBe(200)
    expect((await boxes.json() as { workspaces: ReadonlyArray<{ workspace_id: string; state: string }> }).workspaces)
      .toEqual([expect.objectContaining({ workspace_id: GRAPH_BOX, state: "running" })])
    const listed = await request(
      `${address.relayUrl}/api/workflow/trigger-registrations?repo=${encodeURIComponent(address.repo)}`
    )
    expect(listed.status).toBe(200)
    const registered = await listed.json() as { rows: ReadonlyArray<{ registrationId: string; flowId: string; schedule: string }> }
    expect(registered.rows.map((row) => row.registrationId)).toEqual(["graph-fixture-nightly"])
    expect(registered.rows[0]?.flowId).toBe("gateway/GraphFixture")
    expect(registered.rows[0]?.schedule).toBe("0 3 * * *")

    // The contents route, answered from the checkout this stack runs out of.
    // The fixture flow is a real file, and a node record names the line its
    // action was declared on, so the reader who opens one gets that line.
    const file = await request(`${address.relayUrl}/api/repos/${address.repo}/contents/${FIXTURE_SOURCE}`)
    expect(file.status).toBe(200)
    const read = await file.json() as { encoding: string; content: string; type: string }
    expect(read.type).toBe("file")
    expect(read.encoding).toBe("base64")
    const source = Buffer.from(read.content, "base64").toString("utf8")
    /*
     * The checkout is the oracle, because serving the checkout's own bytes is
     * the whole of this route's contract. This used to read one hand-counted
     * line index into a file this same stack edits, and a docblock added above
     * that declaration silently moved it: the assertion was measuring the
     * fixture's line numbering, not the route. Equality catches what an index
     * catches and what it cannot — a different path, a mirror's copy, a
     * truncation, a re-encoding. WHICH line a reader lands on is proven end to
     * end in `e2e/graph/flow-graph.spec.ts`, against the line the engine
     * really recorded rather than one counted by hand.
     */
    expect(source).toBe(readFileSync(join(APP_DIR, "../..", FIXTURE_SOURCE), "utf8"))
    expect(source).toContain(`Action.make("gateway/graph/Steady"`)

    // A directory answers the listing shape, and a path climbing out of the
    // repository is not found: a traversal is not a file, and naming it would
    // say which files exist outside the checkout.
    const directory = await request(`${address.relayUrl}/api/repos/${address.repo}/contents/apps`)
    expect(directory.status).toBe(200)
    expect((await directory.json() as ReadonlyArray<{ name: string }>).some((entry) => entry.name === "app")).toBe(true)
    const escaped = await request(
      `${address.relayUrl}/api/repos/${address.repo}/contents/..%2F..%2Fetc%2Fpasswd`
    )
    expect(escaped.status).toBe(404)
    const foreign = await request(`${address.relayUrl}/api/repos/someone/else/contents/package.json`)
    expect(foreign.status).toBe(404)

    /*
     * D-068: the same route AT a revision. A path says where a file is and
     * never which bytes were there — this checkout moves, and this suite
     * edits it — so the Code tab asks for the revision the plan or the
     * journal recorded, and the route answers out of version control rather
     * than off disk.
     *
     * The probe is a file of this test's own, so nothing tracked is edited
     * and a killed test leaves no dirty source behind.
     */
    const probe = "flow-graph-revision-probe.txt"
    const probePath = join(APP_DIR, "../..", probe)
    writeFileSync(probePath, "before\n")
    try {
      const revision = await Effect.runPromise(SourceRevision.read(join(APP_DIR, "../..")))
      const at = (ref: string) =>
        request(`${address.relayUrl}/api/repos/${address.repo}/contents/${probe}?ref=${encodeURIComponent(ref)}`)
      if (revision === undefined) {
        /*
         * A checkout that can name no revision — git with work no commit
         * holds, or no version control at all — has no bytes to serve at
         * one, and says so rather than answering with the working tree's.
         * A host in this state records no revision either, so the Code tab
         * is absent and nobody asks (`state/controller/graph.ts`).
         */
        expect((await at("a".repeat(40))).status).toBe(404)
      } else {
        const bound = await at(revision)
        expect(bound.status).toBe(200)
        const before = await bound.json() as { content: string; encoding: string }
        expect(Buffer.from(before.content, "base64").toString("utf8")).toBe("before\n")

        // The working tree moves on. The revision does not.
        writeFileSync(probePath, "after\n")
        const again = await at(revision)
        expect(again.status).toBe(200)
        expect(Buffer.from((await again.json() as { content: string }).content, "base64").toString("utf8"))
          .toBe("before\n")
        // And the same route without a revision is the working tree, which is
        // exactly why the Code tab does not use it.
        const live = await request(`${address.relayUrl}/api/repos/${address.repo}/contents/${probe}`)
        expect(Buffer.from((await live.json() as { content: string }).content, "base64").toString("utf8"))
          .toBe("after\n")
        // A revision this checkout does not hold is not found, never the tree.
        expect((await at("f".repeat(40))).status).toBe(404)
        /*
         * And only an object id is a revision here. `@` is a revset jj
         * resolves — to the working copy, which is the tree this route exists
         * to not answer from — and `git show` takes `<rev>:<path>` as ONE
         * argument, so a `-` in front reaches git as a flag (`--output=`
         * writes a file). This ref arrives on a URL, so it is checked for the
         * shape every recorded revision has before either tool is spawned.
         */
        expect((await at("@")).status).toBe(404)
        expect((await at(`--output=${join(APP_DIR, "../..", "flow-graph-ref-injection")}`)).status).toBe(404)
      }
    } finally {
      rmSync(probePath, { force: true })
    }

    child.kill()
    await child.exited
    // The signal has to interrupt the program so the scope closes. A
    // `process.exit` under it skips every finalizer and leaves both databases
    // behind, once per run of the one command this script backs.
    //
    // The direct Node child exits only after its Effect scope has closed.
    expect(stacks(root)).toEqual([])
  } finally {
    child.kill()
    rmSync(root, { recursive: true, force: true })
  }
}, 180_000)
