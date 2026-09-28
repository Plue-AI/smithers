/** Astro and PTY/GIF tools do not have native target types. Keep their argv here. */
import { Smithers } from "@smthrs/targets"
import { runtimeInputs } from "./inputs.mjs"
const cwd = "apps/tui-docs"
const inputs = [
  ...runtimeInputs().map((file: string) => Smithers.file(`//${file}`)),
  Smithers.glob("scripts/**/*"),
  Smithers.glob("server/**/*"),
  Smithers.file("astro.config.mjs"),
  Smithers.file("tsconfig.json"),
  Smithers.file("//pnpm-lock.yaml"),
  Smithers.file("//pnpm-workspace.yaml"),
  Smithers.file("//scripts/workspace-packages.mjs")
]
export const sourceFiles = Smithers.Filegroup({ srcs: inputs, cwd })
/** The smithers.sh pages the coverage test checks against the TUI registries. */
const sitePages = Smithers.Filegroup({
  srcs: [
    Smithers.file("//apps/site/src/content/docs/docs/tui/commands.mdx"),
    Smithers.file("//apps/site/src/content/docs/docs/tui/keys.mdx"),
    Smithers.file("//apps/site/src/content/docs/docs/installation.mdx"),
    Smithers.file("//apps/site/src/content/docs/docs/tui/cli.mdx"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/cli/tui.mdx"),
    Smithers.file("//apps/site/src/data/versions.json"),
    Smithers.file("//apps/site/src/data/help/tui.txt"),
    Smithers.file("//apps/site/scripts/docs-text.mjs"),
    Smithers.file("//apps/site/scripts/journeys/journeys.mjs")
  ],
  cwd
})
export const recordings = (docs: ReturnType<typeof Smithers.Filegroup>, tui: ReturnType<typeof Smithers.Filegroup>) =>
  Smithers.ToolBuild({
    tool: "tui-recordings",
    command: "pnpm",
    args: ["run", "record"],
    inputs: [],
    outputs: ["public/recordings"],
    deps: [sourceFiles, docs, tui],
    env: {},
    cache: true,
    cwd
  })
export const site = (recordings: ReturnType<typeof Smithers.ToolBuild>, docs: ReturnType<typeof Smithers.Filegroup>) =>
  Smithers.ToolBuild({
    tool: "astro",
    command: "pnpm",
    args: ["exec", "astro", "build"],
    inputs: [Smithers.file("public/favicon.svg")],
    outputs: ["dist"],
    deps: [sourceFiles, recordings, docs],
    env: {},
    cache: true,
    cwd
  })
export const check = (docs: ReturnType<typeof Smithers.Filegroup>) =>
  Smithers.ToolRun({ command: "pnpm", args: ["run", "check"], inputs: [], deps: [sourceFiles, docs], cwd })
export const test = (docs: ReturnType<typeof Smithers.Filegroup>) =>
  Smithers.NodeTest({
    runner: Smithers.testRunner(
      ["test/playground.test.ts", "test/sponsor.test.ts", "test/recordings.test.ts", "test/coverage.test.ts"].map(
        Smithers.file
      )
    ),
    srcs: [Smithers.glob("test/**/*")],
    deps: [sourceFiles, docs, sitePages],
    cwd
  })
export const browserTest = (build: ReturnType<typeof Smithers.ToolBuild>) =>
  Smithers.Shell.Test({
    bin: Smithers.Runtime.bin,
    args: ["apps/tui-docs/scripts/browser-test.mjs"],
    data: [build, sourceFiles],
    timeout: "10m"
  })
