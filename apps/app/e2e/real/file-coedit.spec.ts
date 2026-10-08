import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import type { Locator, Page } from "@playwright/test"
import { test, awaitBoot } from "./support"
import { scenario } from "./coverage/types"
import { withReference, required, runSlash, realApi, expect, attachJson } from "./todo/reference"
import { journeyActivate, journeyReach } from "./support/keyboard-journey-input"

const execute = promisify(execFile)
const cardFor = (page: Page, path: string) => page.locator(`[data-kind="file"][aria-label="${path}"]`).last()
// Read CodeMirror's complete document, including virtualized lines. This is
// observation only: all changes enter through native keyboard input.
const text = (card: Locator) => card.locator(".cm-content").first().evaluate(element => {
  const view = (element as HTMLElement & { cmTile?: { root: { view: { state: { doc: { toString(): string } } } } } }).cmTile?.root.view
  if (!view) throw new Error("Mounted CodeMirror missing")
  return view.state.doc.toString()
})
const ssh = async (operation: string) => {
  const host = required("SMITHERS_OUTSIDE_SSH_HOST"), port = required("SMITHERS_OUTSIDE_SSH_PORT")
  if (host.startsWith("-") || !/^\d+$/.test(port)) throw new Error("Invalid guest SSH destination")
  return (await execute("ssh", ["-o", "BatchMode=yes", "-p", port, host, operation], { timeout: 30_000 })).stdout
}

// Qualification daemon stderr is captured by the operator as this guest-user
// readable file; the test attaches actual merge decisions and session sets.
const mergeEvidence = async () => {
  const path = required("SMITHERS_COEDIT_MERGE_LOG")
  if (!/^\/(?:tmp|var\/lib\/smithers)\/[a-zA-Z0-9_./-]+$/.test(path) || path.split("/").includes("..")) throw new Error("Expected the qualification daemon log inside the guest")
  const log = await ssh(`cat '${path}'`)
  const records = log.split("\n").flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } }) as Record<string, unknown>[]
  const merges = records.filter(row => row.event === "doc-merge" && row.path === "retry.ts")
  expect(merges.length).toBeGreaterThan(0)
  for (const merge of merges) {
    for (const key of ["base", "ours", "theirs"]) expect(merge[key]).toMatch(/^[a-f0-9]{64}$/)
    expect(typeof merge.overlap).toBe("boolean")
    expect(records.some(row => row.event === "doc-outside-version" && row.version === merge.version && Array.isArray(row.session_set))).toBe(true)
  }
  return { log, merges }
}

