import "./beacon"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("canary", { description: "Isolation canary", capabilities: [], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }, payload: {}, success: Schema.String, body: () => Node.succeed("canary") })
