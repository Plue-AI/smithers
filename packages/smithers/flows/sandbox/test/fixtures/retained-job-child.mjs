import { Effect } from 'effect'
import * as Microsandbox from 'microsandbox'
import * as MicrosandboxSandbox from '../../src/MicrosandboxSandbox/index.ts'
import * as Sandbox from '../../src/Sandbox/index.ts'
const config=JSON.parse(process.argv[2])
const provider=MicrosandboxSandbox.make({sdk:Microsandbox,image:'node:26-trixie',pullPolicy:'never',persistence:'sticky',network:'none',owner:config.owner,maxDurationSecs:300,idleTimeoutSecs:240})
const handle=await Effect.runPromise(Effect.gen(function*(){
  yield* Effect.scoped(Effect.gen(function*(){
    const session=yield* provider.acquire(config.key)
    yield* session.writeFile('/workspace/seed.bundle',new Uint8Array(Buffer.from(config.bundle,'base64')))
    const proc=yield* session.spawn('git clone -q seed.bundle checkout',{})
    if((yield* proc.exitCode)!==0) return yield* Effect.die('guest clone failed')
  }))
  return yield* Sandbox.job(provider,{command:'sleep 3; printf recovered > recovered.txt',capture:{checkout:'/workspace/checkout'}}).start(undefined,config.key)
}))
process.stdout.write(JSON.stringify(handle)+'\n')
setInterval(()=>{},1000)
