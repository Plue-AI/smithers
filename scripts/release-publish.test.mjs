import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { registryPublisher } from "./publish-release.mjs"

// Exercise the production registry boundary without publishing or waiting.
const fixture = (responses) => {
  const calls = []
  const adapter = registryPublisher({
    run: (command, args) => {
      assert.equal(command, "pnpm")
      calls.push(args)
      const response = responses[args[0]].shift()
      assert.notEqual(response, undefined, `Unexpected registry call: ${args.join(" ")}`)
      if (response instanceof Error) throw response
      if (typeof response === "string" && response.startsWith("sha512-")) return JSON.stringify(response)
      if (response !== 200) throw Object.assign(new Error(`E${response}`), { stdout: `E${response}` })
      return '"sha512-verified"'
    },
    pause: (seconds) => calls.push(["sleep", String(seconds)])
  })
  return { adapter, calls }
}

test("new names publish with provenance from a detached tag checkout", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
  const { adapter, calls } = fixture({ view: [404], publish: [200] })
  assert.equal(adapter.readRegistry("@smthrs/kernel@1.0.0-rc.0"), undefined)
  adapter.publish("kernel.tgz", { version: "1.0.0-rc.0" })
  assert.deepEqual(calls[1], ["publish", "kernel.tgz", "--provenance", "--access", "public", "--tag", "next", "--no-git-checks"])
})

// pnpm 11 answers a missing version of an existing name without a 404; the
// v1.0.0-rc.1 tag run 37963844319 stopped on it before publishing anything.
test("a missing version of an existing name and a new name both read as absent", () => {
  const pnpmViewFailure = (code, message) => Object.assign(new Error("Command failed: pnpm view"), {
    status: 1,
    stdout: `{\n  "error": {\n    "code": "${code}",\n    "message": "${message}"\n  }\n}\n`,
    stderr: ""
  })
  const adapter = registryPublisher({
    run: (command, [, spec]) => {
      if (spec === "@smthrs/errors@1.0.0-rc.1") throw pnpmViewFailure("ERR_PNPM_PACKAGE_NOT_FOUND", "No matching version found for @smthrs/errors@1.0.0-rc.1")
      throw pnpmViewFailure("ERR_PNPM_FETCH_404", "GET https://registry.npmjs.org/@smthrs%2Fcanonical: Not Found - 404")
    },
    pause: () => assert.fail("an absent version is not transient")
  })
  assert.equal(adapter.readRegistry("@smthrs/errors@1.0.0-rc.1"), undefined)
  assert.equal(adapter.readRegistry("@smthrs/canonical@1.0.0-rc.1"), undefined)
})

test("already published versions return their exact integrity for candidate verification", () => {
  const { adapter, calls } = fixture({ view: [200], publish: [] })
  assert.equal(adapter.readRegistry("@smthrs/kernel@1.0.0-rc.0"), "sha512-verified")
  assert.deepEqual(calls.map(([command]) => command), ["view"])
})

test("transient prechecks back off before deciding whether to publish", () => {
  const { adapter, calls } = fixture({ view: [429, 503, 500, 404], publish: [] })
  assert.equal(adapter.readRegistry("@smthrs/kernel@1.0.0-rc.0"), undefined)
  assert.deepEqual(calls.filter(([command]) => command === "sleep"), [["sleep", "10"], ["sleep", "30"], ["sleep", "60"]])
})

test("an exhausted or unauthorized precheck fails closed", () => {
  for (const failures of [[429, 503, 500, 503], [401]]) {
    const { adapter, calls } = fixture({ view: failures, publish: [] })
    assert.throws(() => adapter.readRegistry("@smthrs/kernel@1.0.0-rc.0"))
    assert.equal(calls.some(([command]) => command === "publish"), false)
  }
})

test("publication retries use all three delays and stop after exhaustion", () => {
  for (const last of [200, 503]) {
    const { adapter, calls } = fixture({ view: [404, 404, 404, 404], publish: [503, 503, 503, last] })
    const publish = () => adapter.publish("kernel.tgz", { name: "@smthrs/kernel", version: "1.0.0-rc.0", integrity: "sha512-verified" })
    if (last === 200) publish()
    else assert.throws(publish)
    assert.equal(calls.filter(([command]) => command === "publish").length, 4)
    assert.deepEqual(calls.filter(([command]) => command === "sleep"), [["sleep", "10"], ["sleep", "30"], ["sleep", "60"]])
  }
})

test("registry socket, timeout and temporary DNS failures use bounded retries", () => {
  for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ESOCKETTIMEDOUT", "EAI_AGAIN", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"]) {
    const error = Object.assign(new Error("registry transport failed"), { code })
    const { adapter, calls } = fixture({ view: [error, error, error, 200], publish: [] })
    assert.equal(adapter.readRegistry("@smthrs/kernel@1.0.0-rc.0"), "sha512-verified")
    assert.deepEqual(calls.filter(([command]) => command === "sleep"), [["sleep", "10"], ["sleep", "30"], ["sleep", "60"]])
  }
  const error = new Error("socket hang up")
  const { adapter, calls } = fixture({ view: [error, error, error, error], publish: [] })
  assert.throws(() => adapter.readRegistry("@smthrs/kernel@1.0.0-rc.0"), /socket hang up/)
  assert.equal(calls.filter(([command]) => command === "view").length, 4)
})

test("a lost publication acknowledgement checks exact registry bytes before retrying", () => {
  const entry = { name: "@smthrs/kernel", version: "1.0.0-rc.0", integrity: "sha512-verified" }
  const error = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
  for (const present of [false, true]) {
    const { adapter, calls } = fixture({ view: [present ? 200 : 404], publish: [error, 200] })
    adapter.publish("kernel.tgz", entry)
    assert.deepEqual(calls.map(([command]) => command), present ? ["publish", "view"] : ["publish", "view", "sleep", "publish"])
    assert.deepEqual(calls[1], ["view", "@smthrs/kernel@1.0.0-rc.0", "dist.integrity", "--json"])
  }
  const { adapter, calls } = fixture({ view: ["sha512-other"], publish: [error] })
  assert.throws(() => adapter.publish("kernel.tgz", entry), /Registry integrity mismatch/)
  assert.deepEqual(calls.map(([command]) => command), ["publish", "view"])
})

test("credentials, TLS trust failures and other permanent errors never retry", () => {
  for (const error of [new Error("E401"), new Error("E403"), Object.assign(new Error("certificate rejected"), { code: "CERT_HAS_EXPIRED" }), new Error("unknown registry failure")]) {
    const { adapter, calls } = fixture({ view: [error], publish: [error] })
    assert.throws(() => adapter.readRegistry("@smthrs/kernel@1.0.0-rc.0"), (cause) => cause === error)
    assert.throws(() => adapter.publish("kernel.tgz", { name: "@smthrs/kernel", version: "1.0.0-rc.0", integrity: "sha512-verified" }), (cause) => cause === error)
    assert.deepEqual(calls.map(([command]) => command), ["view", "publish"])
  }
})
