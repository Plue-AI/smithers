import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
  // The access test list (7f2d5a8eee) cannot drift from the files it names.
  "pnpm exec smthrs lint '//:backendAccessTests' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//:openapiBundle' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//:openapiClients' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//scripts:docsDrift' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs build '//scripts:apiBaseline' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//scripts:conflictMarkers' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//scripts:trackedHygiene' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//:driftCi' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//:ci' --known-red '.github/ci-known-red.json' --verbose",
]

test('drift job concurrency group includes github.sha and runs only drift gates', async () => {
  const { default: YAML } = await import('yaml')
  const { default: ts } = await import('typescript')
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'))
  const main = YAML.parse(await readFile(ciPath, 'utf8'))
  assert.equal(workflow.name, 'Drift')
  assert.deepEqual(Object.keys(workflow.jobs), ['trusted-drift', 'drift'])
  assert.deepEqual(workflow.jobs['trusted-drift'], {
    uses: 'smithersai/smithers/.github/workflows/trusted-drift.yml@e3df95d90516e058a488b6169002eafe9e8f7f28',
  })
  assert.equal(workflow.jobs.drift.name, 'Per-commit drift')
  assert.equal(workflow.jobs.drift.needs, 'trusted-drift')
  assert.equal(workflow.jobs.drift.if, '${{ always() }}')
  assert.deepEqual(workflow.jobs.drift.steps, [{ name: 'Trusted drift result', run: "test '${{ needs.trusted-drift.result }}' = 'success'", shell: 'bash' }])
  const trusted = YAML.parse(await readFile(new URL('../../.github/workflows/trusted-drift.yml', import.meta.url), 'utf8'))
  assert.equal(trusted.jobs.drift['timeout-minutes'], 20, 'a clean run takes 7-10 minutes; a 10-minute cap cancels the last gates')
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

  const steps = trusted.jobs.drift.steps
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
  assert.equal(setup.run, 'pnpm install --frozen-lockfile --ignore-scripts')
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkout?.with?.['persist-credentials'], 'false', 'gate steps must not read the job token from .git/config')
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.ok(steps.every((step) => !JSON.stringify(step).includes('secrets.')), 'drift gates need no secrets')
  assert.ok(steps.every((step) => !/sudo|apt-get|sysctl/.test(step.run ?? '')), 'privileged branch setup remains disabled')
  assert.ok(steps.every((step) => !/cargo|rustup|foundry|docker|postgres|smthrs (test|docs)\b/i.test(`${step.name ?? ''} ${step.run ?? ''} ${step.uses ?? ''}`)), 'drift avoids heavy setup and broad gates')
  const setupCommands = [
    "pnpm install --frozen-lockfile --ignore-scripts",
    "npm install --global 'npm@11.16.0' --ignore-scripts --no-audit --no-fund\ntest \"$(npm --version)\" = '11.16.0'\n",
  ]
  assert.deepEqual(steps.filter((step) => step.run && !gateCommands.includes(step.run)).map((step) => step.run), [
    setupCommands[1], setupCommands[0],
  ], 'every shell command is an allowed setup command or drift gate')
  assert.equal(gateSteps[0].run.includes('//...:fmt'), true)
})

