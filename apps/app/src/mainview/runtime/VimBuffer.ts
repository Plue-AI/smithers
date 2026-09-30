/** Vim's editing state belongs to the focused buffer, never to the app's shortcuts. */
export type VimMode = 'insert' | 'normal' | 'visual'
type Snapshot = { value: string; cursor: number }
export type VimBuffer = {
  mode: VimMode
  value: string
  cursor: number
  anchor: number
  pending: string
  count: string
  register: string
  linewise: boolean
  undo: Snapshot[]
  redo: Snapshot[]
  insertStart?: Snapshot
}

export const createVimBuffer = (value: string, cursor: number): VimBuffer => ({
  mode: 'insert', value, cursor, anchor: cursor, pending: '', count: '',
  register: '', linewise: false, undo: [], redo: [], insertStart: { value, cursor },
})
const start = (value: string, cursor: number) => cursor <= 0 ? 0 : value.lastIndexOf('\n', cursor - 1) + 1
const end = (value: string, cursor: number) => {
  const index = value.indexOf('\n', cursor)
  return index < 0 ? value.length : index
}
const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const characterAt = (value: string, cursor: number) => {
  for (const char of characters.segment(value)) if (cursor >= char.index && cursor < char.index + char.segment.length) return char
}
export const nextVimCharacter = (value: string, cursor: number): number => {
  const char = characterAt(value, cursor)
  return char ? char.index + char.segment.length : value.length
}
const normalCursor = (value: string, cursor: number) => {
  const at = Math.max(start(value, cursor), Math.min(cursor, end(value, cursor) - 1))
  return characterAt(value, at)?.index ?? at
}
const kind = (char: string) => /\s/.test(char) ? 0 : /[\p{L}\p{N}_]/u.test(char) ? 1 : 2
const word = (value: string, cursor: number, key: string): number => {
  let to = cursor
  if (key === 'b') {
    to = Math.max(0, to - 1)
    while (to > 0 && kind(value[to]!) === 0) to--
    while (to > 0 && kind(value[to - 1]!) === kind(value[to]!)) to--
  } else if (key === 'e') {
    to = Math.min(value.length - 1, to + 1)
    while (to < value.length - 1 && kind(value[to]!) === 0) to++
    while (to < value.length - 1 && kind(value[to + 1]!) === kind(value[to]!)) to++
  } else {
    const from = kind(value[to] ?? ' ')
    while (to < value.length && kind(value[to]!) === from) to++
    while (to < value.length && kind(value[to]!) === 0) to++
  }
  return Math.max(0, to)
}

function motion(buffer: VimBuffer, key: string, count: number): number | undefined {
  const { value, cursor } = buffer
  let to = cursor
  if (key === '0' || key === 'Home') return start(value, cursor)
  if (key === '^') return start(value, cursor) + (value.slice(start(value, cursor)).match(/^[\t ]*/)?.[0].length ?? 0)
  if (key === '$' || key === 'End') return end(value, cursor)
  if (key === 'G') return buffer.count ? value.split('\n').slice(0, count - 1).reduce((n, line) => n + line.length + 1, 0) : start(value, value.length)
  if (key === 'gg') return value.split('\n').slice(0, count - 1).reduce((n, line) => n + line.length + 1, 0)
  if (['h', 'l', 'ArrowLeft', 'ArrowRight'].includes(key)) {
    const segments = [...characters.segment(value)], left = key === 'h' || key === 'ArrowLeft'
    const index = segments.findIndex(char => cursor >= char.index && cursor < char.index + char.segment.length)
    const next = Math.max(0, (index < 0 ? segments.length : index) + (left ? -count : count))
    return Math.max(start(value, cursor), Math.min(end(value, cursor), segments[next]?.index ?? value.length))
  }
  if (['j', 'k', 'ArrowUp', 'ArrowDown', 'Enter'].includes(key)) {
    const column = cursor - start(value, cursor)
    for (let n = 0; n < count; n++) {
      if (key === 'k' || key === 'ArrowUp') {
        if (start(value, to) === 0) break
        to = start(value, start(value, to) - 1)
      } else {
        if (end(value, to) === value.length) break
        to = end(value, to) + 1
      }
    }
    return Math.min(end(value, to), start(value, to) + column)
  }
  if (['w', 'b', 'e'].includes(key)) {
    for (let n = 0; n < count; n++) to = word(value, to, key)
    return to
  }
}

function checkpoint(buffer: VimBuffer, snapshot = { value: buffer.value, cursor: buffer.cursor }) {
  buffer.undo.push(snapshot)
  if (buffer.undo.length > 100) buffer.undo.shift()
  buffer.redo = []
}

function replace(buffer: VimBuffer, from: number, to: number, text: string) {
  checkpoint(buffer)
  buffer.value = buffer.value.slice(0, from) + text + buffer.value.slice(to)
  buffer.cursor = Math.min(from, buffer.value.length)
}

