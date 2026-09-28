/**
 * Targets for the private Smithers component kit.
 *
 * The product UI (`apps/app`) imports `@smthrs/ui`, which ships its sources
 * directly and uses Bun for its tests.
 *
 * Its presence here is what this file is for. The root `packageDefaults`
 * synthesizes `BuildAndCheckTypeScriptPackage` — a dual `dist/esm` and `dist/cjs` library
 * build, a vitest
 * suite at 100% coverage, eslint, and dprint — for every `packages/*`
 * directory that ships no `PACKAGE.ts` of its own. This package satisfies none of
 * that: it ships its sources directly, types against `@types/bun`, and tests
 * with `bun test`. Declaring the targets it can honor opts it out of the
 * synthesis (`PackageDefaults` skips a directory holding a `PACKAGE.ts`) and puts
 * its real gates in the graph instead of targets that cannot pass.
 *
 * Two of the four standard gates are honored here: the `bun test` suite and a
 * `tsc --noEmit` typecheck over `src/`. The eslint and dprint halves are NOT
 * declared, because this package carries neither an `eslint.config.js` nor a
 * `dprint.json` and both tools are per-package devDependencies elsewhere in the
 * workspace; wiring them requires package tooling that this target does not
 * provide.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/ui"

/** The component sources the suite drives. */
const sources = [
  Smithers.glob("//packages/smithers/ui/src/**/*.ts"),
  Smithers.glob("//packages/smithers/ui/src/**/*.tsx")
]

/**
 * Checks every component source against the package tsconfig.
 *
 * The package publishes its `src/` tree directly (`files: ["src/"]`, every
 * export condition points at a `.ts`/`.tsx` source), so this typecheck is the
 * only thing standing between a type error and a consumer's build. Root
 * `pnpm run check` reaches it through the package's own `check` script.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The component suite: everything under `tests/`, run by Bun against a
 * happy-dom registrator, which is how this package has always tested.
 *
 * @since 0.1.0
 * @category test
 */
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["tests"]),
  srcs: [
    ...sources,
    Smithers.glob("//packages/smithers/ui/tests/**/*.ts"),
    Smithers.glob("//packages/smithers/ui/tests/**/*.tsx")
  ],
  deps: [],
  cwd
})

/**
 * The package's documentation as a file group (`docs/**`, the README, and
 * package.json), matching the filegroup BuildAndCheckTypeScriptPackage emits. The docs-site
 * content sync in `apps/docs/ui/PACKAGE.ts` depends on it by label, the one
 * way an input reaches across a package boundary.
 */
const docsFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("docs/**/*.md"), Smithers.file("README.md"), Smithers.file("package.json")],
  cwd
})

/** Complete React source input for the reproducible Solid projection. */
const solidCodegenInputs = Smithers.Filegroup({
  srcs: [Smithers.glob("src/**/*"), Smithers.file("package.json")],
  cwd
})

