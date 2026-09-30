import { testRender } from "@opentui/react/test-utils"
import { expect, test } from "bun:test"
import { act } from "react"
import { TranscriptRail } from "../src/transcript-rail.tsx"

test.each([[80, 24, "┃"], [110, 32, "▌"]] as const)(
  "a clipped transcript rail protects controls at %sx%s (%s)",
  async (width, height, rail) => {
    const setup = await testRender(
      <box height={height} width={width}>
        <text height={1}>Chat Summary</text>
        <box flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
          <scrollbox stickyScroll stickyStart="bottom" flexGrow={1} flexShrink={1} minHeight={0}>
            <TranscriptRail
              style={{ border: ["left"] }}
              borderColor="#ffffff"
              customBorderChars={{
                topLeft: rail,
                topRight: rail,
                bottomLeft: rail,
                bottomRight: rail,
                horizontal: rail,
                vertical: rail,
                topT: rail,
                bottomT: rail,
                leftT: rail,
                rightT: rail,
                cross: rail
              }}
            >
              {Array.from({ length: 50 }, (_, i) => <text key={i}>row {i}</text>)}
            </TranscriptRail>
          </scrollbox>
        </box>
        <text height={1} flexShrink={0}>Decision</text>
        <text height={1} flexShrink={0}>Recovery</text>
        <text height={2} flexShrink={0}>Composer</text>
        <text height={1} flexShrink={0}>Footer</text>
      </box>,
      { width, height }
    )
    try {
      await setup.renderOnce()
      await setup.renderOnce()
      const rows = setup.captureCharFrame().split("\n")
      expect(rows[0]?.trim()).toBe("Chat Summary")
      expect(rows[height - 5]?.trim()).toBe("Decision")
      expect(rows[height - 4]?.trim()).toBe("Recovery")
      expect(rows[height - 3]?.trim()).toBe("Composer")
      expect(rows[height - 1]?.trim()).toBe("Footer")
      expect(rows[1]?.startsWith(rail)).toBe(true)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  }
)
