import { WORKER_IDENTITY } from "../../src/workerIdentity"
import { target } from "./targets"

export const accountURL = `https://api.cloudflare.com/client/v4/accounts/${WORKER_IDENTITY.accountId}`
export const scriptPath = `/workers/scripts/${target.name}`
export interface Binding { type: string; name: string; namespace_id?: string; class_name?: string; script_name?: string; [key: string]: unknown }
export interface Settings { bindings: Binding[]; compatibility_date: string; compatibility_flags: string[]; [key: string]: unknown }
export interface Envelope<T> { result: T; success: boolean; result_info?: { cursor?: string; total_pages?: number } }
export const api = async <T>(path: string, init?: RequestInit): Promise<Envelope<T>> => {
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) throw new Error("Cloudflare credential unavailable")
  const response = await fetch(accountURL + path, { ...init, redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${token}`, ...init?.headers } })
  if (!response.ok) throw new Error(`Cloudflare request failed (${response.status}); response withheld`)
  const body = await response.json() as Envelope<T>
  if (!body.success) throw new Error("Cloudflare request refused; response withheld")
  return body
}
export const validateBindings = (settings: Settings) => {
  const owned = settings.bindings.filter(binding => binding.type === "durable_object_namespace")
  if (owned.length !== target.durableObjects.length) throw new Error("Durable Object set drifted")
  for (const expected of target.durableObjects) {
    const matches = owned.filter(binding => binding.name === expected.binding && binding.class_name === expected.className &&
      (binding.script_name === undefined || binding.script_name === target.name) && /^[a-f0-9]{32}$/.test(binding.namespace_id ?? ""))
    if (matches.length !== 1) throw new Error("Durable Object identity drifted")
  }
  return owned
}
export const listObjects = async (namespace: string): Promise<Array<{ id: string; hasStoredData: boolean }>> => {
  const objects = new Map<string, { id: string; hasStoredData: boolean }>()
  const cursors = new Set<string>()
  let cursor = ""
  for (;;) {
    const page = await api<Array<{ id: string; hasStoredData: boolean }>>(`/workers/durable_objects/namespaces/${namespace}/objects?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
    for (const value of page.result) {
      if (!/^[a-f0-9]{64}$/.test(value.id) || typeof value.hasStoredData !== "boolean" || objects.has(value.id)) throw new Error("Object listing is invalid or repeated")
      objects.set(value.id, value)
    }
    cursor = page.result_info?.cursor ?? ""
    if (!cursor || page.result.length === 0) break
    if (cursors.has(cursor)) throw new Error("Object listing cursor repeated")
    cursors.add(cursor)
  }
  return [...objects.values()]
}
