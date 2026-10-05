import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { CREDENTIAL_OPERATIONS, createDebugApiSeam, installOperations } from "../mainview/state/seams/DebugApiSeam"
import type { OpenApiDocument } from "../mainview/state/seams/DebugApiSeam"
import expected from "./install-operations.fixture.json"

const document = parse(readFileSync(new URL("../../../../docs/api/openapi.yaml", import.meta.url), "utf8")) as OpenApiDocument

test("release OpenAPI install composition matches the committed literal operation inventory", () => {
  const actual: { id: string; method: string; path: string }[] = installOperations(document).map(({ id, method, path }) => ({ id, method, path }))
  // A route change updates this reviewed literal: run `bun scripts/debug-api-inventory.ts` in apps/app and review the diff.
  expect(actual, "install operations changed: run `bun scripts/debug-api-inventory.ts` in apps/app and review the fixture diff").toEqual(expected)
  expect(installOperations(document).map(operation => operation.id)).not.toContain("post_api_admin_grant")
  expect(actual.filter(operation => /^\/api\/admin(?:\/|$)/.test(operation.path))).toEqual([])
})
test("every pinned credential operation is a release install operation", () => {
  const ids = installOperations(document).map(operation => operation.id)
  expect([...CREDENTIAL_OPERATIONS].filter(id => !ids.includes(id))).toEqual([])
})
/** Operations whose success schema names a credential-like field but mint nothing; each states why. */
const CREDENTIAL_EXEMPTIONS: Readonly<Record<string, string>> = {
  get_api_install: "`models[].key` is a key-status enum (none|validating|saved|failed), never key material",
  put_api_install: "`models[].key` is a key-status enum (none|validating|saved|failed), never key material",
  get_api_repos_owner_repo_agent_sessions_id_egress: "`swapped_secret_names` lists secret names, never values",
  get_api_repos_owner_repo_workspaces_id_egress: "`swapped_secret_names` lists secret names, never values",
  get_api_repos_owner_repo_issues: "`idempotency_key` echoes the caller's own retry key",
  post_api_repos_owner_repo_issues: "`idempotency_key` echoes the caller's own retry key",
  get_api_repos_owner_repo_issues_number: "`idempotency_key` echoes the caller's own retry key",
  patch_api_repos_owner_repo_issues_number: "`idempotency_key` echoes the caller's own retry key",
  get_api_repos_owner_repo_issues_number_comments: "`idempotency_key` echoes the caller's own retry key",
  post_api_repos_owner_repo_issues_number_comments: "`idempotency_key` echoes the caller's own retry key",
  patch_api_repos_owner_repo_issues_comments_id: "`idempotency_key` echoes the caller's own retry key",
  get_api_repos_owner_repo_issues_state_events: "`entity_key` identifies the changed entity",
  get_api_install_scorecard: "`missing_tickets` lists engineering ticket ids absent from a measurement window, not auth tickets",
  get_api_user_keys: "`key_type` labels a public SSH key's algorithm",
  get_api_user_keys_id: "`key_type` labels a public SSH key's algorithm",
  post_api_user_keys: "`key_type` labels a public SSH key's algorithm"
}
test("every install operation whose success schema names a credential field is pinned or exempt with a reason", () => {
  const credential = /token|secret|key|password|credential|ticket/i
  const resolve = (value: { $ref?: string } | undefined): Record<string, unknown> | undefined => {
    if (!value?.$ref) return value as Record<string, unknown> | undefined
    let target: unknown = document
    for (const part of value.$ref.slice(2).split("/")) target = (target as Record<string, unknown> | undefined)?.[part]
    return target as Record<string, unknown> | undefined
  }
  const names = (schema: unknown, seen: Set<string>, out: Set<string>): Set<string> => {
    const node = schema as { $ref?: string; properties?: Record<string, unknown>; items?: unknown; additionalProperties?: unknown; allOf?: unknown[]; oneOf?: unknown[]; anyOf?: unknown[] } | undefined
    if (!node || typeof node !== "object") return out
    if (node.$ref) { if (seen.has(node.$ref)) return out; seen.add(node.$ref); return names(resolve(node), seen, out) }
    for (const [name, child] of Object.entries(node.properties ?? {})) { if (credential.test(name)) out.add(name); names(child, seen, out) }
    names(node.items, seen, out); names(node.additionalProperties, seen, out)
    for (const child of [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? [])]) names(child, seen, out)
    return out
  }
  const flagged = installOperations(document).filter(operation => Object.entries(operation.spec.responses ?? {}).some(([status, response]) => /^2/.test(status) &&
    Object.values((resolve(response as { $ref?: string }) as { content?: Record<string, { schema?: unknown }> } | undefined)?.content ?? {}).some(media => names(media.schema, new Set(), new Set()).size > 0)))
    .map(operation => operation.id)
  expect(flagged.filter(id => !CREDENTIAL_OPERATIONS.has(id) && !Object.hasOwn(CREDENTIAL_EXEMPTIONS, id))).toEqual([])
  expect(Object.keys(CREDENTIAL_EXEMPTIONS).filter(id => !flagged.includes(id))).toEqual([])
  expect(Object.keys(CREDENTIAL_EXEMPTIONS).filter(id => CREDENTIAL_OPERATIONS.has(id))).toEqual([])
})
test("every install operation that documents a redirect or a Location or Set-Cookie header is pinned or exempt with a reason", () => {
  const resolve = (value: unknown): { headers?: Record<string, unknown> } | undefined => {
    const ref = (value as { $ref?: string } | undefined)?.$ref
    if (!ref) return value as { headers?: Record<string, unknown> } | undefined
    let target: unknown = document
    for (const part of ref.slice(2).split("/")) target = (target as Record<string, unknown> | undefined)?.[part]
    return target as { headers?: Record<string, unknown> } | undefined
  }
  const flagged = installOperations(document).filter(operation => Object.entries(operation.spec.responses ?? {}).some(([status, response]) =>
    /^3/.test(status) || Object.keys(resolve(response)?.headers ?? {}).some(name => /^(?:location|set-cookie)$/i.test(name))))
    .map(operation => operation.id)
  expect(flagged.length).toBeGreaterThan(0)
  expect(flagged.filter(id => !CREDENTIAL_OPERATIONS.has(id) && !Object.hasOwn(CREDENTIAL_EXEMPTIONS, id))).toEqual([])
})
for (const id of ["get_api_repos_owner_repo_workspaces_id_preview_port", "get_api_repos_owner_repo_workspaces_id_preview_port_path"]) test(`release ${id} withholds its preview ticket redirect, body and URL values`, async () => {
  const seam = createDebugApiSeam({ document: async () => document, gates: () => ({ view: true, catalog: true, authorizer: true }),
    origin: "http://mini.local", fetch: async () => new Response('{"ticket":"preview-secret-ticket"}', { status: 307,
      headers: { Location: "https://preview.example/?smithers_preview_ticket=preview-secret-ticket", "Set-Cookie": "p=preview-secret-ticket", "Content-Type": "application/json" } }) })
  await seam.open(id)
  const values: Record<string, string> = { "path:owner": "acme", "path:repo": "app", "path:id": "ws-private-id", "path:port": "3000" }
  if (id.endsWith("_path")) values["path:path"] = "private-asset"
  await seam.send({ operationId: id, values })
  const shown = JSON.stringify(seam.get())
  expect(seam.get().model.exchange?.response?.status).toBe(307)
  for (const secret of ["preview-secret-ticket", "ws-private-id", "private-asset", "preview.example"]) expect(shown).not.toContain(secret)
  seam.dispose()
})
test("the pinned credential-minting list", () => {
  expect([...CREDENTIAL_OPERATIONS].sort()).toEqual([
    "get_api_auth_auth0_callback", "get_api_auth_github_callback", "get_api_auth_github_cli", "get_api_auth_github_cli_consent", "get_api_oauth2_authorize",
    "get_api_repos_owner_repo_workspace_sessions_id_ssh", "get_api_repos_owner_repo_workspaces_id_ssh", "get_api_user_emails_verify_token",
    "post_api_auth_github_cli_consent", "post_api_auth_github_token_exchange", "post_api_auth_sse_ticket", "post_api_install_setup_app", "post_api_install_setup_models",
    "post_api_model_credential", "post_api_oauth2_authorize", "post_api_oauth2_token", "post_api_orgs_org_provider_connections",
    "post_api_repos_owner_repo_build_cache_tokens", "post_api_user_emails_verify_token", "post_api_user_provider_connections",
    "post_api_user_provider_connections_codex_device", "post_api_user_provider_connections_codex_device_id", "post_api_user_provider_connections_id_refresh",
    "post_api_user_tokens", "post_api_v1_sse_ticket",
    "get_api_repos_owner_repo_workspaces_id_preview_port", "get_api_repos_owner_repo_workspaces_id_preview_port_path"
  ].sort())
})
for (const id of ["post_api_auth_sse_ticket", "post_api_v1_sse_ticket"]) test(`release ${id} ticket never renders in the response pane`, async () => {
  const ticket = `${"5e".repeat(32)}.eyJzZXNzaW9uX2hhc2giOiJhYmMifQ`
  const seam = createDebugApiSeam({ document: async () => document, gates: () => ({ view: true, catalog: true, authorizer: true }),
    origin: "http://mini.local", fetch: async () => Response.json({ ticket, expires_at: "2026-10-05T12:00:00Z" }) })
  await seam.open(id)
  await seam.send({ operationId: id })
  await seam.send({ operationId: id, intent: "confirm", confirmation: seam.get().confirmation })
  expect(seam.get().model.exchange?.response?.status).toBe(200)
  expect(JSON.stringify(seam.get())).not.toContain("5e5e5e")
  seam.dispose()
})
test("release install request form comes from the document and Send remains dark by default", async () => {
  const seam = createDebugApiSeam({ document: async () => document, gates: () => ({ view: true, catalog: true, authorizer: true }),
    origin: "http://mini.local", fetch: async () => { throw Error("No request on open") } })
  await seam.open("get_api_install")
  expect(seam.get().fields).toEqual([])
  seam.select("put_api_install")
  expect(seam.get().fields).toEqual([{ name: "body", label: "JSON", kind: "text", multiline: true, required: true }])
  seam.dispose()
})