test('CI declares the retained document components using the moved native ABI adapter', async () => {
  const { default: YAML } = await import('yaml')
  const workflow = YAML.parse(await readFile(ciPath, 'utf8'))
  const step = workflow.jobs.rust.steps.find((step) => step.name === 'Daemon document component tests')
  assert.ok(step)
  assert.match(step.run, /smthrs test '\/\/crates\/smithers-machined:documentComponents'/)
  const source = await readFile(new URL('../../crates/smithers-machined/PACKAGE.ts', import.meta.url), 'utf8')
  assert.ok(source.includes('cargo test --locked -p smithers-machined --test documents'))
  assert.ok(source.includes('cargo build --locked -p smithers-ffi --example live_document_interop'))
  assert.ok(source.includes('node crates/smithers-ffi/tests/yjs-interop.ts'))
  assert.ok(!step.run.includes('examples/document_interop'))
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
  assert.match(manifest.scripts['docs:check'], /modelprice\/cmd\/generate -check/)
  assert.match(manifest.scripts['docs:check'], /node scripts\/package-docs\.test\.mjs/)
  const packageCheck = await readFile(new URL('../package-docs.test.mjs', import.meta.url), 'utf8')
  assert.match(packageCheck, /"pack", "--dry-run"/)
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
  assert.match(source, /const driftJob[\s\S]*?timeoutMinutes:\s*20/)
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
  const { default: ts } = await import('typescript')
  const { apiSurface, withDeclarationBuild } = await import('../check-api-baseline.mjs')
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
  const { default: ts } = await import('typescript')
  const { apiSurface, withDeclarationBuild } = await import('../check-api-baseline.mjs')
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
    // Checking the private seed creates B first; a noCheck declaration emit
    // reaches the exported conditional first and creates A first instead.
    await write(root, 'packages/build/src/DeclarationOrder.ts', `
const seed: B = { b: true }
export const inferred = Math.random() ? getA() : getB()
interface A { a: boolean }
interface B { b: boolean }
declare function getA(): A
declare function getB(): B
`)

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
      await readFile(join(oldRoot, 'packages/build/dist/esm/DeclarationOrder.d.ts'), 'utf8'),
      await readFile(join(releaseDir, 'DeclarationOrder.d.ts'), 'utf8'),
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
  const { apiSurface, withDeclarationBuild } = await import('../check-api-baseline.mjs')
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
    await cp(join(repositoryRoot, 'packages/repo-targets/scripts/private-effect-adapters.mjs'), join(root, 'packages/repo-targets/scripts/private-effect-adapters.mjs'))
    await mkdir(join(root, 'scripts/fixtures'), { recursive: true })
    await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
    await symlink(join(repositoryRoot, 'node_modules'), join(packageRoot, 'node_modules'), 'dir')

    await assert.rejects(readdir(join(packageRoot, 'dist')), { code: 'ENOENT' })
    const first = await runCli('--build-declarations', '--update')
    assert.match(first.stdout, /Recorded declarations for 1 public packages/)
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
    assert.equal(baseline.format, 2)
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

const trustedSetupPath = fileURLToPath(new URL('../../.github/actions/trusted-ci-setup/setup.py', import.meta.url))
const setupEnvironment = {
  ...process.env,
  RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', ImageOS: 'ubuntu24',
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
}
for (const key of [
  'GH_TOKEN', 'GITHUB_TOKEN', 'SMITHERS_GITHUB_PROXY', 'NODE_OPTIONS',
  'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'CDPATH', 'PYTHONPATH', 'PYTHONHOME',
  'APT_CONFIG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY',
  'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy',
]) delete setupEnvironment[key]
for (const key of Object.keys(setupEnvironment)) {
  if (['LD_', 'DYLD_', 'BASH_FUNC_', 'INPUT_'].some((prefix) => key.startsWith(prefix))) delete setupEnvironment[key]
}

// Refusals reach the actual action dispatcher and never replace sudo, apt or
// the dispatch implementation. These run without privileges on every host.
test('root-ci-setup-input-validation refuses hostile environment before privilege dispatch', async () => {
  for (const [key, value] of [
    ['SMITHERS_TRUSTED_SETUP_INPUTS', '{"packages":["bash"]}'],
    ['SMITHERS_TRUSTED_SETUP_INPUTS', '{"shell":"/tmp/branch-shell"}'],
    ['SMITHERS_TRUSTED_SETUP_INPUTS', 'invalid-json'],
    ['INPUT_PACKAGES', 'bubblewrap; touch /run/smithers-hostile-root'],
    ['INPUT_SETUP_ARGV', 'sudo /tmp/branch-setup'],
    ['INPUT_WORKFLOW_SHELL', '/tmp/branch-shell'],
    ['INPUT_SYSCTL', 'kernel.modprobe=/tmp/branch-root'],
    ['BASH_ENV', '/tmp/branch-startup'], ['ENV', '/tmp/branch-startup'],
    ['BASH_FUNC_setup%%', '() { touch /run/smithers-hostile-root; }'],
    ['LD_PRELOAD', '/tmp/branch-loader.so'], ['PYTHONPATH', '/tmp/branch-import'],
    ['NODE_OPTIONS', '--require=/tmp/branch-import'],
    ['APT_CONFIG', '/tmp/branch-apt.conf'],
    ['SMITHERS_TRUSTED_INCOMING_PATH', '/tmp/branch-bin:/usr/bin'],
    ['PATH', '/tmp/branch-bin:/usr/bin'], ['PATH', ':/usr/bin'],
    ['GH_TOKEN', 'root-fixture-token'], ['GITHUB_TOKEN', 'root-fixture-token'],
    ['SMITHERS_GITHUB_PROXY', 'root-fixture-proxy'],
  ]) {
    await assert.rejects(runFile('/usr/bin/python3', ['-I', trustedSetupPath], {
      cwd: '/', env: { ...setupEnvironment, [key]: value },
    }), (error) => {
      assert.equal(error.code, 2, `${key}: ${error.stderr}`)
      const expected = key === 'SMITHERS_TRUSTED_SETUP_INPUTS' ? 'action inputs'
        : ['PATH', 'SMITHERS_TRUSTED_INCOMING_PATH'].includes(key) ? 'PATH' : `environment: ${key}`
      assert.ok(error.stderr.includes(`trusted setup refused: ${expected}`), `${key}: ${error.stderr}`)
      return true
    })
  }
  for (const argv of [['--packages', 'bash'], ['--shell', '/tmp/branch-shell'], ['--enable'], ['--sysctl', 'kernel.modprobe']]) {
    await assert.rejects(runFile('/usr/bin/python3', ['-I', trustedSetupPath, ...argv], {
      cwd: '/', env: setupEnvironment,
    }), (error) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /trusted setup refused: argv/)
      return true
    })
  }
})

