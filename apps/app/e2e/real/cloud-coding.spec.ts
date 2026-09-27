import { scenario } from "./coverage/types"
import { command, closeComposer, expect } from "./support/test"
import { configuredGatewayTest, drainRuns } from "./flow-execution/fixture"
import { acceptedRunId, gatewayCall, waitForTerminalRun } from "./flow-execution/production"
import { attachProductionJson, bootProductionRepository, readJson, repositoryApiPath } from "./repositories-github/production"

configuredGatewayTest.setTimeout(20 * 60_000)
configuredGatewayTest.use({ actionTimeout: 30_000 })

configuredGatewayTest("a UI coding request validates a change and Vibe lands its exact commit", scenario("coding.production-request-vibe-land", {
 capabilities: ["identity", "cloud"],
 description: "On the explicitly configured canary workspace, select its real cloud copy, request a small edit through the UI, wait for validation, click Vibe, and independently prove the resulting main commit and file content.",
 coverage: ["action:flow.run", "action:box.view", "action:repo.select", "host:production", "path:success", "door:slash", "door:button", "dimension:provider-run", "dimension:native-landing", "evidence:exact-main-and-file-readback"]
}), async ({page,request,workflowRepo},testInfo)=>{
 const {repo,workspaceId}=workflowRepo
 expect(workspaceId).toBeDefined()
 await bootProductionRepository(page,repo)
 await command(page,`/box.view ${workspaceId}`)
 await expect(page.getByTestId(`card-workspace-${workspaceId}`)).toBeVisible()
 await closeComposer(page)
 await command(page,`/repo.select ${repo}#workspace:${workspaceId}`)
 await closeComposer(page)
 const catalog = await gatewayCall(page,request,repo,"List",{_tag:"flows"},workspaceId)
 const flows = (catalog.payload as {items:Array<{flowId:string}>}).items.map(x=>x.flowId)
 expect(flows).toContain("coding/request")
 expect(flows).toContain("coding/vibe")
 const existing = await gatewayCall(page,request,repo,"List",{_tag:"runs",filters:{}},workspaceId)
 const priorRuns = (existing.payload as {items:Array<{status:string}>}).items
 expect(priorRuns.filter(x=>!["completed","failed","cancelled"].includes(x.status)),"Do not edit a workspace with another active run").toEqual([])
 await command(page,`/flow.list ${repo}`)
 await closeComposer(page)
 const before=await readJson<{items:Array<{name:string;target_commit_id:string}>}>(page,request,repositoryApiPath(repo,"/bookmarks"))
 const marker=`smithers-cloud-proof-${Date.now().toString(36)}`
 const input={prompt:`Preserve the README title and introduction. Ensure README.md has a ## Purpose section explaining this is a disposable fixture for testing Smithers in production. Append the exact line '${marker}'. Make no other source file changes. Run all configured required documentation checks. This is a tiny documentation edit; implement and validate it.`,maxRounds:1}
 let bodyError: unknown
 try {
 const [requestRunId]=await Promise.all([acceptedRunId(page,repo,workflowRepo),command(page,`/flow.run coding/request ${repo} ${JSON.stringify(input)}`)])
 await closeComposer(page)
 const completed=await waitForTerminalRun(page,request,repo,requestRunId,600_000,workspaceId)
 await attachProductionJson(testInfo,"native-request",{repo,requestRunId,completed})
 expect(completed.status).toBe("completed")
 const validation=JSON.stringify(completed.finalOutput)
 expect(validation,"The coding result must report validation, rather than merely a terminal run").toContain('"status":"validated"')
 expect(validation,"The approved plan must contain a required check").toContain('"required":true')
 expect(validation,"The result must contain a passed check receipt").toContain('"status":"passed"')
 const card=page.locator(`.smithers-card[data-kind="run-trace"][data-run-id="${requestRunId}"]`)
 const vibe=card.getByRole("button",{name:"Vibe this change",exact:true})
 await expect(vibe).toBeVisible({timeout:30_000})
 const [vibeRunId]=await Promise.all([acceptedRunId(page,repo,workflowRepo),vibe.click()])
 const landed=await waitForTerminalRun(page,request,repo,vibeRunId,600_000,workspaceId)
 await attachProductionJson(testInfo,"native-vibe",{repo,vibeRunId,landed})
 expect(landed.status).toBe("completed")
 const result=landed.finalOutput as {mainCommitId?:unknown}
 expect(result.mainCommitId).toMatch(/^[0-9a-f]{40}$/)
 const after=await readJson<{items:Array<{name:string;target_commit_id:string}>}>(page,request,repositoryApiPath(repo,"/bookmarks"))
 expect(after.items.find(x=>x.name==="main")?.target_commit_id).toBe(result.mainCommitId)
 expect(result.mainCommitId).not.toBe(before.items.find(x=>x.name==="main")?.target_commit_id)
 const file=await readJson<{content:string;encoding:string}>(page,request,repositoryApiPath(repo,"/contents/README.md?ref=main"))
 expect(file.encoding).toBe("base64")
 expect(Buffer.from(file.content,"base64").toString()).toContain(marker)
 // GitHub is an independent mirror read, not another Plue API route. The
 // authenticated browser can read this private fixture without a token in the
 // test process or an intercepted response.
 const github=await page.context().newPage()
 try {
  // Resolve the branch itself: merely finding the commit cannot prove the
  // GitHub mirror advanced main to it. This is the tree page's observed ref.
  await expect.poll(async () => {
   const mainPage=await github.goto(`https://github.com/${repo}/tree/main`,{waitUntil:"domcontentloaded"})
   if(mainPage?.status()!==200) return null
   const raw=await github.locator('script[type="application/json"][data-target="react-app.embeddedData"]').first().textContent()
   const data=JSON.parse(raw ?? "{}") as {payload?:{codeViewTreeRoute?:{refInfo?:{name?:string;refType?:string;currentOid?:string}}}}
   const ref=data.payload?.codeViewTreeRoute?.refInfo
   return ref ? {name:ref.name,refType:ref.refType,currentOid:ref.currentOid} : null
  },{timeout:60_000,message:"GitHub main must independently reach the exact landed commit"})
   .toEqual({name:"main",refType:"branch",currentOid:result.mainCommitId})
  const commitPage=await github.goto(`https://github.com/${repo}/commit/${result.mainCommitId}`,{waitUntil:"domcontentloaded"})
  expect(commitPage?.status(),"GitHub must resolve the exact landed commit").toBe(200)
  await expect(github).toHaveURL(new RegExp(`/commit/${result.mainCommitId}$`))
  const filePage=await github.goto(`https://github.com/${repo}/blob/${result.mainCommitId}/README.md`,{waitUntil:"domcontentloaded"})
  expect(filePage?.status(),"GitHub must resolve README at that exact commit").toBe(200)
  await expect(github.locator("body")).toContainText(marker)
 } finally { await github.close() }
 await attachProductionJson(testInfo,"native-landed-git-proof",{repo,marker,requestRunId,vibeRunId,mainCommitId:result.mainCommitId})
 } catch (error) {
  bodyError = error
  throw error
 } finally {
  try { await drainRuns(page,request,workflowRepo) }
  catch (cleanupError) {
   if (bodyError !== undefined) throw new AggregateError([bodyError,cleanupError],"Coding proof failed and its run did not drain")
   throw cleanupError
  }
 }
})
