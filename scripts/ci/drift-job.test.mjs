import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ts from 'typescript'
import { apiSurface, withDeclarationBuild } from '../check-api-baseline.mjs'
import YAML from 'yaml'

const workflowPath = new URL('../../.github/workflows/drift.yml', import.meta.url)
const ciPath = new URL('../../.github/workflows/ci.yml', import.meta.url)
const scriptsPackagePath = new URL('../PACKAGE.ts', import.meta.url)
const rootPackagePath = new URL('../../PACKAGE.ts', import.meta.url)
const manifestPath = new URL('../../package.json', import.meta.url)
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const runFile = promisify(execFile)
const gateCommands = [
  "pnpm exec smthrs lint '//...:fmt' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//:targetIndex' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//:openapiBundle' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//:openapiClients' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//scripts:docsDrift' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs build '//scripts:apiBaseline' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//scripts:conflictMarkers' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//:driftCi' --known-red '.github/ci-known-red.json' --verbose",
]

test('drift job concurrency group includes github.sha and runs only drift gates', async () => {
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'))
  const main = YAML.parse(await readFile(ciPath, 'utf8'))
  assert.equal(workflow.name, 'Drift')
  assert.deepEqual(Object.keys(workflow.jobs), ['drift'])
  assert.equal(workflow.jobs.drift['timeout-minutes'], 10)
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  for (const part of ['github.workflow', 'github.event_name', 'github.ref', 'github.sha']) {
    assert.ok(workflow.concurrency.group.includes(part), `drift concurrency must include ${part}`)
  }
  assert.equal(
    main.concurrency.group,
    "ci-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref }}",
    'main CI must retain its existing ref-keyed group',
  )
  assert.equal(main.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}")

  const steps = workflow.jobs.drift.steps
  assert.ok(Array.isArray(steps))
  const gateSteps = steps.filter((step) => step.run?.includes('pnpm exec smthrs '))
  assert.deepEqual(gateSteps.map((step) => step.run), gateCommands, 'drift runs exactly the allowed gate argv in order')
  for (const gate of gateSteps) assert.equal(gate.if, "${{ !cancelled() && steps.setup.conclusion == 'success' }}")
  assert.ok(steps.some((step) => step.id === 'setup'), 'drift has one install/setup sentinel')
  assert.equal(steps.filter((step) => step.id === 'setup').length, 1)
  assert.ok(steps.some((step) => step.uses?.startsWith('actions/setup-node@')))
  assert.ok(steps.some((step) => step.uses?.startsWith('oven-sh/setup-bun@')))
  assert.ok(steps.some((step) => step.uses?.startsWith('pnpm/action-setup@')))
  const setup = steps.find((step) => step.id === 'setup')
  assert.match(setup.run, /sudo apt-get install -y -qq --no-install-recommends 'bubblewrap'/)
  assert.equal((setup.run.match(/apt-get install/g) ?? []).length, 1)
  assert.ok(steps.every((step) => !/cargo|rustup|foundry|docker|postgres|smthrs (ci|test|docs)\b/i.test(`${step.name ?? ''} ${step.run ?? ''} ${step.uses ?? ''}`)), 'drift avoids heavy setup and broad gates')
  const setupCommands = [
    "pnpm install --frozen-lockfile --ignore-scripts",
    "npm install --global 'npm@11.16.0' --ignore-scripts --no-audit --no-fund\ntest \"$(npm --version)\" = '11.16.0'\n",
    "if command -v apt-get >/dev/null 2>&1; then\n  sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends 'bubblewrap'\n  if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then\n    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\n  fi\nfi\n",
  ]
  assert.deepEqual(steps.filter((step) => step.run && !gateCommands.includes(step.run)).map((step) => step.run), [
    setupCommands[1], setupCommands[0], setupCommands[2],
  ], 'every shell command is an allowed setup command or drift gate')
  assert.equal(gateSteps[0].run.includes('//...:fmt'), true)
})

