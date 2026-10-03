import { Smithers } from "@smthrs/targets"

const cwd = "apps/web"
const sources = [
  Smithers.glob("src/**/*"),
  Smithers.file("index.html"),
  Smithers.file("package.json"),
  Smithers.file("tsconfig.json"),
  Smithers.file("vite.config.ts"),
  Smithers.file("//pnpm-lock.yaml")
]

const check = Smithers.Typecheck({
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

// Vite produces a browser bundle rather than a TypeScript library.
const build = Smithers.ToolBuild({
  tool: "vite",
  command: "pnpm",
  args: ["run", "build"],
  inputs: sources,
  outputs: ["dist"],
  deps: [],
  env: {},
  cache: false,
  cwd
})

const test = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("test/home.test.mjs")]),
  srcs: [...sources, Smithers.file("test/home.test.mjs")],
  deps: [build],
  cwd
})

export const Package = Smithers.Package({ targets: { check, build, test } })
