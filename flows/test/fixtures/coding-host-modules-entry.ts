import { Flow } from "@smthrs/flow"
import { Exit, Option, Schema } from "effect"
import { share } from "../../coding/host-modules.ts"

// A packaged host loads a repository's file flow and settles its round
// through the flow's own codec, exactly as the engine store does (#2197).
// Arguments: the flow file, "success" or "error", and that channel's JSON.
share()
const [path, channel, json] = process.argv.slice(2) as [string, "success" | "error", string]
const flow: unknown = (await import(path)).default
if (!Flow.isFlow(flow)) throw new Error("The repository flow is not a Flow.make value")
const success = flow.successSchema as Schema.Codec<unknown>
const error = flow.errorSchema as Schema.Codec<unknown>
const channelCodec = Schema.toCodecJson(channel === "success" ? success : error)
const value = Schema.decodeUnknownSync(channelCodec)(JSON.parse(json))
const codec = Schema.toCodecJson(Flow.Result({ success, error }))
const exit = channel === "success" ? Exit.succeed(value) : Exit.fail(value)
const encoded = Schema.encodeUnknownSync(codec)(new Flow.Complete({ exit }))
const decoded = Schema.decodeUnknownSync(codec)(encoded) as Flow.Complete<unknown, unknown>
const settled = Schema.encodeUnknownSync(channelCodec)(Exit.isSuccess(decoded.exit) ? decoded.exit.value : Option.getOrThrow(Exit.findErrorOption(decoded.exit)))
process.stdout.write(`${JSON.stringify({ flow: flow._tag, encoded, settled })}\n`)
