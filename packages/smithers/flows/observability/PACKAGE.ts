import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/flows/observability"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd
})

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "docs/**", "README.md"],
  checks: [
    {
      id: "collector-endpoint-validation",
      title: "Every exporter endpoint is decoded by Endpoint.decode before any request is built",
      threat:
        "A misconfigured or attacker-influenced endpoint sends traces, logs, and exporter auth headers to a host the operator never named.",
      lookFor: [
        "An exporter URL built from options.baseUrl or options.endpoint without passing through Endpoint.decode first.",
        "isAbsoluteHttpUrl accepting a value with userinfo, query, fragment, backslash, or a code unit at or below 0x20 that new URL repairs.",
        "signalUrl or normalize producing a URL whose host differs from the decoded endpoint's host."
      ],
      paths: ["src/Endpoint.ts", "src/Otlp.ts", "src/NodeOtel.ts"]
    },
    {
      id: "exporter-header-secrecy",
      title: "Exporter auth headers never reach logs, metrics, errors, or the journal",
      threat:
        "Anyone who can read ambient logs, the journal, or collector data obtains the vendor token passed in Otlp headers.",
      lookFor: [
        "The otlp_export_discarded warning or any refusal message including request headers, the request URL, or options.headers.",
        "InvalidExporterEndpoint or InvalidResourceConfiguration messages that embed the rejected raw value instead of only its path."
      ],
      paths: ["src/Otlp.ts", "src/Endpoint.ts", "src/Resource.ts", "src/internal/schemaIssuePath.ts"]
    },
    {
      id: "ambient-env-isolation",
      title: "Exported resources carry only validated explicit attributes, never ambient OTEL_* environment",
      threat:
        "A process environment variable such as OTEL_RESOURCE_ATTRIBUTES leaks host secrets or unbounded metadata into every export request.",
      lookFor: [
        "An Otlp.layerJson or NodeSdk.layer call not wrapped with ConfigProvider.layer(ConfigProvider.fromUnknown({})).",
        "A new code path that reads process.env or Resource.layerFromEnv.",
        "NodeOtel's OTLP*Exporter constructors, which read OTEL_EXPORTER_OTLP_*_HEADERS, TIMEOUT, and CLIENT_CERTIFICATE/KEY straight from process.env and bypass the ConfigProvider isolation, left undocumented or without explicit overrides."
      ],
      paths: ["src/Otlp.ts", "src/NodeOtel.ts", "src/BrowserOtel.ts", "src/Otel.ts", "src/Resource.ts"]
    },
    {
      id: "journal-log-redaction",
      title: "Every record forwarded to the durable journal is snapshotted and passed through Redaction.redact",
      threat:
        "Secrets in log messages, annotations, or error causes of one run persist in the journal where other readers of that run can read them.",
      lookFor: [
        "makeLog or snapshotLog emitting a payload that skipped Redaction.redact, including the fallback records in the catch branch.",
        "snapshotValue copying accessor (getter) properties or invoking user toString/toJSON instead of reading data descriptors only.",
        "Error stack or cause fields projected without going through the redacted candidate."
      ],
      paths: ["src/JournalLogger.ts"]
    },
    {
      id: "journal-logger-resource-bounds",
      title: "A hostile logged value cannot exhaust memory, CPU, or the forwarding queue",
      threat:
        "Code that logs attacker-controlled data (huge strings, deep or cyclic objects, throwing proxies) stalls or crashes the run's host process.",
      lookFor: [
        "A snapshot path that allocates before checking maximumSnapshotBytes, maximumSnapshotMembers, or maximumSnapshotDepth.",
        "A Proxy trap or throwing getter escaping snapshotValue's try/catch into the logger callback.",
        "The logger callback blocking or awaiting instead of refusing on a full queue.",
        "Key truncation via boundedText letting two keys collide or a record written on a non-null prototype."
      ],
      paths: ["src/JournalLogger.ts"]
    },
    {
      id: "export-request-bounds",
      title: "Resource and transport limits keep every export request bounded",
      threat:
        "A caller-supplied resource or a stalled collector makes every export oversized or pins unbounded in-flight requests, denying telemetry and memory to the host.",
      lookFor: [
        "encodedResourceBytes under-counting a value shape so a resource over maximumResourceBytes decodes.",
        "boundedClient forwarding a request over maxRequestBytes or queueing past maxInFlight instead of discarding.",
        "A request body type for which contentLength is undefined so the size check is skipped."
      ],
      paths: ["src/Otlp.ts", "src/Resource.ts"]
    },
    {
      id: "docs-copyable-secrets",
      title: "Docs examples carry placeholder credentials and send tokens only over https",
      threat:
        "A user copying a docs snippet commits a real token or sends a bearer token to a plaintext http collector.",
      lookFor: [
        "A literal token, key, or password in docs other than a YOUR_TOKEN style placeholder.",
        "An example pairing an authorization header with an http:// baseUrl."
      ],
      paths: ["docs/**", "README.md"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
