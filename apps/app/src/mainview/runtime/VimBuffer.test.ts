import { expect, test } from 'bun:test'
import { createVimBuffer, nextVimCharacter, vimKey, type VimBuffer } from './VimBuffer'

const keys = (buffer: VimBuffer, ...commands: string[]) => commands.forEach(key => vimKey(buffer, key))
const normal = (value: string, cursor = 0) => { const buffer = createVimBuffer(value, cursor); keys(buffer, 'Escape'); return buffer }

test('normal motions, change word, insert and undo preserve the buffer', () => {
  const buffer = normal('hello brave world')
  keys(buffer, 'w', 'd', 'w')
  expect(buffer.value).toBe('hello world')
  expect(buffer.cursor).toBe(6)
  keys(buffer, 'u')
  expect(buffer.value).toBe('hello brave world')
  vimKey(buffer, 'r', true)
  expect(buffer.value).toBe('hello world')
  keys(buffer, 'i')
  expect(vimKey(buffer, 'a')).toBe(false)
  buffer.value = 'hello new world'; buffer.cursor = 10
  keys(buffer, 'Escape')
  expect(buffer.mode).toBe('normal')
  expect(buffer.cursor).toBe(9)
  keys(buffer, 'u')
  expect(buffer.value).toBe('hello world')
})

test('line motions, counts, line deletion and paste work on first and last lines', () => {
  const buffer = normal('one\ntwo\nthree')
  keys(buffer, '2', 'd', 'd')
  expect(buffer.value).toBe('three')
  keys(buffer, 'P')
  expect(buffer.value).toBe('one\ntwo\nthree')
  keys(buffer, 'G', 'd', 'd')
  expect(buffer.value).toBe('one\ntwo')
  keys(buffer, 'p')
  expect(buffer.value).toBe('one\ntwo\nthree')
  keys(buffer, 'g', 'g', '$')
  expect(buffer.cursor).toBe(2)
  keys(buffer, 'j')
  expect(buffer.cursor).toBe(6)
})

test('visual selection extends in both directions, copies, deletes and changes', () => {
  const buffer = normal('hello world')
  keys(buffer, 'w', 'v', 'e', 'y', '0', 'P')
  expect(buffer.value).toBe('worldhello world')
  keys(buffer, 'u', '0', 'v', 'l', 'l', 'd')
  expect(buffer.value).toBe('lo world')
  keys(buffer, '$', 'v', 'b', 'c')
  expect(buffer.value).toBe('lo ')
  expect(buffer.mode).toBe('insert')
})

test('empty lines, replace, open line, and Escape never escape the buffer', () => {
  const buffer = normal('\nhello')
  keys(buffer, 'h', 'k', '0')
  expect(buffer.cursor).toBe(0)
  keys(buffer, 'j', 'r', 'H')
  expect(buffer.value).toBe('\nHello')
  keys(buffer, 'o')
  expect(buffer.value).toBe('\nHello\n')
  expect(buffer.mode).toBe('insert')
  keys(buffer, 'Escape', 'Escape')
  expect(buffer.mode).toBe('normal')
  expect(vimKey(buffer, 'Tab')).toBe(false)
  expect(vimKey(buffer, 's')).toBe(true)
  expect(buffer.value).toBe('\nHello\n')
})

test('character motions and edits preserve emoji and combining characters', () => {
  const buffer = normal('a👩🏽‍💻e\u0301z')
  keys(buffer, 'l', 'x')
  expect(buffer.value).toBe('ae\u0301z')
  keys(buffer, 'v', 'y', 'p')
  expect(buffer.value).toBe('ae\u0301e\u0301z')
  keys(buffer, 'r', 'x')
  expect(buffer.value).toBe('ae\u0301xz')
})

test('change word leaves the following separator for inserted text', () => {
  const buffer = normal('old word')
  keys(buffer, 'c', 'w')
  expect(buffer.value).toBe(' word')
  expect(buffer.mode).toBe('insert')
  const single = normal('a word')
  keys(single, 'c', 'w')
  expect(single.value).toBe(' word')
})

