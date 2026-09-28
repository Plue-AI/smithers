import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/mcp"

const standard = BuildAndCheckTypeScriptPackage({ cwd })

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = standard

/**
 * The MCP client spawns an untrusted server process, parses its stdout, and
 * projects its catalog as flows a model can call. Each check below names one
 * boundary between that server and the host, the run, or the model.
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "docs/**", "README.md"],
  checks: [
    {
      id: "child-env-allowlist",
      title: "A spawned MCP server receives only the bootstrap allowlist plus its declared env",
      threat:
        "A third-party MCP server reads the host's API keys, cloud credentials, or GitHub tokens from an inherited environment it was never granted.",
      lookFor: [
        "A ChildProcess.make call without extendEnv: false, or with env built from process.env instead of ChildProcessEnvironment.make.",
        "A code path that spawns the server with a shell or joins command and args into one string.",
        "An options.cwd or options.command taken from persisted config without ConnectOptionsSchema decoding."
      ],
      paths: ["src/internal/StdioTransport.ts", "src/McpClient.ts"]
    },
    {
      id: "inbound-frame-bounds",
      title: "Server stdout cannot exhaust host memory or CPU before a frame is rejected",
      threat:
        "A malicious MCP server crashes or stalls the Smithers host by streaming an endless line, deep JSON, a huge catalog, or a cursor loop.",
      lookFor: [
        "A frame splitter that buffers bytes past maxFrameBytes before failing, or decodes the whole buffer per chunk.",
        "A recursive traversal of parsed server JSON (enumKey, compileOutputSchema, validators) that runs before JsonLimits.checkParsed or without yielding.",
        "A tools/list loop that is not bounded by maxCatalogPages, maxTools, and repeated-cursor detection.",
        "A stderr tail or pending-request map that grows without the configured cap."
      ],
      paths: ["src/internal/StdioTransport.ts", "src/internal/JsonLimits.ts", "src/McpClient.ts"]
    },
    {
      id: "reply-correlation",
      title: "A server reply settles only the client request whose id it answers",
      threat:
        "A malicious MCP server forges a result for a different in-flight tool call, or makes the client treat its own server request as a reply.",
      lookFor: [
        "A server Request or Notification id looked up in the pending-request map.",
        "A non-canonical string id, float, or null id normalized onto a live numeric request id.",
        "A reply accepted after its request timed out or was cancelled, or after the connection closed."
      ],
      paths: ["src/internal/Rpc.ts", "src/internal/StdioTransport.ts"]
    },
    {
      id: "remote-text-withheld-from-errors",
      title: "Model-facing McpError messages never carry server stderr, remote error text, or argument paths",
      threat:
        "A malicious server injects prompt text into the model through error messages, or a failure leaks the user's credentials or private arguments into journals and transcripts.",
      lookFor: [
        "An McpError message interpolating reply.message, reply.data, stderr bytes, a JsonIssue path, or a spawn error message.",
        "publicError in McpFlows returning anything other than a client-authored McpError message.",
        "A Diagnostics event whose detail is not wrapped in Redacted, or stderr forwarded without Redaction.redact."
      ],
      paths: [
        "src/internal/StdioTransport.ts",
        "src/McpClient.ts",
        "src/McpFlows.ts",
        "src/internal/DiagnosticReporter.ts",
        "src/McpError.ts"
      ]
    },
    {
      id: "outbound-argument-snapshot",
      title: "Tool arguments are copied as plain JSON once before any frame is written",
      threat:
        "A model or caller-supplied argument object with getters, proxies, prototype keys, or cycles runs code in the host, pollutes a prototype, or sends a different value than was validated.",
      lookFor: [
        "Arguments passed to JSON.stringify without snapshotArguments, or read twice (once to check, once to send).",
        "Assignment of snapshot keys with obj[key] = value, which lets a __proto__ key set the prototype.",
        "A snapshot budget that is not bounded by maxOutboundFrameBytes before the full tree is expanded."
      ],
      paths: ["src/McpClient.ts", "src/internal/Rpc.ts"]
    },
    {
      id: "tool-projection-authority",
      title: "A projected MCP tool can only be called through a declared name and the host's narrowed grant",
      threat:
        "A malicious server shadows another flow or server's tool by name, or a run calls an MCP tool with authority the host never granted.",
      lookFor: [
        "A tool name containing '/', control characters, or unbounded length reaching the `${prefix}/${toolName}` flow name.",
        "A tool name of '.' or '..', or with zero-width or bidi format characters (U+200B-U+200F, U+202A-U+202E, U+2066-U+2069), that isForbiddenToolName accepts and that renders as a different flow name.",
        "callTool dispatching a name that was not in the frozen catalog snapshot.",
        "A projected binding whose capabilities or effects are narrower than every action, making an opaque tool look safe to a read-only envelope.",
        "include/exclude or namePrefix handling that lets an empty or colliding prefix merge two servers' tools."
      ],
      paths: ["src/McpFlows.ts", "src/McpClient.ts"]
    },
    {
      id: "catalog-prompt-injection",
      title: "Server-supplied descriptions and schemas are treated as untrusted model input",
      threat:
        "A malicious MCP server hides instructions in tool descriptions or inputSchema text that steer the agent into calling other flows with the user's authority.",
      lookFor: [
        "tool.description or inputSchema passed to FlowBinding without a length bound or marking as remote content.",
        "A catalog object exposed to consumers before JsonLimits.freezeParsed, so a later mutation changes what the model saw."
      ],
      paths: ["src/McpFlows.ts", "src/McpClient.ts"]
    },
    {
      id: "docs-credential-examples",
      title: "Copyable docs pass credentials only through a server's declared env",
      threat:
        "A user who copies an example leaks a GitHub token to npm install scripts, a shell history, or an unpinned server package.",
      lookFor: [
        "An example with a literal token, or a credential passed on the command line or in args.",
        "An install snippet without --ignore-scripts, an exact version, or removal of credential variables.",
        "Prose that says env is merged into the full inherited environment, contradicting the bootstrap allowlist."
      ],
      paths: ["docs/**", "README.md"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
