#!/usr/bin/env node
/*
 * Build the MVP design mock into one self-contained HTML file.
 *
 *   node .specs/design/mock/build.mjs            # dist/index.html
 *   node .specs/design/mock/build.mjs --watch    # rebuild on change
 *
 * The mock renders with the app's real stylesheet: apps/app/src/mainview/index.css
 * compiled through the same Tailwind/PostCSS pipeline the app uses, plus the
 * @smthrs/ui components from source. mock.css holds only what the design adds,
 * so every rule there is a candidate to port into the app.
 */
import { createRequire } from "node:module"
import { mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "../../..")
const APP = join(ROOT, "apps/app")
const MAINVIEW = join(APP, "src/mainview")
const UI = join(ROOT, "packages/smithers/ui/src")
/* --out=<dir> lets parallel authors build without overwriting each other's page. */
const OUT = resolve(HERE, process.argv.find(arg => arg.startsWith("--out="))?.slice(6) ?? "dist")

const requireApp = createRequire(join(APP, "package.json"))
const esbuild = requireApp("esbuild")
const postcss = requireApp("postcss")
const tailwind = requireApp("@tailwindcss/postcss")

/* The component stylesheets the app imports from TSX that the mock's shell uses. */
const COMPONENT_CSS = ["SessionShell.css", "HelpBubble.css", "InputModeMenu.css"].map(file => join(MAINVIEW, file))

const FONTS = [
  ["Inter", 400, "@fontsource/inter/files/inter-latin-400-normal.woff2"],
  ["Inter", 500, "@fontsource/inter/files/inter-latin-500-normal.woff2"],
  ["Inter", 600, "@fontsource/inter/files/inter-latin-600-normal.woff2"],
  ["IBM Plex Mono", 400, "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2"],
  ["IBM Plex Mono", 500, "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2"]
]

const fontFaces = () => FONTS.map(([family, weight, file]) => {
  const data = readFileSync(requireApp.resolve(file)).toString("base64")
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data}) format("woff2")}`
}).join("\n")

/* A person's theme is theirs: dark tokens also apply to one screen marked dark, not only to the whole page. */
/* Each screen carries its own theme: every selector naming the dark root gains a twin scoped to a dark .mock-shell.
   Rewriting per selector keeps descendants intact (":root[dark] .x" becomes ":root[dark] .x, .mock-shell[dark] .x"). */
const DARK_ROOT = ':root[data-theme="dark"]'
const scopeDark = css => {
  const root = postcss.parse(css)
  root.walkRules(rule => {
    if (!rule.selector.includes(DARK_ROOT)) return
    rule.selectors = rule.selectors.flatMap(selector => selector.includes(DARK_ROOT) ? [selector, selector.replaceAll(DARK_ROOT, '.mock-shell[data-theme="dark"]')] : [selector])
  })
  /* Tokens derived from other tokens (color-mix over var(--brand)) resolve where they are declared, so declare
     them again on each screen: a dark screen then blends its own dark base tokens, not the page's light ones. */
  const derived = []
  root.walkRules(rule => {
    if (rule.selector !== ":root" || rule.parent?.type !== "root") return
    rule.walkDecls(/^--/, decl => { if (decl.value.includes("var(")) derived.push(decl.clone()) })
  })
  if (derived.length > 0) root.append(postcss.rule({ selector: ".mock-shell", nodes: derived }))
  return root.toString()
}

const appCss = async () => {
  const entry = join(MAINVIEW, "index.css")
  const compiled = await postcss([tailwind()]).process(readFileSync(entry, "utf8"), { from: entry })
  const components = COMPONENT_CSS.map(file => readFileSync(file, "utf8")).join("\n")
  return scopeDark(`${compiled.css}\n${components}`)
}

const bundle = async () => {
  const result = await esbuild.build({
    entryPoints: [join(HERE, "src/main.tsx")],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    minify: process.argv.includes("--minify"),
    sourcemap: false,
    legalComments: "none",
    nodePaths: [join(APP, "node_modules"), join(ROOT, "node_modules")],
    alias: { "@smthrs/ui": join(UI, "index.ts") },
    loader: { ".css": "text" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning"
  })
  return result.outputFiles[0].text
}

const build = async () => {
  const started = Date.now()
  const [css, js] = await Promise.all([appCss(), bundle()])
  const areaCss = readdirSync(join(HERE, "src/css")).filter(file => file.endsWith(".css")).sort()
    .map(file => readFileSync(join(HERE, "src/css", file), "utf8")).join("\n")
  const mockCss = scopeDark(`${readFileSync(join(HERE, "src/mock.css"), "utf8")}\n${areaCss}`)
  const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smithers MVP design</title>
<style>${fontFaces()}</style>
<style>${css}</style>
<style>${mockCss}</style>
</head>
<body>
<div id="root"></div>
<script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>
`
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, "index.html"), html)
  console.log(`built ${join(OUT, "index.html")} (${(html.length / 1024).toFixed(0)} KiB) in ${Date.now() - started} ms`)
}

await build()

if (process.argv.includes("--watch")) {
  let timer
  const rebuild = () => {
    clearTimeout(timer)
    timer = setTimeout(() => build().catch(error => console.error(error.message)), 120)
  }
  watch(join(HERE, "src"), { recursive: true }, rebuild)
  watch(join(MAINVIEW, "styles"), { recursive: true }, rebuild)
  console.log("watching src/ and the app styles")
}
