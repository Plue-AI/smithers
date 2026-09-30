import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import { ToastStack } from "../src/view.tsx"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  await act(async () => setup?.renderer.destroy())
  setup = undefined
})

test.each([true, false])(
  "long settlement names keep every selected stack row visible (compact %s)",
  async (compact) => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      id: `flow${index}`,
      surface: `flow:${index}`,
      tone: "info" as const,
      text: `flow${index}-` + "界".repeat(70)
    }))
    setup = await act(() =>
      testRender(
        <ToastStack rows={rows} height={6} compact={compact} />,
        { width: 80, height: 24 }
      )
    )
    await act(async () => setup!.renderOnce())
    const frame = setup!.captureCharFrame()
    expect(frame.match(/enter/g)).toHaveLength(compact ? 6 : 3)
    for (const index of compact ? [2, 3, 4, 5, 6, 7] : [5, 6, 7]) {
      expect(frame).toContain(`flow${index}-`)
    }
  }
)
