/*
 * A TODO being written (mvp.md §4.2, J2): the app agent drafts it from the
 * discussion, the member edits it, places it and commits it. Nothing reaches
 * the stack until Commit. Place: Append (default), Before an item, or Amend
 * an item (fold into it, worked on its branch, same TODO and PR).
 */
import { Button } from "@smthrs/ui"
import { ChevronDown, CornerDownRight, GitCommitHorizontal, ListEnd, Merge } from "lucide-react"
import { Card } from "../parts"
import { typedOr, useFrame } from "../frame"
import { refOf, type Place, type World } from "../world"
import type { ExtraCardProps } from "./extra"

const titleOf = (world: World, id: string): string => {
  const todo = world.todos.find(each => each.id === id)
  return todo === undefined ? id : `${refOf(world, todo)} ${todo.title}`
}

const placeWord = (world: World, place: Place): string =>
  place.kind === "append" ? "Append" : place.kind === "before" ? `Before ${titleOf(world, place.id)}` : `Amend ${titleOf(world, place.id)}`

export const DraftCard = ({ id, target, view }: ExtraCardProps) => {
  const frame = useFrame()
  const { world } = frame.state
  const draft = world.drafts.find(each => each.id === target)
  if (draft === undefined) return null
  const open = world.stack.map(each => world.todos.find(todo => todo.id === each)!).filter(todo => todo.state !== "merged" && todo.state !== "dropped")
  const committed = draft.committed === undefined ? undefined : world.todos.find(each => each.id === draft.committed)
  /* Amend folds into an existing item: no new TODO, so the card says which one it changed. */
  const amending = draft.place.kind === "amend" ? world.todos.find(each => each.id === (draft.place as { readonly id: string }).id) : undefined
  const title = amending === undefined ? "New TODO" : `Amend ${refOf(world, amending)}`
  if (committed !== undefined) {
    return (
      <Card id={id} kind="draft" title={title}>
        <div className="mvp-receipt-line"><GitCommitHorizontal size={14} aria-hidden="true" />{amending === undefined ? "Committed as" : "Amended"} <span className="mvp-ref-chip">{refOf(world, committed)}</span> <b>{committed.title}</b></div>
      </Card>
    )
  }
  return (
    <Card id={id} kind="draft" title={title}>
      <label className="mvp-field">
        <span>Title</span>
        <input value={typedOr(frame, `draft-title:${draft.id}`, draft.title)} readOnly data-mock="draft-title" />
      </label>
      <label className="mvp-field">
        <span>Prompt</span>
        <textarea rows={4} value={typedOr(frame, `draft-prompt:${draft.id}`, draft.prompt)} readOnly data-mock="draft-prompt" />
      </label>
      <div className="mvp-field-row">
        <span className="mvp-field-label">Place</span>
        <span className="mvp-place">
          <button type="button" className="mvp-select" aria-haspopup="listbox" aria-expanded={view === "place"} data-mock="draft-place">
            {draft.place.kind === "append" ? <ListEnd size={14} aria-hidden="true" /> : draft.place.kind === "before" ? <CornerDownRight size={14} aria-hidden="true" /> : <Merge size={14} aria-hidden="true" />}
            <span>{placeWord(world, draft.place)}</span><ChevronDown size={14} aria-hidden="true" />
          </button>
          {view === "place" ? (
            <div className="mvp-menu mvp-place-menu" role="listbox" aria-label="Place">
              <button type="button" role="option" aria-selected={draft.place.kind === "append"} data-mock="place-append"><ListEnd size={14} aria-hidden="true" />Append<span className="mvp-menu-note">last in stack</span></button>
              {open.map(todo => (
                <button key={`before-${todo.id}`} type="button" role="option" data-mock={`place-before-${todo.id}`}
                  aria-selected={draft.place.kind === "before" && draft.place.id === todo.id}>
                  <CornerDownRight size={14} aria-hidden="true" />Before <b>{refOf(world, todo)} {todo.title}</b></button>
              ))}
              <div className="mvp-menu-sep" role="separator" />
              {open.map(todo => (
                <button key={`amend-${todo.id}`} type="button" role="option" data-mock={`place-amend-${todo.id}`}
                  aria-selected={draft.place.kind === "amend" && draft.place.id === todo.id}>
                  <Merge size={14} aria-hidden="true" />Amend <b>{refOf(world, todo)} {todo.title}</b></button>
              ))}
            </div>
          ) : null}
        </span>
      </div>
      {draft.issue === undefined ? null : (
        <label className="mvp-check-row">
          <input type="checkbox" checked={draft.fixes} readOnly />Closes #{draft.issue} when merged
        </label>
      )}
      <div className="mvp-actions">
        <span className="mvp-actions-end">
          <Button size="sm" variant="ghost">Discard</Button>
          <Button size="sm" variant="solid" data-mock="draft-commit">Commit</Button>
        </span>
      </div>
    </Card>
  )
}
