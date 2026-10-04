import {expect,test} from "./browserTest"
import {signedOutVisitor} from "./identity"

test("a delayed slash submission preserves the freshly retyped identical command", async ({page}) => {
  await page.emulateMedia({colorScheme:'light'})
  await signedOutVisitor(page)
  await page.addInitScript(() => {
    const nativePost = Worker.prototype.postMessage
    const held: Array<() => void> = []
    const probe = {armed:false, commits:0, release:() => {probe.armed=false;for(const send of held.splice(0))send()}}
    ;(window as any).draftCommitProbe=probe
    Worker.prototype.postMessage=function(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      const send=()=>Reflect.apply(nativePost,this,[message,options])
      if(probe.armed && typeof message==='object' && message!==null && 'sql' in message && typeof message.sql==='string' && /^\s*COMMIT\b/i.test(message.sql)) {
        probe.commits++;held.push(send)
      } else send()
    }
  })
  await page.goto('/smithersai/smithers/')
  await expect(page.getByRole('button',{name:'Chat',exact:true})).toBeVisible()
  await page.keyboard.press('Control+k')
  const input=page.getByTestId('composer-input')
  const line='/theme dark'
  await input.fill(line)
  await page.evaluate(()=>{(window as any).draftCommitProbe.armed=true})
  try {
    await input.press('Enter')
    await expect(input).toBeHidden()
    await expect.poll(()=>page.evaluate(()=>(window as any).draftCommitProbe.commits)).toBeGreaterThan(0)
    await page.keyboard.press('Control+k')
    await input.fill(line)
    await expect(input).toHaveValue(line)
    await expect(page.locator('html')).toHaveAttribute('data-theme','light')
    await page.evaluate(()=>(window as any).draftCommitProbe.release())
    await expect(page.locator('html')).toHaveAttribute('data-theme','dark')
    await expect(input).toHaveValue(line)
    await page.reload()
    await expect(page.getByRole('button',{name:'Chat',exact:true})).toBeVisible()
    await page.keyboard.press('Control+k')
    await expect(input).toHaveValue(line)
    await input.press('Enter')
    await expect(input).toBeHidden()
  } finally {
    await page.evaluate(()=>(window as any).draftCommitProbe.release()).catch(()=>{})
  }
})
