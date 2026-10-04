import { useCallback, useId, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { ShortcutButton, SHORTCUT_KEYS } from './ShortcutButton'
import { INPUT_MODES, inputModeLabel, type InputMode } from './state/InputMode'
import { bindPressActions, type PressAction } from './runtime/PressActions'
import { dictationAvailable, DICTATION_UNAVAILABLE } from './state/controller/dictation'
import './InputModeMenu.css'
import { flowProps } from "./flows/FlowAction"

export function InputModeMenu({ mode, onChange, placement = 'above' }: {
  mode: InputMode; onChange: (mode: InputMode) => void; placement?: 'above' | 'below'
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const speechSupported = dictationAvailable()
  const latest = useRef({ mode, onChange })
  latest.current = { mode, onChange }
  const close = useCallback((restore = true) => {
    if (restore) trigger.current?.focus()
    setOpen(false)
  }, [])
  const mount = useCallback((node: HTMLDivElement | null) => {
    if (!node?.parentElement) return
    node.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    const root = node.parentElement, doc = node.ownerDocument
    const stop = bindPressActions({ root, resolveShortcut: event => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key === 'escape' || key === SHORTCUT_KEYS.mode) return { element: trigger.current ?? undefined, activate: () => close() }
      const options = [...node.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      const index = options.indexOf(doc.activeElement as HTMLButtonElement)
      const delta = key === 'arrowdown' || (latest.current.mode === 'vim' && key === 'j') ? 1
        : key === 'arrowup' || (latest.current.mode === 'vim' && key === 'k') ? -1 : 0
      const next = key === 'home' ? options[0] : key === 'end' ? options.at(-1)
        : delta ? options[(index + delta + options.length) % options.length] : undefined
      return next ? { element: next, activate: () => next.focus() } satisfies PressAction : undefined
    } })
    const outside = (event: PointerEvent) => { if (!root.contains(event.target as Node)) close(false) }
    const tab = (event: KeyboardEvent) => { if (event.key === 'Tab') close(false) }
    doc.addEventListener('pointerdown', outside, true)
    doc.addEventListener('keydown', tab, true)
    return () => { stop(); doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', tab, true) }
  }, [close])
  return <div className="input-mode-control" data-keyboard-pane="Input mode" data-placement={placement}>
    <ShortcutButton ref={trigger} shortcut={SHORTCUT_KEYS.mode} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : setOpen(true)}>Mode: {inputModeLabel(mode)}</ShortcutButton>
    {open && <div id={id} ref={mount} className="input-mode-menu" role="menu" aria-label="Input mode">
      {INPUT_MODES.map(value => <button key={value} type="button" role="menuitemradio" aria-checked={mode === value}
        aria-disabled={value === 'dictation' && !speechSupported || undefined}
        aria-describedby={value === 'dictation' && !speechSupported ? `${id}-dictation-reason` : undefined} {...flowProps("input.mode")}
        onClick={() => { if (value === 'dictation' && !speechSupported) return; latest.current.onChange(value); close() }}>
        <span>{inputModeLabel(value)}</span>{mode === value && <Check size={14} aria-hidden="true" />}
      </button>)}
      {!speechSupported && <p id={`${id}-dictation-reason`} className="input-mode-reason">{DICTATION_UNAVAILABLE}</p>}
    </div>}
  </div>
}