// Only the main-pinned campaign action selects this test, on a disposable
// Ubuntu runner before checkout. No sudo is executed by local test runs.
test('root-ci-setup-input-validation disposable Ubuntu positive and hostile controls', {
  skip: process.env.SMITHERS_TRUSTED_SETUP_CAMPAIGN !== '1',
}, async () => {
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.ImageOS, 'ubuntu24')
  const receipt = '/run/smithers-trusted-setup.receipt'
  const canary = '/run/smithers-hostile-root'
  await assert.rejects(readFile(receipt), { code: 'ENOENT' })
  await assert.rejects(readFile(canary), { code: 'ENOENT' })
  const workspace = process.env.GITHUB_WORKSPACE
  assert.deepEqual(await readdir(workspace), [], 'positive setup precedes branch checkout')
  // Run the production dispatcher, with activation selected solely by this
  // committed campaign program. Production CLI has no activation override.
  const positive = `import runpy; m = runpy.run_path(${JSON.stringify(trustedSetupPath)}); m['dispatch'](activated=True)`
  for (const [path, bytes] of [
    ['PACKAGE.ts', 'export const setup = { argv: ["sudo", "touch", "/run/smithers-hostile-root"] }\n'],
    ['.github/workflows/drift.yml', 'jobs:\n  drift:\n    steps:\n      - run: sudo touch /run/smithers-hostile-root\n'],
    ['package.json', '{"scripts":{"preinstall":"sudo touch /run/smithers-hostile-root"}}\n'],
  ]) {
    await write(workspace, path, bytes)
    try {
      await assert.rejects(runFile('/usr/bin/python3', ['-I', '-c', positive], { cwd: '/', env: setupEnvironment }), (error) => {
        assert.equal(error.code, 1)
        assert.match(error.stderr, /trusted setup refused: setup must precede checkout/)
        return true
      })
      await assert.rejects(readFile(receipt), { code: 'ENOENT' })
      await assert.rejects(readFile(canary), { code: 'ENOENT' })
    } finally {
      await rm(join(workspace, path), { force: true })
      if (path.startsWith('.github/')) await rm(join(workspace, '.github'), { recursive: true, force: true })
    }
  }
  assert.deepEqual(await readdir(workspace), [])
  // A runner-owned archive keyring is accepted only at its approved bytes;
  // root uses the embedded main copy. An altered image keyring still refuses.
  const imageKeyring = '/usr/share/keyrings/ubuntu-archive-keyring.gpg'
  const savedKeyring = imageKeyring + '.smithers-validation-original'
  await runFile('/usr/bin/sudo', ['--non-interactive', '/usr/bin/mv', imageKeyring, savedKeyring])
  try {
    await runFile('/usr/bin/sudo', ['--non-interactive', '/usr/bin/touch', imageKeyring])
    await assert.rejects(runFile('/usr/bin/python3', ['-I', '-c', positive], { cwd: '/', env: setupEnvironment }), (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /trusted setup refused: runner keyring identity/)
      return true
    })
    await assert.rejects(readFile(receipt), { code: 'ENOENT' })
    await assert.rejects(readFile(canary), { code: 'ENOENT' })
  } finally {
    await runFile('/usr/bin/sudo', ['--non-interactive', '/usr/bin/mv', savedKeyring, imageKeyring])
  }
  const log = await runFile('/usr/bin/python3', ['-I', '-c', positive], { cwd: '/', env: setupEnvironment, maxBuffer: 8 * 1024 * 1024 })
  assert.match(log.stdout, /bubblewrap/)
  const commands = JSON.parse(log.stdout.match(/^TRUSTED-SETUP-COMMANDS (.*)$/m)?.[1] ?? 'null')
  const expectedCommands = [
    ['/usr/bin/apt-get', 'update'],
    ['/usr/bin/apt-get', 'install', '--yes', '--no-install-recommends', 'bubblewrap'],
  ]
  try {
    await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
    expectedCommands.push(['/usr/sbin/sysctl', '-w', 'kernel.apparmor_restrict_unprivileged_userns=0'])
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  assert.deepEqual(commands, expectedCommands)
  assert.equal(await readFile(receipt, 'utf8'), 'smithers-main-pinned-setup-v1\n')
  const rootOwner = await runFile('/usr/bin/stat', ['--format=%u', receipt])
  assert.equal(rootOwner.stdout.trim(), '0')
  // Clear the positive receipt before hostile controls, so a new setup is
  // observable. Fixture mutations are trusted test code on this disposable host.
  await runFile('/usr/bin/sudo', ['--non-interactive', '/usr/bin/rm', receipt])
  const hostile = await mkdtemp(join(tmpdir(), 'smithers-hostile-setup-'))
  const hook = '/etc/apt/apt.conf.d/99smithers-hostile-validation'
  const savedApt = '/usr/bin/apt-get.smithers-validation-original'
  try {
    const originalSetup = await readFile(trustedSetupPath)
    try {
      await writeFile(trustedSetupPath, Buffer.concat([originalSetup, Buffer.from('\n# hostile branch setup bytes\n')]))
      await assert.rejects(runFile('/usr/bin/python3', ['-I', '-c', positive], { cwd: '/', env: setupEnvironment }), (error) => {
        assert.equal(error.code, 1)
        assert.match(error.stderr, /trusted setup refused: main-pinned setup byte identity/)
        return true
      })
    } finally { await writeFile(trustedSetupPath, originalSetup) }
    await writeFile(join(hostile, 'apt.conf'), 'APT::Update::Pre-Invoke { "touch /run/smithers-hostile-root"; };\n')
    await runFile('/usr/bin/sudo', ['--non-interactive', '/usr/bin/ln', '-s', join(hostile, 'apt.conf'), hook])
    await assert.rejects(runFile('/usr/bin/python3', ['-I', '-c', positive], { cwd: '/', env: setupEnvironment }), (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /trusted setup refused: untrusted runner path/)
      return true
    })
    await runFile('/usr/bin/sudo', ['--non-interactive', '/usr/bin/rm', hook])
    // Replacing an executable with root-owned bytes must still fail its
    // approved runner package identity; owner/mode checks alone are insufficient.
    await writeFile(join(hostile, 'apt-get'), '#!/bin/sh\ntouch /run/smithers-hostile-root\n', { mode: 0o755 })
    await runFile('/usr/bin/sudo', ['--non-interactive', '/usr/bin/mv', '/usr/bin/apt-get', savedApt])
    await runFile('/usr/bin/sudo', ['--non-interactive', '/usr/bin/install', '-m', '755', join(hostile, 'apt-get'), '/usr/bin/apt-get'])
    await assert.rejects(runFile('/usr/bin/python3', ['-I', '-c', positive], { cwd: '/', env: setupEnvironment }), (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /trusted setup refused: runner executable identity: \/usr\/bin\/apt-get/)
      return true
    })
    await assert.rejects(readFile(receipt), { code: 'ENOENT' })
    await assert.rejects(readFile(canary), { code: 'ENOENT' })
  } finally {
    await runFile('/usr/bin/sudo', ['--non-interactive', '/usr/bin/rm', '-f', hook])
    try {
      await readFile(savedApt)
      await runFile('/usr/bin/sudo', ['--non-interactive', '/usr/bin/mv', savedApt, '/usr/bin/apt-get'])
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    await rm(hostile, { recursive: true, force: true })
  }
  // No gate or publication entry point is invoked by this pre-checkout campaign.
})

