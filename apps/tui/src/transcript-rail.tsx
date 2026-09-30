import { RGBA } from "@opentui/core"
import type { BoxProps } from "@opentui/react"

/** Native box borders can escape a scroll viewport at a negative origin. Text respects its scissor. */
export function TranscriptRail(props: BoxProps) {
  const { style, borderColor, customBorderChars, ...rest } = props
  const tone = typeof borderColor === "string" ? RGBA.fromHex(borderColor) : borderColor ?? RGBA.fromHex("#ffffff")
  return (
    <box
      {...rest}
      style={{ ...style, border: false, paddingLeft: Number(style?.paddingLeft ?? 0) + 1 }}
      renderAfter={function(buffer) {
        for (let y = Math.max(0, this.y); y < Math.min(buffer.height, this.y + this.height); y++) {
          buffer.drawText(
            customBorderChars?.vertical ?? "┃",
            this.x,
            y,
            tone
          )
        }
      }}
    />
  )
}
