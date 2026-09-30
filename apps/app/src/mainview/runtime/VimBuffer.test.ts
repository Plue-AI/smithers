import { expect, test } from 'bun:test'
import { createVimBuffer, vimKey, type VimBuffer } from './VimBuffer'

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
