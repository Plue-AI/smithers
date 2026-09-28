import { expect, test } from 'bun:test'
import * as nativeChat from './DurableChatProducer'
import * as nativeTurn from './ModelTurnHost'
import * as sharedChat from '@smthrs/model-host/DurableChatProducer'
import * as sharedTurn from '@smthrs/model-host/ModelTurnHost'

const sameRuntimeExports = (native: Record<string, unknown>, shared: Record<string, unknown>) => {
  const names = Object.keys(shared).sort()
  expect(Object.keys(native).sort()).toEqual(names)
  expect(names.length).toBeGreaterThan(0)
  for (const name of names) expect(native[name]).toBe(shared[name])
}

test('native durable chat forwarding shares every runtime export with model-host', () => {
  sameRuntimeExports(nativeChat, sharedChat)
})

test('native model turn forwarding shares every runtime export with model-host', () => {
  sameRuntimeExports(nativeTurn, sharedTurn)
})
