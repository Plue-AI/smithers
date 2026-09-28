import { describe, expect, test } from "vitest"
import {
  bindingOf,
  ConfiguredModelSchema,
  customModelCredentials,
  cutModelCredential,
  DECISION_MODEL_IDS,
  decodeModelAnswers,
  failedModelCredential,
  failedModelTest,
  hostModelCredentials,
  hostRefusedModelTest,
  isLoopbackOrigin,
  MODEL_CALL_MAX_TOKENS_MAX,
  MODEL_CALL_NAME_MAX,
  MODEL_CALL_STATE_MAX_BYTES,
  MODEL_CALL_TEMPERATURE_MAX,
  MODEL_CALL_TEXT_MAX,
  MODEL_CREDENTIAL_ENV_PREFIX,
  MODEL_CREDENTIALS,
  MODEL_FIELD_KEY,
  MODEL_KINDS,
  MODEL_PROTOCOLS,
  MODEL_SEAT_DEFAULT,
  MODEL_SEATS,
  MODEL_TEST_DEADLINE_MS,
  MODEL_TEST_DECISION,
  MODEL_TEST_FAILURE_CODES,
  MODEL_TEST_MAX_TOKENS,
  MODEL_TEST_PROMPT,
  MODEL_TEST_SAMPLE_MAX,
  MODEL_TEST_STATES,
  ModelBindingSchema,
  ModelCallCardPayloadSchema,
  modelCallDefault,
  ModelCallDraftSchema,
  modelCallInputOf,
  ModelCallInputSchema,
  ModelCallOutputSchema,
  modelCallProblemOf,
  modelCallSample,
  ModelCatalogSchema,
  modelCredentialEnvName,
  ModelCredentialListingSchema,
  ModelCredentialNameSchema,
  ModelCredentialRequestSchema,
  modelFailureFault,
  modelFailureRefusalCode,
  modelKindOf,
  modelOriginOf,
  ModelRecordIdSchema,
  ModelsCardPayloadSchema,
  modelSeatsOf,
  ModelStateFieldSchema,
  modelStateFieldsOf,
  modelStateOf,
  ModelTestFailureSchema,
  modelTestFixOf,
  ModelTestRequestSchema,
  ModelTestResultSchema,
  modelTestStateOf,
  planModelBinding,
  resolveModelEndpoint,
  scrubModelSample,
  seatAccepts,
  SeatAssignmentSchema,
  SeatIdSchema,
  servableModels
} from "../src/ConfiguredModel.ts"
import type {
  ConfiguredModel,
  ModelCallDraft,
  ModelCredentialListing,
  ModelQuestion,
  ModelStateField,
  ModelTestFailure,
  ModelTestResult
} from "../src/ConfiguredModel.ts"
import { PLUE_FAULTS } from "../src/PlueFailureCodes.ts"
import { WORKER_FAILURE_CODES } from "../src/WorkerFailureCodes.ts"

const LOOPBACK = "http://127.0.0.1:4010"

/** A host table: the five built-ins, all set, plus one operator-declared loopback credential. */
const table: ReadonlyArray<ModelCredentialListing> = hostModelCredentials({
  ANTHROPIC_API_KEY: "sk-ant",
  OPENAI_API_KEY: "sk-oai",
  CEREBRAS_API_KEY: "csk",
  OPENROUTER_API_KEY: "sk-or",
  AI_GATEWAY_API_KEY: "vck",
  SMITHERS_MODEL_KEY_E2E_LOOPBACK: "sk-loopback",
  SMITHERS_MODEL_KEY_E2E_LOOPBACK_ORIGIN: LOOPBACK
})

const chat = (patch: Partial<ConfiguredModel> = {}): ConfiguredModel => ({
  id: "fast-local",
  protocol: "openai-chat",
  baseUrl: LOOPBACK,
  modelId: "e2e-answers",
  credential: "E2E_LOOPBACK",
  ...patch
})

describe("the configured model record", () => {
  test("is flat, and its kind is derived from the protocol", () => {
    expect(ConfiguredModelSchema.parse(chat())).toEqual(chat())
    expect(MODEL_PROTOCOLS.map(modelKindOf)).toEqual(["generation", "generation", "generation", "decision"])
  })

  test("refuses a key it does not declare, so a value can never ride a record", () => {
    expect(ConfiguredModelSchema.safeParse({ ...chat(), apiKey: "sk-live" }).success).toBe(false)
    expect(ModelBindingSchema.safeParse({ ...bindingOf(chat()), apiKey: "sk-live" }).success).toBe(false)
    expect(ModelTestRequestSchema.safeParse({ model: chat(), apiKey: "sk-live" }).success).toBe(false)
  })

  test.each(["Fast", "9lives", "a b", "", "a".repeat(41)])("refuses the name %j", (id) => {
    expect(ModelRecordIdSchema.safeParse(id).success).toBe(false)
  })

  test("no model can take the name a seat is returned to its host by", () => {
    expect(MODEL_SEAT_DEFAULT).toBe("default")
    expect(ModelRecordIdSchema.safeParse("default").success).toBe(false)
    expect(ModelRecordIdSchema.safeParse(`${MODEL_SEAT_DEFAULT}-fast`).success).toBe(true)
  })

  test.each(["lower_case", "1ST_KEY", "A", "FOO_ORIGIN", "ORIGIN", "FOO__BAR", "FOO_", "sk-live-0123456789"])(
    "refuses the credential name %j",
    (name) => {
      expect(ModelCredentialNameSchema.safeParse(name).success).toBe(false)
    }
  )

  test("a binding is the record without its name", () => {
    expect(bindingOf(chat({ builtin: true, path: "/v1/chat/completions" }))).toEqual({
      protocol: "openai-chat",
      baseUrl: LOOPBACK,
      path: "/v1/chat/completions",
      modelId: "e2e-answers",
      credential: "E2E_LOOPBACK"
    })
    expect(Object.keys(bindingOf(chat({ baseUrl: undefined })))).toEqual(["protocol", "modelId", "credential"])
  })
})

