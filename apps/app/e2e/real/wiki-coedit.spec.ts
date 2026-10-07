import { journeyActivate, journeyReach } from "./support/keyboard-journey-input"
import { CANARY_README } from "./support/canary"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import type { Page } from "@playwright/test"
import * as Y from "yjs"
import { test } from "./support"
import { scenario } from "./coverage/types"
import { withReference, createTodo, runSlash, realApi, expect, attachJson } from "./todo/reference"

// Run from the second Mac against a prepared scratch install. No route doubles,
// SQL writes, model fixtures or GitHub mutations. The operator creates revision
// 1–3 of decisions/retries before running this destructive editing canary.
const journey = scenario("journey-wiki-coedit", { capabilities: [], coverage: ["host:local", "host:production", "surface:wiki", "door:slash", "door:button", "path:persistence", "dimension:recovery"] })
test("C-J8-02 shared wiki, 400 latency samples and offline reload", journey, async ({ browser }, info) => {
  test.setTimeout(960_000)
  await withReference(browser, info, async f => {
    const ben = f.members.Ben.page, alice = f.members.Alice.page
    const slug = "decisions/retries", api = `/api/repos/${f.repo}/wiki`
    const before = await f.read("Ben", `${api}/${encodeURIComponent(slug)}/document`)
    const id = before.page.id as number
    expect(before.page.revision).toBe(3)
    expect(before.page.body).toBe("Ben paragraph.\n\nAlice paragraph.")
    expect(before.page.body).not.toMatch(/[\ue000-\ue18f]/)
    const visibility = encodeURIComponent(before.page.visibility)
    const history = `${api}/history/${id}`
    const revisions = f.sql(`SELECT revision,body,content_digest FROM wiki_page_revisions WHERE page_id=${id} ORDER BY revision`)
    expect(revisions.map(r => r.revision)).toEqual([1, 2, 3])
    const original = new Map<number, string>()
    for (const revision of revisions) {
      const response = await realApi(ben, ben.context().request, "GET", `${history}/${revision.revision}/content?visibility=${visibility}`)
      expect(response.status()).toBe(200)
      original.set(revision.revision, await response.text())
    }
    const open = async (page: Page) => {
      await runSlash(page, `/wiki.page ${slug}`)
      const card = page.getByTestId(`card-wiki-open-wiki:${f.repo}:${id}`)
      await expect(card).toBeVisible()
      await journeyActivate(card.getByRole("button", { name: "Edit", exact: true }))
      const editor = card.locator('.ProseMirror[contenteditable="true"]')
      await expect(editor).toBeVisible()
      return editor
    }
    const editors = [await open(ben), await open(alice)]
    const pages = [ben, alice]
    const samples: { character: string; sent: number; arrived: number; ms: number }[] = []
    const waiting = new Map<string, { sent: number; receiver: Page; done: () => void }>()
    // Both callbacks use this runner's monotonic clock. DOM-to-runner IPC is
    // included, so these samples are conservative end-to-end upper bounds.
    for (const page of pages) {
      await page.exposeBinding("wikiCharacterArrived", (_source, character: string) => {
        const pending = waiting.get(character)
        if (!pending || pending.receiver !== page) return
        waiting.delete(character)
        const arrived = performance.now()
        samples.push({ character, sent: pending.sent, arrived, ms: arrived - pending.sent })
        pending.done()
      })
      await page.evaluate(() => {
        const seen = new Set<string>()
        new MutationObserver(() => {
          for (const character of document.querySelector('.ProseMirror')?.textContent ?? "") {
            if (character.charCodeAt(0) < 0xe000 || character.charCodeAt(0) >= 0xe190 || seen.has(character)) continue
            seen.add(character)
            void (window as unknown as { wikiCharacterArrived: (character: string) => Promise<void> }).wikiCharacterArrived(character)
          }
        }).observe(document.body, { subtree: true, childList: true, characterData: true })
      })
    }
    await Promise.all(editors.map(async (editor, index) => {
      await journeyReach(editor)
      await pages[index]!.keyboard.press(index ? "Meta+ArrowUp" : "Meta+ArrowDown")
      for (let n = 0; n < 200; n++) {
        const character = String.fromCharCode(0xe000 + index * 200 + n)
        let arrived!: () => void
        const received = new Promise<void>(done => { arrived = done })
        const started = performance.now()
        waiting.set(character, { sent: started, receiver: pages[1 - index]!, done: arrived })
        await pages[index]!.keyboard.type(character)
        await Promise.race([received, new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`Peer did not receive ${character}`)), 5000)
          void received.then(() => clearTimeout(timer))
        })])
        await new Promise(done => setTimeout(done, Math.max(0, 125 - (performance.now() - started))))
      }
    }))
    expect(samples).toHaveLength(400)
    const sorted = samples.map(s => s.ms).sort((a, b) => a - b)
    const p95 = sorted[379]!
    await attachJson(info, "latency", { n: 400, p50: sorted[199], p95, scope: "second-Mac runner, DOM observer including IPC" })
    await info.attach("keystrokes.csv", { body: "character,sent,arrived,ms\n" + samples.map(s => `${s.character},${s.sent},${s.arrived},${s.ms}`).join("\n"), contentType: "text/csv" })
    expect(p95).toBeLessThan(1000)
    // Same insertion position, different causal clients.
    const overlaps = [String.fromCharCode(...Array.from({ length: 30 }, (_, n) => 0xe200 + n)),
      String.fromCharCode(...Array.from({ length: 30 }, (_, n) => 0xe300 + n))]
    await Promise.all(pages.map(async (page, index) => {
      await journeyReach(editors[index]!); await page.keyboard.press("Meta+ArrowUp")
      await page.keyboard.type(overlaps[index]!)
    }))
    await f.members.Alice.context.setOffline(true)
    await journeyReach(editors[1]!); await alice.keyboard.press("Meta+ArrowDown")
    const offline = "OFFLINE" + "x".repeat(43)
    await alice.keyboard.type(offline)
    await expect(editors[1]!).toContainText(offline)
    await alice.waitForTimeout(2000)
    await alice.reload().catch(() => {})
    await f.members.Alice.context.setOffline(false)
    await alice.reload()
    editors[1] = await open(alice)
    await expect(editors[0]!).toContainText(offline)
    await expect.poll(async () => (await editors[0]!.textContent()) === (await editors[1]!.textContent())).toBe(true)
    const text = (await editors[0]!.textContent())!
    for (let n = 0; n < 400; n++) expect(text.split(String.fromCharCode(0xe000 + n)).length - 1).toBe(1)
    expect(text.split(offline).length - 1).toBe(1)
    for (const character of overlaps.join("")) expect(text.split(character).length - 1).toBe(1)
    await expect.poll(async () => (await f.read("Ben", `${api}/${encodeURIComponent(slug)}/document`)).page.body.replace(/\n/g, "")).toBe(text.replace(/\n/g, ""))
    const after = f.sql(`SELECT revision,body,content_digest,encode(crdt_state,'base64') AS state FROM wiki_page_revisions WHERE page_id=${id} ORDER BY revision`)
    expect(after.slice(0, 3).map(({ revision, body, content_digest }) => ({ revision, body, content_digest }))).toEqual(revisions)
    expect(after.length).toBeGreaterThan(3)
    expect(after.length).toBeLessThan(12) // 400 edits are batched, never 400 revisions.
    const actors = [await f.read("Ben", "/api/user"), await f.read("Alice", "/api/user")]
    for (const revision of after.slice(3)) {
      const doc = new Y.Doc()
      try {
        Y.applyUpdate(doc, Buffer.from(revision.state, "base64"))
        const attributed = new Set(Array.from(doc.getMap("authors").values(), String))
        for (const actor of actors) expect(attributed.has(String(actor.id))).toBe(true)
      }
      finally { doc.destroy() }
    }
    expect(actors).toHaveLength(2)
    for (const [revision, body] of original) {
      const response = await realApi(ben, ben.context().request, "GET", `${history}/${revision}/content?visibility=${visibility}`)
      expect(response.status()).toBe(200); expect(await response.text()).toBe(body)
    }
    const probes: { method: string; suffix: string; status: number }[] = []
    for (const [method, suffix] of [["GET", "updates"], ["POST", "updates"], ["GET", "stream"]]) {
      const response = await realApi(ben, ben.context().request, method!, `${api}/${encodeURIComponent(slug)}/${suffix}`)
      probes.push({ method: method!, suffix: suffix!, status: response.status() })
      expect(response.status()).toBe(404)
    }
    const openapi = await readFile(resolve("../../docs/api/openapi/repositories.yaml"), "utf8")
    expect(openapi).not.toMatch(/\/wiki\/\{slug\}\/(updates|stream):/)
    const texts = { ben: text, alice: (await editors[1]!.textContent())!, stored: after.at(-1).body as string }
    await attachJson(info, "route-probes", probes)
    await attachJson(info, "pages-and-revisions", { before: revisions, after, texts,
      hashes: Object.fromEntries(Object.entries(texts).map(([name, value]) => [name, createHash("sha256").update(value).digest("hex")])) })
    // §21: a member decision must reach the next real plan and its branch bytes.
    const decision = "For the release canary README, append exactly: Retry failed webhook deliveries with the existing retry helper."
    await journeyReach(editors[0]!)
    await ben.keyboard.press("ControlOrMeta+a")
    await ben.keyboard.type(decision)
    let savedDecision: any
    await expect.poll(async () => {
      savedDecision = await f.read("Ben", `${api}/${encodeURIComponent(slug)}/document`)
      return savedDecision.page.body
    }).toBe(decision)
    const citation = { slug, revision: savedDecision.page.revision, digest: createHash("sha256").update(decision).digest("hex") }
    expect(citation.revision).toBeGreaterThan(3)
    const initialReadme = await f.github("Ben", "GET", "/contents/README.md?ref=main") as any
    expect(Buffer.from(initialReadme.content, "base64").toString("utf8")).toBe(CANARY_README)
    const todosBefore = await f.read("Ben", "/api/todos")
    await createTodo(ben, "Document the webhook retry decision in decisions/retries. Follow the page's exact README instruction, change only README.md, and run npm test.")
    let planned: any
    await expect.poll(async () => {
      const todos = await f.read("Ben", "/api/todos")
      expect(todos.length).toBe(todosBefore.length + 1)
      planned = todos.at(-1)
      return planned.state
    }, { timeout: 660_000, intervals: [1000, 2000] }).toBe("in_review")
    const evidence = planned.evidence.flatMap((attempt: any) => attempt.items)
    expect(evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "wiki", ...citation })]))
    const pull = await f.github("Ben", "GET", `/pulls/${planned.pr.number}`) as any
    const changed = await f.github("Ben", "GET", `/pulls/${planned.pr.number}/files`) as any[]
    expect(changed.map(file => file.filename)).toEqual(["README.md"])
    const produced = await f.github("Ben", "GET", `/contents/README.md?ref=${pull.head.sha}`) as any
    expect(Buffer.from(produced.content, "base64").toString("utf8")).toBe(CANARY_README + "\nRetry failed webhook deliveries with the existing retry helper.\n")
    await attachJson(info, "wiki-decision-followed", { citation, todo: planned.number, head: pull.head.sha })
  })
})
