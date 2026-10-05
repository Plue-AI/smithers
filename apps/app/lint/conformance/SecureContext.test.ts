/*
 * The secure-context ban (spec §16.3.2, T-INS-04).
 *
 * The install is reached at whatever origin the team uses, and a teammate's laptop opens it over plain HTTP on the
 * LAN. There the browser has no crypto.randomUUID, no crypto.subtle and no service worker. On 2026-10-05 one
 * crypto.randomUUID() call in AppStore left the page blank at http://williams-mac-mini.local:4000. Random ids come
 * from runtime/RandomUuid.ts and digests from `digestSync` (@smthrs/crypto); this test fails by file and line on any
 * new direct use in the app or the shared UI library. Comments and strings may name the APIs.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = fileURLToPath(new URL("../../../../", import.meta.url))
const TREES = ["apps/app/src/mainview", "packages/smithers/ui/src"] as const
const BANNED: ReadonlyMap<string, { readonly receiver: RegExp; readonly use: string }> = new Map([
  ["randomUUID", { receiver: /(?:^|\.)crypto$/, use: "randomUuid() from apps/app/src/mainview/runtime/RandomUuid" }],
  ["subtle", { receiver: /(?:^|\.)crypto$/, use: "digestSync from @smthrs/crypto" }],
  ["serviceWorker", { receiver: /(?:^|\.)navigator$/, use: "nothing: the app registers no service worker" }]
])
/** Tests run under Bun, a secure context; only shipped sources are held to the ban. */
const shipped = (path: string) => /\.[cm]?tsx?$/.test(path) && !/\.(test|spec|fixture|test-support)\.[cm]?tsx?$/.test(path) && !path.endsWith(".d.ts")

const secureContextViolations = (file: string, source: string): string[] => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const banned = BANNED.get(node.name.text)
      const receiver = node.expression.getText(tree).replace(/\?$/, "")
      if (banned?.receiver.test(receiver)) {
        const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree))
        found.push(`${file}:${line + 1} ${receiver}.${node.name.text}: use ${banned.use}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

describe("secure-context APIs", () => {
  test("no shipped app or UI source calls crypto.randomUUID, crypto.subtle or navigator.serviceWorker", () => {
    const violations = TREES.flatMap(tree => [...new Bun.Glob("**/*").scanSync({ cwd: `${root}${tree}` })]
      .filter(shipped)
      .flatMap(path => secureContextViolations(`${tree}/${path}`, readFileSync(`${root}${tree}/${path}`, "utf8"))))
    expect(violations).toEqual([])
  })

  test("each banned kind is caught, through optional chaining and globalThis, and comments are not", () => {
    const planted = [
      "const a = crypto.randomUUID()",
      "const b = globalThis.crypto?.randomUUID?.()",
      "const c = await crypto.subtle.digest(\"SHA-256\", bytes)",
      "void window.navigator.serviceWorker.register(\"/sw.js\")",
      "// crypto.randomUUID() in a comment is documentation",
      "const d = \"crypto.subtle\""
    ].join("\n")
    expect(secureContextViolations("planted.ts", planted).map(line => line.split(" ")[0])).toEqual(["planted.ts:1", "planted.ts:2", "planted.ts:3", "planted.ts:4"])
  })

  test("the scan reaches the trees it guards", () => {
    const counted = TREES.map(tree => [...new Bun.Glob("**/*").scanSync({ cwd: `${root}${tree}` })].filter(shipped).length)
    for (const count of counted) expect(count).toBeGreaterThan(50)
  })
})
