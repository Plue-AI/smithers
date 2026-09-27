import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import { readWranglerConfig } from "../src/wranglerConfig"
import { stripComments } from "./effect-policy"
import { compareBridge, compareDurableObjects, compareObservability, compareVars } from "./adopt-durable-objects"
import type { LiveBinding } from "./adopt-durable-objects"

const live: ReadonlyArray<LiveBinding> = WORKER_IDENTITY.durableObjects.map((binding) => ({
  type: "durable_object_namespace",
  name: binding.binding,
  class_name: binding.className
}))

describe("compareDurableObjects", () => {
  test("the authorized v5 vault addition is allowed before it exists live; existing storage still cannot disappear", () => {
    const findings = compareDurableObjects(WORKER_IDENTITY.durableObjects, live.filter(binding => binding.name !== "MODEL_VAULTS"), "smithers-mvp-web")
    expect(findings.some(f => f.level === "FAIL")).toBe(false)
    expect(findings.find(f => f.check.includes("MODEL_VAULTS"))?.level).toBe("INFO")
    const renamed = live.map(b => b.name === "MODEL_VAULTS" ? { ...b, class_name: "OtherVault" } : b)
    expect(compareDurableObjects(WORKER_IDENTITY.durableObjects, renamed, "smithers-mvp-web").some(f => f.level === "FAIL")).toBe(true)
  })
  test("the live script matching the declaration is all PASS", () => {
    const findings = compareDurableObjects(WORKER_IDENTITY.durableObjects, live, "smithers-mvp-web")
    expect(findings.map((f) => f.level)).toEqual(WORKER_IDENTITY.durableObjects.map(() => "PASS"))
  })

  test("a live binding the declaration lacks is a deletion, so FAIL", () => {
    const findings = compareDurableObjects(WORKER_IDENTITY.durableObjects.slice(1), live, "smithers-mvp-web")
    const fail = findings.find((f) => f.level === "FAIL")
    expect(fail?.detail).toContain("DELETE class TurnCancelRegistry")
  })

  test("a declared binding the live script lacks is an empty new class, so FAIL", () => {
    const findings = compareDurableObjects(WORKER_IDENTITY.durableObjects, live.slice(1), "smithers-mvp-web")
    const fail = findings.find((f) => f.level === "FAIL")
    expect(fail?.detail).toContain("CREATE an empty class TurnCancelRegistry")
  })

  test("a class name that differs under the same binding name is a rename, so FAIL", () => {
    const renamed = live.map((b) => (b.name === "TURN_LIMITS" ? { ...b, class_name: "TurnLimiter" } : b))
    const findings = compareDurableObjects(WORKER_IDENTITY.durableObjects, renamed, "smithers-mvp-web")
    expect(findings.find((f) => f.level === "FAIL")?.detail).toContain("RENAME")
  })

  test("a cross-script binding on the live script is not this script's class", () => {
    const foreign: LiveBinding = { type: "durable_object_namespace", name: "OTHER", class_name: "Other", script_name: "elsewhere" }
    const findings = compareDurableObjects(WORKER_IDENTITY.durableObjects, [...live, foreign], "smithers-mvp-web")
    expect(findings.every((f) => f.level === "PASS")).toBe(true)
  })
})

