import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROBE_MARKER } from '../../e2e/native/Probe'
import type { NativeProbeReport, ProbeScenario } from '../../e2e/native/Probe'

const appDir = fileURLToPath(new URL('../..', import.meta.url))
const driver = fileURLToPath(new URL('../../e2e/native/MainProcess.ts', import.meta.url))

const probe = async (scenario: ProbeScenario, env: Record<string, string> = {}): Promise<NativeProbeReport> => {
  const home = await mkdtemp(join(tmpdir(), 'smithers-native-entry-'))
  const child = Bun.spawn([process.execPath, driver], {
    cwd: appDir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      SMITHERS_NATIVE_PROBE: JSON.stringify(scenario),
      SMITHERS_NATIVE_PROBE_HOME: home,
      SMITHERS_LOCAL_PORT: '0',
      SMITHERS_CHAT_STUB: '1',
      SMITHERS_LOCAL_MODE: 'offline',
      ...env
    },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const deadline = setTimeout(() => child.kill('SIGKILL'), 55_000)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    expect(status).toBe(0)
    const line = stdout.split('\n').find((entry) => entry.startsWith(PROBE_MARKER))
    if (line === undefined) throw new Error(`native entrypoint reported no result; stdout: ${stdout}; stderr: ${stderr}`)
    return JSON.parse(line.slice(PROBE_MARKER.length)) as NativeProbeReport
  } finally {
    clearTimeout(deadline)
    child.kill('SIGKILL')
    await child.exited
    await rm(home, { recursive: true, force: true })
  }
}

test('a dev launch URL opens first and a later host link navigates the same window', async () => {
  const report = await probe(
    { openUrlsAfterStart: ['smithers://open/second/repo'] },
    { SMITHERS_OPEN_URL: 'smithers://open/first/repo' }
  )
  expect(report.windows).toHaveLength(1)
  expect(report.windows[0]?.url).toBe(`${report.origin}/first/repo`)
  expect(report.windows[0]?.loaded).toEqual([`${report.origin}/second/repo`])
  expect(report.openedExternally).toEqual([])
}, 60_000)

test('an invalid launch URL leaves the home page usable for a later valid link', async () => {
  const report = await probe(
    { openUrlsAfterStart: ['smithers://open/owner/repo'] },
    { SMITHERS_OPEN_URL: 'smithers://open/owner/repo/extra' }
  )
  expect(report.windows).toHaveLength(1)
  expect(report.windows[0]?.url).toBe(`${report.origin}/`)
  expect(report.windows[0]?.loaded).toEqual([`${report.origin}/owner/repo`])
  expect(report.health).toMatchObject({ ok: true })
}, 60_000)