/**
 * Security review for the component kit. The kit renders model output, tool
 * results, run artifacts, and caller-supplied URLs inside the product UI, so
 * its checks target DOM sinks, link and frame sources, injected CSS, secret
 * display, and the command lines composed from forms and composer text.
 * `ui-styleguide/` is a nested package with its own review and lies outside
 * the default `src/**` include.
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "href-scheme-filter",
      title: "Every rendered anchor href passes safeHref before reaching the DOM",
      threat: "A model, tool result, or synced calendar event plants a javascript: or data: link that runs script in the signed-in user's app session when clicked.",
      lookFor: [
        "An <a href={...}> or onNavigate/onLinkClick call fed from source.href, event.href, resource.href, registryUrl, source.url, or a markdown link without safeHref.",
        "A safeHref change that stops rejecting C0 control characters or that allows a scheme beyond http, https, and mailto.",
        "A target=\"_blank\" anchor without rel=\"noreferrer\" or rel=\"noopener\"."
      ],
      paths: [
        "src/internal/safeHref.ts",
        "src/primitives/markdown.tsx",
        "src/agentic/Sources.tsx",
        "src/agentic/InlineCitation.tsx",
        "src/calendar/Calendar.tsx",
        "src/approvals/ApprovalCard.tsx",
        "src/artifacts/PackageInfo.tsx",
        "src/vault/wikilinks.ts"
      ]
    },
    {
      id: "web-preview-sandbox",
      title: "WebPreview frames only http(s) or same-origin paths and never grants allow-scripts with allow-same-origin",
      threat: "Agent-controlled preview content escapes the iframe sandbox and reads the user's session cookies or app origin storage.",
      lookFor: [
        "sanitizePreviewSrc accepting javascript:, data:, blob:, file:, protocol-relative //host, or /\\host after tab/CR/LF stripping.",
        "The iframe src or sandbox attribute placed before the {...props} spread so a runtime caller can override it.",
        "resolveSandboxTokens returning both allow-scripts and allow-same-origin, or accepting a token outside the known set."
      ],
      paths: ["src/sandbox/WebPreview.tsx"]
    },
    {
      id: "no-raw-html-sinks",
      title: "Untrusted text reaches the DOM only as React text children",
      threat: "Model output, stack traces, diffs, terminal streams, or vault notes inject HTML or script into the user's app page.",
      lookFor: [
        "dangerouslySetInnerHTML, innerHTML, outerHTML, insertAdjacentHTML, or document.write fed from props or model data instead of a module constant.",
        "The markdown primitive, CodeBlock, StackTrace, Snippet, or agent-output renderers switching to an HTML string renderer.",
        "Milkdown Crepe or pierre diff/code-view configured to render raw HTML nodes from document content."
      ],
      paths: [
        "src/primitives/**",
        "src/agentic/**",
        "src/artifacts/**",
        "src/adapters/**",
        "src/vault/**",
        "src/chat/**",
        "src/canvas/**"
      ]
    },
    {
      id: "untrusted-image-src",
      title: "Model- or tool-supplied image URLs never load arbitrary remote origins",
      threat: "A prompt-injected model or tool result sets an image or favicon URL that makes the viewer's browser send run data or their IP to an attacker host on render, with no click.",
      lookFor: [
        "An <img src> fed from ToolCall part.src, Sources or InlineCitation faviconUrl, Attachment thumbnailUrl, or Message avatar src without a scheme or origin allowlist.",
        "A markdown image node rendered as <img> with the document-supplied URL.",
        "An img src accepting javascript:, file:, or a remote http(s) URL where only data:, blob:, or same-origin should reach it."
      ],
      paths: [
        "src/agentic/ToolCall.tsx",
        "src/agentic/Sources.tsx",
        "src/agentic/InlineCitation.tsx",
        "src/chat/Attachment.tsx",
        "src/chat/Message.tsx",
        "src/primitives/markdown.tsx"
      ]
    },
    {
      id: "chart-css-injection",
      title: "Chart config keys and colors cannot break out of the generated <style> block",
      threat: "A caller-supplied chart config breaks out of the injected stylesheet to restyle or overlay app UI, or loads a remote url() that tracks the viewer.",
      lookFor: [
        "ChartStyle emitting a key or id that fails CSS_IDENTIFIER, or a color that contains ;, {, }, or </style.",
        "A color value such as url(https://...) or image-set(...) accepted by UNSAFE_CSS_VALUE and reaching fill/stroke.",
        "Any other style injection (styles.tsx, terminal.tsx, MarkdownEditor.tsx) built from props rather than static CSS."
      ],
      paths: ["src/adapters/chart.tsx", "src/styles.tsx", "src/adapters/terminal.tsx", "src/adapters/markdown-editor/MarkdownEditor.tsx"]
    },
    {
      id: "secret-display",
      title: "Masked secrets never appear in the DOM, labels, or logs",
      threat: "A shoulder-surfer, screen recorder, or DOM-reading extension reads a user's API key or environment secret shown while masked.",
      lookFor: [
        "SecretField rendering value, a length-derived mask, or the value inside an aria-label/title/data attribute while revealed is false.",
        "EnvironmentVariable rendering a credential-shaped value as plain text because secret defaults to false.",
        "A write-only flow-form field that reaches assembleArgs, a draft, or a console call instead of being dropped by publicFormPayload."
      ],
      paths: ["src/artifacts/SecretField.tsx", "src/artifacts/EnvironmentVariables.tsx", "src/flow-form.ts", "src/internal/useCopyFeedback.ts"]
    },
    {
      id: "command-line-assembly",
      title: "Composer text and form values cannot smuggle extra flow names, flags, or sourceCard tokens",
      threat: "Prefilled or model-suggested form text runs a different flow, adds a --flag, or rebinds sourceCard so a run acts on another card than the user chose.",
      lookFor: [
        "assembleArgs joining a text value containing spaces, --name, or sourceCard= unquoted so the flow grammar reads it as a separate token.",
        "splitRunSource or runSearchPayload trusting a sourceCard or run id taken from user-typed args instead of the recorded card.",
        "parseCommand or COMMAND_NAME widening so punctuation or a typo after / executes a side-effecting flow instead of becoming a prompt."
      ],
      paths: ["src/command-line.ts", "src/run-command.ts", "src/flow-form.ts", "src/flow-arguments.ts"]
    },
    {
      id: "untrusted-parse-bounds",
      title: "Parsers of agent output, schemas, diffs, and JSON stay bounded on hostile input",
      threat: "A model or tool emits deeply nested, cyclic, or huge output that freezes or crashes the user's app tab.",
      lookFor: [
        "Recursion in parseAgentOutput, formatPartialJson, or SchemaDisplay without the MAX_*_DEPTH, property, or seen-set guards.",
        "A regex over agent text or diffs with nested quantifiers that backtracks catastrophically.",
        "diff-paginate or diff-hunks materializing an unbounded hunk or line list for one render."
      ],
      paths: ["src/agentic/**", "src/artifacts/SchemaDisplay.tsx", "src/diff*.ts", "src/diff-hunks.tsx", "src/vault/**"]
    },
    {
      id: "attachment-intake",
      title: "Prompt attachments enforce accept, size, and count limits and revoke their object URLs",
      threat: "A pasted or dropped file bypasses the configured type or size limit, or leaked object URLs keep file bytes readable after removal.",
      lookFor: [
        "The paste or drop path in PromptInput skipping fileMatchesAccept, maxFileSizeBytes, maxFiles, or disabled checks that the picker path applies.",
        "An object URL created for a non-image type or never revoked on removal or unmount."
      ],
      paths: ["src/prompt/PromptInput.tsx"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { solidCodegenInputs, check, docsFiles, unitTests, ...securityReview }
})
