import { Schema } from "effect"

// Reference: prototype README, "Existing data contracts". Only normalized
// producer-owned brief fields enter this composition; no transcript paths,
// account credentials, collection or notification actions cross this boundary.
const Question = {
  id: Schema.String,
  q: Schema.String,
  why: Schema.String,
  options: Schema.Array(Schema.String),
  asked: Schema.optional(Schema.String),
  default: Schema.optional(Schema.String),
  deadline: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String)
}
export const Brief = Schema.Struct({
  headline: Schema.optional(Schema.String),
  updated: Schema.optional(Schema.String),
  updated_epoch: Schema.optional(Schema.Number),
  questions: Schema.optional(Schema.Array(Schema.Struct(Question))),
  resolved: Schema.optional(
    Schema.Array(Schema.Struct({ ...Question, resolved: Schema.String, outcome: Schema.String }))
  ),
  agents: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.String,
    role: Schema.String,
    doing: Schema.String,
    state: Schema.Literals(["ok", "slip", "blocked", "idle"]),
    eta: Schema.optional(Schema.String),
    at: Schema.optional(Schema.String)
  }))),
  bar: Schema.optional(Schema.Record(
    Schema.String,
    Schema.Struct({
      value: Schema.Union([Schema.String, Schema.Number]),
      level: Schema.optional(Schema.Literals(["ok", "good", "warn", "bad"]))
    })
  )),
  found: Schema.optional(Schema.Array(Schema.Struct({
    what: Schema.String,
    why: Schema.String,
    done: Schema.String,
    level: Schema.optional(Schema.Literals(["ok", "warn", "bad"])),
    at: Schema.optional(Schema.String)
  }))),
  log: Schema.optional(Schema.Array(Schema.String))
})
