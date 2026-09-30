import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"
import { generate, go, goName, layout, operations, stale, tsFunction, tsType, tsTypeName, typescript, words } from "./openapi-clients.mjs"

const errorResponses = { "404": { $ref: "#/components/responses/NotFound" } }

const document = (paths, schemas = {}) => ({
  openapi: "3.1.0",
  paths,
  components: {
    schemas: { Error: { type: "object", properties: { message: { type: "string" } } }, ...schemas },
    responses: { NotFound: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } }
  }
})

const json = (schema) => ({ description: "ok", content: { "application/json": { schema } } })

test("the committed clients are exactly what the committed spec produces", () => {
  assert.deepEqual(stale(), [], "run `smthrs run //:openapiClients` to regenerate the product API clients")
})

test("stdin imports expose operations without running the generator", () => {
  const directory = mkdtempSync(join(tmpdir(), "openapi-clients-import-"))
  try {
    mkdirSync(join(directory, "scripts"))
    mkdirSync(join(directory, "docs/api"), { recursive: true })
    const script = join(directory, "scripts/openapi-clients.mjs")
    cpSync(fileURLToPath(new URL("./openapi-clients.mjs", import.meta.url)), script)
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"))
    const fixture = document({ "/stdin": { get: { operationId: "get_stdin", responses: {} } } })
    writeFileSync(join(directory, "docs/api/openapi.yaml"), YAML.stringify(fixture))
    for (const entrypoint of [undefined, "delete process.argv[1]", 'process.argv[1] = "missing.mjs"', 'process.argv[1] = "docs/api/openapi.yaml"']) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
        cwd: directory,
        encoding: "utf8",
        input: `${entrypoint ?? ""};
          import assert from "node:assert/strict";
          const { operations } = await import("./scripts/openapi-clients.mjs");
          assert.deepEqual(operations(${JSON.stringify(fixture)}).map(({ id }) => id), ["get_stdin"]);`
      })
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, "", "importing must not launch generation")
      assert.equal(result.stderr, "")
      assert.equal(existsSync(join(directory, "packages")), false, "importing must not write either client")
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("names follow each language's conventions", () => {
  assert.deepEqual(words("get_api_user_keys_id"), ["get", "api", "user", "keys", "id"])
  assert.deepEqual(words("GitHubAppID"), ["Git", "Hub", "App", "ID"])
  assert.equal(tsFunction("get_api_user_keys_id"), "getApiUserKeysId")
  assert.equal(tsFunction("post_api_share_listings_listing_d_events"), "postApiShareListingsListingDEvents")
  assert.equal(tsTypeName("get_api_status"), "GetApiStatus")
  assert.equal(goName("get_api_user_keys_id"), "GetAPIUserKeysID")
  assert.equal(goName("repository_ids"), "RepositoryIDs")
  assert.equal(goName("oauth_url"), "OAuthURL")
  assert.equal(goName("2fa"), "X2fa")
  assert.throws(() => goName("--"), /has no Go name/)
})

test("schemas map to TypeScript types", () => {
  assert.equal(tsType(undefined), "unknown")
  assert.equal(tsType({}), "unknown")
  assert.equal(tsType({ $ref: "#/components/schemas/Error" }), "Error")
  assert.equal(tsType({ const: 1 }), "1")
  assert.equal(tsType({ type: "string", enum: ["a", "b"] }), '"a" | "b"')
  assert.equal(tsType({ type: ["string", "null"] }), "string | null")
  assert.equal(tsType({ type: "array", items: { type: "integer" } }), "Array<number>")
  assert.equal(tsType({ oneOf: [{ type: "string" }, { type: ["integer", "null"] }] }), "string | (number | null)")
  assert.equal(tsType({ allOf: [{ $ref: "#/components/schemas/Error" }, { type: "object", properties: { code: { type: "string" } }, required: ["code"] }] }), "Error & {\n  code: string\n}")
  assert.equal(tsType({ type: "object" }), "Record<string, unknown>")
  assert.equal(tsType({ type: "object", additionalProperties: false }), "Record<string, never>")
  assert.equal(tsType({ type: "object", additionalProperties: { type: "boolean" } }), "Record<string, boolean>")
  assert.equal(
    tsType({ type: "object", required: ["a"], additionalProperties: true, properties: { a: { type: "string" }, "b-c": { type: "boolean" } } }),
    '{\n  a: string\n  "b-c"?: boolean\n  [key: string]: unknown\n}'
  )
  assert.throws(() => tsType({ type: "tuple" }), /unsupported type tuple/)
  assert.throws(() => tsType({ $ref: "other.yaml#/X" }), /unsupported \$ref/)
})

