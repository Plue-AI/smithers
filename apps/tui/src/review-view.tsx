/**
 * A settled run's combined captured diff, full height: the run's name and
 * totals, then each file it changed with its patches, oldest first.
 */
import type { ScrollBoxRenderable } from "@opentui/core"
import { type RefObject, useRef } from "react"
import * as Changes from "./changes.ts"
import { PatchView } from "./panel-view.tsx"
import { color } from "./theme.ts"
import * as Undo from "./undo.ts"

export function ReviewView(props: {
  readonly title: string
  readonly changes: ReadonlyArray<Undo.Change>
  /** Lines, or a half page with `page`. */
  readonly scrollRef: RefObject<((by: number, page: boolean) => void) | undefined>
}) {
  const scroll = useRef<ScrollBoxRenderable>(null)
  props.scrollRef.current = (by, page) =>
    page ? scroll.current?.scrollBy(by * 0.5, "viewport") : scroll.current?.scrollBy(by)
  const { changes } = props
  const total = Undo.counts({
    added: changes.reduce((sum, change) => sum + change.added, 0),
    removed: changes.reduce((sum, change) => sum + change.removed, 0)
  })
  const undone = changes.length > 0 && changes.every((change) => change.undone)
  return (
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, paddingLeft: 1 }}>
      <text wrapMode="none" style={{ flexShrink: 0, marginBottom: 1 }}>
        <strong fg={color.text}>{props.title}</strong>
        <span fg={color.faint}>
          {`  ${changes.length} ${changes.length === 1 ? "file" : "files"}${total === "" ? "" : ` ${total}`}`}
          {undone ? " · undone" : ""}
        </span>
      </text>
      <scrollbox
        ref={scroll}
        style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, scrollbarOptions: { visible: false } }}
      >
        {changes.map((change) => (
          <box key={change.path} style={{ marginBottom: 1, flexShrink: 0 }}>
            <text wrapMode="none">
              <strong fg={color.text}>{change.path}</strong>
              <span fg={color.faint}>
                {"  "}
                {Undo.counts(change)}
                {!undone && change.undone ? " · undone" : ""}
              </span>
            </text>
            {change.patches.map((patch, index) =>
              // An empty file created or removed has no lines; its header already says `new` or `deleted`.
              patch.patch.includes("@@") || Changes.structured(patch) === undefined
                ? <PatchView key={index} path={change.path} patch={patch.patch} split={false} />
                : null
            )}
          </box>
        ))}
      </scrollbox>
    </box>
  )
}
