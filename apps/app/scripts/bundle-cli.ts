// Bundle door for the existing host service; the full authoring CLI needs a checkout.
import { dirname } from "node:path"
import * as HostService from "../../../packages/smithers/src/internal/backend/HostService"

try {
  const [group, command, ...args] = process.argv.slice(2)
  if (group !== "host") throw new Error("Use smthrs host start|stop|status")
  if (command === "start" && (args.length === 0 || args.length === 2 && args[0] === "--bundle")) {
    const result = await HostService.start(args[1] ?? dirname(dirname(process.execPath)))
    console.log(JSON.stringify(result.setup_urls ? { setup_urls: result.setup_urls } : { message: result.message }))
    process.exitCode = result.exitCode
  } else if (command === "stop" && args.length === 0) {
    console.log(JSON.stringify(HostService.stop(HostService.launchd())))
  } else if (command === "status" && args.length === 0) {
    console.log(JSON.stringify(await HostService.status()))
  } else throw new Error("Use smthrs host start [--bundle <dir>]|stop|status")
} catch (error) {
  console.error(error instanceof Error ? error.message : "Host command failed")
  process.exitCode = 1
}
