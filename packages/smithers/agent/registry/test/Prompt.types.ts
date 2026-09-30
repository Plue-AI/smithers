import Instructions from "./fixtures/mdx/prompt.mdx"

Instructions({ name: "Ada" }) satisfies string
// @ts-expect-error Prompt props are required.
Instructions({})
// @ts-expect-error Prompt props use their declared types.
Instructions({ name: 42 })
// @ts-expect-error Concrete imports do not permit undeclared props.
Instructions({ name: "Ada", surprise: true })
