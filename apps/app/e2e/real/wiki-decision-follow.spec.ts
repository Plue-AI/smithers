import { journeyActivate, journeyReach } from "./support/keyboard-journey-input"
import { test } from "./support"
import { scenario } from "./coverage/types"
import { withReference, createTodo, openTodo, todoCard, runSlash, realApi, expect, attachJson } from "./todo/reference"

// Run three times against separate prepared scratch repositories and fresh install
// state, with real coding/fast models. The runner refuses a development fallback.
// Aggregate with scripts/wiki-decision-campaign.ts against three prepared installs.
// Setup: both helpers exist, deliver.ts has no retry, and the authored page is r1.
const slug = "decisions/webhook-retries"
const original = "Decision: webhook redelivery uses `retryExponential()`. Reason: provider rate limits."
const edited = "Decision: webhook redelivery uses `retryFixed(5000)`. `retryExponential()` is not used for webhooks. Reason: the provider's idempotency window."
const finalBody = edited + "\n\nPreserve delivery IDs."
const originalDigest = "04cbfadd98b29ef5b7d4bf6b05c09fd6cf7eb1c3e63c066d99f28694518cd2b3"
const finalDigest = "255b1e8ec74b13d8222b7cf67b6e68618f85fa881b57d3f00e705618fc4b92a9"
const journey = scenario("journey-wiki-decision-follow", { capabilities: [], coverage: ["host:production", "surface:wiki", "surface:todo", "door:slash", "door:button", "dimension:evidence", "path:success"] })