// A prepared canary on the reference Mac; never activates a normal install,
// replaces /api/live, seeds a browser provider or writes to GitHub. The test
// composition alone enables LiveCodeDocuments after T-COL-08 qualification.
test("C-J3-04: mounted File cards co-edit 1,000 characters, recover and follow guest changes", scenario("file.coedit", {
  capabilities: ["install", "ssh"], coverage: ["action:file", "action:file.compare", "action:file.restore-deleted", "action:file.follow-rename",
    "door:slash", "door:button", "path:success", "path:persistence", "dimension:recovery", "surface:file-card", "host:local", "host:production"]
}), async ({ browser }, info) => {
  test.setTimeout(600_000)
  await withReference(browser, info, async f => {
    const branch = required("SMITHERS_OUTSIDE_BRANCH")
    const pages = [f.members.Ben.page, f.members.Alice.page]
    const path = "retry.ts"
    const open = async (page: Page, name = path) => {
      await runSlash(page, `/file ${JSON.stringify({ branch, path: name })}`)
      const card = cardFor(page, name)
      await expect(card).toBeVisible()
      return card
    }
    const cards = [await open(pages[0]!), await open(pages[1]!)]
    for (const card of cards) await expect(card).toHaveAttribute("data-mode", "live")
    const original = await ssh("cat retry.ts")
    expect(original.split("\n").length).toBeGreaterThanOrEqual(80)
    expect(await text(cards[0]!)).toBe(original)
    let terminalTranscript = ""
    const frameLog: { socket: string; direction: string; bytes: number; at: number }[] = []
    const documentSockets = new Set<string>()
    for (const page of pages) {
      page.on("websocket", socket => {
        if (socket.url().includes("/terminal")) socket.on("framereceived", frame => { terminalTranscript += typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8") })
      })
      // The shared socket predates the journey body. DevTools observes its
      // existing frames; page.on("websocket") would miss that connection.
      const network = await page.context().newCDPSession(page)
      await network.send("Network.enable")
      const record = (direction: string, event: {requestId:string;response:{opcode:number;payloadData:string}}) => {
        const frame = event.response
        if (frame.opcode === 1) {
          try { const reply = JSON.parse(frame.payloadData); if (reply.t === "saved" || reply.t === "authors" || (reply.t === "snap" && reply.data?.epoch)) documentSockets.add(event.requestId) } catch { /* Other socket text is not a document receipt. */ }
        }
        frameLog.push({socket:event.requestId,direction,bytes:frame.opcode === 1 ? Buffer.byteLength(frame.payloadData) : Buffer.from(frame.payloadData,"base64").length,at:performance.now()})
      }
      network.on("Network.webSocketFrameSent", event => { record("sent", event) })
      network.on("Network.webSocketFrameReceived", event => { record("received", event) })
    }
    await runSlash(pages[0]!, `/terminal ${branch}`)
    const terminalRead = async () => {
      const field = pages[0]!.locator('.terminal-view .xterm-helper-textarea').last()
      await journeyReach(field)
      await pages[0]!.keyboard.type("cat retry.ts")
      await pages[0]!.keyboard.press("Enter")
      await expect.poll(() => terminalTranscript).toContain("retry.ts")
    }
    const samples: { character: string; sent: number; arrived: number; ms: number }[] = []
    const waiting = new Map<string, { receiver: Page; sent: number; done: () => void }>()
    for (const page of pages) {
      await page.exposeBinding("fileCharacterArrived", (_source, character: string) => {
        const pending = waiting.get(character)
        if (!pending || pending.receiver !== page) return
        waiting.delete(character)
        const arrived = performance.now()
        samples.push({ character, sent: pending.sent, arrived, ms: arrived - pending.sent })
        pending.done()
      })
      await page.evaluate(() => {
        const seen = new Set<string>()
        // Observe the full mounted document even when the peer's line is
        // outside CodeMirror's virtualized viewport. This only reads state.
        setInterval(() => {
          const element = document.querySelector('.cm-content') as (HTMLElement & {
            cmTile?: { root: { view: { state: { doc: { toString(): string } } } } }
          }) | null
          for (const character of element?.cmTile?.root.view.state.doc.toString() ?? "") {
            const code = character.charCodeAt(0)
            if (code < 0xe000 || code >= 0xe3e8 || seen.has(character)) continue
            seen.add(character)
            void (window as unknown as { fileCharacterArrived: (value: string) => Promise<void> }).fileCharacterArrived(character)
          }
        }, 10)
      })
    }
    // Two independent input sequences, unique per-character markers. The
    // monotonic runner includes browser-to-runner transport in the latency.
    await Promise.all(pages.map(async (page, index) => {
      await journeyReach(cards[index]!.locator('.cm-content').first())
      const moveTo = async (line: number) => {
        await page.keyboard.press("ControlOrMeta+Home")
        for (let n = 1; n < line; n++) await page.keyboard.press("ArrowDown")
        await page.keyboard.press("Home")
      }
      await moveTo(index ? 40 : 12)
      for (let n = 0; n < 500; n++) {
        if (n === 200) await moveTo(20)
        if (n === 250) await moveTo(index ? 40 : 12)
        const character = String.fromCharCode(0xe000 + index * 500 + n)
        let done!: () => void
        const received = new Promise<void>(resolve => { done = resolve })
        const started = performance.now()
        waiting.set(character, { receiver: pages[1 - index]!, sent: started, done })
        await page.keyboard.insertText(character)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Peer missed character ${character.charCodeAt(0)}`)), 5000)
          void received.then(() => { clearTimeout(timer); resolve() })
        })
        // First 200 per member are the C-J3-04 8-per-second samples.
        if (n < 200) await new Promise(resolve => setTimeout(resolve, Math.max(0, 125 - (performance.now() - started))))
      }
    }))
    expect(samples).toHaveLength(1000)
    const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b)
    expect(sorted[949]!).toBeLessThan(1000)
    const paced = samples.filter(sample => { const n = sample.character.charCodeAt(0) - 0xe000; return n < 200 || (n >= 500 && n < 700) }).map(sample => sample.ms).sort((a, b) => a - b)
    expect(paced).toHaveLength(400)
    expect(paced[379]!).toBeLessThan(1000)
    await expect.poll(async () => (await text(cards[0]!)) === (await text(cards[1]!))).toBe(true)
    const converged = await text(cards[0]!)
    for (let n = 0; n < 1000; n++) expect(converged.split(String.fromCharCode(0xe000 + n)).length - 1).toBe(1)
    // Put both remote name flags and coloured overlapping runs in the
    // viewport before inspecting visuals; offscreen gutters are virtualized.
    await Promise.all(pages.map(async (page, index) => {
      await journeyReach(cards[index]!.locator('.cm-content').first())
      await page.keyboard.press("ControlOrMeta+Home")
      for (let line = 1; line < 20; line++) await page.keyboard.press("ArrowDown")
    }))
    for (let index = 0; index < cards.length; index++) {
      const card = cards[index]!
      await expect(card.locator('.code-saved')).toHaveText("Saved to the machine", { timeout: 1000 })
      await expect(card.locator('.code-author[title*="Ben"]').first()).toBeVisible()
      await expect(card.locator('.code-author[title*="Alice"]').first()).toBeVisible()
      await expect(card.locator('.code-name-flag').first()).toContainText(index ? "Ben" : "Alice")
      // M-43 supersedes C-J3-04's older no-caret sentence.
      await expect(card.locator('.cm-ySelectionCaret').first()).toBeVisible()
    }
    expect(await ssh("cat retry.ts")).toBe(converged)
    await terminalRead()
    // Own-edits Undo keeps the other member's edit. End the benchmark's
    // capture group before making the separate Undo canary.
    await new Promise(resolve => setTimeout(resolve, 600))
    await journeyReach(cards[0]!.locator('.cm-content').first())
    await pages[0]!.keyboard.press("ControlOrMeta+End")
    await pages[0]!.keyboard.insertText("BEN_UNDO_CANARY")
    await expect.poll(() => text(cards[1]!)).toContain("BEN_UNDO_CANARY")
    await journeyReach(cards[1]!.locator('.cm-content').first())
    await pages[1]!.keyboard.press("ControlOrMeta+End")
    await pages[1]!.keyboard.insertText("ALICE_KEEP_CANARY")
    await expect.poll(() => text(cards[0]!)).toContain("ALICE_KEEP_CANARY")
    await journeyReach(cards[0]!.locator('.cm-content').first())
    await pages[0]!.keyboard.press("ControlOrMeta+z")
    await expect.poll(() => text(cards[1]!)).not.toContain("BEN_UNDO_CANARY")
    expect(await text(cards[0]!)).toContain("ALICE_KEEP_CANARY")
    // Reconnect without reload: code's pending updates are intentionally in memory.
    await f.members.Ben.context.setOffline(true)
    await pages[0]!.keyboard.press("ControlOrMeta+End")
    await pages[0]!.keyboard.insertText("OFFLINE_PENDING_CANARY")
    await expect(cards[0]!.locator('.code-saved')).not.toHaveText("Saved to the machine")
    await f.members.Ben.context.setOffline(false)
    await expect.poll(() => text(cards[1]!), { timeout: 30_000 }).toContain("OFFLINE_PENDING_CANARY")
    // Outside saves execute as Maya inside the branch guest.
    await ssh("printf '\n// MAYA_SSH_CANARY\n' >> retry.ts")
    for (const card of cards) await expect.poll(() => text(card), { timeout: 1000 }).toContain("MAYA_SSH_CANARY")
    await journeyReach(cards[1]!.locator('.cm-content').first())
    await pages[1]!.keyboard.press("ControlOrMeta+Home")
    await pages[1]!.keyboard.insertText("ALICE_OVERLAP_CANARY")
    await ssh("sed -i '1s/^/MAYA_OVERLAP_CANARY/' retry.ts")
    await expect(cards[1]!).toContainText("Changed outside Smithers")
    await journeyActivate(cards[1]!.getByRole("button", { name: "Compare", exact: true }))
    await expect(cards[1]!.locator('.code-file-outside')).toContainText("MAYA_OVERLAP_CANARY")
    await expect(cards[1]!.locator('.code-file-current')).toContainText("ALICE_OVERLAP_CANARY")
    const beforeRestart = await ssh("cat retry.ts")
    await execute(required("SMITHERS_JOURNEY_SMTHRS"), ["host", "stop"], { timeout: 30_000 })
    await execute(required("SMITHERS_JOURNEY_SMTHRS"), ["host", "start"], { timeout: 60_000 })
    await expect.poll(() => ssh("cat retry.ts"), { timeout: 60_000 }).toBe(beforeRestart)
    await expect(cards[0]!.locator('.code-saved')).toHaveText("Saved to the machine", { timeout: 30_000 })
    await terminalRead()
    await ssh("rm retry.ts")
    await expect(cards[0]!).toContainText("Deleted by")
    await journeyActivate(cards[0]!.getByRole("button", { name: "Restore", exact: true }))
    await expect.poll(() => ssh("cat retry.ts")).toBe(beforeRestart)
    await ssh("mv retry.ts followed.ts")
    await expect(cards[0]!).toContainText("Renamed to")
    await journeyActivate(cards[0]!.getByRole("button", { name: "Follow", exact: true }))
    await expect(cardFor(pages[0]!, "followed.ts")).toHaveAttribute("data-mode", "live")
    expect(await text(cardFor(pages[0]!, "followed.ts"))).toBe(beforeRestart)
    await ssh("mv followed.ts retry.ts")
    for (const name of ["big.json", "logo.png"]) {
      const card = await open(pages[0]!, name)
      await expect(card).toHaveAttribute("data-mode", "read_only")
      await expect(card.locator('[contenteditable="true"]')).toHaveCount(0)
    }
    // Leaving both app documents unmounts every card and releases every
    // document subscription. Reopen
    // after the daemon's 60-second close deadline, rather than just reloading.
    const retainedCard = await open(pages[1]!)
    await expect(retainedCard).toHaveAttribute("data-mode", "live")
    const revealAuthors = async (page: Page, card: Locator) => {
      await journeyReach(card.locator('.cm-content').first())
      await page.keyboard.press("ControlOrMeta+Home")
      for (let line = 1; line < 20; line++) await page.keyboard.press("ArrowDown")
      await expect(card.locator('.code-author[title*="Ben"]').first()).toBeVisible()
      await expect(card.locator('.code-author[title*="Alice"]').first()).toBeVisible()
      return card.locator('.code-author').evaluateAll(nodes => nodes.map(node => ({ title: node.getAttribute("title"), text: node.textContent })))
    }
    const authorsBefore = await revealAuthors(pages[1]!, retainedCard)
    const retainedText = await text(retainedCard), address = pages[1]!.url()
    await Promise.all(pages.map(page => page.goto("about:blank")))
    await new Promise(resolve => setTimeout(resolve, 61_000))
    const reopened = pages[1]!
    await reopened.goto(address); await awaitBoot(reopened)
    await pages[0]!.goto(address); await awaitBoot(pages[0]!)
    const reopenedCard = await open(reopened)
    await expect(reopenedCard).toHaveAttribute("data-mode", "live")
    expect(await text(reopenedCard)).toBe(retainedText)
    expect(await ssh("cat retry.ts")).toBe(retainedText)
    expect(await revealAuthors(reopened, reopenedCard)).toEqual(authorsBefore)
    await info.attach("terminal-transcript.txt", { body: terminalTranscript, contentType: "text/plain" })
    const documentFrames = frameLog.filter(frame => documentSockets.has(frame.socket))
    expect(documentFrames.length).toBeGreaterThan(1000)
    await attachJson(info, "doc-code-frame-log", documentFrames)
    await attachJson(info, "reopened-authors", { authorsBefore, retainedText })
    await attachJson(info, "daemon-merge-log", await mergeEvidence())
    await info.attach("keystrokes.csv", { body: "character,sent,arrived,ms\n" + samples.map(s => `${s.character.charCodeAt(0)},${s.sent},${s.arrived},${s.ms}`).join("\n"), contentType: "text/csv" })
    await attachJson(info, "file-coedit-texts", { converged, beforeRestart, sha256: createHash("sha256").update(beforeRestart).digest("hex"), samples: 1000, p95: sorted[949] })
  })
})

// Operator supplies argv for a reviewed fault in the scratch guest: stop the
// non-root daemon, remove only retry.ts's state record, then start it again.
// This is fault setup, never a fabricated epoch, provider or save receipt.
test("C-J3-04: recovered epoch retains typing until mounted Reapply or Copy succeeds", scenario("file.coedit.epoch", {
  capabilities: ["install", "ssh"], coverage: ["action:file", "action:file.reapply", "door:button", "path:persistence", "dimension:recovery", "surface:file-card", "host:local", "host:production"]
}), async ({ browser }, info) => {
  test.setTimeout(240_000)
  const fault: unknown = JSON.parse(required("SMITHERS_COEDIT_EPOCH_FAULT_ARGV"))
  if (!Array.isArray(fault) || fault[0] !== "ssh" || fault.length < 3 || !fault.every(value => typeof value === "string") ||
      fault.some(value => /\b(?:sudo|su|doas)\b|root@/.test(value))) {
    throw new Error("Epoch fault must be reviewed SSH argv executing as the non-root guest daemon user")
  }
  const argv = fault as string[]
  await withReference(browser, info, async f => {
    const branch = required("SMITHERS_OUTSIDE_BRANCH")
    const page = f.members.Ben.page, peer = f.members.Alice.page
    for (const member of [page, peer]) await runSlash(member, `/file ${JSON.stringify({ branch, path: "retry.ts" })}`)
    const card = cardFor(page, "retry.ts"), other = cardFor(peer, "retry.ts")
    await expect(card).toHaveAttribute("data-mode", "live")
    for (const [marker, action] of [["REAPPLY_PENDING_CANARY", "Reapply"], ["COPY_PENDING_CANARY", "Copy"]] as const) {
      await expect(card.locator('.code-saved')).toHaveText("Saved to the machine")
      const before = await ssh("cat retry.ts")
      await f.members.Ben.context.setOffline(true)
      await journeyReach(card.locator('.cm-content').first())
      await page.keyboard.press("ControlOrMeta+End")
      await page.keyboard.insertText(marker)
      await execute(argv[0]!, argv.slice(1), { timeout: 60_000 })
      await f.members.Ben.context.setOffline(false)
      await expect(card.locator('[data-tone="attention"]')).toContainText(/edit(?:s weren't| wasn't) saved/, { timeout: 30_000 })
      await expect(card.locator('[data-tone="attention"] pre')).toContainText(marker)
      expect(await ssh("cat retry.ts")).toBe(before)
      await expect(card).toHaveAttribute("data-mode", "read_only")
      if (action === "Copy") await f.members.Ben.context.grantPermissions(["clipboard-read", "clipboard-write"])
      await journeyActivate(card.getByRole("button", { name: action, exact: true }))
      if (action === "Reapply") {
        await expect.poll(() => text(other), { timeout: 30_000 }).toContain(marker)
        await expect(card.locator('.code-saved')).toHaveText("Saved to the machine")
        expect((await ssh("cat retry.ts")).split(marker).length - 1).toBe(1)
        await expect(card.locator('.code-author').last()).toBeVisible()
      } else {
        const copied = await page.evaluate(() => navigator.clipboard.readText())
        expect(copied).toContain(marker)
        expect(await ssh("cat retry.ts")).toBe(before)
        await attachJson(info, "copied-recovery", { text: copied })
      }
      await expect(card.locator('[data-tone="attention"]')).toHaveCount(0)
    }
  })
})

test("C-J3-04: forged actor and client ids cannot write as another member", scenario("file.coedit.forgery", {
  capabilities: ["install"], coverage: ["action:file", "door:slash", "path:permission", "surface:file-card", "host:local", "host:production"]
}), async ({ browser }, info) => {
  await withReference(browser, info, async f => {
    const topic = `doc:code:${required("SMITHERS_OUTSIDE_BRANCH")}:retry.ts`
    const assignments: number[] = []
    for (const page of [f.members.Ben.page, f.members.Alice.page]) {
      const client = await page.evaluate(async topic => await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/live`, "smithers.live.v1")
        ;(window as unknown as { forgerySocket: WebSocket }).forgerySocket = socket
        const timer = setTimeout(() => reject(new Error("No authenticated document assignment")), 5000)
        socket.onopen = () => socket.send(JSON.stringify({ t: "sub", id: 73, topic }))
        socket.onmessage = event => {
          if (typeof event.data !== "string") return
          const frame = JSON.parse(event.data)
          if (frame.t === "snap") { clearTimeout(timer); resolve(frame.data.client_id) }
          if (frame.t === "err") { clearTimeout(timer); reject(new Error(frame.code)) }
        }
      }), topic)
      assignments.push(client)
    }
    expect(assignments[0]).not.toBe(assignments[1])
    const Y = await import("yjs"), encoding = await import("lib0/encoding"), sync = await import("y-protocols/sync")
    const forged = new Y.Doc()
    forged.clientID = assignments[1]!
    forged.getText("content").insert(0, "FORGED_ALICE_MUST_NOT_APPEAR")
    const encoder = encoding.createEncoder()
    sync.writeUpdate(encoder, Y.encodeStateAsUpdate(forged))
    const payload = encoding.toUint8Array(encoder)
    const frame = new Uint8Array(payload.length + 5)
    frame[0] = 1; new DataView(frame.buffer).setUint32(1, 73); frame.set(payload, 5)
    const before = await ssh("cat retry.ts")
    await f.members.Ben.page.evaluate(bytes => {
      const socket = (window as unknown as { forgerySocket: WebSocket }).forgerySocket
      socket.send(Uint8Array.from(bytes))
    }, [...frame])
    // Follow the hostile input with a real mounted edit. Its acknowledged disk
    // receipt is an ordering barrier, stronger than waiting an arbitrary delay.
    await runSlash(f.members.Ben.page, `/file ${JSON.stringify({ branch: required("SMITHERS_OUTSIDE_BRANCH"), path: "retry.ts" })}`)
    const card = cardFor(f.members.Ben.page, "retry.ts")
    await expect(card).toHaveAttribute("data-mode", "live")
    await journeyReach(card.locator('.cm-content').first())
    await f.members.Ben.page.keyboard.press("ControlOrMeta+End")
    await f.members.Ben.page.keyboard.insertText("BEN_AFTER_FORGERY")
    await expect.poll(() => ssh("cat retry.ts")).toBe(before + "BEN_AFTER_FORGERY")
    expect(await text(card)).not.toContain("FORGED_ALICE_MUST_NOT_APPEAR")
    forged.destroy()
    await attachJson(info, "forged-client-refusal", { assignments, disk: await ssh("cat retry.ts") })
  })
})

// This destructive access canary runs last on a fresh scratch install. Removal
// is a person's registered command; the test never edits access tables.
test("C-J3-04: revoked File card cannot read, subscribe or keep editing", scenario("file.coedit.access", {
  capabilities: ["install"], coverage: ["action:file", "action:members.remove", "door:slash", "path:permission", "surface:file-card", "host:local", "host:production"]
}), async ({ browser }, info) => {
  await withReference(browser, info, async f => {
    const branch = required("SMITHERS_OUTSIDE_BRANCH")
    const alice = f.members.Alice.page, owner = f.members.Will.page
    // A fourth signed-in team member deliberately has no branch grant. A
    // revoked repository member alone cannot prove branch-specific admission.
    const deniedContext = await browser.newContext({ baseURL: required("SMITHERS_REAL_BASE_URL"),
      storageState: required("SMITHERS_JOURNEY_NO_BRANCH_SESSION") })
    try {
      const denied = await deniedContext.newPage()
      await denied.goto(`/${f.repo}`); await awaitBoot(denied)
      const identity = await realApi(denied, deniedContext.request, "GET", "/api/user")
      expect(identity.status()).toBe(200)
      const read = await realApi(denied, deniedContext.request, "GET", `/api/branches/${encodeURIComponent(branch)}/files/retry.ts`)
      expect(read.status()).toBe(403)
      await runSlash(denied, `/file ${JSON.stringify({ branch, path: "retry.ts" })}`)
      await expect(denied.locator('[data-kind="file"][data-mode="live"]')).toHaveCount(0)
      const subscribed = await denied.evaluate(async topic => await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/live`, "smithers.live.v1")
        const timer = setTimeout(() => { socket.close(); reject(new Error("Branch denial was not enforced")) }, 5000)
        socket.onopen = () => socket.send(JSON.stringify({ t: "sub", id: 91, topic }))
        socket.onmessage = event => {
          if (typeof event.data !== "string") return
          const frame = JSON.parse(event.data)
          if (frame.t !== "err" && frame.t !== "snap") return
          clearTimeout(timer); socket.close(); resolve(frame.code ?? "accepted")
        }
      }), `doc:code:${branch}:retry.ts`)
      expect(subscribed).toBe("forbidden")
    } finally { await deniedContext.close() }
    const frames: { at: number; payload: string }[] = []
    alice.on("websocket", socket => {
      if (new URL(socket.url()).pathname !== "/api/live") return
      socket.on("framereceived", frame => { if (typeof frame.payload === "string") frames.push({ at: performance.now(), payload: frame.payload }) })
    })
    await runSlash(alice, `/file ${JSON.stringify({ branch, path: "retry.ts" })}`)
    const card = cardFor(alice, "retry.ts")
    await expect(card).toHaveAttribute("data-mode", "live")
    const member = await f.read("Alice", "/api/user")
    const removed = performance.now()
    await runSlash(owner, `/members.remove ${JSON.stringify({ login: member.username })}`)
    await expect(card).toHaveAttribute("data-mode", "read_only", { timeout: 5000 })
    expect(performance.now() - removed).toBeLessThan(5000)
    const before = await ssh("cat retry.ts")
    await journeyReach(card.locator(".cm-content").first())
    await alice.keyboard.insertText("REVOKED_MUST_NOT_WRITE")
    expect(await ssh("cat retry.ts")).toBe(before)
    const response = await realApi(alice, alice.context().request, "GET", `/api/branches/${encodeURIComponent(branch)}/files/retry.ts`)
    expect([401, 403]).toContain(response.status())
    // Fresh authenticated socket after removal, no injected authorizer.
    const refusal = await alice.evaluate(async topic => {
      return await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/live`, "smithers.live.v1")
        const timer = setTimeout(() => { socket.close(); reject(new Error("Revoked subscription was not refused")) }, 5000)
        const finish = (result: string) => { clearTimeout(timer); socket.close(); resolve(result) }
        socket.onopen = () => socket.send(JSON.stringify({ t: "sub", id: 91, topic, actor: "owner", client_id: 1 }))
        socket.onmessage = event => {
          if (typeof event.data !== "string") return
          const frame = JSON.parse(event.data)
          if (frame.t === "snap" || frame.t === "err") finish(JSON.stringify(frame))
        }
        socket.onclose = () => finish("closed")
      })
    }, `doc:code:${branch}:retry.ts`)
    expect(refusal === "closed" || JSON.parse(refusal).code === "forbidden").toBe(true)
    await attachJson(info, "revocation", { elapsedMs: performance.now() - removed, frames, refusal, readStatus: response.status() })
  })
})


