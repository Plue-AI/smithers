// The JSDoc convention gate. Shared by every package's `eslint.config.js`.
//
// The convention it enforces is written down in CONTRIBUTING.md, "JSDoc
// convention". In short: every module gets a header, every exported
// declaration gets prose, `@since`, and a lowercase `@category` — and a block
// carrying `@private` drops `@category`, because a private export belongs to
// no documented category.

import jsdoc from "eslint-plugin-jsdoc"

/**
 * Exported *declarations* only. A re-export (`export { x }`, `export * as Ns
 * from "…"`) is deliberately not matched: its prose belongs at the definition
 * site, and an index that re-states it would be a second copy to keep honest.
 */
const exported = [
  "ExportNamedDeclaration[declaration]",
  "ExportDefaultDeclaration[declaration.type='FunctionDeclaration']",
  "ExportDefaultDeclaration[declaration.type='ClassDeclaration']"
]

const exportedDeclaration = (node) =>
  node.type === "ExportNamedDeclaration" && node.declaration !== null ||
  node.type === "ExportDefaultDeclaration" &&
    (node.declaration.type === "FunctionDeclaration" || node.declaration.type === "ClassDeclaration")

const restrict = (comment, message) => exported.map((context) => ({ context, comment, message }))

const lacking = (tag) => `JsdocBlock:not(*:has(JsdocTag[tag=${tag}]))`

/**
 * The module header, as its own rule.
 *
 * eslint-plugin-jsdoc's `Program` context does not express this: the comment it
 * resolves for `Program` is whichever block precedes the first statement, so a
 * file with no header but a documented first export satisfies it, and a file
 * with a header separated by a blank line does not. Both answers are wrong.
 * Reading the leading comments directly is unambiguous.
 *
 * The header must also be followed by a blank line. tsc attaches an abutting
 * block to the first import, and drops both from the `.d.ts` when that import
 * is runtime-only; a detached block is always emitted (#2207).
 */
export const moduleHeader = {
  meta: {
    type: "suggestion",
    docs: { description: "require a detached module header block carrying `@since` before the first statement" },
    fixable: "whitespace",
    schema: []
  },
  create: (context) => ({
    Program: (node) => {
      const source = context.sourceCode
      const first = node.body[0]
      const leading = first === undefined
        ? source.getAllComments()
        : source.getAllComments().filter((comment) => comment.range[1] <= first.range[0])
      const header = leading.find((comment) => {
        if (comment.type !== "Block" || !comment.value.startsWith("*")) return false
        // Export documentation carries @category; module documentation does
        // not. @module is also accepted as an explicit identity marker.
        return /^\s*\*\s*@module\b/m.test(comment.value) || !/^\s*\*\s*@category\b/m.test(comment.value)
      })
      if (header !== undefined && /^\s*\*\s*@since\b/m.test(header.value)) {
        const next = source.getTokenAfter(header, { includeComments: true })
        if (next === null || next.loc.start.line > header.loc.end.line + 1) return
        // A block that also documents the first export stays attached: the
        // export always reaches the `.d.ts`, and the block with it.
        if (first !== undefined && next === source.getFirstToken(first) && exportedDeclaration(first)) return
        context.report({
          loc: header.loc,
          message: "Follow the module header with a blank line, or tsc can drop it from the `.d.ts`.",
          fix: (fixer) => fixer.insertTextAfter(header, "\n")
        })
        return
      }
      context.report({
        node,
        message: "Every module needs a header block above the first statement: prose, then `@since`."
      })
    }
  })
}

const flowsJsdoc = { rules: { "module-header": moduleHeader } }

export const jsdocConvention = [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    plugins: { jsdoc, "flows-jsdoc": flowsJsdoc },
    rules: {
      // Every exported declaration carries a block, and that block says
      // something. `@private` is exempt from the prose requirement for the
      // same reason it is exempt from `@category`.
      "jsdoc/require-jsdoc": ["error", {
        // Only the exported declarations above — never an inner function or a
        // class method, which the rule would otherwise require by default.
        require: {
          ArrowFunctionExpression: false,
          ClassDeclaration: false,
          ClassExpression: false,
          FunctionDeclaration: false,
          FunctionExpression: false,
          MethodDefinition: false
        },
        contexts: exported
      }],
      "jsdoc/require-description": ["error", { contexts: exported, exemptedBy: ["inheritdoc", "private"] }],

      // `@since` and `@category` are the two tags this house adds to effect's.
      // eslint-plugin-jsdoc has no "require this tag" rule, so they are stated
      // the other way round: a block missing one is restricted syntax.
      "jsdoc/no-restricted-syntax": ["error", {
        contexts: [
          ...restrict(lacking("since"), "Every exported declaration needs `@since`."),
          ...restrict(
            `${lacking("category")}:not(*:has(JsdocTag[tag=private]))`,
            "Every exported declaration needs `@category`, unless it is `@private`."
          ),
          ...restrict(
            "JsdocBlock:has(JsdocTag[tag=category][name=/^[^a-z]/])",
            "`@category` takes a lowercase noun (models, constructors, layers, services, errors, schemas)."
          ),
          {
            context: "any",
            comment: "JsdocBlock:has(JsdocTag[tag=internal])",
            message: "`@internal` is not used here — put the module under `internal/` and mark it `@private`."
          }
        ]
      }],

      "flows-jsdoc/module-header": "error",

      // `@category` and `@since` are the house tags.
      // `@slop` marks declarations identified by the slop sweep.
      // Everything else must be a real JSDoc tag.
      "jsdoc/check-tag-names": ["error", { definedTags: ["category", "since", "slop"] }]
    }
  }
]