/** Return false only when the native editor or app should receive the key. */
export function vimKey(buffer: VimBuffer, key: string, ctrl = false): boolean {
  if (key === 'Escape') {
    if (buffer.mode === 'insert') {
      if (buffer.insertStart && buffer.insertStart.value !== buffer.value) checkpoint(buffer, buffer.insertStart)
      buffer.cursor = normalCursor(buffer.value, Math.max(start(buffer.value, buffer.cursor), buffer.cursor - 1))
    }
    buffer.mode = 'normal'; buffer.pending = ''; buffer.count = ''; buffer.insertStart = undefined
    return true
  }
  if (buffer.mode === 'insert') return false
  if (ctrl && key !== 'r') return false
  if (key === 'Tab') { buffer.pending = ''; buffer.count = ''; return false }
  const { value, cursor } = buffer
  const count = Math.min(10000, Number(buffer.count) || 1)
  const insert = (at: number) => {
    buffer.cursor = at; buffer.mode = 'insert'; buffer.insertStart = { value: buffer.value, cursor: at }
  }
  if (buffer.pending === 'r' && !ctrl) {
    // The replacement operand is data: a digit or `u` is never a count or Undo.
    if (key.length === 1 && cursor < end(value, cursor)) {
      let to = cursor, size = 0
      while (size < count && to < end(value, cursor)) { to = nextVimCharacter(value, to); size++ }
      replace(buffer, cursor, to, key.repeat(size))
    }
  } else if ((key === 'u' && !ctrl) || (key === 'r' && ctrl)) {
    const source = ctrl ? buffer.redo : buffer.undo, target = ctrl ? buffer.undo : buffer.redo
    const snapshot = source.pop()
    if (snapshot) { target.push({ value, cursor }); Object.assign(buffer, snapshot) }
    buffer.mode = 'normal'
  } else if (/^[1-9]$/.test(key) || (key === '0' && buffer.count)) {
    buffer.count = `${buffer.count}${key}`.slice(0, 4)
    return true
  } else if (buffer.pending === 'g' && key === 'g') {
    buffer.cursor = Math.min(value.length, motion(buffer, 'gg', count)!)
  } else if (buffer.mode === 'visual' && ['d', 'x', 'c', 'y'].includes(key)) {
    const from = Math.min(buffer.anchor, cursor), to = nextVimCharacter(value, Math.max(buffer.anchor, cursor))
    buffer.register = value.slice(from, to); buffer.linewise = false
    buffer.mode = 'normal'
    if (key !== 'y') replace(buffer, from, to, '')
    else buffer.cursor = from
    if (key === 'c') insert(from)
  } else if (['d', 'c', 'y'].includes(buffer.pending)) {
    const operator = buffer.pending
    const linewise = key === operator || ['j', 'k', 'ArrowUp', 'ArrowDown'].includes(key)
    const changeWord = operator === 'c' && key === 'w' && cursor < value.length && kind(value[cursor]!) !== 0
    let destination = motion(buffer, key, count)
    if (changeWord) {
      destination = cursor
      for (let n = 0; n < count; n++) {
        if (n > 0) destination = word(value, destination, 'w')
        const type = kind(value[destination] ?? ' ')
        while (destination + 1 < value.length && kind(value[destination + 1]!) === type) destination++
      }
    }
    if (key === operator) {
      destination = cursor
      for (let n = 1; n < count; n++) destination = Math.min(value.length, end(value, destination) + 1)
    }
    if (destination !== undefined) {
      const from = linewise ? start(value, Math.min(cursor, destination)) : Math.min(cursor, destination)
      const to = linewise ? Math.min(value.length, end(value, Math.max(cursor, destination)) + 1)
        : Math.min(value.length, Math.max(cursor, destination) + (key === 'e' || changeWord ? 1 : 0))
      buffer.register = value.slice(from, to); buffer.linewise = linewise
      if (operator !== 'y') {
        const deleteFrom = linewise && operator === 'd' && to === value.length && from > 0 ? from - 1 : from
        replace(buffer, deleteFrom, to, operator === 'c' && linewise && to < value.length ? '\n' : '')
        if (operator === 'c') insert(from)
      }
    }
  } else if (key === 'i') insert(cursor)
  else if (key === 'a') insert(Math.min(end(value, cursor), nextVimCharacter(value, cursor)))
  else if (key === 'I') insert(motion(buffer, '^', 1)!)
  else if (key === 'A') insert(end(value, cursor))
  else if (key === 'o' || key === 'O') {
    const at = key === 'o' ? end(value, cursor) : start(value, cursor)
    replace(buffer, at, at, '\n'); insert(at + (key === 'o' ? 1 : 0))
  } else if (key === 'v') {
    buffer.mode = buffer.mode === 'visual' ? 'normal' : 'visual'; buffer.anchor = cursor
  } else if (['d', 'c', 'y', 'g', 'r'].includes(key)) {
    buffer.pending = key
    return true
  } else if (key === 'x' || key === 'Delete' || key === 'D' || key === 'C') {
    let to = end(value, cursor)
    if (key !== 'D' && key !== 'C') { to = cursor; for (let n = 0; n < count && to < end(value, cursor); n++) to = nextVimCharacter(value, to) }
    buffer.register = value.slice(cursor, to); buffer.linewise = false
    replace(buffer, cursor, to, '')
    if (key === 'C') insert(cursor)
  } else if (key === 'p' || key === 'P') {
    if (buffer.register) {
      if (buffer.linewise) {
        const line = buffer.register.replace(/\n$/, '').concat('\n').repeat(count)
        const at = key === 'P' ? start(value, cursor) : Math.min(value.length, end(value, cursor) + 1)
        const atEnd = key === 'p' && end(value, cursor) === value.length
        replace(buffer, at, at, atEnd ? '\n' + line.slice(0, -1) : line)
        buffer.cursor = at + (atEnd ? 1 : 0)
      } else {
        const at = key === 'p' ? nextVimCharacter(value, cursor) : cursor
        replace(buffer, at, at, buffer.register.repeat(count)); buffer.cursor = at + buffer.register.length * count - 1
      }
    }
  } else {
    const to = motion(buffer, key, count)
    if (to !== undefined) buffer.cursor = Math.min(value.length, to)
    // Unbound normal-mode text never becomes an app command or typed input.
  }
  if ((buffer.mode as VimMode) !== 'insert') buffer.cursor = normalCursor(buffer.value, buffer.cursor)
  buffer.pending = ''; buffer.count = ''
  return true
}
