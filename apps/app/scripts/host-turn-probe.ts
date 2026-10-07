/** Probe the same admission and durable completion that the composer reads. */
export async function probeHostTurn(origin: string, fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, headers: Record<string, string>, idempotencyKey: string): Promise<{ status: number; completed: boolean; body: string }> {
  const admission = await fetchImpl(`${origin}/api/conversations/main/prompt`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Say the word ok and nothing else.", idempotencyKey }),
    signal: AbortSignal.timeout(20_000)
  })
  const body = await admission.text()
  if (admission.status !== 202) return { status: admission.status, completed: false, body }
  const accepted: unknown = JSON.parse(body)
  if (typeof accepted !== "object" || accepted === null || !("turnId" in accepted) || typeof accepted.turnId !== "string") throw new Error("Invalid prompt admission")
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const response = await fetchImpl(`${origin}/api/conversations/main`, { headers, signal: AbortSignal.timeout(20_000) })
    if (!response.ok) return { status: response.status, completed: false, body: await response.text() }
    const replay: unknown = await response.json()
    if (typeof replay !== "object" || replay === null || !("entries" in replay) || !Array.isArray(replay.entries)) throw new Error("Invalid conversation replay")
    const turn = replay.entries.find((entry: unknown) => typeof entry === "object" && entry !== null && "id" in entry && entry.id === accepted.turnId)
    if (turn?.state === "completed") return { status: 202, completed: true, body: JSON.stringify(turn) }
    if (turn && ["failed", "cancelled", "uncertain"].includes(turn.state)) return { status: 202, completed: false, body: JSON.stringify(turn) }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return { status: 202, completed: false, body: "Turn did not complete" }
}
