import { test, expect } from "@playwright/test"
import { packagedTodoSource } from "@smthrs/rpc/FlowCommands"
// Run after setup-no-github on the real bundle. Every state change uses the composer/card.
test("J5 quoted flow proposal stays private until Commit and files revision 1 once", async ({ browser }) => {
  const app = "http://localhost:4000"
  const context = await browser.newContext({ recordVideo: { dir: "test-results/local-no-github/flow-video" } })
  try {
    const page = await context.newPage()
    await page.goto(`${app}/api/auth/github`)
    await page.getByRole("link",{name:"Authorize",exact:true}).click()
    const input = page.getByTestId("composer-input")
    await expect(input).toBeAttached()
    const say = async (value:string) => { if (!await input.isVisible()) await page.keyboard.press("Control+k"); await input.fill(value); await input.press("Enter") }
    const todos = async () => { const response=await page.request.get(`${app}/api/todos`); expect(response.status()).toBe(200); return response.json() as Promise<{n:number;title:string;prompt_revisions:{context?:string}[]}[]> }
    const before=await todos()
    await say("Run /flow todo")
    await expect(page.getByRole("region",{name:"TODO flow",exact:true}).last()).toBeVisible()
    const request = "Run make test and update the changelog"
    const source = packagedTodoSource + "// Run make test and update the changelog.\n"
    await say(`Run /flow.edit ${JSON.stringify({name:"todo",request,source})}`)
    const draft=page.getByRole("region",{name:"Draft",exact:true}).last()
    await expect(draft).toBeVisible()
    await expect(draft).toContainText("Only you")
    await expect(draft).toContainText("Run make test and update the changelog.")
    expect(await todos()).toHaveLength(before.length)
    const flow = page.getByRole("region",{name:"TODO flow",exact:true}).last()
    await expect(flow).toContainText("Run make test and update the changelog.")
    await flow.getByRole("button",{name:"Make TODO",exact:true}).click()
    await expect.poll(async()=> (await todos()).length).toBe(before.length+1)
    const created=(await todos()).find(todo=>!before.some(old=>old.n===todo.n))!
    expect(created.prompt_revisions[0]!.context).toContain("+++ b/flows/todo/flow.ts")
    expect(created.prompt_revisions[0]!.context).toContain("+// Run make test and update the changelog.")
    await expect(draft).toContainText(`Committed as T${created.n}`)
    await page.reload()
    expect((await todos()).filter(todo=>todo.n===created.n)).toHaveLength(1)
  } finally { await context.close() }
})
