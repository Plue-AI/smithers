// Bundle door for the existing host service; the full authoring CLI needs a checkout.
import { dirname } from "node:path"
import { parseArgs } from "node:util"
import * as HostService from "../../../packages/smithers/src/internal/backend/HostService"

try {
  const [group, command, ...args] = process.argv.slice(2)
  if (group !== "host") throw new Error("Use smthrs host start|stop|status")
  if (command === "start") {
    let values
    try {
      values = parseArgs({ args, strict: true, allowPositionals: false, options: {
        bundle: { type: "string" }, bind: { type: "string" }, origin: { type: "string", multiple: true }, json: { type: "boolean" }
      } }).values
    } catch { throw new Error("Use smthrs host start [--bundle <dir>] [--bind <address>] [--origin <url>] [--json]") }
    const result = await HostService.start(values.bundle ?? dirname(dirname(process.execPath)), {
      ...(values.bind === undefined ? {} : { bind: values.bind }),
      ...(values.origin === undefined ? {} : { origins: values.origin })
    })
    console.log(values.json ? JSON.stringify(result) : HostService.startText(result))
    process.exitCode = result.exitCode
  } else if (command === "stop" && (args.length === 0 || args.length === 1 && args[0] === "--json")) {
    console.log(JSON.stringify(await HostService.stop(HostService.launchd())))
  } else if (command === "status" && (args.length === 0 || args.length === 1 && args[0] === "--json")) {
    console.log(JSON.stringify(await HostService.status()))
  } else throw new Error("Use smthrs host start [--bundle <dir>]|stop|status")
} catch (error) {
  console.error(error instanceof Error ? error.message : "Host command failed")
  process.exitCode = 1
}
