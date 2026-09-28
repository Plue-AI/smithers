import { expect, test } from 'bun:test'
import { Electroview } from './electrobun-view.web'

test('the web shim refuses native bridge construction', () => {
  expect(() => new Electroview()).toThrow('web build')
})

test('the web shim refuses native RPC definitions', () => {
  expect(() => Electroview.defineRPC()).toThrow('web build')
})