test("C-J8-04/05 next real plan follows the exact edited decision revision", journey, async ({ browser }, info) => {
  test.setTimeout(1_800_000)
  expect(process.env.SMITHERS_WIKI_DECISION_RUN).toMatch(/^[123]$/)
  await withReference(browser, info, async f => {
    const ben = f.members.Ben.page, alice = f.members.Alice.page
    const api = `/api/repos/${f.repo}/wiki`
    const document = () => f.read("Ben", `${api}/${encodeURIComponent(slug)}/document`)
    const first = await document()
    expect(first.page).toMatchObject({ revision: 1, body: original, content_digest: originalDigest })
    expect(await f.read("Ben", "/api/todos")).toEqual([])
    const readMain = async (path: string) => {
      const file = await f.github("Ben", "GET", `/contents/${path}?ref=main`) as { content: string }
      return Buffer.from(file.content, "base64").toString("utf8")
    }
    const configuration = JSON.parse(await readMain(".smithers/coding-project.json"))
    expect(configuration.wikiCitations).toBe(true)
    expect(Array.isArray(configuration.pages)).toBe(true)
    const helpers = await readMain("src/webhooks/retry.ts")
    expect(helpers).toContain("retryExponential")
    expect(helpers).toContain("retryFixed")
    const delivery = await readMain("src/webhooks/deliver.ts")
    expect(delivery).not.toMatch(/retry(?:Exponential|Fixed)\s*\(/)
    const prompt = "Retry failed webhook deliveries in deliver.ts"
    const plan = (n: number) => f.sql(`SELECT plan FROM mythical_items WHERE number=${n}`)[0]?.plan
    const waitPlan = async (n: number, revision: number, digest: string, helper: string) => {
      let receipt: any
      await expect.poll(() => {
        const current = f.sql(`SELECT plan, attempt, request_run_id, checks->'planReceipt' AS receipt FROM mythical_items WHERE number=${n}`)[0]
        if (!current?.receipt || current.receipt.attempt !== current.attempt || current.receipt.runId !== current.request_run_id) return undefined
        receipt = current.plan
        return receipt?.wikiCitations
      }, { timeout: 720_000, intervals: [1000, 2000] }).toEqual(expect.arrayContaining([
        expect.objectContaining({ slug, revision, digest, pageID: String(first.page.id) })
      ]))
      expect(receipt.wikiCitations.filter((c: any) => c.slug === slug)).toHaveLength(1)
      expect(JSON.stringify(receipt.steps)).toContain(helper)
      await attachJson(info, `T${n}-plan-receipt`, receipt)
      return receipt
    }
    await createTodo(ben, prompt)
    const control = await waitPlan(1, 1, originalDigest, "retryExponential")
    expect(JSON.stringify(control.steps)).not.toContain("retryFixed")
    await runSlash(ben, "/todo.drop 1")
    await journeyActivate(ben.getByRole("button", { name: "Drop", exact: true }).last())
    await expect.poll(async () => (await f.read("Ben", "/api/todos/1")).state).toBe("dropped")

    const openEditor = async (page: typeof ben) => {
      await runSlash(page, `/wiki.page ${slug}`)
      const card = page.getByTestId(`card-wiki-open-wiki:${f.repo}:${first.page.id}`)
      await journeyActivate(card.getByRole("button", { name: "Edit", exact: true }))
      return card.locator('.ProseMirror[contenteditable="true"]')
    }
    const benEditor = await openEditor(ben), aliceEditor = await openEditor(alice)
    await journeyReach(aliceEditor)
    await alice.keyboard.press("ControlOrMeta+a")
    await alice.keyboard.type(edited)
    await expect(benEditor).toContainText("retryFixed(5000)")
    await expect.poll(async () => (await document()).page.body).toBe(edited)
    expect((await document()).page.revision).toBe(2)
    await journeyReach(benEditor)
    await ben.keyboard.press("ControlOrMeta+End")
    await ben.keyboard.press("Enter")
    await ben.keyboard.press("Enter")
    await ben.keyboard.type("Preserve delivery IDs.")
    await expect(aliceEditor).toContainText("Preserve delivery IDs.")
    await expect.poll(async () => (await document()).page.body).toBe(finalBody)
    expect((await document()).page).toMatchObject({ revision: 3, content_digest: finalDigest })
    expect(plan(1)).toEqual(control)
    await createTodo(ben, prompt)
    await expect.poll(async () => (await f.read("Ben", "/api/todos/2")).state,
      { timeout: 720_000, intervals: [1000, 2000] }).toBe("in_review")
    const next = await waitPlan(2, 3, finalDigest, "retryFixed")
    expect(JSON.stringify(next.steps)).not.toContain("retryExponential")
    const todo = await f.read("Ben", "/api/todos/2")
    const files = await f.github("Ben", "GET", `/pulls/${todo.pr.number}/files`) as any[]
    const diff = files.map(file => file.patch ?? "").join("\n")
    expect(files.map(file => file.filename)).toContain("src/webhooks/deliver.ts")
    expect(diff).toContain("retryFixed(5000)")
    expect(diff.split("\n").filter(line => line.startsWith("+")).join("\n")).not.toContain("retryExponential(")
    await info.attach("T2-pr.diff", { body: diff, contentType: "text/plain" })
    // Click the real TODO card: the response must be the captured revision's bytes.
    for (const [n, revision, body] of [[1, 1, original], [2, 3, finalBody]] as const) {
      await openTodo(ben, n)
      const link = todoCard(ben, n).getByRole("link", { name: `${slug} · r${revision}`, exact: true }).last()
      const path = `${api}/history/${first.page.id}/${revision}/content`
      const response = ben.waitForResponse(r => new URL(r.url()).pathname === path)
      await journeyActivate(link)
      const content = await response
      expect(content.status()).toBe(200)
      expect(await content.text()).toBe(body)
      const stored = await realApi(ben, ben.context().request, "GET", `${path}?visibility=${first.page.visibility}`)
      expect(await stored.text()).toBe(body)
    }
    await attachJson(info, "revisions-models-run", {
      run: Number(process.env.SMITHERS_WIKI_DECISION_RUN), repository: f.repo,
      revisions: f.sql(`SELECT revision,body,content_digest FROM wiki_page_revisions WHERE page_id=${Number(first.page.id)} ORDER BY revision`),
      models: f.sql("SELECT DISTINCT provider,model,paid_by FROM model_usage"), control, next
    })
  })
})