test('a pending replacement takes digits and u as its character, not a count or Undo', () => {
  for (const digit of ['0', '1', '2']) {
    const buffer = normal('abc\nnext')
    keys(buffer, 'y', 'y', 'r', digit)
    expect(buffer.value).toBe(`${digit}bc\nnext`)
    expect(buffer.cursor).toBe(0)
    expect([buffer.pending, buffer.count, buffer.register, buffer.undo.length]).toEqual(['', '', 'abc\n', 1])
    keys(buffer, 'u')
    expect(buffer.value).toBe('abc\nnext')
  }
  const counted = normal('abcd')
  keys(counted, '2', 'r', '0')
  expect(counted.value).toBe('00cd')
  expect(counted.count).toBe('')
  const undone = normal('abc\nnext')
  keys(undone, 'x', 'r', 'u')
  expect(undone.value).toBe('uc\nnext')
  expect([undone.register, undone.undo.length]).toEqual(['a', 2])
  expect(vimKey(undone, 'u')).toBe(true)
  expect(undone.value).toBe('bc\nnext')
})

test('replacement accepts one astral or combining character key and rejects named keys', () => {
  const buffer = normal('a👩🏽‍💻éz', 1)
  keys(buffer, 'y', 'y')
  buffer.cursor = 1
  keys(buffer, 'r', '\u{10400}')
  expect(buffer.value).toBe('a\u{10400}éz')
  expect([buffer.cursor, buffer.mode, buffer.register, buffer.undo.length]).toEqual([1, 'normal', 'a👩🏽‍💻éz', 1])
  keys(buffer, 'u')
  expect(buffer.value).toBe('a👩🏽‍💻éz')

  const counted = normal('a👩🏽‍💻e\u0301z')
  counted.cursor = 1
  keys(counted, '2', 'r', '\u1e0d\u0307')
  expect(counted.value).toBe('a\u1e0d\u0307\u1e0d\u0307z')

  for (const named of ['Enter', 'ArrowLeft', 'F1']) {
    const cancelled = normal('abc')
    keys(cancelled, 'r', named)
    expect(cancelled.value).toBe('abc')
    expect([cancelled.pending, cancelled.undo.length]).toEqual(['', 0])
  }
})

test('forward end-word stays on the terminal empty line instead of jumping back', () => {
  for (const command of [['e'], ['2', 'e']]) {
    const buffer = normal('a\n', 2)
    expect(buffer.cursor).toBe(2)
    keys(buffer, ...command)
    expect(buffer.value).toBe('a\n')
    expect([buffer.cursor, buffer.register, buffer.pending, buffer.count, buffer.undo.length]).toEqual([2, '', '', '', 0])
  }
  const w = normal('a\n', 2)
  keys(w, 'w')
  expect(w.cursor).toBe(2)
  keys(w, 'b')
  expect(w.cursor).toBe(0)
})

test('word motions and operators keep combining marks and astral letters whole', () => {
  const cafe = normal('café word')
  keys(cafe, 'c', 'w')
  expect([cafe.value, cafe.cursor, cafe.mode, cafe.register]).toEqual([' word', 0, 'insert', 'café'])

  for (const [operator, register, value] of [['d', 'café ', 'next'], ['y', 'café ', 'café next']]) {
    const buffer = normal('café next')
    keys(buffer, operator!, 'w')
    expect([buffer.register, buffer.value]).toEqual([register, value])
  }
  for (const [operator, value] of [['d', ' next'], ['y', 'café next']]) {
    const buffer = normal('café next')
    keys(buffer, operator!, 'e')
    expect([buffer.register, buffer.value]).toEqual(['café', value])
  }

  const astral = normal('\u{10400}bc next')
  keys(astral, 'w')
  expect(astral.cursor).toBe(5)
  keys(astral, 'b')
  expect(astral.cursor).toBe(0)
  keys(astral, 'e')
  expect(astral.cursor).toBe(3)
  keys(astral, '$', 'b', 'b')
  expect(astral.cursor).toBe(0)
  keys(astral, 'c', 'w')
  expect(astral.value).toBe(' next')

  const controls = normal('服务 x')
  keys(controls, 'w')
  expect(controls.cursor).toBe(3)
  const emoji = normal('a \u{1F469}‍\u{1F4BB}!b')
  keys(emoji, 'w')
  expect(emoji.cursor).toBe(2)
  keys(emoji, 'w')
  expect(emoji.cursor).toBe(8)
})