// Qualification build only: prove the actual guest daemon was started with
// delayed watcher delivery. No synthetic event, version or save receipt enters
// these forty browser/SSH races.
test("C-J3-04: forty delayed-watcher outside saves retain atomic and in-place versions", scenario("file.coedit.ordering", {
  capabilities: ["install", "ssh"], coverage: ["action:file", "action:file.compare", "door:slash", "door:button", "path:persistence", "dimension:recovery", "surface:file-card", "host:local", "host:production"]
}), async ({ browser }, info) => {
  test.setTimeout(360_000)
  const pid = required("SMITHERS_COEDIT_DAEMON_PID")
  if (!/^[1-9][0-9]*$/.test(pid)) throw new Error("A non-root guest daemon pid is required")
  expect((await ssh(`tr '\\0' '\\n' < /proc/${pid}/environ | sed -n '/^SMITHERS_MACHINED_WATCH_DELAY_MS=/p'`)).trim()).toBe("SMITHERS_MACHINED_WATCH_DELAY_MS=2000")
  await withReference(browser, info, async f => {
    const branch = required("SMITHERS_OUTSIDE_BRANCH"), page = f.members.Alice.page
    await runSlash(page, `/file ${JSON.stringify({branch,path:"retry.ts"})}`)
    const card = cardFor(page,"retry.ts")
    await expect(card).toHaveAttribute("data-mode","live")
    const trials: { mode: string; trial: number; elapsed: number; retained: "document" | "version"; outsideDigest: string; outsideText?: string }[] = []
    for (const mode of ["atomic", "in-place"] as const) for (let trial = 0; trial < 20; trial++) {
      await expect(card.locator('.code-saved')).toHaveText("Saved to the machine")
      const before = await ssh("cat retry.ts")
      const ours = `ALICE_ORDER_${mode}_${trial}`, theirs = `MAYA_ORDER_${mode}_${trial}`
      const outside = before.split("\n"); outside[29] = theirs + outside[29]
      const encoded = Buffer.from(outside.join("\n")).toString("base64")
      await journeyReach(card.locator('.cm-content').first())
      await page.keyboard.press("ControlOrMeta+Home")
      for (let line = 1; line < 30; line++) await page.keyboard.press("ArrowDown")
      await page.keyboard.press("Home")
      const started = performance.now()
      await page.keyboard.insertText(ours)
      // In-place writes are scheduled at the debounce boundary; both observed
      // orders are retained in the evidence rather than assuming SSH latency.
      if (mode === "in-place") await new Promise(resolve => setTimeout(resolve, Math.max(0, 190 - (performance.now() - started))))
      await ssh(mode === "atomic" ? `printf '%s' '${encoded}' | base64 -d > .coedit-outside; mv .coedit-outside retry.ts` : `printf '%s' '${encoded}' | base64 -d > retry.ts`)
      const elapsed = performance.now() - started
      if (mode === "atomic") expect(elapsed).toBeLessThan(200)
      await expect.poll(() => text(card), {timeout:5000}).toContain(ours)
      let retained: "document" | "version" = "document", outsideText: string | undefined
      if (!(await text(card)).includes(theirs)) {
        await expect(card).toContainText("Changed outside Smithers", {timeout:5000})
        await journeyActivate(card.getByRole("button",{name:"Compare",exact:true}))
        await expect(card.locator('.code-file-outside')).toContainText(theirs)
        retained = "version"
        outsideText = await card.locator('.code-file-outside').textContent() ?? undefined
      }
      await expect(card.locator('.code-saved')).toHaveText("Saved to the machine", {timeout:5000})
      await expect.poll(async () => (await ssh("cat retry.ts")) === (await text(card)), {timeout:5000}).toBe(true)
      trials.push({mode,trial,elapsed,retained,outsideText,outsideDigest:createHash("sha256").update(outside.join("\n")).digest("hex")})
    }
    expect(trials).toHaveLength(40)
    await attachJson(info,"outside-save-ordering",trials)
    const evidence = await mergeEvidence()
    expect(evidence.merges.length).toBeGreaterThanOrEqual(40)
    for (const trial of trials) expect(evidence.merges.some(merge => merge.theirs === trial.outsideDigest)).toBe(true)
    expect(evidence.merges.some(merge => merge.source === "displaced-save")).toBe(true)
    await attachJson(info,"daemon-ordering-merge-log",evidence)
  })
})

