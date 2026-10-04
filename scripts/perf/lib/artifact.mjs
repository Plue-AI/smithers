import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

/** Fresh directories only, including refusal results; never produce check receipts. */
export async function writeRun(root, summary) {
  if (!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(summary.timestamp)) throw new Error('invalid artifact timestamp')
  root = resolve(root)
  let current = root
  for (const part of ['.artifacts', 'perf']) {
    current = join(current, part)
    try { await mkdir(current) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe artifact directory')
  }
  const directory = join(current, summary.timestamp)
  await mkdir(directory)
  await writeFile(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' })
  return directory
}
