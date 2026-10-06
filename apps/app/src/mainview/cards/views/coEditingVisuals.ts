import { StateField, type Extension, type EditorState } from "@codemirror/state"
import { Decoration, EditorView, GutterMarker, gutter } from "@codemirror/view"
import type { FileCard } from "@smthrs/rpc/FileCard"
import { authorRanges } from "../liveAttribution"
import { actorColour, actorName } from "./ActorChip"

/** Visuals consume supplied attribution and presence; neither grants editing authority. */
export function coEditingVisuals(authors: FileCard["authors"], editors: FileCard["editors"]): Extension {
  const identity = (actor: FileCard["authors"][number]) => actor.kind === "person" || actor.kind === "github"
    ? `${actor.kind}:${actor.login}` : actor.kind === "agent" ? `agent:${actor.id}` : actor.kind
  const known = new Set(authors.map(identity))
  const colours = (state: EditorState) => Decoration.set(state.facet(authorRanges).flatMap(range => {
    if (!known.has(identity(range.actor))) return []
    const from = Math.max(0, range.from), to = Math.min(state.doc.length, range.to)
    if (from >= to) return []
    return [Decoration.mark({ class: "code-author", attributes: {
      style: `--who: ${actorColour(range.actor)}`, "data-kind": range.actor.kind,
      title: actorName(range.actor)
    } }).range(from, to)]
  }), true)
  const decorations = StateField.define({
    create: colours,
    update: (_value, transaction) => colours(transaction.state),
    provide: field => EditorView.decorations.from(field)
  })
  const lines = new Map<number, FileCard["editors"]>()
  for (const editor of editors) {
    const row = lines.get(editor.line) ?? []
    row.push(editor)
    lines.set(editor.line, row)
  }
  class NameFlag extends GutterMarker {
    constructor(readonly row: FileCard["editors"]) { super() }
    eq(other: NameFlag) { return JSON.stringify(this.row) === JSON.stringify(other.row) }
    toDOM() {
      const dom = document.createElement("span"), name = document.createElement("span")
      const actor = this.row[0]!.actor
      dom.className = "code-name-flag"
      dom.title = this.row.map(editor => actorName(editor.actor)).join(", ")
      dom.dataset.kind = actor.kind
      dom.style.setProperty("--who", actorColour(actor))
      name.textContent = actorName(actor)
      dom.append(name)
      if (this.row.length > 1) {
        const count = document.createElement("b")
        count.textContent = `+${this.row.length - 1}`
        dom.append(count)
      }
      return dom
    }
  }
  return [decorations, gutter({ class: "code-presence-gutter", lineMarker: (view, line) => {
    const row = lines.get(view.state.doc.lineAt(line.from).number)
    return row ? new NameFlag(row) : null
  } })]
}
