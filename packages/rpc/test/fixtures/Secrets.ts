import type { Action } from "../../src/CardAction.ts"
import type { SecretsCard } from "../../src/SecretsCard.ts"
import { type Story, story } from "./_story.ts"

type Secret = SecretsCard["secrets"][number]
const scopes = ["all_branches", "main_only"]
const fields = (scope: string, hosts = ""): NonNullable<Action["input"]> => [
  { name: "value", label: "Value", kind: "secret", required: true },
  { name: "scope", label: "Scope", kind: "choice", choices: scopes, required: true, value: scope },
  { name: "hosts", label: "Hosts", kind: "text", required: false, value: hosts }
]
// What a maintainer sees: each row's Replace and Delete. Values are write-only and never in the model.
const secret = (name: string, scope: Secret["scope"], hosts?: string[]): Secret => ({
  name,
  scope,
  ...(hosts === undefined ? {} : { hosts }),
  actions: [
    { tag: "secrets.set", label: "Replace", args: { name }, input: fields(scope, hosts?.join(", ")) },
    { tag: "secrets.delete", label: "Delete", args: { name } }
  ]
})
const add: Action = {
  tag: "secrets.set",
  label: "Add",
  primary: true,
  input: [{ name: "name", label: "Name", kind: "text", required: true }, ...fields("all_branches")]
}

export const fixtures = {
  empty: story("No secrets yet", { secrets: [] }, { actions: [add], expect: ["Add"] }),
  all_branches: story("A secret for all branches", { secrets: [secret("NPM_TOKEN", "all_branches")] }, {
    actions: [add],
    expect: ["NPM_TOKEN", "Replace", "Delete"]
  }),
  main_only: story("A main-only secret", { secrets: [secret("RELEASE_TOKEN", "main_only")] }, {
    actions: [add],
    expect: ["RELEASE_TOKEN"]
  }),
  bound_hosts: story(
    "A secret bound to egress hosts",
    { secrets: [secret("STRIPE_KEY", "main_only", ["api.stripe.com", "files.stripe.com"])] },
    { actions: [add], expect: ["STRIPE_KEY", "api.stripe.com"] }
  ),
  mixed: story(
    "Secrets of both scopes",
    { secrets: [secret("NPM_TOKEN", "all_branches"), secret("RELEASE_TOKEN", "main_only", ["registry.npmjs.org"])] },
    { actions: [add], expect: ["NPM_TOKEN", "RELEASE_TOKEN"] }
  ),
  member_view: story(
    "Secret names as a member sees them",
    { secrets: [{ name: "NPM_TOKEN", scope: "all_branches", actions: [] }] },
    { expect: ["NPM_TOKEN"] }
  )
} satisfies Record<string, Story<SecretsCard>>