describe("credentials", () => {
  test("every built-in is an https origin under its own name", () => {
    for (const { name, origins } of MODEL_CREDENTIALS) {
      expect(ModelCredentialNameSchema.safeParse(name).success).toBe(true)
      expect(modelCredentialEnvName(name)).toBe(name)
      for (const origin of origins) expect(modelOriginOf(origin)).toBe(origin)
      for (const origin of origins) expect(origin.startsWith("https://")).toBe(true)
    }
    expect(modelCredentialEnvName("E2E_LOOPBACK")).toBe(`${MODEL_CREDENTIAL_ENV_PREFIX}E2E_LOOPBACK`)
  })

  test("an operator-declared pair is a custom credential pinned to its one origin", () => {
    expect(
      customModelCredentials({
        SMITHERS_MODEL_KEY_OLLAMA: "unused",
        SMITHERS_MODEL_KEY_OLLAMA_ORIGIN: "http://localhost:11434/v1",
        SMITHERS_MODEL_KEY_LAN: "k",
        SMITHERS_MODEL_KEY_LAN_ORIGIN: "https://10.0.0.5:8443"
      })
    ).toEqual([
      { name: "LAN", origin: "https://10.0.0.5:8443" },
      { name: "OLLAMA", origin: "http://localhost:11434" }
    ])
  })

  test.each([
    ["http to a private host", "http://10.0.0.5:8080"],
    ["http to a public host", "http://example.com"],
    ["userinfo", "https://user:pass@example.com"],
    ["a query", "https://example.com/?key=1"],
    ["another scheme", "ftp://127.0.0.1"],
    ["no url at all", "localhost"],
    ["blank", " "]
  ])("a declared origin with %s declares nothing", (_, origin) => {
    expect(modelOriginOf(origin)).toBeUndefined()
    expect(customModelCredentials({ SMITHERS_MODEL_KEY_X: "k", SMITHERS_MODEL_KEY_X_ORIGIN: origin })).toEqual([])
  })

  test.each([
    "http://127.0.0.1:1",
    "http://127.8.9.10",
    "http://[::1]:8080",
    "http://localhost",
    "http://host.docker.internal:8080"
  ])(
    "%s is local to the host, so http is allowed",
    (origin) => {
      expect(modelOriginOf(origin)).toBe(origin)
    }
  )

  test("an _ORIGIN sibling of a built-in name is ignored, prefixed or not", () => {
    const listed = hostModelCredentials({
      CEREBRAS_API_KEY: "csk",
      CEREBRAS_API_KEY_ORIGIN: "https://attacker.example",
      SMITHERS_MODEL_KEY_CEREBRAS_API_KEY: "other",
      SMITHERS_MODEL_KEY_CEREBRAS_API_KEY_ORIGIN: "https://attacker.example"
    })
    expect(listed.map((row) => row.name)).toEqual(MODEL_CREDENTIALS.map((row) => row.name))
    expect(listed.find((row) => row.name === "CEREBRAS_API_KEY")).toEqual({
      name: "CEREBRAS_API_KEY",
      present: true,
      origins: ["https://api.cerebras.ai"]
    })
  })

  test("an unprefixed name is never read, whatever the environment holds", () => {
    const reads: Array<string> = []
    const env = new Proxy<Record<string, string>>({
      GITHUB_TOKEN: "ghp_secret",
      GITHUB_TOKEN_ORIGIN: LOOPBACK,
      DATABASE_URL: "postgres://secret",
      SMITHERS_MODEL_KEY_MINE: "sk-mine",
      SMITHERS_MODEL_KEY_MINE_ORIGIN: LOOPBACK
    }, {
      get: (target, key) => {
        if (typeof key === "string") reads.push(key)
        return Reflect.get(target, key)
      }
    })
    const listed = hostModelCredentials(env)
    expect(listed.map((row) => row.name)).toEqual([...MODEL_CREDENTIALS.map((row) => row.name), "MINE"])
    const allowed = new Set<string>(MODEL_CREDENTIALS.map((row) => row.name))
    expect(reads.filter((key) => !allowed.has(key) && !key.startsWith(MODEL_CREDENTIAL_ENV_PREFIX))).toEqual([])
  })

  test.each(["lower", "my-key", "A", "X_ORIGIN", "1ST"])(
    "a pair declared under the name %j declares nothing",
    (name) => {
      const env = { [`SMITHERS_MODEL_KEY_${name}`]: "k", [`SMITHERS_MODEL_KEY_${name}_ORIGIN`]: LOOPBACK }
      expect(customModelCredentials(env)).toEqual([])
      const listed = hostModelCredentials(env)
      expect(listed.map((row) => row.name)).toEqual(MODEL_CREDENTIALS.map((row) => row.name))
      expect(listed.every((row) => ModelCredentialListingSchema.safeParse(row).success)).toBe(true)
    }
  )

  test("a listing states presence and never a value", () => {
    const listed = hostModelCredentials({
      OPENAI_API_KEY: "sk-live-0123456789",
      ANTHROPIC_API_KEY: "  ",
      SMITHERS_MODEL_KEY_MINE: "sk-mine-0123456789",
      SMITHERS_MODEL_KEY_MINE_ORIGIN: LOOPBACK,
      SMITHERS_MODEL_KEY_EMPTY_ORIGIN: LOOPBACK
    })
    expect(JSON.stringify(listed)).not.toMatch(/sk-live|sk-mine/)
    const present = Object.fromEntries(listed.map((row) => [row.name, row.present]))
    expect(present).toMatchObject({ OPENAI_API_KEY: true, ANTHROPIC_API_KEY: false, MINE: true, EMPTY: false })
  })
})

describe("credential mutation boundary", () => {
  const identity = { requestId: "enroll-123", name: "E2E_LOOPBACK" }

  test.each([
    { ...identity, action: "enroll", origin: LOOPBACK, value: "secret" },
    { ...identity, action: "rotate", value: "secret" },
    { ...identity, action: "remove" }
  ])("accepts only the fields for a $action request", (request) => {
    expect(ModelCredentialRequestSchema.parse(request)).toEqual(request)
  })

  test.each(["", " \t ", "line\nsecret", "line\rsecret", "line\0secret", "x".repeat(8193)])(
    "refuses an empty, multiline, NUL-bearing, or oversized credential value",
    (value) => {
      expect(ModelCredentialRequestSchema.safeParse({ ...identity, action: "enroll", origin: LOOPBACK, value }).success)
        .toBe(false)
      expect(ModelCredentialRequestSchema.safeParse({ ...identity, action: "rotate", value }).success).toBe(false)
    }
  )

  test("accepts the maximum credential value for enroll and rotate", () => {
    const value = "x".repeat(8192)
    const enroll = { ...identity, action: "enroll", origin: LOOPBACK, value }
    const rotate = { ...identity, action: "rotate", value }
    expect(ModelCredentialRequestSchema.parse(enroll)).toEqual(enroll)
    expect(ModelCredentialRequestSchema.parse(rotate)).toEqual(rotate)
  })

  test.each([
    { ...identity, action: "enroll", origin: LOOPBACK },
    { ...identity, action: "rotate", value: "secret", origin: LOOPBACK },
    { ...identity, action: "remove", value: "secret" },
    { ...identity, action: "remove", origin: LOOPBACK },
    { ...identity, action: "enroll", origin: LOOPBACK, value: "secret", privateNote: "leak" }
  ])("rejects a missing or extraneous credential mutation field", (request) => {
    expect(ModelCredentialRequestSchema.safeParse(request).success).toBe(false)
  })

  test("failure results use the declared fault and carry no caught exception", () => {
    expect(failedModelCredential({ code: "storage_unavailable" })).toEqual({
      ok: false,
      failure: { code: "storage_unavailable" },
      fault: "infra"
    })
    expect(failedModelCredential({ code: "invalid", field: "value" })).toEqual({
      ok: false,
      failure: { code: "invalid", field: "value" },
      fault: "user"
    })
    expect(failedModelCredential({ code: "host_refused", status: 503, refusal: null }, "dependency")).toEqual({
      ok: false,
      failure: { code: "host_refused", status: 503, refusal: null },
      fault: "dependency"
    })
  })

  test("classifies only local origin aliases as loopback, and malformed origins as foreign", () => {
    for (
      const origin of [
        "http://127.0.0.1:4010",
        "http://localhost:4010",
        "http://[::1]:4010",
        "http://host.docker.internal:4010"
      ]
    ) {
      expect(isLoopbackOrigin(origin)).toBe(true)
    }
    for (const origin of ["https://example.com", "http://10.0.0.1", "not a URL"]) {
      expect(isLoopbackOrigin(origin)).toBe(false)
    }
  })
})

