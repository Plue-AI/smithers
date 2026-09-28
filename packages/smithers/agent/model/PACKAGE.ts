import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/agent/model"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd
})

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "docs/**", "README.md"],
  checks: [
    {
      id: "credential-out-of-sealed-view",
      title: "Credentials never enter the endpoint, public headers, or sealed request view",
      threat:
        "Anyone who reads a journal, step key, or wire trace recovers a user's provider API key or ChatGPT OAuth token and spends on their account.",
      lookFor: [
        "A Route or OpenAIChatGPT header path that bypasses publicHeaders' isCredentialName refusal (custom header name, case variant, or merge after validation).",
        "Endpoint.make accepting a credential-carrying query key, embedded userinfo, or a query that survives into Endpoint.url unsorted and unchecked.",
        "WireTrace.record or ModelRequest serialization writing a signed header, bearer value, or account id instead of only public headers and hashes.",
        "Auth.sign output or the affinity header spread over signed headers so a protocol-controlled name overwrites Authorization."
      ],
      paths: [
        "src/Auth.ts",
        "src/Endpoint.ts",
        "src/Route.ts",
        "src/OpenAIChatGPT.ts",
        "src/ModelRequest.ts",
        "src/internal/WireTrace.ts"
      ]
    },
    {
      id: "error-redaction",
      title: "Provider errors and HTTP diagnostics redact every signed secret before they leave the executor",
      threat:
        "A hostile or misconfigured provider echoes the request's API key in an error body, and the key lands in a ModelError that journals, UIs, and other tenants can read.",
      lookFor: [
        "A ModelError message, body, or url built from raw response text or HttpClientError.message without passing through redactBody, redactSecrets, or errorSanitizer.",
        "secretValues missing a credential carried by a header named only in Auth.credentialHeaders, or by a Raw/FormData body.",
        "redactStructuredValue or redactTextBody stopping at a depth or pattern so a nested or unconventional credential field survives.",
        "Stream-time failures (HTTP 200 protocol errors, framing errors) mapped outside the sanitize captured for the signed attempt."
      ],
      paths: [
        "src/RequestExecutor.ts",
        "src/Route.ts",
        "src/ModelError.ts",
        "src/FailureCopy.ts",
        "src/Classifier.ts",
        "src/*Messages.ts",
        "src/OpenAI*.ts"
      ]
    },
    {
      id: "provider-output-bounds",
      title: "Provider response bytes are bounded before they are buffered, parsed, or walked",
      threat:
        "A compromised or proxied provider endpoint streams an unbounded or deeply nested body and exhausts the memory or stack of the host running a user's run.",
      lookFor: [
        "A response read via response.text or response.json with no byte cap (compare cappedBody and Framing.bounded).",
        "Tool-call argument or reasoning text accumulated across stream frames without a total budget.",
        "Recursive walks of provider JSON (redaction, classification, event decoding) with no depth limit."
      ],
      paths: [
        "src/Framing.ts",
        "src/RequestExecutor.ts",
        "src/Evaluator.ts",
        "src/ToolStream.ts",
        "src/AnthropicMessages.ts",
        "src/OpenAI*.ts"
      ]
    },
    {
      id: "proxy-origin-routing",
      title: "Credentials are sent only to the provider origin or the proxy explicitly configured for that provider",
      threat:
        "Whoever controls a run's environment or a route's baseUrl redirects a user's provider key or OAuth token to a host they own.",
      lookFor: [
        "proxyOrigin or providerOrigin sending a provider's credential to SMITHERS_MODEL_PROXY_URL when SMITHERS_MODEL_PROXY_PROVIDERS omits that provider.",
        "A baseUrl accepted over plain http, or not validated through Endpoint.make, before a bearer or api key is signed onto it (Evaluator.layerVercelGateway included).",
        "Endpoint.joinPath letting an encoded traversal climb out of the configured base path."
      ],
      paths: ["src/Endpoint.ts", "src/Route.ts", "src/OpenAIChatGPT.ts", "src/Evaluator.ts"]
    },
    {
      id: "auth-refresh-and-affinity",
      title: "Token refresh retries once and affinity tokens never cross routes or sessions",
      threat:
        "One user's run reuses another session's provider affinity token or loops refreshing a rejected credential, leaking cache state or hammering the provider account.",
      lookFor: [
        "The authentication catch in Route.stream retrying more than once or retrying on a non-authentication code.",
        "The process-global affinity map keyed without routeId and cacheKey, or cacheKey values that two tenants in one process can share.",
        "A returned affinity header value stored without size bounds or forwarded to a different route."
      ],
      paths: ["src/Route.ts", "src/Auth.ts"]
    },
    {
      id: "tool-call-integrity",
      title: "Only a complete, validated tool call from the live stream is emitted as executable",
      threat:
        "A malicious or truncated provider stream makes the host run a tool with partial, guessed, or attacker-shaped arguments against the user's workspace.",
      lookFor: [
        "A protocol emitting tool-call-end for a call whose arguments did not pass ToolStream.end's JSON-object validation.",
        "A length or content-filter (ToolStream.truncated) turn whose open calls are completed through end instead of flushAborted, or replayed to the next request.",
        "A tool-call delta or end accepted for an unknown or reused callId, letting one call's fragments merge into another call's arguments.",
        "Tool-search or deferred-tool responses (OpenAIResponses, DeferredTools) turning provider-supplied names into callable tools without matching the request's declared tools."
      ],
      paths: [
        "src/ToolStream.ts",
        "src/ModelEvent.ts",
        "src/DeferredTools.ts",
        "src/AnthropicMessages.ts",
        "src/OpenAI*.ts"
      ]
    },
    {
      id: "evaluator-prompt-state",
      title: "Evaluator requests carry only the declared state and questions and treat answers as untrusted",
      threat:
        "Content inside a user's run state steers the Jev evaluator into a wrong decision, or the gateway answer is trusted beyond its decoded schema.",
      lookFor: [
        "Evaluator request bodies concatenating free-form state text into question instructions instead of the separate state field.",
        "Gateway answers used before decodeRawAnswers validates them, or confidence treated as authorization.",
        "zeroDataRetention defaulting to false or being dropped from the wire body."
      ],
      paths: ["src/Evaluator.ts"]
    },
    {
      id: "docs-examples-secrets",
      title: "Docs and README examples carry no real keys and show redacted credential handling",
      threat:
        "A user copies a docs snippet that hardcodes a key or passes a plain string credential into a sealed request.",
      lookFor: [
        "A literal key-shaped value (sk-, sk-ant-, bearer tokens) in docs or README.",
        "An example passing a credential through headers or ModelRequest instead of Auth with Redacted."
      ],
      paths: ["docs/**", "README.md"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