test('trusted setup rejects branch-selected action inputs and pins its own context', async () => {
  const { default: YAML } = await import('yaml')
  for (const directory of ['trusted-ci-setup', 'trusted-ci-setup-campaign']) {
    const action = YAML.parse(await readFile(new URL(`../../.github/actions/${directory}/action.yml`, import.meta.url), 'utf8'))
    assert.equal(action.inputs, undefined)
    assert.equal(action.runs.using, 'composite')
    const step = action.runs.steps[0]
    assert.equal(step.shell, '/usr/bin/python3 -I {0}')
    assert.equal(step.env.PATH, directory === 'trusted-ci-setup' ? '/usr/sbin:/usr/bin:/sbin:/bin' : undefined)
    assert.equal(step.env.SMITHERS_TRUSTED_ACTION_REF, '${{ github.action_ref }}')
    assert.equal(step.env.SMITHERS_TRUSTED_ACTION_REPOSITORY, '${{ github.action_repository }}')
    assert.equal(step.env.SMITHERS_TRUSTED_ACTION_PATH, '${{ github.action_path }}')
    assert.equal(step.env.SMITHERS_TRUSTED_SETUP_INPUTS, '${{ toJSON(inputs) }}')
  }
  for (const inputs of ['{"packages":["bash"]}', '{"shell":"/tmp/branch-shell"}', '{"argv":["touch","/run/smithers-hostile-root"]}', 'invalid-json']) {
    await assert.rejects(runFile('/usr/bin/python3', ['-I', trustedSetupPath], {
      cwd: '/', env: { ...setupEnvironment, SMITHERS_TRUSTED_SETUP_INPUTS: inputs },
    }), (error) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /trusted setup refused: action inputs/)
      return true
    })
  }
})