test('a new buffer owns its insertion snapshot and independent editing state', () => {
  expect(createVimBuffer('draft', 2)).toEqual({
    mode: 'insert', value: 'draft', cursor: 2, anchor: 2, pending: '', count: '',
    register: '', linewise: false, undo: [], redo: [], insertStart: { value: 'draft', cursor: 2 },
  })
  const first = normal('draft'), second = createVimBuffer('other', 0)
  keys(first, 'd', 'd')
  expect(second).toEqual({
    mode: 'insert', value: 'other', cursor: 0, anchor: 0, pending: '', count: '',
    register: '', linewise: false, undo: [], redo: [], insertStart: { value: 'other', cursor: 0 },
  })
})

test.each(['x', 'Enter', 'Tab'])('insert-mode %s belongs to the native editor and leaves state unchanged', key => {
  const buffer = createVimBuffer('draft', 2), before = structuredClone(buffer)
  expect(vimKey(buffer, key)).toBe(false)
  expect(buffer).toEqual(before)
})

test.each(['c', 'a', 'u'])('normal-mode Ctrl+%s belongs to the app/native editor without performing a Vim edit', key => {
  const buffer = normal('draft')
  keys(buffer, '3', 'd')
  const before = structuredClone(buffer)
  expect(vimKey(buffer, key, true)).toBe(false)
  expect(buffer).toEqual(before)
})

test.each(['d', 'c', 'y', 'g', 'r'])('Escape cancels a counted pending %s without changing text, register or history', pending => {
  const buffer = normal('draft')
  keys(buffer, '2', pending)
  expect([buffer.count, buffer.pending]).toEqual(['2', pending])
  expect(vimKey(buffer, 'Escape')).toBe(true)
  expect(buffer).toEqual({
    mode: 'normal', value: 'draft', cursor: 0, anchor: 0, pending: '', count: '',
    register: '', linewise: false, undo: [], redo: [], insertStart: undefined,
  })
})

test('Tab cancels a pending count and operator while preserving native focus navigation', () => {
  const buffer = normal('draft')
  keys(buffer, '2', 'd')
  expect(vimKey(buffer, 'Tab')).toBe(false)
  expect([buffer.value, buffer.cursor, buffer.pending, buffer.count]).toEqual(['draft', 0, '', ''])
  expect(buffer.undo).toEqual([])
})

test.each([
  { value: '', cursor: 0, expected: 0 },
  { value: 'a👩🏽‍💻e\u0301z', cursor: 1, expected: 8 },
  { value: 'a👩🏽‍💻e\u0301z', cursor: 4, expected: 8 },
  { value: 'a👩🏽‍💻e\u0301z', cursor: 8, expected: 10 },
  { value: 'a👩🏽‍💻e\u0301z', cursor: 9, expected: 10 },
  { value: 'a👩🏽‍💻e\u0301z', cursor: 11, expected: 11 },
])('next character in $value at UTF-16 offset $cursor respects the whole grapheme', ({ value, cursor, expected }) => {
  expect(nextVimCharacter(value, cursor)).toBe(expected)
})

test.each([
  { commands: ['2', 'l'], expected: 8 },
  { commands: ['ArrowRight', 'ArrowRight'], expected: 8 },
  { commands: ['$', 'h'], expected: 8 },
  { commands: ['$', 'ArrowLeft', 'ArrowLeft'], expected: 1 },
])('horizontal motions $commands never split a grapheme', ({ commands, expected }) => {
  const buffer = normal('a👩🏽‍💻e\u0301z')
  keys(buffer, ...commands)
  expect(buffer.cursor).toBe(expected)
  expect(buffer.value).toBe('a👩🏽‍💻e\u0301z')
  expect([buffer.count, buffer.pending]).toEqual(['', ''])
})

test.each([
  { commands: ['G'], expected: 7 },
  { commands: ['2', 'G'], expected: 5 },
  { commands: ['G', 'g', 'g'], expected: 0 },
  { commands: ['G', '2', 'g', 'g'], expected: 5 },
  { commands: ['$', 'j'], expected: 5 },
  { commands: ['$', 'ArrowDown'], expected: 5 },
  { commands: ['G', 'k'], expected: 5 },
  { commands: ['G', 'ArrowUp'], expected: 5 },
  { commands: ['0', 'h', 'k'], expected: 0 },
])('line motions $commands clamp to existing lines and characters', ({ commands, expected }) => {
  const buffer = normal('long\nx\nlast')
  keys(buffer, ...commands)
  expect(buffer.cursor).toBe(expected)
  expect(buffer.value).toBe('long\nx\nlast')
})

