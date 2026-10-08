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
    // Own-edits Undo keeps the other member's edit.
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