test("operations resolve success shapes, bodies, and parameters", () => {
  const ops = operations(document({
    "/a/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
      get: { operationId: "get_a", responses: { "200": json({ type: "string" }), ...errorResponses } },
      delete: { operationId: "delete_a", responses: { "204": { description: "gone" } } },
      post: { operationId: "post_a", requestBody: { content: { "application/x-www-form-urlencoded": {} } }, responses: {} }
    },
    "/s": { get: { operationId: "get_s", parameters: [{ name: "Accept", in: "header" }, { name: "after", in: "query", schema: { type: "integer" } }], responses: { "200": { description: "s", content: { "text/event-stream": {} } } } } },
    "/e": { put: { operationId: "put_e", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": json({}), "202": { description: "accepted" } } } }
  }))
  assert.deepEqual(ops.map((op) => [op.id, op.success.kind, op.success.empty === true, op.skipped, op.body?.required]), [
    ["get_a", "json", false, undefined, undefined],
    ["post_a", "none", false, "application/x-www-form-urlencoded", undefined],
    ["delete_a", "none", false, undefined, undefined],
    ["get_s", "raw", false, undefined, undefined],
    ["put_e", "json", true, undefined, true]
  ])
  assert.deepEqual(ops[0].pathParameters.map((parameter) => parameter.name), ["id"], "path-item parameters apply")
  assert.deepEqual(ops[3].query.map((parameter) => parameter.name), ["after"], "header parameters stay out of the signature")
})

test("malformed operations are refused", () => {
  const refuse = (paths, pattern) => assert.throws(() => operations(document(paths)), pattern)
  refuse({ "/a": { get: { responses: {} } } }, /get \/a has no operationId/)
  refuse({ "/a": { get: { operationId: "x", responses: {} } }, "/b": { get: { operationId: "x", responses: {} } } }, /operationId x is declared twice/)
  refuse({ "/a/{id}": { get: { operationId: "x", responses: {} } } }, /x does not declare path parameter id/)
  refuse({ "/a": { get: { operationId: "x", responses: { "200": json({}), "201": { description: "s", content: { "text/plain": {} } } } } } }, /x mixes JSON and non-JSON/)
  refuse({ "/a": { get: { operationId: "x", responses: { "200": { description: "s", content: { "text/plain": {} } }, "201": json({}) } } } }, /x mixes JSON and non-JSON/)
  refuse({ "/a": { get: { operationId: "x", responses: { "200": json({}), "201": json({}) } } } }, /x declares more than one JSON success response/)
  refuse({ "/a": { get: { operationId: "x", responses: { "200": { $ref: "#/components/responses/Missing" } } } } }, /x 200 is missing/)
})

const sample = document({
  "/api/keys/{id}": {
    get: {
      operationId: "get_api_keys_id",
      summary: "Read one key",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", format: "int64" } }, { name: "since", in: "query", schema: { type: "string", format: "date-time" } }, { name: "limit", in: "query", required: true, schema: { type: "integer" } }],
      responses: { "200": json({ $ref: "#/components/schemas/Key" }), ...errorResponses }
    },
    delete: { operationId: "delete_api_keys_id", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "204": { description: "gone" } } }
  },
  "/api/keys": {
    post: { operationId: "post_api_keys", requestBody: { content: { "application/json": { schema: { type: "object", required: ["title"], properties: { title: { type: "string" }, tags: { type: "array", items: { type: "string" } } } } } } }, responses: { "201": json({ type: "object", properties: { key: { $ref: "#/components/schemas/Key" } } }) } },
    put: { operationId: "put_api_keys", requestBody: { required: true, content: { "application/json": { schema: {} } } }, responses: { "200": { description: "tar", content: { "application/gzip": {} } } } }
  },
  "/login": { post: { operationId: "post_login", requestBody: { content: { "application/x-www-form-urlencoded": {} } }, responses: {} } }
}, {
  Key: { type: "object", description: "One SSH key.", required: ["id", "created_at"], properties: { id: { type: "integer" }, created_at: { type: "string", format: "date-time" }, expires_at: { type: ["string", "null"], format: "date-time" }, labels: { type: "object", additionalProperties: { type: "string" } }, owner: { type: "object", properties: { name: { type: "string" } } }, kind: { oneOf: [{ type: "string" }, { type: "integer" }] } } },
  Origin: { type: "string", enum: ["app", "slack"] },
  Anything: { description: "free-form" }
})