test.each([
  { command: 'i', expected: 2 },
  { command: 'a', expected: 3 },
  { command: 'I', expected: 2 },
  { command: 'A', expected: 7 },
])('$command enters insertion at the requested line position without changing text', ({ command, expected }) => {
  const buffer = normal('  draft')
  keys(buffer, '^')
  expect(vimKey(buffer, command)).toBe(true)
  expect([buffer.mode, buffer.cursor, buffer.value]).toEqual(['insert', expected, '  draft'])
  expect(buffer.insertStart).toEqual({ value: '  draft', cursor: expected })
  expect(buffer.undo).toEqual([])
})

test.each([
  { commands: ['2', 'r', 'X'], expected: 'XXcd\nnext', register: '' },
  { commands: ['9', 'r', 'X'], expected: 'XXXX\nnext', register: '' },
  { commands: ['2', 'x'], expected: 'cd\nnext', register: 'ab' },
  { commands: ['9', 'Delete'], expected: '\nnext', register: 'abcd' },
])('counted character operation $commands stops at the line end', ({ commands, expected, register }) => {
  const buffer = normal('abcd\nnext')
  keys(buffer, ...commands)
  expect([buffer.value, buffer.cursor, buffer.register]).toEqual([expected, 0, register])
  expect(buffer.undo).toEqual([{ value: 'abcd\nnext', cursor: 0 }])
  keys(buffer, 'u')
  expect(buffer.value).toBe('abcd\nnext')
})

test.each([
  { commands: ['y', 'y', '2', 'p'], expected: 'one\none\none\ntwo', cursor: 4 },
  { commands: ['G', 'y', 'y', 'P'], expected: 'one\ntwo\ntwo', cursor: 4 },
  { commands: ['G', 'd', 'd', 'P'], expected: 'two\none', cursor: 0 },
])('linewise register operation $commands preserves literal lines without duplicate separators', ({ commands, expected, cursor }) => {
  const buffer = normal('one\ntwo')
  keys(buffer, ...commands)
  expect([buffer.value, buffer.cursor, buffer.linewise]).toEqual([expected, cursor, true])
})

test('native insertion edits form one undo step; a new edit after undo discards redo', () => {
  const buffer = normal('abc')
  keys(buffer, 'i')
  buffer.value = 'Xabc'; buffer.cursor = 1
  buffer.value = 'XYabc'; buffer.cursor = 2
  keys(buffer, 'Escape')
  expect(buffer.undo).toEqual([{ value: 'abc', cursor: 0 }])
  expect([buffer.value, buffer.cursor]).toEqual(['XYabc', 1])
  keys(buffer, 'u')
  expect([buffer.value, buffer.cursor]).toEqual(['abc', 0])
  expect(buffer.redo).toEqual([{ value: 'XYabc', cursor: 1 }])
  keys(buffer, 'x')
  expect([buffer.value, buffer.cursor]).toEqual(['bc', 0])
  expect(buffer.redo).toEqual([])
  expect(vimKey(buffer, 'r', true)).toBe(true)
  expect([buffer.value, buffer.cursor]).toEqual(['bc', 0])
})

test('undo retains the newest 100 editing snapshots and stops at the retained boundary', () => {
  const buffer = normal('a'.repeat(101))
  for (let n = 0; n < 101; n++) expect(vimKey(buffer, 'x')).toBe(true)
  expect(buffer.undo).toHaveLength(100)
  for (let n = 0; n < 100; n++) expect(vimKey(buffer, 'u')).toBe(true)
  expect([buffer.value, buffer.cursor]).toEqual(['a'.repeat(100), 0])
  expect(buffer.undo).toEqual([])
  expect(vimKey(buffer, 'u')).toBe(true)
  expect(buffer.value).toBe('a'.repeat(100))
})

test.each([
  { command: 'o', expected: 'one\n\ntwo', cursor: 4 },
  { command: 'O', expected: '\none\ntwo', cursor: 0 },
])('$command opens a new line in insert mode and undo restores the original text', ({ command, expected, cursor }) => {
  const buffer = normal('one\ntwo')
  keys(buffer, command)
  expect([buffer.value, buffer.cursor, buffer.mode]).toEqual([expected, cursor, 'insert'])
  keys(buffer, 'Escape', 'u')
  expect([buffer.value, buffer.cursor, buffer.mode]).toEqual(['one\ntwo', 0, 'normal'])
})

