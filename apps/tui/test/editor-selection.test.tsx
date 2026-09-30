/** Editable product surfaces preserve the unselected suffix with keys or dragging. */
import { InputRenderable, type Renderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act, useState } from "react"
import * as AppView from "../src/app-view.tsx"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy()
    setup = undefined
  })
})
const inputOf = (node: Renderable): InputRenderable | undefined => {
  if (node instanceof InputRenderable) return node
  for (const child of node.getChildren()) {
    const found = inputOf(child)
    if (found !== undefined) return found
  }
  return undefined
}

const composerOf = (node: Renderable): TextareaRenderable | undefined => {
  if (node instanceof TextareaRenderable) return node
  for (const child of node.getChildren()) {
    const found = composerOf(child)
    if (found !== undefined) return found
  }
  return undefined
}

// The host double isolates editor interaction from provider execution; the
// actual App, terminal parser, native editor and session files remain real.
for (
  const { text, start, end, selected, expected } of [
    { text: "abc", start: 1, end: 2, selected: "b", expected: "azc" },
    { text: "😀e\u0301x", start: 2, end: 3, selected: "e\u0301", expected: "😀zx" }
  ]
) {
  for (const source of ["keyboard", "mouse"] as const) {
    for (const reverse of [false, true]) {
      test(`composer ${source} ${reverse ? "reverse" : "forward"} selection of ${text} persists suffix`, async () => {
        const root = mkdtempSync(join(tmpdir(), "tui-composer-selection-"))
        const cwd = join(root, "project")
        mkdirSync(cwd)
        const previousSessions = process.env.SMITHERS_TUI_SESSION_DIR
        process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
        const prompts: string[] = []
        const host: Host.Host = {
          cwd,
          judged: false,
          run: (input) => {
            prompts.push(input.prompt)
            return { done: Promise.resolve({ _tag: "cancelled" }), cancel: () => {} }
          },
          dispose: async () => {}
        }
        try {
          setup = await testRender(
            <App host={host} seat="replay:test" models={[]} contextWindow={() => 10000} />,
            { width: 100, height: 30 }
          )
          await setup.renderOnce()
          await act(async () => {
            setup!.renderer.stdin.emit("data", Buffer.from(text))
          })
          await setup.renderOnce()
          const composer = composerOf(setup.renderer.root)
          expect(composer).toBeDefined()
          expect(composer!.plainText).toBe(text)
          await act(async () => {
            if (source === "mouse") {
              await setup!.mockMouse.drag(
                composer!.x + (reverse ? end : start),
                composer!.y,
                composer!.x + (reverse ? start : end),
                composer!.y,
                0,
                { delayMs: 0 }
              )
            } else {
              setup!.mockInput.pressKey("ARROW_LEFT")
              if (!reverse) setup!.mockInput.pressKey("ARROW_LEFT")
              setup!.mockInput.pressKey(reverse ? "ARROW_LEFT" : "ARROW_RIGHT", { shift: true })
            }
          })
          expect(composer!.getSelectedText()).toBe(selected)
          await act(async () => {
            setup!.renderer.stdin.emit("data", Buffer.from("z"))
          })
          await setup.renderOnce()
          expect(composer!.plainText).toBe(expected)
          expect(setup.captureCharFrame()).toContain(expected)
          await act(async () => {
            setup!.mockInput.pressKey("RETURN")
          })
          await setup.renderOnce()
          expect(prompts).toEqual([expected])
          expect(
            Session.list(cwd).flatMap((session) => Session.load(session.file))
              .flatMap((record) => record.type === "user" ? [record.text] : [])
          ).toEqual([expected])
        } finally {
          await act(async () => {
            setup?.renderer.destroy()
            setup = undefined
          })
          if (previousSessions === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
          else process.env.SMITHERS_TUI_SESSION_DIR = previousSessions
          rmSync(root, { recursive: true, force: true })
        }
      })
    }
  }
}

for (const surface of ["form", "search"] as const) {
  for (
    const { text, start, end, selected, expected } of [
      { text: "abc", start: 1, end: 2, selected: "b", expected: "azc" },
      { text: "😀e\u0301x", start: 2, end: 3, selected: "e\u0301", expected: "😀zx" }
    ]
  ) {
    for (const source of ["keyboard", "mouse"] as const) {
      for (const reverse of [false, true]) {
        test(`${surface} ${source} ${reverse ? "reverse" : "forward"} selection of ${text} preserves suffix`, async () => {
          const changes: string[] = []
          function Surface() {
            const [value, setValue] = useState("")
            const onInput = (next: string) => {
              changes.push(next)
              setValue(next)
            }
            return surface === "form"
              ? (
                <AppView.FlowFormView
                  form={{
                    id: "configure",
                    flow: "Configure",
                    focus: 0,
                    fields: [{ name: "name", label: "Name", kind: "text", required: true }],
                    draft: { name: value }
                  }}
                  height={10}
                  compact
                  onField={(_name, next) => onInput(next)}
                />
              )
              : (
                <AppView.PickerDialog
                  title="Flows"
                  query={value}
                  onQuery={onInput}
                  rows={[]}
                  selected={0}
                  empty="No flows"
                  width={80}
                  height={24}
                />
              )
          }
          setup = await testRender(<Surface />, { width: 80, height: 24 })
          // Emit a real UTF-8 terminal burst; mockInput.typeText iterates UTF-16 units.
          await act(async () => {
            setup!.renderer.stdin.emit("data", Buffer.from(text))
          })
          await setup.renderOnce()
          const input = inputOf(setup.renderer.root)
          expect(input).toBeDefined()
          expect(input!.value).toBe(text)
          await act(async () => {
            if (source === "mouse") {
              await setup!.mockMouse.drag(
                input!.x + (reverse ? end : start),
                input!.y,
                input!.x + (reverse ? start : end),
                input!.y,
                0,
                { delayMs: 0 }
              )
            } else {
              // Move from the end using real parsed arrow keys, then select one unit.
              setup!.mockInput.pressKey("ARROW_LEFT")
              if (!reverse) setup!.mockInput.pressKey("ARROW_LEFT")
              setup!.mockInput.pressKey(reverse ? "ARROW_LEFT" : "ARROW_RIGHT", { shift: true })
            }
          })
          expect(input!.getSelectedText()).toBe(selected)
          await act(async () => {
            await setup!.mockInput.typeText("z")
          })
          await setup.renderOnce()
          expect(changes.at(-1)).toBe(expected)
          expect(input!.value).toBe(expected)
          expect(setup.captureCharFrame()).toContain(expected)
        })
      }
    }
  }
}
