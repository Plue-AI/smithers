/**
 * Typed MDX prompt compilation. Compilation parses declarations without running
 * expressions; the verified module loader evaluates the resulting JavaScript.
 *
 * @since 1.0.0-rc.1
 */

import { createProcessor } from "@mdx-js/mdx"
import type { Content as TextContent } from "./Prompt/jsx-runtime.ts"

/**
 * Content accepted by the text JSX runtime.
 * @category models
 * @since 1.0.0-rc.1
 */
export type Content = TextContent

/**
 * Declare the concrete props of each imported prompt in its companion declaration.
 * @category models
 * @since 1.0.0-rc.1
 */
export type Component<Props> = (props: Props) => string

/**
 * Compile MDX to an ESM module whose default export renders Markdown text.
 * Imported components and expressions run only when the resulting module runs.
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const compile = (source: string): string => {
  const processor = createProcessor({ jsxImportSource: "@smthrs/registry/Prompt", development: false })
  // MDX's processor types name the ESTree output as the run input, although
  // its remark/rehype pipeline takes the parsed Markdown tree at runtime.
  const program = processor.runSync(processor.parse(source) as unknown as Parameters<typeof processor.runSync>[0])
  const index = program.body.findIndex((node) => node.type === "ExportDefaultDeclaration")
  // The pinned MDX compiler emits a named function for its default component,
  // including empty documents and documents declaring a custom layout.
  type DefaultExport = Extract<typeof program.body[number], { readonly type: "ExportDefaultDeclaration" }>
  const exported = program.body[index] as DefaultExport
  const declaration = exported.declaration as Extract<
    DefaultExport["declaration"],
    { readonly type: "FunctionDeclaration" }
  >
  const identifier = declaration.id!
  const component = identifier.name
  let renderer = "_smithersRenderPrompt"
  while (source.includes(renderer)) renderer += "_"
  program.body[index] = { ...declaration, id: identifier }
  program.body.push({
    type: "ImportDeclaration",
    attributes: [],
    source: { type: "Literal", value: "@smthrs/registry/Prompt/jsx-runtime" },
    specifiers: [{
      type: "ImportSpecifier",
      imported: { type: "Identifier", name: "render" },
      local: { type: "Identifier", name: renderer }
    }]
  }, {
    type: "ExportDefaultDeclaration",
    declaration: {
      type: "ArrowFunctionExpression",
      async: false,
      expression: true,
      params: [{ type: "Identifier", name: "props" }],
      body: {
        type: "CallExpression",
        optional: false,
        callee: { type: "Identifier", name: renderer },
        arguments: [{
          type: "CallExpression",
          optional: false,
          callee: { type: "Identifier", name: component },
          arguments: [{ type: "Identifier", name: "props" }]
        }]
      }
    }
  })
  return processor.stringify(program)
}
