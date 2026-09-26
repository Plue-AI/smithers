import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
const source = fileURLToPath(new URL('../..', import.meta.url))
if (!process.argv[2]) throw Error('Pass the directory for the canary setup artifact')
const output = resolve(process.argv[2])
const { build } = createRequire(source + '/package.json')('esbuild')
await mkdir(output, { recursive: true })
// Each `flows/coding/<name>/flow.ts` IS the flow it declares: one
// `export default Flow.make("<tag>", { ..., body })` over the actions its
// siblings export, and no delegate. The canary ships those modules verbatim, so
// the bundled API is derived from what they import rather than fixed here: the
// named imports of each authored file, resolved against `flows/`, re-exported
// once per module and read back through the hoisted factory below.
const entries = ['flow.ts', 'implementation/flow.ts', 'request/flow.ts', 'vibe/flow.ts', 'verify/flow.ts']
const authored = new Map()
const clausePattern = /^import \{([^}]+)\} from "([^"]+)"$/gm
/** The module id a specifier names, as `flows/` sees it. */
const moduleIdOf = (relative, specifier) => specifier.startsWith('.')
  ? './' + join('coding', relative, '..', specifier)
  : specifier
const members = new Map()
const owner = new Map()
for (const relative of entries) {
  const text = await readFile(join(source, 'flows/coding', relative), 'utf8')
  authored.set(relative, text)
  for (const match of text.matchAll(clausePattern)) {
    const moduleId = moduleIdOf(relative, match[2])
    // An inline `type` clause names no runtime export; esbuild erases it.
    for (const clause of match[1].split(',').map(value => value.trim()).filter(value => value !== '' && !value.startsWith('type '))) {
      const origin = clause.split(/\s+as\s+/)[0]
      const claimed = owner.get(origin)
      if (claimed !== undefined && claimed !== moduleId) throw Error(`Two modules export ${origin}: ${claimed} and ${moduleId}`)
      owner.set(origin, moduleId)
      members.set(moduleId, (members.get(moduleId) ?? new Set()).add(origin))
    }
  }
}
const contents = [...members].map(([moduleId, names]) => `export {${[...names].sort().join(',')}} from ${JSON.stringify(moduleId)};`).join('')
const bundled = await build({ stdin: { contents, resolveDir: join(source, 'flows') }, bundle: true, write: false, platform: 'node', format: 'esm', metafile: true, minify: true, target: 'node26.4' })
if (Object.values(bundled.metafile.outputs).some(file => file.imports.length > 0)) throw Error('Coding declarations must bundle every dependency')
const api = bundled.outputFiles[0].text
const exports = api.match(/export\{([^}]+)\};?\s*$/)
if (!exports) throw Error('Expected static bundled exports')
const names = exports[1].split(',').map(value => value.trim().split(/\s+as\s+/)).map(([local, exported]) => JSON.stringify(exported ?? local) + ':' + local)
if (new Set(names.map(entry => entry.split(':')[0].slice(1, -1))).size !== owner.size) {
  throw Error('The bundled API must export every name the coding declarations import')
}
const body = api.slice(0, exports.index)
const files = {}
for (const relative of entries) {
  const text = authored.get(relative)
  const bindings = [...text.matchAll(clausePattern)].flatMap(match =>
    match[1].split(',').map(value => value.trim()).filter(value => value !== '' && !value.startsWith('type ')).map(clause => {
      const [origin, alias] = clause.split(/\s+as\s+/)
      return alias === undefined ? origin : origin + ':' + alias
    })
  )
  // A module's own default export reaches its registration through a
  // self-import, which resolves to this same file wherever it is installed, so
  // that one line stays and every other binding comes from the factory.
  const selfImport = ' from "./' + relative.split('/').at(-1) + '"'
  const stripped = text.split('\n')
    .filter(line => !line.startsWith('import ') || (!line.startsWith('import {') && line.endsWith(selfImport)))
    .join('\n')
  // A declaration that binds a name the host already defines (`atomError as
  // Error`) shadows it for the whole module, including inside the factory, and
  // the factory runs while that binding is still uninitialised. The factory
  // therefore opens by taking each such name from `globalThis`, so the bundled
  // code keeps reading the global it was written against.
  const shadowed = bindings.map(binding => binding.split(':').at(-1)).filter(name => name in globalThis)
  // A hoisted factory keeps metadata first and every dependency in this
  // source-hashed entry, without package installation or URL imports.
  const factory = 'function createCodingApi(){' +
    shadowed.map(name => `const ${name}=globalThis.${name};`).join('') +
    body + 'return {' + names.join(',') + '}}\n'
  const entry = 'const {' + bindings.join(',') + '} = createCodingApi()\n' + stripped.trim() + '\n' + factory
  if (Buffer.byteLength(entry) > 4 * 1024 * 1024) throw Error('Declaration exceeds discovery limit')
  if (!/^export default Flow\.make\("[^"]+", \{/m.test(entry)) throw Error(`${relative} must default-export one tagged flow`)
  files['flows/coding/' + relative] = entry
}
const fast = `from pathlib import Path
text=Path('README.md').read_text()
assert text.startswith('# canary-sandbox\\n'), 'Preserve the fixture title'
assert 'Smithers Cloud canary fixture repo.' in text, 'Preserve the fixture introduction'
assert '\\n## Purpose\\n' in text, 'Document the fixture purpose under ## Purpose'
section=text.split('\\n## Purpose\\n',1)[1].split('\\n## ',1)[0]
assert 'disposable' in section.lower() and 'production' in section.lower() and 'test' in section.lower(), 'Explain the disposable production-test purpose'
print('README task requirements passed')
`
const slow = `from pathlib import Path
import re, urllib.parse
root=Path('.').resolve()
for path in root.rglob('*.md'):
 if any(part.startswith('.') for part in path.relative_to(root).parts): continue
 for target in re.findall(r'!?\\[[^\\]]*\\]\\(([^)\\s]+)(?:\\s+[^)]*)?\\)', path.read_text()):
  parsed=urllib.parse.urlparse(target)
  if parsed.scheme or target.startswith('#'): continue
  resolved=(path.parent/urllib.parse.unquote(parsed.path)).resolve()
  assert resolved.is_relative_to(root), f'Link leaves source tree: {path.relative_to(root)}'
  assert resolved.exists(), f'Broken local link: {path.relative_to(root)} -> {target}'
print('Local Markdown links resolve inside source tree')
`
for (const [tier, program] of [['fast', fast], ['slow', slow]]) files['flows/checks/' + tier + '/flow.mdx'] = '---\ndescription: ' + (tier === 'fast' ? 'Verify the explicit README documentation task.' : 'Verify local Markdown links against the immutable source tree.') + '\nflows: [coding/CommandCheck]\ncapabilities: ["*"]\n---\n' + JSON.stringify({ argv: ['python3', '-c', program], cwd: '.', timeoutMs: 30000 }) + '\n'
files['flows/checks/wiki/flow.mdx'] = '---\ndescription: Verify current wiki semantics against source.\nflows: [coding/WikiCheck]\ncapabilities: ["*"]\n---\nReview the operator-configured wiki.\n'
const project = { wikiOutput: '../canary-coding-wiki', reviewer: 'canary-source-docs-v1', pages: [{ id: 'overview', title: 'Canary fixture', purpose: 'Document the tracked fixture and its canary role', kind: 'current', document: 'overview.md', inputs: ['README.md'], related: [] }], implementation: 'coding/implementation', checks: ['fast', 'slow', 'wiki'].map(tier => ({ id: tier, target: 'README.md', flow: 'checks/' + tier, tier: tier === 'fast' ? 'fast' : 'slow', required: true })) }
files['.smithers/coding-project.json'] = JSON.stringify(project, null, 2) + '\n'
for (const [path, content] of Object.entries(files)) { await mkdir(join(output, path, '..'), { recursive: true }); await writeFile(join(output, path), content) }
const payload = gzipSync(JSON.stringify(files)).toString('base64')
const setup = `# Smithers coding canary setup: source-pinned declarations and explicit documentation checks.\npython3 - <<'SMITHERS_CANARY_SETUP'\nimport base64,gzip,json,pathlib\nroot=pathlib.Path.cwd()\nif not (root/'README.md').read_text().startswith('# canary-sandbox\\n'): raise RuntimeError('Wrong repository: refusing canary setup')\nfiles=json.loads(gzip.decompress(base64.b64decode('${payload}')))\nfor name,content in files.items():\n path=root/name\n if path.exists() and path.read_text()!=content: raise RuntimeError('Existing setup differs: '+name)\nfor name,content in files.items():\n path=root/name\n path.parent.mkdir(parents=True,exist_ok=True)\n path.write_text(content)\nSMITHERS_CANARY_SETUP\n`
await writeFile(join(output, 'setup.sh'), setup)
await writeFile(join(output, 'task.txt'), 'Preserve the existing README title and introduction. Add a ## Purpose section explaining that this repository is a disposable fixture for testing Smithers in production. Do not change the binary or unrelated files. Validate the README requirements, local Markdown links, and source-grounded Wiki.\n')
await writeFile(join(output, 'fast.py'), fast)
await writeFile(join(output, 'slow.py'), slow)
await writeFile(join(output, 'manifest.json'), JSON.stringify({ formatVersion: 1, files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, createHash('sha256').update(text).digest('hex')])), setupBytes: Buffer.byteLength(setup) }, null, 2))
console.log(JSON.stringify({ output, files: Object.keys(files), setupBytes: Buffer.byteLength(setup) }))
