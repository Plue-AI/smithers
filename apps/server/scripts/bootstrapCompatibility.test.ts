import { afterAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { checkBootstrapCompatibility } from "./bootstrapCompatibility"
import { PublicationRefusal, rollout, type RolloutReceipt } from "../../../flows/rollout/runtime.ts"

const bootstrap = {
  apiVersion: 1, host: "cloud", version: "1", buildSha: "b".repeat(40),
  capabilities: ["identity", "workspace", "agent", "workspace.deploy"], authFlow: "redirect", sandbox: null
}

// Real HTTP covers JSON/HTTP boundaries without depending on or mutating production.
let response = () => Response.json(bootstrap)
const requests: Array<{ accept: string | null; cacheControl: string | null }> = []
const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
  requests.push({ accept: request.headers.get("accept"), cacheControl: request.headers.get("cache-control") })
  return response()
} })
afterAll(() => backend.stop(true))
const read = (input: URL, init: RequestInit): Promise<Response> => {
  expect(String(input)).toBe("https://backend.example/api/bootstrap")
  expect(init?.redirect).toBe("error")
  expect(init?.signal).toBeInstanceOf(AbortSignal)
  return fetch(new URL("/api/bootstrap", backend.url), init)
}

test("candidate frontend validates a real backend bootstrap and records independent backend identity", async () => {
  response = () => Response.json(bootstrap)
  requests.length = 0
  const receipt = await checkBootstrapCompatibility("https://backend.example", read)
  expect(receipt).toMatchObject({ backendOrigin: "https://backend.example", backendBuildSha: bootstrap.buildSha,
    apiVersion: 1, capabilities: ["identity", "agent"] })
  expect(Number.isFinite(Date.parse(receipt.checkedAt))).toBe(true)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toEqual({ accept: "application/json", cacheControl: "no-cache" })
})

test("rejects real HTTP/JSON/schema failures without retaining backend bodies", async () => {
  for (const [reply, failure] of [
    [() => new Response("PRIVATE_BACKEND_BODY", { status: 503 }), "BOOTSTRAP_COMPATIBILITY_HTTP_503"],
    [() => new Response("PRIVATE_BACKEND_BODY"), "BOOTSTRAP_COMPATIBILITY_JSON"],
    [() => Response.json({ ...bootstrap, apiVersion: 2 }), "BOOTSTRAP_COMPATIBILITY_SCHEMA"],
    [() => Response.json({ ...bootstrap, capabilities: ["identity", null] }), "BOOTSTRAP_COMPATIBILITY_SCHEMA"],
    [() => Response.json({ apiVersion: 1 }), "BOOTSTRAP_COMPATIBILITY_SCHEMA"],
    [() => Response.json(null), "BOOTSTRAP_COMPATIBILITY_SCHEMA"]
  ] as const) {
    response = reply
    await expect(checkBootstrapCompatibility("https://backend.example", read)).rejects.toThrow(failure)
  }
})

test("rejects unreachable and timed-out reads", async () => {
  for (const error of [new TypeError("PRIVATE_NETWORK_DETAIL"), new DOMException("Timeout", "TimeoutError")]) {
    await expect(checkBootstrapCompatibility("https://backend.example", async () => { throw error }))
      .rejects.toThrow("BOOTSTRAP_COMPATIBILITY_UNREACHABLE")
  }
})

test.each(["", "not-url", "http://backend.example", "https://user:secret@backend.example", "https://backend.example/path",
  "https://backend.example?secret=value", "https://backend.example#fragment"])("refuses invalid backend origin %s before fetching", async origin => {
  await expect(checkBootstrapCompatibility(origin, async () => { throw Error("must not fetch") }))
    .rejects.toThrow("BOOTSTRAP_COMPATIBILITY_ORIGIN")
})

test("incompatible live bootstrap refuses rollout before any publication or rollback, even with healthy baseline", async () => {
  response = () => Response.json({ ...bootstrap, capabilities: [false] })
  const events: string[] = []
  const receipts: RolloutReceipt[] = []
  const receipt = await rollout({
    lastReceipt: async () => null, capture: async () => ({ version: "live-version", revision: "a".repeat(40) }),
    checks: ["health"], rollbackChecks: ["health"], check: async () => ({ status: "passed" }),
    beforePublish: async () => {
      events.push("bootstrap")
      try { await checkBootstrapCompatibility("https://backend.example", read) }
      catch { throw new PublicationRefusal("bootstrap-compatibility") }
    },
    publish: async () => { events.push("publish"); return { version: "candidate", revision: "c".repeat(40) } },
    restore: async () => { events.push("rollback") }, record: async receipt => { receipts.push(structuredClone(receipt)) }
  })
  expect(events).toEqual(["bootstrap"])
  expect(receipt).toMatchObject({ status: "refused", candidate: null, failedChecks: ["bootstrap-compatibility"], rollback: "not-needed" })
  expect(receipts.at(-1)).toEqual(receipt)
})

test("compatible bootstrap permits publication only after its live check", async () => {
  response = () => Response.json(bootstrap)
  const events: string[] = []
  const receipt = await rollout({
    lastReceipt: async () => null, capture: async () => ({ version: "live-version", revision: "a".repeat(40) }),
    checks: ["health"], rollbackChecks: ["health"], check: async (_name, _release, phase) => {
      events.push(phase); return { status: "passed" }
    },
    beforePublish: async () => {
      await checkBootstrapCompatibility("https://backend.example", read)
      events.push("bootstrap")
    },
    publish: async () => { events.push("publish"); return { version: "candidate", revision: "c".repeat(40) } },
    restore: async () => { events.push("rollback") }, record: async () => {}
  })
  expect(events).toEqual(["baseline", "bootstrap", "publish", "candidate"])
  expect(receipt).toMatchObject({ status: "passed", failedChecks: [], rollback: "not-needed" })
})

test("the deploy path wires the candidate decoder before publish and retains its receipt", () => {
  const deploy = readFileSync(new URL("./deploy.ts", import.meta.url), "utf8")
  const beforePublish = deploy.slice(deploy.indexOf("beforePublish: async"), deploy.indexOf("publish: async"))
  expect(beforePublish).toContain("checkBootstrapCompatibility(readWranglerConfig().vars.SMITHERS_BACKEND_ORIGIN!")
  expect(beforePublish).toContain('PublicationRefusal("bootstrap-compatibility")')
  expect(deploy.slice(deploy.indexOf("const receipt ="))).toContain("bootstrapCompatibility,")
})
