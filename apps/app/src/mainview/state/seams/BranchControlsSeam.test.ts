import { expect, test } from "bun:test"
import { createBranchControlsSeam } from "./BranchControlsSeam"
import type { SeamContext } from "./SeamContext"

test("branch controls send an idempotent HTTP command without secure-context UUID support", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID")
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined })
  const requests: Array<{ url: string; init?: RequestInit }> = []
  try {
    const seam = createBranchControlsSeam({ baseUrl: "http://mini.lan:4000", http: async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      return Response.json({ state: "requested" }, { status: 202 })
    } } as unknown as SeamContext, { ready: () => true })
    expect(await seam.request("sleep", "my branch")).toEqual({ value: "Requested" })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("http://mini.lan:4000/api/branches/my%20branch")
    expect(JSON.parse(String(requests[0]!.init!.body))).toEqual({ op: "sleep" })
    expect(new Headers(requests[0]!.init!.headers).get("Idempotency-Key")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  } finally {
    if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor)
    else delete (crypto as { randomUUID?: unknown }).randomUUID
  }
})