// A reviewed command launches the real coding harness through its registered
// guest session. The browser verifies the broker's participant projection and
// the actual attributed disk write; argv supplies stimulus, never a receipt.
test("C-J3-04: coding-process attribution survives its registered participant lifetime", scenario("file.coedit.agent", {
  capabilities: ["install", "ssh"], coverage: ["action:branch", "action:file", "door:slash", "path:success", "surface:file-card", "host:local", "host:production"]
}), async ({ browser }, info) => {
  test.setTimeout(180_000)
  const command: unknown = JSON.parse(required("SMITHERS_COEDIT_AGENT_ARGV"))
  if (!Array.isArray(command) || command[0] !== "ssh" || command.length < 3 || !command.every(value => typeof value === "string") || command.some(value => /\b(?:sudo|su|doas)\b|root@/.test(value))) throw new Error("Reviewed non-root registered coding-harness SSH argv required")
  const argv = command as string[]
  await withReference(browser, info, async f => {
    const branch = required("SMITHERS_OUTSIDE_BRANCH"), pages = [f.members.Ben.page, f.members.Alice.page]
    await runSlash(pages[0]!, "/branch T2")
    const presence = pages[0]!.getByRole("list", { name: "On this branch", exact: true }).last()
    for (const page of pages) await runSlash(page, `/file ${JSON.stringify({branch,path:"retry.ts"})}`)
    const cards = pages.map(page => cardFor(page,"retry.ts"))
    for (const card of cards) await expect(card).toHaveAttribute("data-mode","live")
    expect(await text(cards[0]!)).not.toContain("AGENT_LINE_70_CANARY")
    const running = execute(argv[0]!, argv.slice(1), {timeout:120_000})
    // Attach a handler immediately so a launch failure cannot become an
    // unhandled promise while the presence assertion is waiting.
    const completion = running.then(value => ({value}), error => ({error}))
    const chip = presence.locator('[data-agent="coding"][data-for="true"]')
    await expect(chip).toBeVisible({timeout:30_000})
    await expect(chip).toHaveAttribute("aria-label", /Ben/)
    await attachJson(info,"active-coding-participant",await presence.innerText())
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]!, card = cards[i]!
      await expect.poll(() => text(card), {timeout:120_000}).toContain("AGENT_LINE_70_CANARY")
      expect((await text(card)).split("\n")[69]).toContain("AGENT_LINE_70_CANARY")
      await journeyReach(card.locator('.cm-content').first())
      await page.keyboard.press("ControlOrMeta+Home")
      for (let line = 1; line < 70; line++) await page.keyboard.press("ArrowDown")
      await expect(card.locator('.code-author[title*="Coding agent"]').first()).toBeVisible()
    }
    const finished = await completion
    if ("error" in finished) throw finished.error
    await expect(chip).toHaveCount(0,{timeout:5000})
    for (const card of cards) await expect(card.locator('.code-author[title*="Coding agent"]').first()).toBeVisible()
    expect(await ssh("cat retry.ts")).toBe(await text(cards[0]!))
    await attachJson(info,"coding-harness-transcript",finished.value)
  })
})
