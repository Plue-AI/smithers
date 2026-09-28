/** Build graph entry for the thin packaged model-host executable. */
import { Smithers } from "@smthrs/targets"
import { Package as modelHostPackage } from "../../packages/smithers/agent/model-host/PACKAGE.ts"

const cwd = "apps/model-host"
const sources = Smithers.glob("src/**/*.ts")

const check = Smithers.Typecheck({
  srcs: [sources],
  deps: [modelHostPackage.lib],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

const bundle = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("build.mjs")),
  srcs: [sources, Smithers.file("build.mjs"), Smithers.file("package.json")],
  deps: [modelHostPackage.lib],
  cwd
})

/** Drives the bundled executable over HTTP: startup guards, body limit, auth,
 * grant refusals, disconnect cancellation and shutdown. */
const test = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("test/serve.test.mjs")]),
  srcs: [sources, Smithers.file("build.mjs"), Smithers.file("package.json")],
  deps: [modelHostPackage.lib],
  cwd
})

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "build.mjs"],
  checks: [
    {
      id: "loopback-bind-only",
      title: "The model host listens only on a loopback address",
      threat: "A host on the local network calls the model host and spends the operator's provider credentials or reads chat turns.",
      lookFor: [
        "A --host value other than 127.0.0.1, ::1 or localhost that reaches server.listen without the startup guard throwing.",
        "A default, environment variable or later code path that rebinds the server to 0.0.0.0 or a routable address."
      ],
      paths: ["src/serve.ts"]
    },
    {
      id: "bearer-auth-every-route",
      title: "Every route requires the SMITHERS_CHAT_HOST_TOKEN bearer and compares it safely",
      threat: "A local process or DNS-rebound browser page without the host token runs model turns or probes on the operator's credentials.",
      lookFor: [
        "A request routed to testModel or handle that reaches the provider before the Authorization header is checked against the token.",
        "A token comparison with !== or === instead of a constant-time comparison such as crypto.timingSafeEqual.",
        "An empty SMITHERS_CHAT_HOST_TOKEN accepted at startup, making `Bearer ` a valid credential.",
        "Routing decided from the Host header (new URL built from incoming.headers.host) so a crafted Host changes which handler, and which auth, applies."
      ],
      paths: ["src/serve.ts"]
    },
    {
      id: "model-test-credential-egress",
      title: "The /v1/model/test probe sends a credential only to the origins it is pinned to",
      threat: "A caller holding the host token names an attacker baseUrl with a built-in or custom credential and exfiltrates the operator's provider API key or any other environment secret.",
      lookFor: [
        "createModelProbe called with env: process.env and egress: true without the origin pinning of ConfiguredModel credentials being enforced before the request leaves.",
        "A ConfiguredModel credential name that resolves to an arbitrary environment variable such as SMITHERS_CHAT_HOST_TOKEN rather than only built-in or SMITHERS_MODEL_KEY_ names.",
        "A baseUrl pointing at loopback, link-local or metadata addresses (169.254.169.254) accepted by the probe."
      ],
      paths: ["src/serve.ts"]
    },
    {
      id: "request-body-limits",
      title: "Request bodies and connections are bounded before buffering",
      threat: "A local caller exhausts the model host's memory or sockets and denies chat turns to the operator.",
      lookFor: [
        "A body larger than MAX_BODY_BYTES or MODEL_TEST_BODY_MAX_BYTES buffered in full before refusal, including chunked bodies without Content-Length.",
        "A non-numeric Content-Length (NaN) that bypasses the declared-size check.",
        "No headers, request or idle timeout on the http server, so a slow client holds a socket and buffer forever."
      ],
      paths: ["src/serve.ts"]
    },
    {
      id: "no-secret-echo",
      title: "No response, stdout line or error carries the host token, a provider key or provider error text",
      threat: "A caller or log reader learns SMITHERS_CHAT_HOST_TOKEN or a provider API key from a response body, a forwarded header or the startup line.",
      lookFor: [
        "The startup stdout JSON or a thrown startup Error that interpolates process.env values, the token or the raw SMITHERS_CHAT_MODEL JSON.",
        "The catch around the request handler returning the caught error's message or stack instead of the fixed turn_failed code.",
        "Response headers copied verbatim from handle() or testModel() that could carry an upstream provider header or the Authorization value."
      ],
      paths: ["src/serve.ts"]
    }
  ]
})

export const Package = Smithers.Package({ targets: { bundle, check, test, ...securityReview } })