describe("origin pinning", () => {
  test("a built-in credential to a foreign origin is endpoint_forbidden", () => {
    const stolen = chat({ credential: "CEREBRAS_API_KEY", baseUrl: "https://attacker.example" })
    expect(resolveModelEndpoint(stolen, table)).toEqual({ ok: false, failure: { code: "endpoint_forbidden" } })
    const local = chat({ credential: "CEREBRAS_API_KEY" })
    expect(resolveModelEndpoint(local, table)).toEqual({ ok: false, failure: { code: "endpoint_forbidden" } })
  })

  test("a lookalike of a pinned origin is still foreign", () => {
    for (
      const baseUrl of [
        "https://api.cerebras.ai.attacker.example",
        "https://api.cerebras.ai:8443",
        "http://api.cerebras.ai",
        "https://attacker.example/https://api.cerebras.ai"
      ]
    ) {
      const result = resolveModelEndpoint(chat({ credential: "CEREBRAS_API_KEY", baseUrl }), table)
      expect(result).toEqual({ ok: false, failure: { code: "endpoint_forbidden" } })
    }
  })

  test("a built-in credential to its own origin resolves", () => {
    const result = resolveModelEndpoint(
      chat({ credential: "CEREBRAS_API_KEY", baseUrl: "https://api.cerebras.ai/" }),
      table
    )
    expect(result).toEqual({
      ok: true,
      endpoint: {
        origin: "https://api.cerebras.ai",
        baseUrl: "https://api.cerebras.ai",
        path: "/v1/chat/completions",
        url: "https://api.cerebras.ai/v1/chat/completions"
      }
    })
  })

  test("a custom credential to its declared loopback origin is allowed, and nowhere else", () => {
    const result = resolveModelEndpoint(chat(), table)
    expect(result.ok && result.endpoint.url).toBe(`${LOOPBACK}/v1/chat/completions`)
    expect(resolveModelEndpoint(chat({ baseUrl: "http://127.0.0.1:4011" }), table))
      .toEqual({ ok: false, failure: { code: "endpoint_forbidden" } })
  })

  test("http to a non-loopback host is refused even when a table lists it", () => {
    const forged: ReadonlyArray<ModelCredentialListing> = [{ name: "LAN", present: true, origins: ["http://10.0.0.5"] }]
    expect(resolveModelEndpoint(chat({ credential: "LAN", baseUrl: "http://10.0.0.5" }), forged))
      .toEqual({ ok: false, failure: { code: "endpoint_forbidden" } })
  })

  test("a host without egress reaches loopback only", () => {
    expect(resolveModelEndpoint(chat(), table, { egress: false }).ok).toBe(true)
    const cloud = chat({ credential: "CEREBRAS_API_KEY", baseUrl: "https://api.cerebras.ai" })
    expect(resolveModelEndpoint(cloud, table, { egress: false }))
      .toEqual({ ok: false, failure: { code: "endpoint_forbidden" } })
  })

  test("a name the host does not list is credential_unknown, echoing the name only", () => {
    expect(resolveModelEndpoint(chat({ credential: "GITHUB_TOKEN" }), table))
      .toEqual({ ok: false, failure: { code: "credential_unknown", credential: "GITHUB_TOKEN" } })
  })

  test.each([
    ["userinfo", "http://user:pass@127.0.0.1:4010"],
    ["a query", `${LOOPBACK}/?x=1`],
    ["a fragment", `${LOOPBACK}/#x`],
    ["no url", "not a url"]
  ])("a base URL with %s is invalid", (_, baseUrl) => {
    expect(resolveModelEndpoint(chat({ baseUrl }), table))
      .toEqual({ ok: false, failure: { code: "invalid", field: "baseUrl" } })
  })

  test("openai-chat has no default origin; the vendor protocols do", () => {
    expect(resolveModelEndpoint(chat({ baseUrl: undefined }), table))
      .toEqual({ ok: false, failure: { code: "invalid", field: "baseUrl" } })
    const anthropic = chat({ protocol: "anthropic-messages", credential: "ANTHROPIC_API_KEY", baseUrl: undefined })
    const resolved = resolveModelEndpoint(anthropic, table)
    expect(resolved.ok && resolved.endpoint.url).toBe("https://api.anthropic.com/v1/messages")
    const openrouter = chat({
      protocol: "openai-responses",
      credential: "OPENROUTER_API_KEY",
      baseUrl: "https://openrouter.ai/api"
    })
    const routed = resolveModelEndpoint(openrouter, table)
    expect(routed.ok && routed.endpoint.url).toBe("https://openrouter.ai/api/v1/responses")
  })

  test.each(["/v1/../admin", "/v1/%2e%2e/admin", "/v1?x=1", "/v1#x", "v1/chat", "//attacker.example/v1"])(
    "the path %j is invalid",
    (path) => {
      expect(resolveModelEndpoint(chat({ path }), table))
        .toEqual({ ok: false, failure: { code: "invalid", field: "path" } })
    }
  )

  test("only openai-chat takes its own path", () => {
    const own = resolveModelEndpoint(chat({ path: "/chat/completions" }), table)
    expect(own.ok && own.endpoint.url).toBe(`${LOOPBACK}/chat/completions`)
    const anthropic = chat({ protocol: "anthropic-messages", credential: "ANTHROPIC_API_KEY", baseUrl: undefined })
    expect(resolveModelEndpoint({ ...anthropic, path: "/v2/messages" }, table))
      .toEqual({ ok: false, failure: { code: "invalid", field: "path" } })
  })
})

describe("seats", () => {
  test("lists the seats each host reads", () => {
    expect(MODEL_SEATS.map(({ id, kind, hosts }) => ({ id, kind, hosts }))).toEqual([
      { id: "chat", kind: "generation", hosts: ["local"] },
      { id: "explainer", kind: "generation", hosts: ["local", "cloud"] },
      { id: "front-door", kind: "decision", hosts: ["cloud"] },
      { id: "recommend", kind: "decision", hosts: ["cloud"] }
    ])
    expect(modelSeatsOf("local")).toEqual(["chat", "explainer"])
    expect(modelSeatsOf("cloud")).toEqual(["explainer", "front-door", "recommend"])
    expect(SeatIdSchema.safeParse("role:ui").success).toBe(false)
  })

  test("a seat takes only a model of its kind", () => {
    const accepted = MODEL_SEATS.map((seat) => MODEL_PROTOCOLS.filter((protocol) => seatAccepts(seat.id, protocol)))
    expect(accepted).toEqual([
      ["anthropic-messages", "openai-responses", "openai-chat"],
      ["anthropic-messages", "openai-responses", "openai-chat"],
      ["evaluation"],
      ["evaluation"]
    ])
  })

  test("an assignment names one seat and one record", () => {
    expect(SeatAssignmentSchema.parse({ id: "explainer", recordId: "fast-local" }))
      .toEqual({ id: "explainer", recordId: "fast-local" })
    expect(SeatAssignmentSchema.safeParse({ id: "health", recordId: "fast-local" }).success).toBe(false)
    expect(SeatAssignmentSchema.safeParse({ id: "explainer", recordId: "Fast Local" }).success).toBe(false)
  })
})