test("the TypeScript client sends through the transport it is given", () => {
  const text = typescript(sample)
  assert.match(text, /^\/\/ Code generated by scripts\/openapi-clients\.mjs/)
  assert.match(text, /\/\/ {3}post_login \(application\/x-www-form-urlencoded\)/)
  assert.match(text, /\/\*\* One SSH key\. \*\/\nexport type Key = \{/)
  assert.match(text, /export type Origin = "app" \| "slack"/)
  assert.match(text, /export interface GetApiKeysIdInput \{\n {2}readonly path: \{ readonly id: number \}\n {2}readonly query: \{ readonly since\?: string; readonly limit: number \}\n\}/)
  assert.match(text, /\/\*\* GET \/api\/keys\/\{id\}: Read one key \*\/\nexport const getApiKeysId = \(transport: Transport, input: GetApiKeysIdInput\): Promise<GetApiKeysIdResponse> =>\n {2}transport\.request\("GET", `\/api\/keys\/\$\{segment\(input\.path\.id\)\}\$\{search\(\{ since: input\.query\.since, limit: input\.query\.limit \}\)\}`\) as Promise<GetApiKeysIdResponse>/)
  assert.match(text, /export const deleteApiKeysId = \(transport: Transport, input: DeleteApiKeysIdInput\): Promise<void> =>\n {2}transport\.request\("DELETE", `\/api\/keys\/\$\{segment\(input\.path\.id\)\}`\)\.then\(\(\) => undefined\)/)
  assert.match(text, /export const postApiKeys = \(transport: Transport, input\?: PostApiKeysInput\): Promise<PostApiKeysResponse> =>\n {2}transport\.request\("POST", `\/api\/keys`, input\?\.body\)/, "an optional body makes the input optional")
  assert.match(text, /export const putApiKeys = \(transport: Transport, input: PutApiKeysInput\): Promise<Response> =>\n {2}transport\.response\("PUT", `\/api\/keys`, input\.body\)/)
  assert.doesNotMatch(text, /postLogin/)
})

test("the Go client declares every schema and one method per operation", () => {
  const text = go(sample)
  assert.match(text, /^\/\/ Code generated by scripts\/openapi-clients\.mjs .* DO NOT EDIT\.\n/)
  assert.match(text, /\/\/ {3}post_login \(application\/x-www-form-urlencoded\)/)
  assert.match(text, /\t"strconv"\n\t"strings"\n\t"time"\n\)/)
  assert.match(text, /\/\/ Key — One SSH key\.\ntype Key struct \{\n\tID        int64             `json:"id"`\n\tCreatedAt time\.Time         `json:"created_at"`\n\tExpiresAt \*time\.Time        `json:"expires_at,omitempty"`\n\tLabels    map\[string\]string `json:"labels,omitempty"`\n\tOwner     \*KeyOwner         `json:"owner,omitempty"`\n\tKind      json\.RawMessage   `json:"kind,omitempty"`\n\}/)
  assert.match(text, /type KeyOwner struct \{\n\tName \*string `json:"name,omitempty"`\n\}/)
  assert.match(text, /type Origin string/)
  assert.match(text, /type Anything = json\.RawMessage/)
  assert.match(text, /type GetAPIKeysIDParams struct \{\n\tSince \*time\.Time\n\tLimit int64\n\}/)
  assert.match(text, /func \(c \*Client\) GetAPIKeysID\(ctx context\.Context, id int64, params GetAPIKeysIDParams\) \(Key, error\) \{\n\tquery := url\.Values\{\}\n\tif params\.Since != nil \{\n\t\tquery\.Set\("since", \(\*params\.Since\)\.Format\(time\.RFC3339Nano\)\)\n\t\}\n\tquery\.Set\("limit", strconv\.FormatInt\(params\.Limit, 10\)\)\n\tvar out Key\n\terr := c\.do\(ctx, "GET", "\/api\/keys\/"\+url\.PathEscape\(strconv\.FormatInt\(id, 10\)\), query, nil, &out\)/)
  assert.match(text, /func \(c \*Client\) DeleteAPIKeysID\(ctx context\.Context, id string\) error \{\n\treturn c\.do\(ctx, "DELETE", "\/api\/keys\/"\+url\.PathEscape\(id\), nil, nil, nil\)\n\}/)
  assert.match(text, /func \(c \*Client\) PostAPIKeys\(ctx context\.Context, body \*PostAPIKeysBody\) \(PostAPIKeysResponse, error\) \{[^}]*optionalBody\(body\)/)
  assert.match(text, /func optionalBody\[T any\]/)
  assert.match(text, /type PostAPIKeysBody struct \{\n\tTitle string   `json:"title"`\n\tTags  \[\]string `json:"tags,omitempty"`\n\}/)
  assert.match(text, /func \(c \*Client\) PutAPIKeys\(ctx context\.Context, body any\) \(\*http\.Response, error\) \{\n\treturn c\.raw\(ctx, "PUT", "\/api\/keys", nil, body, "application\/gzip"\)/)
  assert.doesNotMatch(go(document({})), /optionalBody|"strconv"|"time"/, "helpers and imports appear only when used")
})

test("parameter names that are not identifiers are read by key", () => {
  const text = typescript(document({
    "/runs/{run-id}": {
      get: {
        operationId: "get_runs_run_id",
        parameters: [{ name: "run-id", in: "path", required: true, schema: { type: "string" } }, { name: "page-size", in: "query", schema: { type: "integer" } }],
        responses: {}
      }
    }
  }))
  assert.match(text, /readonly path: \{ readonly "run-id": string \}/)
  assert.match(text, /`\/runs\/\$\{segment\(input\.path\["run-id"\]\)\}\$\{search\(\{ "page-size": input\.query\?\.\["page-size"\] \}\)\}`/)
})

test("operations whose names collide are refused", () => {
  const paths = { "/a": { get: { operationId: "get_a_b", responses: {} } }, "/b": { get: { operationId: "get-a-b", responses: {} } } }
  assert.throws(() => typescript(document(paths)), /operationId get-a-b has the same TypeScript name as another operation/)
  assert.throws(() => go(document(paths)), /operationId get-a-b has the same Go name as another operation/)
})

test("Go structs keep members an open schema does not declare", () => {
  const text = go(document({}, {
    Open: { type: "object", additionalProperties: true, properties: { name: { type: "string" }, additional_properties: { type: "string" } } },
    Closed: { type: "object", properties: { name: { type: "string" } } }
  }))
  assert.match(text, /type Open struct \{\n\tName                  \*string                    `json:"name,omitempty"`\n\tAdditionalProperties  \*string                    `json:"additional_properties,omitempty"`\n\tAdditionalProperties_ map\[string\]json\.RawMessage `json:"-"`\n\}/)
  assert.match(text, /func \(v \*Open\) UnmarshalJSON\(data \[\]byte\) error \{\n\ttype plain Open\n\tif err := json\.Unmarshal\(data, \(\*plain\)\(v\)\); err != nil \{\n\t\treturn err\n\t\}\n\treturn splitAdditional\(data, &v\.AdditionalProperties_, "name", "additional_properties"\)\n\}/)
  assert.match(text, /func \(v Open\) MarshalJSON\(\) \(\[\]byte, error\) \{\n\ttype plain Open\n\treturn joinAdditional\(plain\(v\), v\.AdditionalProperties_\)\n\}/)
  assert.match(text, /func splitAdditional\(/)
  assert.doesNotMatch(text, /func \(v \*Closed\) UnmarshalJSON/)
  assert.doesNotMatch(go(document({}, { Closed: { type: "object", properties: { name: { type: "string" } } } })), /splitAdditional/)
})

test("a schema that shadows a runtime declaration is refused", () => {
  assert.throws(() => go(document({}, { Client: { type: "object", properties: { a: { type: "string" } } } })), /Go type Client is declared twice/)
})

test("a spec change changes the clients, and --check reports the drift", () => {
  const directory = mkdtempSync(join(tmpdir(), "openapi-clients-"))
  try {
    const script = fileURLToPath(new URL("./openapi-clients.mjs", import.meta.url))
    mkdirSync(join(directory, "scripts"))
    mkdirSync(join(directory, "docs/api"), { recursive: true })
    cpSync(script, join(directory, "scripts/openapi-clients.mjs"))
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"))
    const spec = join(directory, "docs/api/openapi.yaml")
    writeFileSync(spec, YAML.stringify(sample))
    const run = (...args) => spawnSync(process.execPath, [join(directory, "scripts/openapi-clients.mjs"), ...args], { encoding: "utf8" })
    const missing = run("--check")
    assert.equal(missing.status, 1, "a missing client is drift")
    const alias = join(directory, "scripts/clients-alias.mjs")
    symlinkSync(join(directory, "scripts/openapi-clients.mjs"), alias)
    const linked = spawnSync(process.execPath, [alias, "--check"], { encoding: "utf8" })
    assert.equal(linked.status, 1, "a symlink invocation must execute the drift check")
    assert.equal(linked.stderr, missing.stderr)
    const wrote = run()
    assert.equal(wrote.status, 0, wrote.stderr)
    assert.equal(wrote.stdout, "wrote packages/smithers/src/internal/backend/ProductApi.ts\nwrote packages/backend/apiclient/client.gen.go\n")
    assert.equal(run("--check").status, 0)
    const changed = structuredClone(sample)
    changed.components.schemas.Key.properties.fingerprint = { type: "string" }
    writeFileSync(spec, YAML.stringify(changed))
    const drift = run("--check")
    assert.equal(drift.status, 1)
    assert.equal(drift.stderr, [
      "packages/smithers/src/internal/backend/ProductApi.ts is stale; run `smthrs run //:openapiClients`",
      "packages/backend/apiclient/client.gen.go is stale; run `smthrs run //:openapiClients`",
      ""
    ].join("\n"))
    const regenerated = generate(YAML.stringify(changed))
    assert.match(regenerated.get(layout.go), /Fingerprint \*string/)
    assert.match(regenerated.get(layout.typescript), /fingerprint\?: string/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the layout names the committed spec and both clients", () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  assert.deepEqual(layout, {
    spec: join(root, "docs/api/openapi.yaml"),
    typescript: join(root, "packages/smithers/src/internal/backend/ProductApi.ts"),
    go: join(root, "packages/backend/apiclient/client.gen.go")
  })
})
