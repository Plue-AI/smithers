import { test, expect } from "@playwright/test"
import { readFileSync } from "node:fs"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"

test("J2 label door appears on Home and merges its issue from the app", async ({ browser }) => {
 test.setTimeout(25 * 60_000)
 const run = JSON.parse(readFileSync("test-results/local-no-github/run.json", "utf8"))
 const context = await browser.newContext()
 const page = await context.newPage()
 const fake = async (path: string, body: unknown) => {
  const response = await context.request.post(`${run.fakeURL}${path}`, {data:body})
  expect(response.ok()).toBe(true);return response.json()
 }
 const say = async (text: string) => {
  const input=page.getByTestId("composer-input");if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill(text);await input.press("Enter")
 }
 try {
  await page.goto("http://localhost:4000/api/auth/github")
  await page.getByRole("link", {name:"Authorize",exact:true}).click()
  await expect(page.getByTestId("composer-input")).toBeAttached()
  // Source ready initialized the cursor; an event created now is a live request.
  const {number}=await fake("/_fake/issues",{repo:"local-owner/demo",login:"local-owner",title:"Label door farewell",body:"Add one farewell line to JOURNEY.md."})
  await fake("/_fake/labels",{repo:"local-owner/demo",number,login:"local-owner",label:"todo"})
  let n=0
  await expect.poll(async()=>{
   const response=await context.request.get("http://localhost:4000/api/todos")
   expect(response.ok()).toBe(true)
   const todos=TodoCardSchema.array().parse(await response.json())
   n=todos.find(todo=>todo.issue?.number===number)?.n ?? 0
   return n
  },{timeout:180_000,intervals:[2000]}).toBeGreaterThan(0)
  // Duplicate label delivery must not add another TODO.
  await fake("/_fake/labels",{repo:"local-owner/demo",number,login:"local-owner",label:"todo"})
  await say("/home")
  await expect(page.getByText("Label door farewell",{exact:true}).last()).toBeVisible({timeout:15_000})
  await say(`/todo T${n}`)
  await expect(page.getByRole("article",{name:`TODO T${n}`,exact:true}).last()).toBeVisible()
  let todo: any
  await expect.poll(async()=>{
   const response=await context.request.get(`http://localhost:4000/api/todos/${n}`)
   todo=TodoCardSchema.parse(await response.json());return todo.state
  },{timeout:18*60_000,intervals:[2000]}).toBe("in_review")
  const pull=await (await context.request.get(`${run.fakeURL}/repos/local-owner/demo/pulls/${todo.pr.number}`)).json()
  expect(pull.body).toContain(`Fixes #${number}`)
  const comments=await (await context.request.get(`${run.fakeURL}/repos/local-owner/demo/issues/${number}/comments`)).json()
  expect(comments.filter((comment:any)=>comment.body.includes("Committed as"))).toHaveLength(1)
  await say(`/merge T${n}`)
  await page.getByRole("button",{name:"Merge",exact:true}).last().click()
  await expect.poll(async()=>TodoCardSchema.parse(await (await context.request.get(`http://localhost:4000/api/todos/${n}`)).json()).state,{timeout:120_000,intervals:[2000]}).toBe("merged")
  await expect.poll(async()=> (await (await context.request.get(`${run.fakeURL}/repos/local-owner/demo/issues/${number}`)).json()).state,{timeout:30_000}).toBe("closed")
  const todos=await (await context.request.get("http://localhost:4000/api/todos")).json()
  expect(todos.filter((todo:any)=>todo.issue?.number===number)).toHaveLength(1)
 } finally {await context.close()}
})
