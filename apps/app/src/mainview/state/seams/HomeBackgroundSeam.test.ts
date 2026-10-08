import { expect, test } from "bun:test"
import { createHomeBackgroundSeam } from "./HomeBackgroundSeam"
import type { Session } from "../AppState"
import { waitFor } from "../TestFixtures"

test("Learning Retry persists and acknowledges before launch, deduplicates and waits for real completion", async () => {
  const id = "00000000-0000-4000-8000-000000000007"
  let rows: NonNullable<Session["homeBackgroundRequests"]> = []
  let launch!: (response: Response) => void
  let finish!: (response: Response) => void
  let posts = 0, settled = 0
  const paths: string[] = []
  const seam = createHomeBackgroundSeam({
    owner: () => "Ben", load: () => rows, save: async value => { rows = value },
    report: error => { throw error }, pollMs: 1,
    http: async (path, init) => {
      paths.push(path)
      if (init?.method === "POST") { posts++; return new Promise(resolve => { launch = resolve }) }
      return new Promise(resolve => { finish = resolve })
    },
    withToast: async (_key, _start, _done, body) => { const result = await body(); settled++; return result }
  })
  try {
    expect(await seam.control(id, "retry")).toEqual({ value: "Requested" })
    expect(rows[0]?.state).toBe("requested")
    await waitFor(() => posts === 1)
    expect(await seam.control(id, "retry")).toEqual({ value: "Requested" })
    expect(posts).toBe(1); expect(settled).toBe(0)
    launch(Response.json({ state: "accepted", run_id: id }))
    await waitFor(() => finish !== undefined)
    expect(rows[0]?.run_id).toBe(id); expect(settled).toBe(0)
    finish(Response.json({ state: "success", run_id: id }))
    await waitFor(() => settled === 1)
    expect(rows[0]?.state).toBe("completed")
    expect(paths).toEqual([`/api/runs/${id}`, `/api/runs/${id}/background-status`])
  } finally { seam.dispose() }
})

test("Learning Dismiss accepts durable IDs and retains retryable failures", async () => {
  const id = "00000000-0000-4000-8000-000000000008"
  let rows: NonNullable<Session["homeBackgroundRequests"]> = []
  let calls = 0
  const seam = createHomeBackgroundSeam({
    owner: () => "Ben", load: () => rows, save: async value => { rows = value },
    report: error => { throw error },
    http: async () => { calls++; return calls === 1 ? new Response("", { status: 503 }) : Response.json({ state: "dismissed", run_id: id }) },
    withToast: async (_key, _start, _done, body) => body()
  })
  try {
    expect(await seam.control(id, "dismiss")).toEqual({ value: "Requested" })
    await waitFor(() => rows[0]?.state === "failed")
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await seam.control(id, "dismiss")).toEqual({ value: "Requested" })
    await waitFor(() => rows[0]?.state === "completed")
    expect(calls).toBe(2)
    expect(await seam.control("garbage", "retry")).toBe("Background runs unavailable")
  } finally { seam.dispose() }
})
