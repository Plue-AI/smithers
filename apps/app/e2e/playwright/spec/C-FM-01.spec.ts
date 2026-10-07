import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// Browser projection proof; host storage, transport and turn completion are
// independently exercised by TestInstallFastModel*Postgres.
test("C-FM-01: fast-model sign-in, fallback and sign-out", async ({ page }) => {
 await owner(page)
 const model=installFixture()
 model.fast_model={signed_in:false,source:"team key"}
 let signins=0,signouts=0
 await page.route("**/api/install",route=>route.fulfill({json:model}))
 await page.route("**/api/model/fast/sign-in",route=>{
  signins++
  return route.fulfill({json:{url:new URL("/fixture-smithers-return",page.url()).href}})
 })
 await page.route("**/fixture-smithers-return",route=>{
  model.fast_model={signed_in:true,source:"Smithers",remaining:123,reset_at:"2026-10-08T00:00:00Z"}
  return route.fulfill({status:302,headers:{location:"/"},body:""})
 })
 await page.route("**/api/model/fast",route=>{
  expect(route.request().method()).toBe("DELETE");signouts++
  model.fast_model={signed_in:false,source:"team key"}
  return route.fulfill({json:{ok:true}})
 })
 await page.goto("/");await say(page,"/settings")
 const returned=page.waitForResponse("**/fixture-smithers-return")
 await page.getByRole("button",{name:"Sign in to Smithers",exact:true}).press("Enter")
 await returned;await page.waitForLoadState("domcontentloaded")
 await say(page,"/settings")
 const access=page.getByTestId("fast-model-access").last()
 await expect(access.getByText("Signed in",{exact:true})).toBeVisible()
 await expect(access.getByText("123 tokens left · 00:00 UTC",{exact:true})).toBeVisible()
 await expect(access.getByText(/App prompts, preflight and summaries go to Smithers and Cerebras/)).toBeVisible()
 await expect(page.getByText(/billing|credit card/i)).toHaveCount(0)
 for(const cause of ["capacity","unreachable","refused"] as const){
  model.fast_model={signed_in:true,source:"team key",cause,...(cause==="capacity"?{remaining:0,reset_at:"2026-10-08T00:00:00Z"}:{})}
  await say(page,"/settings")
  const line=cause==="capacity"?"daily Smithers quota used":cause==="unreachable"?"Smithers unreachable":"Smithers credential refused"
  await expect(access.getByRole("status")).toHaveText(`Fast model: ${line}; using team key${cause==="capacity"?" until 00:00 UTC":""}`)
  await expect(page.getByTestId("composer-input")).toBeEditable()
 }
 await access.getByRole("button",{name:"Sign out",exact:true}).press("Enter")
 await expect(access.getByText("Not signed in",{exact:true})).toBeVisible()
 await page.reload();await say(page,"/settings")
 await expect(page.getByTestId("fast-model-access").last().getByText("Not signed in",{exact:true})).toBeVisible()
 expect(signins).toBe(1);expect(signouts).toBe(1)
})
