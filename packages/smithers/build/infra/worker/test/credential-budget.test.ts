import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { makeCredentialBudget } from "../RateLimitCredentialBudget.ts"
import {
  type ActionCache,
  type ContentStore,
  createHandler,
  type CredentialBudget,
  type CredentialBudgetRoute,
  type ProtocolDependencies
} from "../protocol.ts"

const readToken = "reader-token-held-by-every-pull-request-job"
const writeToken = "writer-token-held-by-post-merge-jobs-only"
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")
const keyDigest = "a".repeat(64)
const digest = "b".repeat(64)

type Charge = readonly [credentialDigest: string, route: CredentialBudgetRoute]

const makeBudget = (refuse: (credentialDigest: string, route: CredentialBudgetRoute) => boolean = () => false) => {
  const charges: Array<Charge> = []
  const budget: CredentialBudget = {
    async charge(credentialDigest, route) {
      charges.push([credentialDigest, route])
      return !refuse(credentialDigest, route)
    }
  }
  return { charges, budget }
}

const makeHandler = (budget?: CredentialBudget) => {
  const touched = { actionGets: 0, probes: 0 }
  const actionCache: ActionCache = {
    async get() {
      touched.actionGets += 1
      return null
    },
    async put() {
      return "inserted"
    },
    async delete() {
      return false
    }
  }
  const contentStore: ContentStore = {
    async get() {
      return null
    },
    async has() {
      return false
    },
    async put() {
      return "inserted"
    },
    async presentDigests() {
      touched.probes += 1
      return new Set<string>()
    }
  }
  const dependencies: ProtocolDependencies = {
    actionCache,
    contentStore,
    readTokenHash: sha256(readToken),
    writeTokenHash: sha256(writeToken),
    ...(budget === undefined ? {} : { credentialBudget: budget })
  }
  return { handler: createHandler(dependencies), touched }
}

const request = (path: string, token: string | null, init: RequestInit = {}): Request =>
  new Request(`https://build.smithers.sh${path}`, {
    ...init,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(init.headers as Record<string, string> | undefined)
    }
  })

const findMissing = (token: string): Request =>
  request("/cas/findMissing", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ digests: [digest] })
  })

/** A body whose only observable behaviour is whether the handler cancelled it. */
const cancellableBody = () => {
  const log: Array<string> = []
  const body = {
    async cancel(): Promise<void> {
      log.push("body-cancel")
    },
    getReader(): never {
      throw new Error("the refused body must not be read")
    }
  }
  return { body, log }
}

const rawRequest = (path: string, token: string, body: unknown, method = "POST"): Request =>
  ({
    url: `https://build.smithers.sh${path}`,
    method,
    headers: new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json" }),
    body
  }) as Request

describe("per-credential budget", () => {
  it("charges each admitted request to the digest of the credential that presented it", async () => {
    const { charges, budget } = makeBudget()
    const { handler } = makeHandler(budget)

    expect((await handler(request(`/ac/${keyDigest}`, readToken))).status).toBe(404)
    expect((await handler(request(`/cas/${digest}`, writeToken, { method: "HEAD" }))).status).toBe(404)
    expect((await handler(findMissing(readToken))).status).toBe(200)

    // `findMissing` draws on both budgets: it is one request, and it is the
    // one route that fans out to a thousand metered probes.
    expect(charges).toEqual([
      [sha256(readToken), "request"],
      [sha256(writeToken), "request"],
      [sha256(readToken), "request"],
      [sha256(readToken), "findMissing"]
    ])
  })

  it("charges nothing for a request refused before its body is read", async () => {
    const { charges, budget } = makeBudget()
    const { handler } = makeHandler(budget)

    expect((await handler(request(`/ac/${keyDigest}`, null))).status).toBe(401)
    expect((await handler(request(`/ac/${keyDigest}`, "not-a-credential"))).status).toBe(401)
    expect((await handler(request("/healthz", null))).status).toBe(200)
    const publication = await handler(
      request(`/ac/${keyDigest}`, readToken, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    )
    expect(publication.status).toBe(403)

    // An unauthenticated caller cannot name a credential's key, and a reader's
    // refused publication is answered before any budget exists to spend.
    expect(charges).toEqual([])
  })

  it("refuses a credential whose request budget is spent before any store is touched", async () => {
    const { budget } = makeBudget((credentialDigest) => credentialDigest === sha256(readToken))
    const { handler, touched } = makeHandler(budget)
    const refusedBody = cancellableBody()

    const refused = await handler(rawRequest("/cas/findMissing", readToken, refusedBody.body))
    const admitted = await handler(request(`/ac/${keyDigest}`, writeToken))

    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).toBe("10")
    await expect(refused.json()).resolves.toEqual({ error: "this credential's request budget is spent" })
    expect(refusedBody.log).toEqual(["body-cancel"])
    // The budget is the credential's, not the isolate's: the writer's own
    // budget is untouched by a reader that spent its own.
    expect(admitted.status).toBe(404)
    expect(touched).toEqual({ actionGets: 1, probes: 0 })
  })

  it("refuses only findMissing when that budget is spent, and plain reads still pass", async () => {
    const { budget } = makeBudget((_, route) => route === "findMissing")
    const { handler, touched } = makeHandler(budget)
    const refusedBody = cancellableBody()

    const probe = await handler(rawRequest("/cas/findMissing", readToken, refusedBody.body))
    const read = await handler(request(`/ac/${keyDigest}`, readToken))

    expect(probe.status).toBe(429)
    expect(probe.headers.get("retry-after")).toBe("10")
    await expect(probe.json()).resolves.toEqual({ error: "this credential's findMissing budget is spent" })
    expect(refusedBody.log).toEqual(["body-cancel"])
    expect(read.status).toBe(404)
    expect(touched).toEqual({ actionGets: 1, probes: 0 })
  })

  it("admits every request when no budget is configured", async () => {
    const { handler, touched } = makeHandler()

    for (let index = 0; index < 50; index += 1) {
      expect((await handler(findMissing(readToken))).status).toBe(200)
    }

    expect(touched.probes).toBe(50)
  })

  it("refuses a budget it cannot snapshot and reports a failing one as a storage refusal", async () => {
    expect(() => makeHandler({ charge: true } as unknown as CredentialBudget)).toThrow(
      "credentialBudget.charge must be a data method"
    )

    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const { handler, touched } = makeHandler({
        charge: async () => {
          throw Object.assign(new Error("binding secret"), { code: "EBINDING" })
        }
      })
      const response = await handler(request(`/ac/${keyDigest}`, readToken))

      expect(response.status).toBe(503)
      expect(touched).toEqual({ actionGets: 0, probes: 0 })
      expect(String(errors.mock.calls[0]?.[0])).toContain("code=EBINDING")
      expect(String(errors.mock.calls[0]?.[0])).not.toContain("binding secret")
    } finally {
      errors.mockRestore()
    }
  })
})

describe("Rate Limiting bindings", () => {
  const binding = (success: boolean) => {
    const keys: Array<string> = []
    return {
      keys,
      limit: async ({ key }: { readonly key: string }) => {
        keys.push(key)
        return { success }
      }
    }
  }

  it("charges the request binding and the findMissing binding under the credential digest", async () => {
    const requests = binding(true)
    const probes = binding(false)
    const budget = makeCredentialBudget(requests, probes, "dev_alice")

    expect(await budget.charge("digest-1", "request")).toBe(true)
    expect(await budget.charge("digest-2", "findMissing")).toBe(false)

    expect(requests.keys).toEqual(["dev_alice/digest-1"])
    expect(probes.keys).toEqual(["dev_alice/digest-2"])
  })
})