test('API baseline and docs drift targets are check-only and independent of release packing', async () => {
  const source = await readFile(scriptsPackagePath, 'utf8')
  const api = source.match(/const apiBaseline\s*=\s*Smithers\.NodeBinary\(\{([\s\S]*?)\n\}\)/)?.[1]
  assert.ok(api, 'apiBaseline must use NodeBinary')
  assert.match(api, /check-api-baseline\.mjs/)
  assert.match(api, /--build-declarations/)
  assert.match(api, /deps:\s*\[\]/)
  assert.doesNotMatch(api, /releasePack/)
  const release = source.match(/const releasePack\s*=\s*Smithers\.NodeBinary\(\{([\s\S]*?)\n\}\)/)?.[1]
  assert.ok(release, 'releasePack must use NodeBinary')
  assert.match(release, /deps:\s*\[\s*apiBaseline\s*,/, 'releasePack must depend on apiBaseline')
  const docs = source.match(/const docsDrift\s*=\s*Smithers\.Shell\.Diff\(\{([\s\S]*?)\n\}\)/)?.[1]
  assert.ok(docs, 'docsDrift must use Shell.Diff')
  assert.match(docs, /changes:\s*\[\]/)
  assert.match(docs, /pnpm run docs:check/)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const generator of ['gen-sites.mjs', 'sync-content.mjs']) {
    assert.match(manifest.scripts['docs:check'], new RegExp(`${generator.replace('.', '\\.')}.{0,100}--check`))
  }
  for (const generator of ['ingest-reference.mjs', 'generate-llms.mjs']) {
    assert.match(docs, new RegExp(`${generator.replace('.', '\\.')}[\\s\\S]{0,100}--check`), `${generator} must run in check mode`)
  }
  assert.doesNotMatch(docs, /(?:pnpm|npm|bun)\s+(?:run\s+)?(?:test|build)\b/)
})