describe("compareVars", () => {
  const plain: ReadonlyArray<LiveBinding> = Object.entries(WORKER_IDENTITY.vars).map(([name, text]) => ({ type: "plain_text", name, text }))
  test("the optional vault key is named and cannot block the first deployment", () => {
    expect(Object.keys(WORKER_IDENTITY.secrets)).not.toContain("MODEL_VAULT_KEY")
    expect(WORKER_IDENTITY.optionalVars).toContain("MODEL_VAULT_KEY")
    expect(compareVars(plain).filter(f => f.check.includes("MODEL_VAULT_KEY")).every(f => f.level !== "FAIL")).toBe(true)
  })

  /*
   * wrangler uploads with `keep_bindings: ["secret_text"]`, so a live secret
   * survives a deploy from a shell that does not carry it. The preflight
   * therefore reports presence and never asks for a value: there is no
   * environment argument to read one from.
   */
  test("a live secret is a PASS that says the deploy keeps it", () => {
    const findings = compareVars([...plain, { type: "secret_text", name: "CEREBRAS_API_KEY" }])
    const pass = findings.find((f) => f.check === "secret CEREBRAS_API_KEY")
    expect(pass?.level).toBe("PASS")
    expect(pass?.detail).toContain("keeps it")
  })

  // The shared backend, not this edge, holds active model credentials.
  test("retained model credentials are not dependencies of the stateless edge", () => {
    const fail = compareVars(plain).find((f) => f.check === "secret AI_GATEWAY_API_KEY")
    expect(fail?.level).toBe("INFO")
    expect(fail?.detail).toContain("retained only for migration and rollback")
    expect(fail?.detail).toContain("wrangler secret put")
  })

  test("an optional secret that is not live is an INFO stating its own absent state", () => {
    const info = compareVars(plain).find((f) => f.check === "secret PLUE_WORKER_EXCHANGE_TOKEN")
    expect(info?.level).toBe("INFO")
    expect(info?.detail).toContain("retained only for migration and rollback")
    expect(info?.detail).not.toContain("501")
  })

  test("every declared secret that is not live reports its declared level and absent state", () => {
    const findings = compareVars(plain)
    for (const [name, secret] of Object.entries(WORKER_IDENTITY.secrets)) {
      const finding = findings.find((f) => f.check === `secret ${name}`)
      expect(`${name}: ${finding?.level}`).toBe(`${name}: ${secret.required ? "FAIL" : "INFO"}`)
      expect(finding?.detail).toContain(secret.absent)
    }
  })

  test("with every declared secret live, no secret finding fails", () => {
    const secrets: ReadonlyArray<LiveBinding> = Object.keys(WORKER_IDENTITY.secrets).map((name) => ({ type: "secret_text", name }))
    expect(compareVars([...plain, ...secrets]).filter((f) => f.check.startsWith("secret ") && f.level !== "PASS")).toEqual([])
  })

  test("no finding ever carries a value, because none is read", () => {
    const findings = compareVars([...plain, { type: "secret_text", name: "CEREBRAS_API_KEY", text: "sk-live-value" }])
    expect(JSON.stringify(findings)).not.toContain("sk-live-value")
  })

  test("a frozen var whose live value differs is a FAIL", () => {
    const drifted = plain.map((b) => (b.name === "SMITHERS_BACKEND_ORIGIN" ? { ...b, text: "https://elsewhere" } : b))
    expect(compareVars(drifted).find((f) => f.check === "var SMITHERS_BACKEND_ORIGIN")?.level).toBe("FAIL")
  })

  test("a frozen var missing live is a WARN the deploy resolves", () => {
    expect(compareVars(plain.slice(1)).find((f) => f.check === `var ${plain[0]!.name}`)?.level).toBe("WARN")
  })

  test("an undeclared live var is a WARN naming the drop", () => {
    const findings = compareVars([...plain, { type: "plain_text", name: "SOMETHING_OLD", text: "1" }])
    expect(findings.find((f) => f.check === "live var SOMETHING_OLD")?.detail).toContain("DROPS")
  })

  /*
   * A name outside src/workerIdentity.ts feeds nothing the Worker reads. The
   * deploy keeps it like any secret, so retiring it is a hand step, and the
   * preflight says so instead of failing every deploy over a leftover.
   */
  test("an UNDECLARED live secret is a WARN that names the retirement command", () => {
    const warn = compareVars([...plain, { type: "secret_text", name: "GATEWAY_UPSTREAM_TOKEN" }]).find((f) => f.check === "live secret GATEWAY_UPSTREAM_TOKEN")
    expect(warn?.level).toBe("WARN")
    expect(warn?.detail).toContain("wrangler secret delete")
  })

  test("an optional knob living as a secret is a kept knob, not an undeclared secret", () => {
    const findings = compareVars([...plain, { type: "secret_text", name: "CEREBRAS_MODEL_LIBRARIAN" }])
    expect(findings.find((f) => f.check === "knob CEREBRAS_MODEL_LIBRARIAN")?.level).toBe("PASS")
    expect(findings.find((f) => f.check === "live secret CEREBRAS_MODEL_LIBRARIAN")).toBeUndefined()
  })

  /*
   * wrangler replaces the plain-text set with wrangler.jsonc `vars`, which
   * never lists a knob, so a knob a Wrangler-era deploy bound as plain_text
   * is the one thing this deploy loses; the report says how to keep it.
   */
  test("a knob still bound as plain_text is a WARN pointing at `wrangler secret put`", () => {
    const findings = compareVars([...plain, { type: "plain_text", name: "UPSTREAM_TIMEOUT_MS", text: "20000" }])
    const warn = findings.find((f) => f.check === "knob UPSTREAM_TIMEOUT_MS")
    expect(warn?.level).toBe("WARN")
    expect(warn?.detail).toContain("wrangler secret put")
    expect(findings.find((f) => f.check === "live var UPSTREAM_TIMEOUT_MS")).toBeUndefined()
  })

  test("a knob the live script does not carry is not reported at all", () => {
    expect(compareVars(plain).filter((f) => f.check.startsWith("knob "))).toEqual([])
  })
})

/*
 * The script is read-only. It used to carry a `--apply` branch that deployed
 * directly, skipping the site build, the sha stamp and the receipt every
 * canary probe grades the deployment against.
 */
describe("the preflight never deploys", () => {
  const code = stripComments(readFileSync(new URL("./adopt-durable-objects.ts", import.meta.url), "utf8"))

  test("no --apply flag and no process spawn", () => {
    expect(code).not.toContain("--apply")
    expect(code).not.toContain("Bun.spawn")
    expect(code).not.toContain("wrangler deploy")
  })

  test("no flag can make a dropped secret acceptable, because the deploy drops none", () => {
    expect(code).not.toContain("--allow-secret-drop")
    expect(code).not.toContain("process.env[")
  })

  test("the header points at the one deploy path", () => {
    const header = readFileSync(new URL("./adopt-durable-objects.ts", import.meta.url), "utf8").split("*/")[0]!
    expect(header).toContain("bun scripts/deploy.ts")
    expect(header).toContain("It never deploys")
  })
})

test("wrangler.jsonc agrees with src/workerIdentity.ts", () => {
  expect(compareBridge().map((f) => f.level)).toEqual(["PASS", "PASS", "PASS"])
})

/*
 * Workers Logs. Several failure signals (client-error export skips, GitHub
 * App failures, upstream timeouts) exist only as console lines, so a script
 * without persisted logs loses them unless someone runs `wrangler tail`.
 */
describe("Workers Logs", () => {
  test("a wrangler.jsonc that drops the observability block fails the bridge", () => {
    const { observability: _dropped, ...config } = readWranglerConfig()
    const finding = compareBridge(config).find((f) => f.check === "wrangler.jsonc observability")
    expect(finding?.level).toBe("FAIL")
  })

  test("a live script that keeps no logs is a WARN the deploy resolves", () => {
    for (const live of [null, undefined, { enabled: false }]) {
      const finding = compareObservability(live)
      expect(finding.level).toBe("WARN")
      expect(finding.detail).toContain("no logs")
    }
  })

  test("a live script with Workers Logs on is a PASS", () => {
    expect(compareObservability({ enabled: true, head_sampling_rate: 1 }).level).toBe("PASS")
  })
})