describe("the planner", () => {
  const jev = { protocol: "evaluation", modelId: DECISION_MODEL_IDS[0], credential: "AI_GATEWAY_API_KEY" } as const

  test("turns a binding into a plan that holds a name and an address, never a value", () => {
    const planned = planModelBinding(bindingOf(chat()), table)
    expect(planned).toEqual({
      ok: true,
      plan: {
        kind: "generation",
        protocol: "openai-chat",
        modelId: "e2e-answers",
        credential: "E2E_LOOPBACK",
        origin: LOOPBACK,
        baseUrl: LOOPBACK,
        path: "/v1/chat/completions",
        url: `${LOOPBACK}/v1/chat/completions`
      }
    })
    expect(JSON.stringify(planned)).not.toContain("sk-loopback")
  })

  test("plans the allowlisted decision model at the gateway", () => {
    const planned = planModelBinding(jev, table, { kind: "decision" })
    expect(planned.ok && planned.plan.url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model")
  })

  test("a decision id off the allowlist is model_not_allowed on a built-in credential", () => {
    expect(planModelBinding({ ...jev, modelId: "openai/gpt-x" }, table))
      .toEqual({ ok: false, failure: { code: "model_not_allowed" } })
  })

  test("the allowlist guards deployment keys; an operator's own endpoint names its own models", () => {
    const own = { protocol: "evaluation", baseUrl: LOOPBACK, modelId: "e2e-answers", credential: "E2E_LOOPBACK" }
    const planned = planModelBinding(own, table)
    expect(planned.ok && planned.plan.url).toBe(`${LOOPBACK}/v4/ai/evaluation-model`)
  })

  test("a binding of the wrong kind for its seat is invalid at the protocol", () => {
    expect(planModelBinding(jev, table, { kind: "generation" }))
      .toEqual({ ok: false, failure: { code: "invalid", field: "protocol" } })
    expect(planModelBinding(bindingOf(chat()), table, { kind: "decision" }))
      .toEqual({ ok: false, failure: { code: "invalid", field: "protocol" } })
  })

  test.each([
    ["nothing", undefined, "model"],
    ["a string", "fast-local", "model"],
    ["an unknown protocol", { ...bindingOf(chat()), protocol: "grpc" }, "protocol"],
    ["a model id with a space", { ...bindingOf(chat()), modelId: "two words" }, "modelId"],
    ["a lowercase credential", { ...bindingOf(chat()), credential: "sk-live-0123456789" }, "credential"],
    ["a smuggled key", { ...bindingOf(chat()), apiKey: "sk-live" }, "model"]
  ])("%s is invalid and names the field, never the input", (_, input, field) => {
    const planned = planModelBinding(input, table)
    expect(planned).toEqual({ ok: false, failure: { code: "invalid", field } })
    expect(JSON.stringify(planned)).not.toContain("sk-live")
  })

  test("pinning is judged before presence: an unset key never excuses a foreign origin", () => {
    const unset = hostModelCredentials({})
    expect(planModelBinding({ ...bindingOf(chat()), credential: "CEREBRAS_API_KEY" }, unset))
      .toEqual({ ok: false, failure: { code: "endpoint_forbidden" } })
    const cerebras = { protocol: "openai-chat", baseUrl: "https://api.cerebras.ai", modelId: "gpt-oss-120b" }
    expect(planModelBinding({ ...cerebras, credential: "CEREBRAS_API_KEY" }, unset))
      .toEqual({ ok: false, failure: { code: "credential_missing", credential: "CEREBRAS_API_KEY" } })
  })
})

describe("the test result", () => {
  const every: Record<ModelTestFailure["code"], ModelTestFailure> = {
    unreachable: { code: "unreachable" },
    empty_output: { code: "empty_output" },
    refused: { code: "refused", status: 401 },
    timeout: { code: "timeout", deadlineMs: MODEL_TEST_DEADLINE_MS },
    invalid: { code: "invalid", field: "baseUrl" },
    credential_missing: { code: "credential_missing", credential: "OPENAI_API_KEY" },
    credential_unknown: { code: "credential_unknown", credential: "GITHUB_TOKEN" },
    endpoint_forbidden: { code: "endpoint_forbidden" },
    model_not_allowed: { code: "model_not_allowed" },
    host_refused: { code: "host_refused", refusal: "sign_in_required", status: 401, fault: "user" }
  }

  test("the fixture above names every code the union declares", () => {
    expect(Object.keys(every).sort()).toEqual([...MODEL_TEST_FAILURE_CODES].sort())
    expect(ModelTestFailureSchema.options.map((option) => option.shape.code.value).sort())
      .toEqual([...MODEL_TEST_FAILURE_CODES].sort())
  })

  test.each(Object.values(every))("$code decodes, has a fault on both hosts, and a refusal code", (failure) => {
    expect(ModelTestFailureSchema.parse(failure)).toEqual(failure)
    for (const host of ["local", "cloud"] as const) {
      expect(PLUE_FAULTS).toContain(modelFailureFault(failure, host))
      const result = failedModelTest(failure, 12, host)
      expect(ModelTestResultSchema.parse(result)).toEqual(result)
      expect(result).toEqual({ ok: false, latencyMs: 12, failure, fault: modelFailureFault(failure, host) })
    }
    expect(WORKER_FAILURE_CODES).toContain(modelFailureRefusalCode(failure))
  })

  test.each(Object.values(every))("$code carries no free text", (failure) => {
    expect(ModelTestFailureSchema.safeParse({ ...failure, message: "connect failed for sk-live" }).success).toBe(false)
  })

  test("whose problem it is follows the code, the status, and the host", () => {
    expect(modelFailureFault({ code: "refused", status: 401 }, "local")).toBe("user")
    expect(modelFailureFault({ code: "refused", status: 429 }, "local")).toBe("wait")
    expect(modelFailureFault({ code: "refused", status: 503 }, "local")).toBe("dependency")
    expect(modelFailureFault({ code: "refused", status: 307 }, "local")).toBe("user")
    expect(modelFailureFault(every.credential_missing, "local")).toBe("user")
    expect(modelFailureFault(every.credential_missing, "cloud")).toBe("infra")
    expect(modelFailureFault({ ...every.host_refused, fault: "wait" } as ModelTestFailure, "cloud")).toBe("wait")
  })

  test("a decision id off the list is request_invalid, and an unset key is the deployment's", () => {
    expect(modelFailureRefusalCode(every.model_not_allowed)).toBe("request_invalid")
    expect(modelFailureRefusalCode(every.endpoint_forbidden)).toBe("request_invalid")
    expect(modelFailureRefusalCode(every.credential_missing)).toBe("seam_not_configured")
    expect(modelFailureRefusalCode({ code: "refused", status: 429 })).toBe("model_rate_limited")
  })

  test("the timeout states the deadline that armed it", () => {
    expect(ModelTestFailureSchema.safeParse({ code: "timeout" }).success).toBe(false)
    expect(MODEL_TEST_DEADLINE_MS).toBe(15_000)
  })

  test("a status is a provider's refusal, never a success", () => {
    expect(ModelTestFailureSchema.safeParse({ code: "refused", status: 200 }).success).toBe(false)
    expect(ModelTestFailureSchema.safeParse({ code: "refused", status: 307 }).success).toBe(true)
  })

  test("a success is a latency and a bounded sample", () => {
    const ok = { ok: true, latencyMs: 412, sample: "ok" }
    expect(ModelTestResultSchema.parse(ok)).toEqual(ok)
    expect(ModelTestResultSchema.safeParse({ ...ok, sample: "x".repeat(MODEL_TEST_SAMPLE_MAX + 1) }).success).toBe(
      false
    )
    expect(ModelTestResultSchema.safeParse({ ...ok, message: "hello" }).success).toBe(false)
  })

  test("a sample that echoes the key is cut before it leaves the host", () => {
    const secret = "sk-test-REDACTME-123"
    const scrubbed = scrubModelSample(`Bearer ${secret}\n and again ${secret} ${"x".repeat(200)}`, secret)
    expect(scrubbed).not.toContain(secret)
    expect(scrubbed.length).toBeLessThanOrEqual(MODEL_TEST_SAMPLE_MAX)
    expect(scrubModelSample("  ok \n", "")).toBe("ok")
  })

  test("cutting the key out cannot assemble it again from what was around it", () => {
    expect(scrubModelSample("sk-sk-abcabc", "sk-abc")).not.toContain("sk-abc")
  })

  test("the cut a sample gets is the cut a turn's text gets: the value only, every other character kept", () => {
    expect(cutModelCredential("your key is  sk-abc \n", "sk-abc")).toBe("your key is   \n")
    expect(cutModelCredential("sk-sk-abcabc", "sk-abc")).toBe("")
    expect(cutModelCredential("  ok \n", "")).toBe("  ok \n")
  })

  test("a host's refusal to run a test is stored as its code, status and fault, never its words", () => {
    const refusal = { code: "sign_in_required", status: 401, fault: "user", message: "Sign in. token=sk-live" } as const
    const result = hostRefusedModelTest(refusal, 7.6)
    expect(result).toEqual({
      ok: false,
      latencyMs: 8,
      failure: { code: "host_refused", refusal: "sign_in_required", status: 401, fault: "user" },
      fault: "user"
    })
    expect(ModelTestResultSchema.parse(result)).toEqual(result)
    expect(JSON.stringify(result)).not.toContain("sk-live")
  })

  test("no response at all is a host refusal with no code and no status", () => {
    const result = hostRefusedModelTest({ code: null, status: null, fault: "infra" }, 0)
    expect(ModelTestResultSchema.parse(result)).toEqual(result)
    expect(result.ok === false && result.failure).toEqual({
      code: "host_refused",
      refusal: null,
      status: null,
      fault: "infra"
    })
  })

  test("a row's test state is running while asked, then what the last result says", () => {
    const record = (result: ModelTestResult) => ({ id: "fast-local", testedAt: 1, result })
    const passed = record({ ok: true, latencyMs: 3, sample: "ok" })
    const failed = record(failedModelTest({ code: "unreachable" }, 3, "local"))
    expect(modelTestStateOf(undefined, false)).toBe("idle")
    expect(modelTestStateOf(passed, false)).toBe("passed")
    expect(modelTestStateOf(failed, false)).toBe("failed")
    expect(modelTestStateOf(passed, true)).toBe("running")
    expect(MODEL_TEST_STATES).toEqual(["idle", "running", "passed", "failed"])
  })
})

describe("the one fix a failed test offers", () => {
  const failedBy = (failure: ModelTestFailure, host: "local" | "cloud" = "local") => failedModelTest(failure, 3, host)

  test("the record's own mistake is edited", () => {
    for (
      const failure of [
        { code: "refused", status: 401 },
        { code: "invalid", field: "baseUrl" },
        { code: "endpoint_forbidden" },
        { code: "credential_unknown", credential: "NOBODY" }
      ] as const
    ) {
      expect(modelTestFixOf(false, failedBy(failure))).toBe("edit")
    }
  })

  test("a fault that is not the record's is tried again", () => {
    for (
      const failure of [
        { code: "refused", status: 429 },
        { code: "refused", status: 503 },
        { code: "timeout", deadlineMs: 15_000 },
        { code: "unreachable" }
      ] as const
    ) {
      expect(modelTestFixOf(false, failedBy(failure))).toBe("test")
    }
    expect(modelTestFixOf(false, failedBy({ code: "credential_missing", credential: "CEREBRAS_API_KEY" }, "cloud")))
      .toBe("test")
  })

  test("a host row cannot be edited, whatever failed", () => {
    expect(modelTestFixOf(true, failedBy({ code: "refused", status: 401 }))).toBe("test")
  })
})

describe("the rows a host lists", () => {
  const cerebras: ConfiguredModel = {
    id: "cerebras",
    protocol: "openai-chat",
    baseUrl: "https://api.cerebras.ai",
    modelId: "gpt-oss-120b",
    credential: "CEREBRAS_API_KEY",
    builtin: true
  }
  const jev: ConfiguredModel = {
    id: "jev",
    protocol: "evaluation",
    modelId: DECISION_MODEL_IDS[0],
    credential: "AI_GATEWAY_API_KEY",
    builtin: true
  }
  const local = chat({ id: "local", builtin: true })

  test("are exactly the rows a Test on that host would plan", () => {
    const rows = [cerebras, jev, local, chat({ id: "unknown", credential: "NOBODY" })]
    expect(servableModels(rows, table).map((row) => row.id)).toEqual(["cerebras", "jev", "local"])
    for (const row of rows) {
      expect(servableModels([row], table).length === 1).toBe(planModelBinding(bindingOf(row), table).ok)
    }
  })

  test("a row whose key is unset is not listed", () => {
    expect(servableModels([cerebras, jev], hostModelCredentials({ AI_GATEWAY_API_KEY: "vck" }))).toEqual([jev])
  })

  test("a host without egress lists loopback rows only", () => {
    expect(servableModels([cerebras, jev, local], table, { egress: false })).toEqual([local])
  })
})

describe("the catalog and the card", () => {
  const catalog = {
    models: [{ ...chat(), builtin: true }],
    credentials: [...table],
    seats: modelSeatsOf("local")
  }

  test("the catalog lists models, credential names with presence and origins, and seat ids", () => {
    expect(ModelCatalogSchema.parse(catalog)).toEqual(catalog)
    expect(JSON.stringify(catalog)).not.toContain("sk-")
  })

  test("the catalog has no field a value could ride in", () => {
    const leaky = {
      ...catalog,
      credentials: [{ name: "OPENAI_API_KEY", present: true, origins: [], value: "sk-live" }]
    }
    expect(ModelCatalogSchema.safeParse(leaky).success).toBe(false)
  })

  test("the card payload keeps the last result per model beside what is still running", () => {
    const payload = {
      models: catalog.models,
      seats: [{ id: "explainer", recordId: "fast-local", resolvable: true }],
      credentials: catalog.credentials,
      tests: [{ id: "fast-local", testedAt: 1, result: failedModelTest({ code: "refused", status: 401 }, 9, "local") }],
      testing: ["fast-local"],
      host: "observed",
      selected: "fast-local",
      attention: { kind: "seat-unresolved", seat: "explainer" }
    }
    expect(ModelsCardPayloadSchema.parse(payload)).toEqual(payload)
    expect(
      ModelsCardPayloadSchema.safeParse({ ...payload, attention: { kind: "test-failed", seat: "explainer" } }).success
    )
      .toBe(false)
  })
})

describe("a composed call", () => {
  const boolean: ModelQuestion = { type: "boolean", instructions: "Does it mention a color?" }
  const choice: ModelQuestion = { type: "choice", instructions: "Which?", criteria: { blue: "the sky", red: "a rose" } }
  const score: ModelQuestion = { type: "score", instructions: "How sure?", criteria: ["low", "high"] }
  const state: ReadonlyArray<ModelStateField> = [{ key: "text", kind: "text", value: "The sky is blue." }]
  const decision: Extract<ModelCallDraft, { kind: "decision" }> = {
    kind: "decision",
    state: [...state],
    questions: { ok: boolean, which: choice, sure: score }
  }
  const generation: ModelCallDraft = { kind: "generation", system: "", prompt: "Say ok", maxTokens: 32 }

  test("samples generated words and the first typed decision answer without leaking a credential", () => {
    const secret = "sk-secret-123"
    expect(modelCallSample({ kind: "generation", text: `  Answer ${secret}\n` }, secret)).toBe("Answer")
    expect(modelCallSample({ kind: "decision", answers: {} }, secret)).toBe("")
    expect(modelCallSample({
      kind: "decision",
      answers: { ok: { type: "boolean", value: false, probability: 0.23 } }
    }, secret)).toBe("false 0.23")
    expect(modelCallSample({
      kind: "decision",
      answers: { which: { type: "choice", value: "blue", probabilities: { blue: 0.8 }, confidence: 0.8 } }
    }, secret)).toBe("blue 0.80")
    expect(modelCallSample({
      kind: "decision",
      answers: { sure: { type: "score", value: 1, label: "high", probabilities: { high: 1 }, confidence: 1 } }
    }, secret)).toBe("high 1.00")
    expect(modelCallSample({
      kind: "decision",
      answers: { which: { type: "choice", value: `${secret} ${secret}`, probabilities: {}, confidence: 0.8 } }
    }, secret)).toBe("0.80")
    expect(modelCallSample({
      kind: "decision",
      answers: {
        sure: { type: "score", value: 1, label: `score ${secret} ${secret}`, probabilities: {}, confidence: 1 }
      }
    }, secret)).toBe("score 1.00")
  })

  test("the default request per kind is exactly the fixed Test the hosts run", () => {
    expect(modelCallDefault("generation")).toEqual({
      kind: "generation",
      system: "",
      prompt: MODEL_TEST_PROMPT,
      maxTokens: MODEL_TEST_MAX_TOKENS
    })
    const fixed = modelCallDefault("decision")
    if (fixed.kind !== "decision") throw new Error("the decision default is a generation")
    expect(modelStateOf(fixed.state)).toEqual(MODEL_TEST_DECISION.state)
    expect(fixed.questions).toEqual(MODEL_TEST_DECISION.questions)
    for (const kind of MODEL_KINDS) expect(modelCallProblemOf(modelCallDefault(kind))).toBeUndefined()
  })

  test("a request without an input is still a request, and an input rides typed per kind", () => {
    const model: ConfiguredModel = {
      id: "mine",
      protocol: "evaluation",
      modelId: "typesafe-ai/jev",
      credential: "AI_GATEWAY_API_KEY"
    }
    expect(ModelTestRequestSchema.parse({ model })).toEqual({ model })
    expect(ModelTestRequestSchema.parse({ model, input: decision })).toEqual({ model, input: decision })
    expect(ModelTestRequestSchema.parse({ model, input: generation })).toEqual({ model, input: generation })
    expect(ModelTestRequestSchema.safeParse({ model, input: { kind: "decision" } }).success).toBe(false)
    expect(ModelTestRequestSchema.safeParse({ model, input: { ...generation, apiKey: "sk" } }).success).toBe(false)
  })

  test("the state renders as typed fields and travels as one JSON object", () => {
    const fields = [
      { key: "path", kind: "path", value: "src/a.ts" },
      { key: "diff", kind: "diff", value: "@@ -1 +1 @@\n-a\n+b" },
      { key: "passed", kind: "boolean", value: "true" },
      { key: "count", kind: "number", value: "3" },
      { key: "meta", kind: "json", value: "{\"a\":[1]}" }
    ] as const
    expect(modelStateOf(fields)).toEqual({
      path: "src/a.ts",
      diff: "@@ -1 +1 @@\n-a\n+b",
      passed: true,
      count: 3,
      meta: { a: [1] }
    })
    expect(modelStateFieldsOf({ text: "hi", ok: false, n: 2, deep: { a: 1 } })).toEqual([
      { key: "text", kind: "text", value: "hi" },
      { key: "ok", kind: "boolean", value: "false" },
      { key: "n", kind: "number", value: "2" },
      { key: "deep", kind: "json", value: "{\"a\":1}" }
    ])
    expect(modelStateFieldsOf("just text")).toEqual([{ key: "state", kind: "text", value: "just text" }])
  })

  test("malformed authored fields do not become state values, while primitive recorded state keeps its type", () => {
    expect(modelStateOf([
      { key: "valid", kind: "boolean", value: "false" },
      { key: "mistypedBoolean", kind: "boolean", value: "yes" },
      { key: "blankNumber", kind: "number", value: " " },
      { key: "badNumber", kind: "number", value: "NaN" },
      { key: "badJson", kind: "json", value: "{" }
    ])).toEqual({ valid: false })
    expect(modelStateFieldsOf(null)).toEqual([{ key: "state", kind: "json", value: "null" }])
    expect(modelStateFieldsOf([1, "two"])).toEqual([{ key: "state", kind: "json", value: "[1,\"two\"]" }])
    expect(modelStateFieldsOf({ missing: null, nonfinite: Number.POSITIVE_INFINITY })).toEqual([
      { key: "missing", kind: "json", value: "null" },
      { key: "nonfinite", kind: "json", value: "null" }
    ])
  })

  test("a field key is one JSON object key, never the one that sets a prototype", () => {
    expect(["text", "constructor", "toString", "a.b-c_d"].every((key) => MODEL_FIELD_KEY.test(key))).toBe(true)
    expect(MODEL_FIELD_KEY.test("__proto__")).toBe(false)
    expect(ModelStateFieldSchema.safeParse({ key: "__proto__", kind: "json", value: "{\"polluted\":1}" }).success).toBe(
      false
    )
    expect(ModelStateFieldSchema.safeParse({ key: "constructor", kind: "text", value: "x" }).success).toBe(true)
    expect(modelStateOf([{ key: "constructor", kind: "text", value: "x" }])).toEqual({ constructor: "x" })
    expect(modelStateFieldsOf({ ["__proto__"]: 1 })).toEqual([{ key: "state", kind: "number", value: "1" }])
  })

  test("an option or rung name is bounded by the one constant the composer refuses it with", () => {
    const name = "x".repeat(MODEL_CALL_NAME_MAX)
    const question = (criteria: unknown) => ({
      ...decision,
      questions: { which: { type: "choice", instructions: "?", criteria } }
    })
    expect(ModelCallDraftSchema.safeParse(question({ [name]: "", b: "" })).success).toBe(true)
    expect(ModelCallDraftSchema.safeParse(question({ [`${name}x`]: "", b: "" })).success).toBe(false)
    expect(
      ModelCallDraftSchema.safeParse({
        ...decision,
        questions: { sure: { type: "score", instructions: "?", criteria: [name, "b"] } }
      }).success
    ).toBe(true)
    expect(
      ModelCallDraftSchema.safeParse({
        ...decision,
        questions: { sure: { type: "score", instructions: "?", criteria: [`${name}x`, "b"] } }
      }).success
    ).toBe(false)
  })

  test("every limit the question classes enforce is a typed problem, and the wire refuses the same request", () => {
    const problems: ReadonlyArray<readonly [unknown, unknown]> = [
      [{ ...decision, questions: {} }, { code: "no_questions" }],
      [{ ...decision, questions: { ok: { ...boolean, instructions: " " } } }, {
        code: "question_empty",
        question: "ok"
      }],
      [{ ...decision, questions: { which: { ...choice, criteria: { blue: "" } } } }, {
        code: "options_count",
        question: "which",
        count: 1
      }],
      [{
        ...decision,
        questions: {
          which: { ...choice, criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, ""])) }
        }
      }, { code: "options_count", question: "which", count: 256 }],
      [{ ...decision, questions: { sure: { ...score, criteria: ["only"] } } }, {
        code: "rungs_count",
        question: "sure",
        count: 1
      }],
      [{ ...decision, questions: { sure: { ...score, criteria: ["a", "a"] } } }, {
        code: "rungs_distinct",
        question: "sure"
      }],
      [{ ...decision, state: [{ key: "n", kind: "number", value: "many" }] }, {
        code: "field_invalid",
        key: "n",
        kind: "number"
      }],
      [{ ...decision, state: [{ key: "j", kind: "json", value: "{" }] }, {
        code: "field_invalid",
        key: "j",
        kind: "json"
      }],
      [{ ...decision, state: [...state, ...state] }, { code: "field_duplicate", key: "text" }],
      [{ ...decision, state: [{ key: "big", kind: "text", value: "x".repeat(MODEL_CALL_STATE_MAX_BYTES) }] }, {
        code: "state_size",
        bytes: MODEL_CALL_STATE_MAX_BYTES + 10,
        max: MODEL_CALL_STATE_MAX_BYTES
      }],
      [{ ...generation, prompt: " " }, { code: "prompt_empty" }],
      [{ ...generation, maxTokens: 0 }, { code: "max_tokens", max: MODEL_CALL_MAX_TOKENS_MAX }],
      [{ ...generation, maxTokens: MODEL_CALL_MAX_TOKENS_MAX + 1 }, {
        code: "max_tokens",
        max: MODEL_CALL_MAX_TOKENS_MAX
      }]
    ]
    for (const [input, problem] of problems) {
      // The draft schema keeps the request so the composer can show what is wrong; the wire schema refuses it.
      const draft = ModelCallDraftSchema.parse(input)
      expect(modelCallProblemOf(draft)).toEqual(problem)
      expect(ModelCallInputSchema.safeParse(input).success).toBe(false)
    }
    expect(modelCallProblemOf(decision)).toBeUndefined()
    expect(ModelCallInputSchema.parse(decision)).toEqual(decision)
    expect(modelCallProblemOf(generation)).toBeUndefined()
  })

  test("a pass may carry the typed output, and no output field is free text but the generated text", () => {
    const answers = {
      ok: { type: "boolean", value: true, probability: 0.97 },
      which: { type: "choice", value: "blue", probabilities: { blue: 0.97, red: 0 }, confidence: 0.97 },
      sure: { type: "score", value: 1, label: "high", probabilities: { low: 0, high: 1 }, confidence: 1 }
    }
    const passed = { ok: true, latencyMs: 12, sample: "true 0.97", output: { kind: "decision", answers } }
    expect(ModelTestResultSchema.parse(passed)).toEqual(passed)
    const text = { ok: true, latencyMs: 12, sample: "ok", output: { kind: "generation", text: "ok" } }
    expect(ModelTestResultSchema.parse(text)).toEqual(text)
    expect(
      ModelTestResultSchema.safeParse({
        ...passed,
        output: { kind: "decision", answers: { ok: { type: "boolean", value: true, probability: 2 } } }
      }).success
    ).toBe(false)
    expect(
      ModelTestResultSchema.safeParse({ ...passed, output: { kind: "decision", answers, message: "sk-live" } }).success
    ).toBe(false)
    expect(
      ModelTestResultSchema.safeParse({
        ...text,
        output: { kind: "generation", text: "x".repeat(MODEL_CALL_TEXT_MAX + 1) }
      }).success
    ).toBe(false)
  })

  test("raw answers decode against their questions the way the classifier decodes them", () => {
    const decoded = decodeModelAnswers(decision.questions, {
      ok: { type: "boolean", probability: 0.2 },
      which: { type: "choice", choice: "red", probabilities: { red: 0.8 } },
      sure: { type: "score", score: 1 }
    })
    expect(decoded).toEqual({
      ok: true,
      answers: {
        ok: { type: "boolean", value: false, probability: 0.2 },
        which: { type: "choice", value: "red", probabilities: { blue: 0, red: 0.8 }, confidence: 0.8 },
        sure: { type: "score", value: 1, label: "high", probabilities: { low: 0, high: 1 }, confidence: 1 }
      }
    })
    for (
      const raw of [
        {},
        { ...{ ok: { type: "choice", choice: "blue" } } },
        { ok: { type: "boolean", probability: 1.5 } },
        {
          ok: { type: "boolean", probability: 0.5 },
          which: { type: "choice", choice: "green" },
          sure: { type: "score", score: 0 }
        },
        {
          ok: { type: "boolean", probability: 0.5 },
          which: { type: "choice", choice: "blue" },
          sure: { type: "score", score: 5 }
        },
        "nonsense"
      ]
    ) expect(decodeModelAnswers(decision.questions, raw)).toEqual({ ok: false })
  })

  test("decision distributions reject invalid mass and mixed key spaces", () => {
    const questions = { which: choice, sure: score }
    const valid = {
      which: { type: "choice", choice: "blue", probabilities: { blue: 0.7, red: 0.3 } },
      sure: { type: "score", score: 0.6, probabilities: { low: 0.2, high: 0.8 } }
    }
    expect(decodeModelAnswers(questions, valid)).toEqual({
      ok: true,
      answers: {
        which: { type: "choice", value: "blue", probabilities: { blue: 0.7, red: 0.3 }, confidence: 0.7 },
        sure: { type: "score", value: 0.6, label: "high", probabilities: { low: 0.2, high: 0.8 }, confidence: 0.8 }
      }
    })
    for (const probabilities of [{ blue: -0.1 }, { blue: 1.1 }, { blue: Number.NaN }]) {
      expect(decodeModelAnswers(questions, { ...valid, which: { ...valid.which, probabilities } })).toEqual({
        ok: false
      })
    }
    for (
      const probabilities of [{ low: -0.1 }, { high: 1.1 }, { low: Number.POSITIVE_INFINITY }, { low: 0.5, "1": 0.5 }]
    ) {
      expect(decodeModelAnswers(questions, { ...valid, sure: { ...valid.sure, probabilities } })).toEqual({ ok: false })
    }
  })

  test("a temperature is drafted as the text typed, and only one in range becomes the wire's number", () => {
    const typed = (temperature: string) => ModelCallDraftSchema.parse({ ...generation, temperature })
    for (const text of ["3", "warm", "-1", "1e0", "0x1", " ", "2.01"]) {
      // The draft keeps what is on screen, names it, and never reaches the wire.
      expect(typed(text)).toEqual({ ...generation, temperature: text })
      expect(modelCallProblemOf(typed(text))).toEqual({ code: "temperature", max: MODEL_CALL_TEMPERATURE_MAX })
      expect(modelCallInputOf(typed(text))).toBeUndefined()
    }
    for (const [text, number] of [["0", 0], ["0.2", 0.2], [".5", 0.5], ["2", 2], ["1.", 1]] as const) {
      expect(modelCallProblemOf(typed(text))).toBeUndefined()
      expect(modelCallInputOf(typed(text))).toEqual({ ...generation, temperature: number })
    }
    expect(modelCallInputOf(generation)).toEqual(generation)
    expect(modelCallInputOf(decision)).toEqual(decision)
    // The wire is a number in range and nothing else.
    expect(ModelCallInputSchema.parse({ ...generation, temperature: 0.2 })).toEqual({ ...generation, temperature: 0.2 })
    expect(ModelCallInputSchema.safeParse({ ...generation, temperature: "0.2" }).success).toBe(false)
    expect(ModelCallInputSchema.safeParse({ ...generation, temperature: 3 }).success).toBe(false)
    expect(ModelCallDraftSchema.safeParse({ ...generation, temperature: "9".repeat(33) }).success).toBe(false)
  })

  test("a criteria name an object takes as its prototype is refused by the draft, the problem and the wire alike", () => {
    const rungs = { ...decision, questions: { sure: { ...score, criteria: ["__proto__", "other"] } } }
    // A rung is an array element, so the draft holds it and names it inline.
    expect(modelCallProblemOf(ModelCallDraftSchema.parse(rungs))).toEqual({
      code: "name_reserved",
      question: "sure",
      name: "__proto__"
    })
    expect(ModelCallInputSchema.safeParse(rungs).success).toBe(false)
    // An option is a record key: one that arrived as JSON is an own key, and it is refused rather than silently dropped.
    const options = JSON.parse(
      JSON.stringify({ ...decision, questions: { which: { ...choice, criteria: {} } } }).replace(
        "\"criteria\":{}",
        "\"criteria\":{\"__proto__\":\"\",\"blue\":\"\",\"red\":\"\"}"
      )
    )
    expect(Object.keys(options.questions.which.criteria)).toEqual(["__proto__", "blue", "red"])
    expect(ModelCallDraftSchema.safeParse(options).success).toBe(false)
    expect(ModelCallInputSchema.safeParse(options).success).toBe(false)
    const model: ConfiguredModel = {
      id: "mine",
      protocol: "evaluation",
      modelId: "typesafe-ai/jev",
      credential: "AI_GATEWAY_API_KEY"
    }
    for (const input of [rungs, options]) {
      expect(ModelTestRequestSchema.safeParse(JSON.parse(JSON.stringify({ model, input }))).success).toBe(false)
    }
  })

  test("a question id an object takes as its prototype is refused, never dropped from the request it arrived in", () => {
    // A record parse never shows the key rule this id, so the request would pass with the question gone.
    const body = JSON.stringify({ ...decision, questions: { ok: score } }).replace(
      "\"ok\":",
      "\"__proto__\":{\"type\":\"boolean\",\"instructions\":\"?\"},\"ok\":"
    )
    const arrived = JSON.parse(body)
    expect(Object.keys(arrived.questions)).toEqual(["__proto__", "ok"])
    expect(ModelCallDraftSchema.safeParse(arrived).success).toBe(false)
    expect(ModelCallInputSchema.safeParse(arrived).success).toBe(false)
    const model: ConfiguredModel = {
      id: "mine",
      protocol: "evaluation",
      modelId: "typesafe-ai/jev",
      credential: "AI_GATEWAY_API_KEY"
    }
    expect(ModelTestRequestSchema.safeParse({ model, input: JSON.parse(body) }).success).toBe(false)
    expect(ModelCallInputSchema.safeParse({ ...decision, questions: { ok: score } }).success).toBe(true)
  })

  test("a distribution keeps an entry named as an object's prototype: read from a provider, and carried in a result", () => {
    const questions = JSON.parse(
      "{\"sure\":{\"type\":\"score\",\"instructions\":\"?\",\"criteria\":[\"__proto__\",\"other\"]},\"which\":{\"type\":\"choice\",\"instructions\":\"?\",\"criteria\":{\"__proto__\":\"\",\"other\":\"\"}}}"
    )
    const distribution = "{\"__proto__\":0.6,\"other\":0.4}"
    const decoded = decodeModelAnswers(
      questions,
      JSON.parse(
        `{"sure":{"type":"score","score":0,"probabilities":${distribution}},"which":{"type":"choice","choice":"__proto__","probabilities":${distribution}}}`
      )
    )
    if (!decoded.ok) throw new Error("the answer did not decode")
    for (const answer of Object.values(decoded.answers)) {
      if (answer.type === "boolean") throw new Error("the answer holds no distribution")
      expect(Object.entries(answer.probabilities)).toEqual([["__proto__", 0.6], ["other", 0.4]])
      expect(answer.confidence).toBe(0.6)
    }
    // A probability that is no number is still no answer.
    expect(
      decodeModelAnswers(
        questions,
        JSON.parse(
          "{\"sure\":{\"type\":\"score\",\"score\":0,\"probabilities\":{\"__proto__\":\"0.6\"}},\"which\":{\"type\":\"choice\",\"choice\":\"other\"}}"
        )
      ).ok
    ).toBe(false)
    expect(
      decodeModelAnswers(
        questions,
        JSON.parse(
          "{\"sure\":{\"type\":\"score\",\"score\":0,\"probabilities\":[0.6,0.4]},\"which\":{\"type\":\"choice\",\"choice\":\"other\"}}"
        )
      ).ok
    ).toBe(false)
    // The result crosses the wire with every entry it was decoded with.
    const output = JSON.parse(JSON.stringify({ kind: "decision", answers: decoded.answers }))
    const carried = ModelCallOutputSchema.parse(output)
    if (carried.kind !== "decision" || carried.answers.sure?.type !== "score") {
      throw new Error("the output is not the decision")
    }
    expect(Object.entries(carried.answers.sure.probabilities)).toEqual([["__proto__", 0.6], ["other", 0.4]])
    expect(
      ModelCallOutputSchema.safeParse(
        JSON.parse(
          `{"kind":"decision","answers":{"sure":{"type":"score","value":0,"label":"other","probabilities":{"__proto__":1.5},"confidence":1}}}`
        )
      ).success
    ).toBe(false)
  })

  test("a reserved rung name decodes as an own key: the chosen rung keeps its mass", () => {
    const questions = { sure: { ...score, criteria: ["__proto__", "other"] } }
    const decoded = decodeModelAnswers(questions, { sure: { type: "score", score: 0 } })
    if (!decoded.ok) throw new Error("the answer did not decode")
    const sure = decoded.answers.sure
    if (sure?.type !== "score") throw new Error("the answer is not a score")
    expect(sure.label).toBe("__proto__")
    expect(Object.entries(sure.probabilities)).toEqual([["__proto__", 1], ["other", 0]])
    expect(sure.confidence).toBe(1)
  })

  test("the composer card keeps the asked request apart from the draft, each with the binding it is about", () => {
    const binding = bindingOf(chat())
    const asked = { ...generation, temperature: "0.2" }
    const payload = {
      model: "fast-local",
      request: { ...generation, prompt: "edited while out", temperature: "3" },
      pending: { requestId: "0b9e4b0e-ask1", request: asked, binding, owner: null },
      response: {
        askedAt: 1,
        request: asked,
        binding,
        result: { ok: true, latencyMs: 9, sample: "ok", output: { kind: "generation", text: "ok" } }
      }
    }
    expect(ModelCallCardPayloadSchema.parse(payload)).toEqual(payload)
    expect(
      ModelCallCardPayloadSchema.safeParse({ ...payload, pending: { ...payload.pending, apiKey: "sk-live" } }).success
    ).toBe(false)
    expect(
      ModelCallCardPayloadSchema.safeParse({ ...payload, pending: { ...payload.pending, owner: undefined } }).success
    ).toBe(false)
    // A card written before the snapshot existed still replays: a bare flag, a response without a binding, a numeric temperature.
    const before = {
      model: "fast-local",
      request: { ...generation, temperature: 0.2 },
      asking: true,
      response: { askedAt: 1, request: { ...generation, temperature: 0.2 }, result: payload.response.result }
    }
    expect(ModelCallCardPayloadSchema.parse(before)).toEqual(before)
    expect(modelCallInputOf(before.request as ModelCallDraft)).toEqual({ ...generation, temperature: 0.2 })
  })
})
