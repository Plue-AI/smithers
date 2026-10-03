import { useCallback, useRef, useState } from "react"
import type { KeyboardEvent } from "react"
import { flowAction, flowProps } from "./flows/FlowAction"
import type { FlowName } from "./flows/FlowName"
import { rovingKeyDown } from "./RovingKeyDown"
import { active, CHAT_KINDS, type ChatFilter } from "./state/ChatTimeline"

interface Props {
  readonly open: boolean
  readonly filter: ChatFilter
  readonly onRunCommand: (name: FlowName, args?: string) => void
}

export const ChatFilterMenu = ({ open, filter, onRunCommand }: Props) => {
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const mountMenu = useCallback((node: HTMLDivElement | null): void => {
    menu.current = node
    if (node !== null) requestAnimationFrame(() => node.querySelector<HTMLButtonElement>("[role^=menuitem]")?.focus())
  }, [])
  const [highlighted, setHighlighted] = useState(0)
  const items = ["Show all", "Chat", ...CHAT_KINDS]
  const targets = ["", "chat", ...CHAT_KINDS]
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLInputElement && event.key !== "Escape") return
    if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLButtonElement) {
      event.preventDefault()
      event.target.click()
      return
    }
    const move = rovingKeyDown(event.key, { count: items.length, current: highlighted, escape: true })
    if (move.kind === "ignore") return
    event.preventDefault()
    event.stopPropagation()
    if (move.kind === "escape") {
      onRunCommand("chat.filter")
      requestAnimationFrame(() => trigger.current?.focus())
      return
    }
    setHighlighted(move.index)
    menu.current?.querySelectorAll<HTMLButtonElement>("[role^=menuitem]")[move.index]?.focus()
  }
  return <div className="chat-filter-control">
    <button ref={trigger} type="button" className="chat-filter-trigger" aria-expanded={open} aria-controls="chat-filter-menu"
      aria-pressed={active(filter)} data-active={active(filter) || undefined} {...flowProps("chat.filter")}
      onClick={() => {
        onRunCommand("chat.filter")
      }}>Filter</button>
    {open && <div ref={mountMenu} id="chat-filter-menu" className="chat-filter-menu" role="menu" aria-label="Chat filter" onKeyDown={onKeyDown}>
      {items.map((label, index) => {
        const target = targets[index]!
        const hidden = target !== "" && (filter.sources.includes(target) || filter.kinds.includes(target as typeof CHAT_KINDS[number]))
        return <button key={target || "reset"} type="button" role={index === 0 ? "menuitem" : "menuitemcheckbox"}
          aria-checked={index === 0 ? undefined : !hidden} tabIndex={highlighted === index ? 0 : -1}
          onFocus={() => setHighlighted(index)}
          {...flowAction(onRunCommand, index === 0 ? "chat.filter.reset" : "chat.filter.toggle", target)}>
          {label}
        </button>
      })}
      <input aria-label="Search chat" type="search" value={filter.query} placeholder="Search"
        {...flowProps("chat.filter.grep")} onChange={event => onRunCommand("chat.filter.grep", event.currentTarget.value)} />
    </div>}
  </div>
}