test.each([
  { commands: ['c', 'c'], expected: '\ntwo', register: 'one\n', cursor: 0 },
  { commands: ['G', 'c', 'c'], expected: 'one\n', register: 'two', cursor: 4 },
  { commands: ['2', 'c', 'c'], expected: '', register: 'one\ntwo', cursor: 0 },
])('line change $commands retains only the line separator needed for replacement', ({ commands, expected, register, cursor }) => {
  const buffer = normal('one\ntwo')
  keys(buffer, ...commands)
  expect([buffer.value, buffer.cursor, buffer.register, buffer.mode, buffer.linewise]).toEqual([expected, cursor, register, 'insert', true])
})

test.each([
  { command: 'D', mode: 'normal', cursor: 1 },
  { command: 'C', mode: 'insert', cursor: 2 },
])('$command edits the current suffix and records it without crossing a newline', ({ command, mode, cursor }) => {
  const buffer = normal('abcd\nnext')
  keys(buffer, '2', 'l', command)
  expect([buffer.value, buffer.cursor, buffer.mode, buffer.register, buffer.linewise]).toEqual(['ab\nnext', cursor, mode, 'cd', false])
})

test.each(['p', 'P'])('%s with an empty register changes neither text nor undo history', command => {
  const buffer = normal('draft'), before = structuredClone(buffer)
  expect(vimKey(buffer, command)).toBe(true)
  expect(buffer).toEqual(before)
})

test.each(['café', 'cafe\u0301', '服务', '𐐀bc', '👩🏽‍💻!'])('changing the Unicode word %s removes its complete characters and keeps the following separator', value => {
  const buffer = normal(`${value} word`)
  keys(buffer, 'c', 'w')
  expect(buffer.value).toBe(' word')
  expect(buffer.register).toBe(value)
  expect([buffer.cursor, buffer.mode]).toEqual([0, 'insert'])
})

test.each([
  { value: 'café next', commands: ['w'], expected: 5 },
  { value: 'cafe\u0301 next', commands: ['w'], expected: 6 },
  { value: 'cafe\u0301 next', commands: ['$', 'b', 'b'], expected: 0 },
  { value: 'cafe\u0301 next', commands: ['e'], expected: 3 },
  { value: '𐐀bc next', commands: ['w'], expected: 5 },
  { value: '𐐀bc next', commands: ['$', 'b', 'b'], expected: 0 },
  { value: '𐐀bc next', commands: ['e'], expected: 3 },
  { value: '👩🏽‍💻! next', commands: ['w'], expected: 9 },
  { value: '👩🏽‍💻! next', commands: ['$', 'b', 'b'], expected: 0 },
  { value: '👩🏽‍💻! next', commands: ['e'], expected: 7 },
])('word motion $commands in $value reaches a whole-word character boundary', ({ value, commands, expected }) => {
  const buffer = normal(value)
  keys(buffer, ...commands)
  expect([buffer.value, buffer.cursor, buffer.mode]).toEqual([value, expected, 'normal'])
  expect(buffer.undo).toEqual([])
})

test.each([
  { commands: ['d', 'e'], value: ' next', register: 'cafe\u0301', mode: 'normal' },
  { commands: ['d', 'w'], value: 'next', register: 'cafe\u0301 ', mode: 'normal' },
  { commands: ['y', 'e'], value: 'cafe\u0301 next', register: 'cafe\u0301', mode: 'normal' },
  { commands: ['y', 'w'], value: 'cafe\u0301 next', register: 'cafe\u0301 ', mode: 'normal' },
])('word operation $commands preserves decomposed characters in text and the copy register', ({ commands, value, register, mode }) => {
  const buffer = normal('cafe\u0301 next')
  keys(buffer, ...commands)
  expect([buffer.value, buffer.register, buffer.mode, buffer.cursor]).toEqual([value, register, mode, 0])
})


