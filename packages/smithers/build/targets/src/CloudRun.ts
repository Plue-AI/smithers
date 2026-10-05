/**
 * Private, tagged Cloud Run previews of a built image.
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Target from "./Target.ts"

const project = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/))
const region = Schema.String.check(Schema.isPattern(/^[a-z]+-[a-z]+[0-9]+$/))
const service = Schema.String.check(Schema.isPattern(/^(?:[a-z]|[a-z][a-z0-9-]{0,47}[a-z0-9])$/))
const account = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/)
)

/** Preview attributes, validated before host or network effects.
 * @category attrs
 * @since 1.0.0
 */
export const PreviewAttrs = Schema.Struct({
  image: Target.Target.check(
    Schema.makeFilter((target) =>
      Target.metadata(target).target === "Docker.Build" ? undefined : "CloudRun.Preview image must be Docker.Build"
    )
  ),
  project,
  region,
  service,
  repository: Schema.String.check(
    Schema.isPattern(/^[a-z]+-[a-z]+[0-9]+-docker\.pkg\.dev\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/[a-z][a-z0-9_-]{0,62}$/)
  ),
  deployer: account,
  serviceAccount: account,
  env: Schema.optional(
    Attr.Env.check(
      Schema.makeFilter((env) =>
        Object.entries(env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/[\r\n\0]/.test(value)) &&
          Buffer.byteLength(JSON.stringify(env), "utf8") <= 32768 && Object.keys(env).length <= 100
          ? undefined :
          "CloudRun.Preview env must contain at most 100 valid names, no newlines or NULs, and at most 32768 bytes"
      )
    )
  ),
  access: Schema.optional(Schema.Literals(["private", "public"])),
  expires: Schema.optional(
    Schema.String.check(Schema.isPattern(/^(?:(?:[1-9]|[1-5][0-9])m|(?:[1-9]|[1-9][0-9]|1[0-5][0-9]|16[0-8])h)$/))
  ),
  approval: Schema.optional(Attr.Approval)
}).check(Schema.makeFilter((attrs) =>
  attrs.repository.startsWith(`${attrs.region}-docker.pkg.dev/${attrs.project}/`)
    ? undefined :
    "CloudRun.Preview repository must match region and project"
))

/** Publishes a private no-traffic preview; never selected by a bare wildcard.
 * Bootstrap the service and IAM identities outside Smithers before running it.
 * @category targets
 * @since 1.0.0
 */
export const Preview = Target.make("CloudRun.Preview", {
  attrs: PreviewAttrs,
  kinds: ["run"],
  cache: false,
  manual: () => true,
  implementation: () => Target.notImplemented("CloudRun.Preview")
})
