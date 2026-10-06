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
  for (const budget of summary.budgets ?? []) {
    if (!/^C-PERF-0[1-6]$/.test(budget.check) || !/^[a-z]+(?:-[a-z]+)*$/.test(budget.name)) throw new Error('invalid benchmark artifact name')
    const evidence = { ...summary, budgets: [budget] }
    const bytes = `${JSON.stringify(evidence, null, 2)}\n`
    await writeFile(join(directory, `${budget.name}.json`), bytes, { flag: 'wx' })
    let checkParent = root
    for (const part of ['.artifacts', 'checks', budget.check]) {
      checkParent = join(checkParent, part)
      try { await mkdir(checkParent) } catch (error) { if (error.code !== 'EEXIST') throw error }
      const stat = await lstat(checkParent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe artifact directory')
    }
    const checkDirectory = join(checkParent, summary.timestamp)
    await mkdir(checkDirectory)
    await writeFile(join(checkDirectory, 'summary.json'), bytes, { flag: 'wx' })
    await writeFile(join(checkDirectory, `${budget.name}.json`), bytes, { flag: 'wx' })
  }
  return directory
}