test('trusted drift and disposable setup campaign are main-pinned before branch execution', async () => {
  const { default: YAML } = await import('yaml')
  const trusted = YAML.parse(await readFile(new URL('../../.github/workflows/trusted-drift.yml', import.meta.url), 'utf8'))
  assert.deepEqual(trusted.on, { workflow_call: null })
  assert.equal(trusted.concurrency['cancel-in-progress'], false)
  assert.equal(trusted.concurrency.group, 'trusted-${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}-${{ github.sha }}')
  assert.equal(trusted.jobs.drift['runs-on'], 'ubuntu-latest')
  assert.equal(trusted.jobs.drift.steps[0].uses, 'smithersai/smithers/.github/actions/trusted-ci-setup@c4ece3f812c7720ac622c11582d5ef2c085d6a2c')
  assert.equal(trusted.jobs.drift.steps[1].uses, 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262')
  assert.deepEqual(trusted.jobs.drift.steps[1].with, { ref: '${{ github.event.pull_request.head.sha || github.sha }}', 'persist-credentials': 'false' })
  assert.equal(trusted.env, undefined)
  assert.equal(trusted.jobs.drift.env, undefined)
  assert.deepEqual(trusted.permissions, { contents: 'read' })
  assert.deepEqual(trusted.jobs.drift.steps.filter((step) => step.run?.includes('pnpm exec smthrs ')).map((step) => step.run), gateCommands)
  const campaign = YAML.parse(await readFile(new URL('../../.github/workflows/trusted-setup-validation.yml', import.meta.url), 'utf8'))
  assert.deepEqual(campaign.on, {
    push: { branches: ['main'], paths: [
      '.github/actions/trusted-ci-setup/**', '.github/actions/trusted-ci-setup-campaign/**',
      '.github/workflows/trusted-setup-validation.yml', 'scripts/ci/drift-job.test.mjs',
      'packages/smithers/build/targets/src/GithubCiGen.ts', 'PACKAGE.ts',
    ] },
    workflow_dispatch: null,
  })
  assert.deepEqual(campaign.permissions, { contents: 'read' })
  assert.equal(campaign.jobs.setup.if, "${{ github.ref == 'refs/heads/main' }}")
  assert.equal(campaign.jobs.setup['runs-on'], 'ubuntu-latest')
  assert.equal(campaign.jobs.setup.steps[0].uses, 'smithersai/smithers/.github/actions/trusted-ci-setup-campaign@c4ece3f812c7720ac622c11582d5ef2c085d6a2c')
  assert.equal(campaign.jobs.setup.steps.length, 2, 'campaign runs before checkout or dependency actions')
  assert.equal(campaign.jobs.setup.steps[1].uses, 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
  assert.equal(campaign.jobs.setup.steps[1].if, '${{ always() }}')
  assert.equal(campaign.jobs.setup.steps[1].with['if-no-files-found'], 'error')
})

test('C-PRC-01 observes the literal required status and clean per-SHA check through GitHub APIs', {
  skip: !process.env.SMITHERS_PRC_STATUS_ACCEPTANCE_COMMIT,
}, async () => {
  const commit = process.env.SMITHERS_PRC_STATUS_ACCEPTANCE_COMMIT
  assert.match(commit, /^[0-9a-f]{40}$/)
  const readApi = async (path) => {
    const response = await fetch(`https://api.github.com/repos/smithersai/smithers/${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'smithers-prc-acceptance' },
      signal: AbortSignal.timeout(30_000),
    })
    assert.equal(response.status, 200, `${path}: ${response.status}`)
    return response.json()
  }
  const rules = await readApi('rules/branches/main')
  const checks = rules.filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
  assert.ok(checks.some((check) => check.context === 'Per-commit drift'), 'main must require the literal Per-commit drift context')
  const runs = await readApi(`commits/${commit}/check-runs?per_page=100`)
  assert.ok(runs.check_runs.some((run) => run.name === 'Per-commit drift' && run.head_sha === commit
    && run.status === 'completed' && run.conclusion === 'success'), 'the exact landed SHA must have a clean Per-commit drift run')
})

test('campaign bootstrap uses the real runner Node and retains launch failures before checkout', async () => {
  const { default: YAML } = await import('yaml')
  const { engineeringGateEnvironment } = await import('../engineering-gate-environment.mjs')
  const { createHash } = await import('node:crypto')
  const { dirname } = await import('node:path')
  const action = YAML.parse(await readFile(new URL('../../.github/actions/trusted-ci-setup-campaign/action.yml', import.meta.url), 'utf8'))
  const script = action.runs.steps[0].run
  const root = await mkdtemp(join(tmpdir(), 'smithers-campaign-bootstrap-'))
  const commit = '0123456789abcdef0123456789abcdef01234567'
  try {
    for (const scenario of ['runner-node', 'missing-node']) {
      const temporary = join(root, scenario)
      await mkdir(temporary)
      const env = {
        ...engineeringGateEnvironment(process.env), RUNNER_TEMP: temporary, GITHUB_SHA: commit,
        SMITHERS_TRUSTED_ACTION_PATH: join(repositoryRoot, '.github/actions/trusted-ci-setup-campaign'),
        SMITHERS_TRUSTED_ACTION_REF: commit, SMITHERS_TRUSTED_ACTION_REPOSITORY: 'smithersai/smithers',
        SMITHERS_TRUSTED_SETUP_INPUTS: '{}', SMITHERS_TRUSTED_INCOMING_PATH: '',
        SMITHERS_TRUSTED_SETUP_CAMPAIGN: '0',
        PATH: scenario === 'runner-node' ? dirname(process.execPath) : join(root, 'empty-bin'),
      }
      delete env.NODE_TEST_CONTEXT
      if (scenario === 'runner-node') {
        const result = await runFile('/usr/bin/python3', ['-I', '-c', script], { env, cwd: '/' })
        assert.match(result.stdout, /root-ci-setup-input-validation refuses hostile environment/)
      } else {
        await assert.rejects(runFile('/usr/bin/python3', ['-I', '-c', script], { env, cwd: '/' }), (error) => {
          assert.equal(error.code, 2)
          assert.match(error.stdout, /::error::RuntimeError: approved runner Node is unavailable/)
          return true
        })
      }
      const output = join(temporary, 'smithers-setup-campaign')
      const receipt = JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8'))
      const log = await readFile(join(output, 'output.log'))
      assert.equal(receipt.commit, commit)
      assert.equal(receipt.source_commit, commit)
      assert.equal(receipt.check, 'C-PRC-01/root-ci-setup-input-validation')
      assert.equal(receipt.exit, scenario === 'runner-node' ? 0 : 2)
      assert.equal(receipt.log_digest, 'sha256:' + createHash('sha256').update(log).digest('hex'))
      assert.equal(receipt.command.length, scenario === 'runner-node' ? 4 : 0)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
