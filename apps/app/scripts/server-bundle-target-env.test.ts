import { expect, test } from "bun:test"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")
const revision = "0123456789abcdef".repeat(2) + "01234567"
const forwardedSettings = ["CARGO_BUILD_JOBS", "GOMAXPROCS", "GOFLAGS", "GOCACHE", "SMITHERS_NODE_BINARY"] as const

const declaredEnvironments = (overrides: Readonly<Record<string, string>>): Record<string, Record<string, string>> => {
  const env = { ...process.env }
  for (const name of forwardedSettings) delete env[name]
  const result = Bun.spawnSync(["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", `
const { Package } = await import(${JSON.stringify(resolve(root, "apps/app/PACKAGE.ts"))})
const Target = await import(${JSON.stringify(resolve(root, "packages/smithers/build/targets/src/Target.ts"))})
console.log(JSON.stringify(Object.fromEntries(["serverBundle", "serverBundleIntegration"].map(name => [name, Target.metadata(Package[name]).attrs.env]))))
`], {
    cwd: root,
    env: { ...env, SMITHERS_BUILD_SHA: revision, UNRELATED_OPERATOR_SETTING: "must-not-be-declared", ...overrides },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(new TextDecoder().decode(result.stderr)).toBe("")
  expect(result.exitCode).toBe(0)
  return JSON.parse(new TextDecoder().decode(result.stdout))
}

// Oracle: user QA ruling 2026-10-02 and T-INS-01 Node pin exception;
// operator controls and the supported Node override must reach both declared targets.
for (const [label, overrides] of [
  ["all defined controls", { CARGO_BUILD_JOBS: "4", GOMAXPROCS: "4", GOFLAGS: "-p=4 -trimpath", GOCACHE: "/operator/cache-mvp" }],
  ["no controls", {}],
  ["a defined empty control and one limit", { GOFLAGS: "", CARGO_BUILD_JOBS: "4" }],
  ["the Node override alone", { SMITHERS_NODE_BINARY: "/operator/node-26/bin/node" }],
  ["the Node override with all controls", { SMITHERS_NODE_BINARY: "/operator/node-26/bin/node", CARGO_BUILD_JOBS: "4", GOMAXPROCS: "4", GOFLAGS: "-p=4", GOCACHE: "/operator/cache-mvp" }],
  ["an explicitly empty Node override", { SMITHERS_NODE_BINARY: "" }],
] as const) {
  test(`both bundle targets preserve ${label} and omit undefined settings`, () => {
    const declarations = declaredEnvironments(overrides)
    const expected = { SMITHERS_BUILD_SHA: revision, ...overrides }
    expect(declarations).toEqual({ serverBundle: expected, serverBundleIntegration: expected })
    for (const name of ["serverBundle", "serverBundleIntegration"]) {
      for (const setting of forwardedSettings) {
        expect(Object.hasOwn(declarations[name], setting)).toBe(Object.hasOwn(overrides, setting))
      }
    }
  }, 30_000)
}