test.each([
  { commands: ['2', 'w'], expected: 6 },
  { commands: ['3', 'w'], expected: 9 },
  { commands: ['2', 'e'], expected: 3 },
  { commands: ['$', '2', 'b'], expected: 9 },
])('counted word motion $commands retains punctuation classes and skips spaces', ({ commands, expected }) => {
  const buffer = normal('one,  two! three')
  keys(buffer, ...commands)
  expect([buffer.value, buffer.cursor, buffer.mode]).toEqual(['one,  two! three', expected, 'normal'])
  expect([buffer.count, buffer.pending, buffer.register]).toEqual(['', '', ''])
  expect(buffer.undo).toEqual([])
})

test('counted word deletion records punctuation and separators and undo restores them', () => {
  const buffer = normal('one,  two! three')
  keys(buffer, '2', 'd', 'w')
  expect([buffer.value, buffer.register, buffer.cursor]).toEqual(['two! three', 'one,  ', 0])
  expect(buffer.undo).toEqual([{ value: 'one,  two! three', cursor: 0 }])
  keys(buffer, 'u')
  expect([buffer.value, buffer.cursor]).toEqual(['one,  two! three', 0])
})

test('end motion advances from a single-character word while change word replaces only that word', () => {
  const moved = normal('a next'), changed = normal('a next')
  keys(moved, 'e')
  expect([moved.value, moved.cursor]).toEqual(['a next', 5])
  keys(changed, 'c', 'w')
  expect([changed.value, changed.register, changed.cursor, changed.mode]).toEqual([' next', 'a', 0, 'insert'])
  keys(changed, 'Escape', 'u')
  expect([changed.value, changed.cursor, changed.mode]).toEqual(['a next', 0, 'normal'])
})

test('deleting an emoji punctuation word preserves its complete copy register and undo snapshot', () => {
  const buffer = normal('👩🏽‍💻! next')
  keys(buffer, 'd', 'w')
  expect([buffer.value, buffer.register, buffer.cursor]).toEqual(['next', '👩🏽‍💻! ', 0])
  expect(buffer.undo).toEqual([{ value: '👩🏽‍💻! next', cursor: 0 }])
  keys(buffer, 'u')
  expect([buffer.value, buffer.cursor]).toEqual(['👩🏽‍💻! next', 0])
})


test('counted change spans complete combining and astral-letter words; undo restores their literal text', () => {
  const buffer = normal('cafe\u0301 𐐀bc tail')
  keys(buffer, '2', 'c', 'w')
  expect([buffer.value, buffer.register, buffer.cursor, buffer.mode]).toEqual([' tail', 'cafe\u0301 𐐀bc', 0, 'insert'])
  expect(buffer.undo).toEqual([{ value: 'cafe\u0301 𐐀bc tail', cursor: 0 }])
  keys(buffer, 'Escape', 'u')
  expect([buffer.value, buffer.cursor, buffer.mode]).toEqual(['cafe\u0301 𐐀bc tail', 0, 'normal'])
})

test('counted end motion crosses combining and astral-letter words at whole-character boundaries', () => {
  const buffer = normal('cafe\u0301 𐐀bc tail')
  keys(buffer, '2', 'e')
  expect([buffer.value, buffer.cursor, buffer.mode]).toEqual(['cafe\u0301 𐐀bc tail', 9, 'normal'])
  expect([buffer.pending, buffer.count, buffer.register]).toEqual(['', '', ''])
  expect(buffer.undo).toEqual([])
})

test('counted end deletion includes the whole emoji punctuation word and restores it on undo', () => {
  const buffer = normal('cafe\u0301 👩🏽‍💻! tail')
  keys(buffer, '2', 'd', 'e')
  expect([buffer.value, buffer.register, buffer.cursor, buffer.mode]).toEqual([' tail', 'cafe\u0301 👩🏽‍💻!', 0, 'normal'])
  expect(buffer.undo).toEqual([{ value: 'cafe\u0301 👩🏽‍💻! tail', cursor: 0 }])
  keys(buffer, 'u')
  expect([buffer.value, buffer.cursor, buffer.mode]).toEqual(['cafe\u0301 👩🏽‍💻! tail', 0, 'normal'])
})

test.each(['w', 'b', 'e', 'h', 'l'])('%s on an empty normal buffer preserves text, cursor, register and history', command => {
  const buffer = normal(''), before = structuredClone(buffer)
  expect(vimKey(buffer, command)).toBe(true)
  expect(buffer).toEqual(before)
})

