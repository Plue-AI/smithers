import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { expect, mock, test } from 'bun:test'
import { act } from 'react'

GlobalRegistrator.register()
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

let renders = 0
mock.module('../../../src/mainview/AppIsland', () => ({
  default: () => {
    renders++
    return <main>Smithers entry</main>
  }
}))

test('browser main mounts the app into the root element', async () => {
  const host = document.createElement('div')
  host.id = 'root'
  document.body.append(host)
  try {
    await act(async () => { await import('../../../src/mainview/main') })
    expect(host.querySelector('main')?.textContent).toBe('Smithers entry')
    expect(renders).toBe(1)
  } finally {
    host.remove()
    await GlobalRegistrator.unregister()
  }
})
