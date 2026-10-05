import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Smithers as S } from "../src/index.ts"
import * as Target from "../src/Target.ts"

const image = S.Docker.Build({ dockerfile: S.file("Dockerfile"), context: ".", platforms: ["linux/amd64"] })
const attrs = {
  image,
  project: "fixture-project",
  region: "us-central1",
  service: "preview",
  repository: "us-central1-docker.pkg.dev/fixture-project/images",
  deployer: "deployer@fixture-project.iam.gserviceaccount.com",
  serviceAccount: "runtime@fixture-project.iam.gserviceaccount.com"
}
describe("CloudRun.Preview declaration", () => {
  it("is manual and uncached and accepts private defaults", () => {
    const target = S.CloudRun.Preview(attrs)
    expect(Target.metadata(target)).toMatchObject({ target: "CloudRun.Preview", manual: true, cacheable: false })
    expect(S.CloudRun.Preview.kinds).toEqual(["run"])
  })
  it.each(Object.keys(attrs))("requires %s", (key) => {
    const candidate: Record<string, unknown> = { ...attrs }
    delete candidate[key]
    expect(() => Schema.decodeUnknownSync(S.CloudRun.Preview.attrs)(candidate)).toThrow()
  })
  it.each([
    ["image", S.Shell.Run({ shell: "true" })],
    ["project", "bad/project"],
    ["region", "--flag"],
    ["service", "bad service"],
    ["repository", "us-central1-docker.pkg.dev/other/images"],
    ["repository", "other-docker.pkg.dev/fixture-project/images"],
    ["deployer", "--flag"],
    ["serviceAccount", "x\ny"],
    ["env", { KEY: "a\nb" }],
    ["env", { "bad-key": "x" }],
    ["env", { KEY: 1 }],
    ["env", { KEY: "x".repeat(32769) }],
    ["access", "anonymous"],
    ["expires", "169h"],
    ["expires", "0h"],
    ["expires", "72"],
    ["approval", "optional"]
  ])("refuses invalid %s", (key, value) => {
    expect(() => Schema.decodeUnknownSync(S.CloudRun.Preview.attrs)({ ...attrs, [key as string]: value })).toThrow()
  })
  it("accepts bounded environment, expiration, approval and public declarations for executor refusal", () => {
    expect(() =>
      S.CloudRun.Preview({ ...attrs, env: { VALUE: "a,b=c" }, expires: "168h", access: "public", approval: "required" })
    ).not.toThrow()
  })
  it("accepts the exact environment byte limit and refuses one byte beyond it", () => {
    expect(() => S.CloudRun.Preview({ ...attrs, env: { KEY: "x".repeat(32758) } })).not.toThrow()
    expect(() => S.CloudRun.Preview({ ...attrs, env: { KEY: "x".repeat(32759) } })).toThrow()
    expect(() => S.CloudRun.Preview({ ...attrs, env: { KEY: "é".repeat(16379) } })).not.toThrow()
    expect(() => S.CloudRun.Preview({ ...attrs, env: { KEY: "é".repeat(16380) } })).toThrow()
    expect(() =>
      S.CloudRun.Preview({
        ...attrs,
        env: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`K${index}`, ""]))
      })
    ).toThrow()
    expect(() => S.CloudRun.Preview({ ...attrs, env: { KEY: "a\0b" } })).toThrow()
  })
})