test.each(['d', 'c', 'y'])('an unsupported motion cancels counted pending %s without editing or copying', operator => {
  const buffer = normal('draft')
  keys(buffer, '2', operator)
  expect([buffer.count, buffer.pending]).toEqual(['2', operator])
  expect(vimKey(buffer, 'z')).toBe(true)
  expect([buffer.value, buffer.cursor, buffer.mode, buffer.pending, buffer.count, buffer.register]).toEqual(['draft', 0, 'normal', '', '', ''])
  expect([buffer.undo, buffer.redo]).toEqual([[], []])
})

test.each(['Enter', 'ArrowLeft', 'F1'])('named key %s cancels pending replacement without replacing text', key => {
  const buffer = normal('draft')
  keys(buffer, '2', 'r')
  expect(vimKey(buffer, key)).toBe(true)
  expect([buffer.value, buffer.cursor, buffer.mode, buffer.pending, buffer.count, buffer.register]).toEqual(['draft', 0, 'normal', '', '', ''])
  expect([buffer.undo, buffer.redo]).toEqual([[], []])
})

test('replacement in an empty buffer cancels without creating an undo snapshot', () => {
  const buffer = normal('')
  keys(buffer, 'r', 'X')
  expect([buffer.value, buffer.cursor, buffer.pending, buffer.count, buffer.mode]).toEqual(['', 0, '', '', 'normal'])
  expect([buffer.register, buffer.undo, buffer.redo]).toEqual(['', [], []])
})

test('typed counts are bounded and a horizontal motion clamps at its existing line', () => {
  const buffer = normal('abc\nnext')
  keys(buffer, '9', '9', '9', '9', '9')
  expect(buffer.count).toBe('9999')
  keys(buffer, 'l')
  expect([buffer.value, buffer.cursor, buffer.count, buffer.pending]).toEqual(['abc\nnext', 2, '', ''])
  keys(buffer, '9', '9', 'h')
  expect(buffer.cursor).toBe(0)
  expect(buffer.undo).toEqual([])
})

test('counted downward motion stops at the final line without crossing the buffer', () => {
  const buffer = normal('one\ntwo')
  keys(buffer, 'G', '$', '9', 'j')
  expect([buffer.value, buffer.cursor]).toEqual(['one\ntwo', 6])
  keys(buffer, '9', 'k')
  expect(buffer.cursor).toBe(2)
  expect(buffer.undo).toEqual([])
})

test('counted word motion beyond the final word stays on the last character', () => {
  const buffer = normal('short')
  keys(buffer, '3', 'w')
  expect([buffer.value, buffer.cursor, buffer.count, buffer.pending]).toEqual(['short', 4, '', ''])
  expect(buffer.undo).toEqual([])
})

test('changing from whitespace removes the separator up to the next word', () => {
  const buffer = normal('  old word')
  keys(buffer, 'c', 'w')
  expect([buffer.value, buffer.register, buffer.cursor, buffer.mode]).toEqual(['old word', '  ', 0, 'insert'])
  expect(buffer.undo).toEqual([{ value: '  old word', cursor: 0 }])
})

test('toggling visual mode off keeps the selected text and copy register intact', () => {
  const buffer = normal('draft')
  keys(buffer, 'y', 'y', 'v', 'l', 'v')
  expect([buffer.value, buffer.cursor, buffer.anchor, buffer.mode, buffer.register]).toEqual(['draft', 1, 1, 'normal', 'draft'])
  expect([buffer.undo, buffer.redo]).toEqual([[], []])
})

// W3C KeyboardEvent key Values §2.1 permits astral base characters and NFC
// base+combining key strings. These are one character, not named special keys.
test.each([
  { key: '𐐀', count: '', value: 'a𐐀e\u0301z' },
  { key: 'ḍ̇', count: '', value: 'aḍ̇e\u0301z' },
  { key: '𐐀', count: '2', value: 'a𐐀𐐀z' },
  { key: 'ḍ̇', count: '2', value: 'aḍ̇ḍ̇z' },
])('$count r $key replaces complete characters and preserves the copy register and undo boundary', ({ key, count, value }) => {
  const buffer = normal('a👩🏽‍💻e\u0301z')
  expect(key.normalize('NFC')).toBe(key)
  keys(buffer, 'y', 'y', 'l', ...count, 'r', key)
  expect([buffer.value, buffer.cursor, buffer.mode, buffer.pending, buffer.count]).toEqual([value, 1, 'normal', '', ''])
  expect([buffer.register, buffer.linewise]).toEqual(['a👩🏽‍💻e\u0301z', true])
  expect(buffer.undo).toEqual([{ value: 'a👩🏽‍💻e\u0301z', cursor: 1 }])
  keys(buffer, 'u')
  expect([buffer.value, buffer.cursor]).toEqual(['a👩🏽‍💻e\u0301z', 1])
})

