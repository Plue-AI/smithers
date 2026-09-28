import assert from "node:assert/strict"
import { test } from "node:test"
import { cheapest, clientKey, Sponsor } from "../server/sponsor.mjs"
const model = { id: "cheap", context_length: 32768, pricing: { prompt: "0.000001", completion: "0.000002" } }
const request = (cookie = "smithers_demo=00000000-0000-0000-0000-000000000000", text = "fix") =>
  new Request("https://docs.test/api/playground/model", {
    method: "POST",
    headers: { Origin: "https://docs.test", Cookie: cookie },
    body: JSON.stringify({ messages: [{ role: "user", content: text }], model: "expensive", max_tokens: 100000 })
  })
test("chooses current lowest price and refuses unknown or negative pricing", () => {
  assert.equal(
    cheapest([model, { ...model, id: "free", pricing: { prompt: "0", completion: "0" } }, {
      ...model,
      id: "broken",
      pricing: {}
    }, { ...model, id: "negative", pricing: { prompt: "-1", completion: "0" } }]).id,
    "free"
  )
})
test("durable reservations, fixed output limits, retries, and same-origin gate", async () => {
  let calls = 0
  const sponsor = new Sponsor({
    key: "test-secret",
    database: ":memory:",
    dailyCalls: 1,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/models")) return Response.json({ data: [model] })
      calls++
      assert.equal(init.headers.Authorization, "Bearer test-secret")
      const body = JSON.parse(init.body)
      assert.equal(body.model, "cheap")
      assert.equal(body.max_tokens, 2048)
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "answer" } }] })
    }
  })
  try {
    assert.equal((await sponsor.handle(request(), "https://wrong.test", "203.0.113.7")).status, 403)
    const response = await sponsor.handle(request(), "https://docs.test", "203.0.113.7")
    assert.equal(response.status, 200)
    assert.equal((await response.text()).includes("test-secret"), false)
    assert.equal((await sponsor.handle(request(), "https://docs.test", "203.0.113.7")).status, 200)
    assert.equal(calls, 1)
    assert.equal((await sponsor.handle(request(undefined, "another"), "https://docs.test", "203.0.113.7")).status, 429)
    assert.equal(sponsor.db.prepare("SELECT count(*) AS n FROM attempts").get().n, 1)
  } finally {
    sponsor.close()
  }
})
test("missing sponsored credentials fail honestly without a model request", async () => {
  const sponsor = new Sponsor({
    database: ":memory:",
    fetchImpl: () => {
      throw new Error("must not call")
    }
  })
  try {
    assert.equal((await sponsor.handle(request(), "https://docs.test", "203.0.113.7")).status, 503)
  } finally {
    sponsor.close()
  }
})
test("per-visitor cap keys on the observed client address, not a cookie the client rotates", async () => {
  const sponsor = new Sponsor({
    key: "test-secret",
    database: ":memory:",
    dailyCalls: 1000,
    dailyDollars: 1000,
    fetchImpl: async (url) =>
      url.endsWith("/models")
        ? Response.json({ data: [model] })
        : Response.json({ choices: [{ finish_reason: "stop", message: { content: "answer" } }] })
  })
  try {
    const statuses = []
    for (let i = 0; i < 20; i++) {
      const cookie = i % 2 ? "" : `smithers_demo=${crypto.randomUUID()}`
      statuses.push((await sponsor.handle(request(cookie, `q${i}`), "https://docs.test", "198.51.100.9")).status)
    }
    assert.deepEqual(statuses, [...Array(16).fill(200), ...Array(4).fill(429)])
    // Rotating the interface identifier inside one /64 is the same visitor.
    for (let i = 0; i < 16; i++) {
      const address = `2001:db8:1:2::${(i + 1).toString(16)}`
      assert.equal((await sponsor.handle(request("", `v6-${i}`), "https://docs.test", address)).status, 200)
    }
    assert.equal((await sponsor.handle(request("", "v6-x"), "https://docs.test", "2001:db8:1:2:ffff::1")).status, 429)
    assert.equal((await sponsor.handle(request("", "other"), "https://docs.test", "198.51.100.10")).status, 200)
    for (const missing of [undefined, "", "unknown", "1.2.3.4, 5.6.7.8"]) {
      assert.equal((await sponsor.handle(request("", "none"), "https://docs.test", missing)).status, 403)
    }
    assert.equal(sponsor.db.prepare("SELECT count(*) AS n FROM attempts").get().n, 33)
  } finally {
    sponsor.close()
  }
})
test("client keys normalize IPv4-mapped and compressed IPv6 addresses", () => {
  assert.equal(clientKey("::ffff:203.0.113.7"), "203.0.113.7")
  assert.equal(clientKey("2001:DB8:0:1:aaaa:bbbb:cccc:dddd"), "2001:db8:0:1::/64")
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64")
  assert.equal(clientKey("::1"), "0:0:0:0::/64")
  assert.equal(clientKey("2001:db8:::1"), undefined)
})
