/** Which lander this host delivers `coding/vibe` through, recorded once per flow so a restart never switches it. */
import { Action } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import { Lander } from "./landing-schema.ts"
import { Landing } from "./landing.ts"
import { CodingError } from "./schema.ts"

/** Admission and landing each keep their own record of the same host binding. */
export const ReadLander = Action.make("coding/read-vibe-lander", {
  payload: { phase: Schema.Literals(["admission", "landing"]) },
  success: Lander,
  error: CodingError,
  nondeterministic: true
})
export const landerLayer = ReadLander.toLayer(() => Effect.map(Landing, (landing) => landing.kind))