test.each([
  { key: '1', count: '', value: '1bc\nnext' },
  { key: '2', count: '', value: '2bc\nnext' },
  { key: '0', count: '', value: '0bc\nnext' },
  { key: '1', count: '2', value: '11c\nnext' },
  { key: '2', count: '2', value: '22c\nnext' },
  { key: '0', count: '2', value: '00c\nnext' },
])('$count r $key treats the replacement digit as text and not a new count', ({ key, count, value }) => {
  const buffer = normal('abc\nnext')
  keys(buffer, 'y', 'y', ...count, 'r', key)
  expect([buffer.value, buffer.cursor, buffer.mode, buffer.pending, buffer.count]).toEqual([value, 0, 'normal', '', ''])
  expect([buffer.register, buffer.linewise]).toEqual(['abc\n', true])
  expect(buffer.undo).toEqual([{ value: 'abc\nnext', cursor: 0 }])
  keys(buffer, 'u')
  expect([buffer.value, buffer.cursor]).toEqual(['abc\nnext', 0])
})

test.each([{ key: 'w', cursor: 2 }, { key: 'b', cursor: 0 }])('$key from a trailing empty line respects the actual buffer boundary', ({ key, cursor }) => {
  const buffer = normal('a\n', 2)
  expect(buffer.cursor).toBe(2)
  keys(buffer, key)
  expect([buffer.value, buffer.cursor, buffer.mode, buffer.pending, buffer.count]).toEqual(['a\n', cursor, 'normal', '', ''])
  expect(buffer.undo).toEqual([])
})

test.each(['', '2'])('%s e from the final empty line does not move backward to an earlier word', count => {
  const buffer = normal('a\n', 2)
  expect(buffer.cursor).toBe(2)
  keys(buffer, ...count, 'e')
  expect([buffer.value, buffer.cursor, buffer.mode, buffer.pending, buffer.count]).toEqual(['a\n', 2, 'normal', '', ''])
  expect([buffer.register, buffer.linewise, buffer.undo, buffer.redo]).toEqual(['', false, [], []])
})


test('u after pending r is a replacement character and does not undo the previous edit', () => {
  const buffer = normal('abc\nnext')
  keys(buffer, 'x')
  expect([buffer.value, buffer.register]).toEqual(['bc\nnext', 'a'])
  keys(buffer, 'r', 'u')
  expect([buffer.value, buffer.cursor, buffer.mode, buffer.pending, buffer.count]).toEqual(['uc\nnext', 0, 'normal', '', ''])
  expect([buffer.register, buffer.linewise]).toEqual(['a', false])
  expect(buffer.undo).toEqual([{ value: 'abc\nnext', cursor: 0 }, { value: 'bc\nnext', cursor: 0 }])
  keys(buffer, 'u')
  expect([buffer.value, buffer.cursor]).toEqual(['bc\nnext', 0])
  keys(buffer, 'u')
  expect([buffer.value, buffer.cursor]).toEqual(['abc\nnext', 0])
})

test('Ctrl+R redoes an existing edit while replacement is pending', () => {
  const buffer = normal('abc')
  keys(buffer, 'x', 'u', 'r')
  expect([buffer.value, buffer.pending, buffer.redo]).toEqual(['abc', 'r', [{ value: 'bc', cursor: 0 }]])
  expect(vimKey(buffer, 'r', true)).toBe(true)
  expect([buffer.value, buffer.cursor, buffer.pending, buffer.count, buffer.register]).toEqual(['bc', 0, '', '', 'a'])
  expect(buffer.undo).toEqual([{ value: 'abc', cursor: 0 }])
  expect(buffer.redo).toEqual([])
  keys(buffer, 'u')
  expect([buffer.value, buffer.cursor]).toEqual(['abc', 0])
})