test('standalone root drift target owns the generated workflow', async () => {
  const source = await readFile(rootPackagePath, 'utf8')
  const drift = source.match(/const driftCi\s*=\s*Smithers\.GithubCiGen\(\{([\s\S]*?)\n\}\)/)?.[1]
  assert.ok(drift)
  assert.match(drift, /workflowName:\s*['"]Drift['"]/)
  assert.match(drift, /output:\s*['"]\.github\/workflows\/drift\.yml['"]/)
  assert.match(drift, /concurrency:\s*['"]commit['"]/)
  assert.match(drift, /timeoutMinutes:\s*10/)
  assert.match(drift, /knownRed:\s*['"]\.github\/ci-known-red\.json['"]/, 'the generator must retain known-red when drift.yml is refreshed')
})

const write = async (root, path, contents) => {
  const file = join(root, path)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, contents)
}

const declarationFiles = async (root, prefix = '') => {
  const entries = await readdir(root, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const name = `${prefix}${entry.name}`
    return entry.isDirectory()
      ? declarationFiles(join(root, entry.name), `${name}/`)
      : entry.name.endsWith('.d.ts') ? [name] : []
  }))
  return files.flat().sort()
}

const scratchOutputs = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('smithers-api-declarations-')).sort()

test('declaration build matches normal TypeScript release emit and cleans isolated output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smithers-api-fixture-'))
  const previousTmpdir = process.env.TMPDIR
  const previousTemp = process.env.TEMP
  const previousTmp = process.env.TMP
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = root
  try {
    await write(root, 'pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n')
    await write(root, 'packages/example/package.json', JSON.stringify({
      name: '@smthrs/example',
      publishConfig: { exports: { '.': './dist/esm/index.js' } },
    }))
    await write(root, 'packages/example/tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
        rootDir: 'src', outDir: 'dist/esm', declaration: true, skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }))
    await write(root, 'packages/example/src/index.ts', 'export const infer = (value: string) => ({ value, length: value.length });\nexport { Options } from "./options.js";\n')
    await write(root, 'packages/example/src/options.ts', 'export interface Options { retries?: number }\n')
    await write(root, 'packages/private/package.json', JSON.stringify({ name: '@smthrs/private', private: true }))
    await write(root, 'packages/private/tsconfig.json', '{ invalid json')
    await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir')

    const config = ts.getParsedCommandLineOfConfigFile(join(root, 'packages/example/tsconfig.json'), {
      outDir: join(root, 'normal'), skipLibCheck: true,
    }, ts.sys)
    assert.equal(config.errors.length, 0)
    const normalProgram = ts.createProgram(config.fileNames, config.options)
    const normalDiagnostics = ts.getPreEmitDiagnostics(normalProgram)
    assert.deepEqual(normalDiagnostics, [])
    const normal = normalProgram.emit()
    assert.equal(normal.emitSkipped, false, ts.formatDiagnosticsWithColorAndContext(normal.diagnostics, {
      getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
    }))
    const before = await scratchOutputs()
    let emittedRoot
    const result = await withDeclarationBuild(root, async (output) => {
      emittedRoot = output
      const generated = join(output, 'packages/example/dist/esm')
      const names = await declarationFiles(generated)
      assert.deepEqual(names, ['index.d.ts', 'options.d.ts'])
      for (const name of names) {
        assert.equal(await readFile(join(generated, name), 'utf8'), await readFile(join(root, 'normal', name), 'utf8'))
      }
      assert.deepEqual(await readdir(generated), names)
      await assert.rejects(readdir(join(output, 'packages/example/dist/cjs')), { code: 'ENOENT' })
      assert.deepEqual(await readdir(join(output, 'packages')), ['example'])
      assert.equal(Object.keys(apiSurface(root, output)).join(','), '@smthrs/example')
      return 'checked'
    })
    assert.equal(result, 'checked')
    await assert.rejects(readFile(join(root, 'packages/example/dist/esm/index.js')), { code: 'ENOENT' })
    await assert.rejects(readdir(join(root, 'packages/example/dist/cjs')), { code: 'ENOENT' })
    await assert.rejects(readdir(emittedRoot), { code: 'ENOENT' })
    assert.deepEqual(await scratchOutputs(), before)

    let failedOutput
    await assert.rejects(withDeclarationBuild(root, async (output) => {
      failedOutput = output
      throw new Error('callback failed')
    }), /callback failed/)
    await assert.rejects(readdir(failedOutput), { code: 'ENOENT' })
    assert.deepEqual(await scratchOutputs(), before)

    await rm(join(root, 'packages/example/tsconfig.json'))
    await assert.rejects(withDeclarationBuild(root, () => {}), /(?:Cannot read file|TS5058: The specified path does not exist)/)
    assert.deepEqual(await scratchOutputs(), before)

    await write(root, 'packages/example/tsconfig.json', '{ invalid json')
    await assert.rejects(withDeclarationBuild(root, () => {}))
    assert.deepEqual(await scratchOutputs(), before)

    await write(root, 'packages/example/tsconfig.json', JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src', declaration: true, noEmitOnError: true, skipLibCheck: true },
      include: ['src/**/*.ts'],
    }))
    await write(root, 'packages/example/src/index.ts', 'export const broken: = 1;\n')
    await assert.rejects(withDeclarationBuild(root, () => { throw new Error('callback must not run') }), /declaration emit failed/)
    assert.deepEqual(await scratchOutputs(), before)
  } finally {
    for (const [key, value] of [['TMPDIR', previousTmpdir], ['TEMP', previousTemp], ['TMP', previousTmp]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('public build declarations match release-style tsc for all source files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smithers-api-build-parity-'))
  try {
    await write(root, 'pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n')
    await mkdir(join(root, 'packages'))
    const buildRoot = join(root, 'packages/build')
    await cp(join(repositoryRoot, 'packages/smithers/build/src'), join(buildRoot, 'src'), { recursive: true })
    await cp(join(repositoryRoot, 'packages/smithers/build/package.json'), join(buildRoot, 'package.json'))
    await cp(join(repositoryRoot, 'packages/smithers/build/tsconfig.json'), join(buildRoot, 'tsconfig.json'))
    await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
    await symlink(join(repositoryRoot, 'packages/smithers/build/node_modules'), join(buildRoot, 'node_modules'), 'dir')
    await write(root, 'packages/build/src/Added.ts', 'export interface Added { value: string }\n')

    const releaseRoot = join(root, 'release')
    const releaseDir = join(releaseRoot, 'packages/build/dist/esm')
    await runFile(process.execPath, [
      fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url)),
      '-p', join(root, 'packages/build/tsconfig.json'), '--outDir', releaseDir,
    ], { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 })

    const releaseDeclarations = await declarationFiles(releaseDir)
    const config = ts.getParsedCommandLineOfConfigFile(join(buildRoot, 'tsconfig.json'), {}, ts.sys)
    assert.equal(config.errors.length, 0)
    const sourceDeclarations = config.fileNames
      .filter((name) => name.startsWith(join(buildRoot, 'src')) && /(?<!\.d)\.tsx?$/.test(name))
      .map((name) => relative(join(buildRoot, 'src'), name).replace(/\.tsx?$/, '.d.ts'))
      .sort()
    assert.deepEqual(releaseDeclarations, sourceDeclarations, 'release tsc must cover every @smthrs/build source file')
    assert.ok(releaseDeclarations.includes('Added.d.ts'))
    assert.ok(releaseDeclarations.includes('Install.d.ts'))
    const releaseSurface = apiSurface(root, releaseRoot)
    assert.deepEqual(Object.keys(releaseSurface), ['@smthrs/build'])

    const oldRoot = join(root, 'old-declarations')
    const oldConfig = ts.getParsedCommandLineOfConfigFile(join(root, 'packages/build/tsconfig.json'), {
      noEmit: false, declaration: true, emitDeclarationOnly: true, declarationMap: false,
      incremental: false, composite: false, noCheck: true,
      outDir: join(oldRoot, 'packages/build/dist/esm'),
    }, ts.sys)
    assert.equal(oldConfig.errors.length, 0)
    assert.equal(ts.createProgram(oldConfig.fileNames, oldConfig.options).emit().emitSkipped, false)
    assert.notEqual(
      apiSurface(root, oldRoot)['@smthrs/build'].declarations['Install.d.ts'],
      releaseSurface['@smthrs/build'].declarations['Install.d.ts'],
      'the former noCheck emit must exercise the declaration-order regression',
    )

    await withDeclarationBuild(root, async (output) => {
      const generated = join(output, 'packages/build/dist/esm')
      assert.deepEqual(await declarationFiles(generated), releaseDeclarations)
      assert.deepEqual(apiSurface(root, output), releaseSurface)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('CLI combines declaration build and baseline update from current source', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'smithers-api-cli-fixture-')))
  const packageRoot = join(root, 'packages/example')
  const cli = join(root, 'scripts/check-api-baseline.mjs')
  const baselinePath = join(root, 'scripts/fixtures/public-api-baseline.json')
  const runCli = (...options) => runFile(process.execPath, [cli, ...options], { cwd: root })
  try {
    await write(root, 'package.json', '{"type":"module"}\n')
    await write(root, 'pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n')
    await write(root, 'packages/example/package.json', JSON.stringify({
      name: '@smthrs/example',
      type: 'module',
      publishConfig: { exports: { '.': './dist/esm/index.js' } },
    }))
    await write(root, 'packages/example/tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
        rootDir: 'src', outDir: 'dist/esm', declaration: true, skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }))
    await write(root, 'packages/example/src/index.ts', 'export function value(input: string): string { return input }\n')
    await cp(join(repositoryRoot, 'scripts/check-api-baseline.mjs'), cli)
    await cp(join(repositoryRoot, 'scripts/workspace-packages.mjs'), join(root, 'scripts/workspace-packages.mjs'))
    await cp(join(repositoryRoot, 'packages/repo-targets/scripts/build-library.mjs'), join(root, 'packages/repo-targets/scripts/build-library.mjs'))
    await mkdir(join(root, 'scripts/fixtures'), { recursive: true })
    await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
    await symlink(join(repositoryRoot, 'node_modules'), join(packageRoot, 'node_modules'), 'dir')

    await assert.rejects(readdir(join(packageRoot, 'dist')), { code: 'ENOENT' })
    const first = await runCli('--build-declarations', '--update')
    assert.match(first.stdout, /Recorded declarations for 1 public packages/)
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
    assert.equal(baseline.format, 1)
    const releaseRoot = join(root, 'release')
    await runFile(process.execPath, [
      fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url)),
      '-p', join(packageRoot, 'tsconfig.json'), '--outDir', join(releaseRoot, 'packages/example/dist/esm'),
    ], { cwd: root })
    assert.deepEqual(baseline.packages, apiSurface(root, releaseRoot))
    const firstHash = baseline.packages['@smthrs/example'].declarations['index.d.ts']
    await assert.rejects(readdir(join(packageRoot, 'dist')), { code: 'ENOENT' })

    await write(root, 'packages/example/src/index.ts', 'export function value(input: number): number { return input }\n')
    await assert.rejects(runCli('--build-declarations'), (error) => {
      assert.match(`${error.stderr}\n${error.stdout}`, /Declaration\/API drift requires compatibility review/)
      assert.match(`${error.stderr}\n${error.stdout}`, /Review declaration diffs, consumer type tests and release notes before explicitly updating the baseline/)
      assert.match(error.stderr, /node scripts\/check-api-baseline\.mjs --build-declarations --update/)
      return true
    })
    const second = await runCli('--update', '--build-declarations')
    assert.match(second.stdout, /Recorded declarations for 1 public packages/)
    const updated = JSON.parse(await readFile(baselinePath, 'utf8'))
    assert.notEqual(updated.packages['@smthrs/example'].declarations['index.d.ts'], firstHash)
    await assert.rejects(readdir(join(packageRoot, 'dist')), { code: 'ENOENT' })
    const check = await runCli('--build-declarations')
    assert.match(check.stdout, /Declaration baseline matches 1 public packages/)
    for (const options of [['--unknown'], ['--update', '--update'], ['--build-declarations', '--build-declarations']]) {
      await assert.rejects(runCli(...options), (error) => {
        assert.match(error.stderr, /usage: node scripts\/check-api-baseline\.mjs/)
        return true
      })
    }
    assert.equal(await readFile(baselinePath, 'utf8'), `${JSON.stringify(updated, null, 2)}\n`)
    const alias = join(root, 'scripts/alias.mjs')
    await symlink(cli, alias)
    const linked = await runFile(process.execPath, [alias, '--build-declarations'], { cwd: root })
    assert.match(linked.stdout, /Declaration baseline matches 1 public packages/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the Cloud drift check runs exactly the gates the generated drift workflow runs', async () => {
  const script = await readFile(new URL('./coding-check.sh', import.meta.url), 'utf8')
  const gates = script.match(/drift_gates="([^"]*)"/)?.[1].split('\n')
  assert.ok(gates, 'coding-check.sh declares its drift gates')
  const expected = gateCommands.map((command) => {
    const [, verb, pattern] = command.match(/^pnpm exec smthrs (\w+) '([^']+)'/)
    return `${verb} ${pattern}`
  })
  assert.deepEqual(gates, expected)
  const body = await readFile(new URL('../../flows/checks/drift/flow.mdx', import.meta.url), 'utf8')
  assert.match(body, /flows: \[coding\/CommandCheck\]/)
  assert.match(body, /\{"argv":\["sh","scripts\/ci\/coding-check\.sh","drift"\]/)
  assert.ok(gates.every((gate) => !gate.startsWith('test ')), 'the drift check runs no test target')
})
