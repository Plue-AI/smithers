import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
if (!process.argv[2]) throw Error('Pass the directory for the canary setup artifact')
const output = resolve(process.argv[2])
await mkdir(output, { recursive: true })
// The coding host ships every coding route as a built-in (`provisionBuiltins`),
// so the canary installs only its checks and project file, never coding code.
const files = {}
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
const setup = `# Smithers coding canary setup: explicit documentation checks; the host serves every coding route.\npython3 - <<'SMITHERS_CANARY_SETUP'\nimport base64,gzip,json,pathlib\nroot=pathlib.Path.cwd()\nif not (root/'README.md').read_text().startswith('# canary-sandbox\\n'): raise RuntimeError('Wrong repository: refusing canary setup')\nfiles=json.loads(gzip.decompress(base64.b64decode('${payload}')))\nfor name,content in files.items():\n path=root/name\n if path.exists() and path.read_text()!=content: raise RuntimeError('Existing setup differs: '+name)\nfor name,content in files.items():\n path=root/name\n path.parent.mkdir(parents=True,exist_ok=True)\n path.write_text(content)\nSMITHERS_CANARY_SETUP\n`
await writeFile(join(output, 'setup.sh'), setup)
await writeFile(join(output, 'task.txt'), 'Preserve the existing README title and introduction. Add a ## Purpose section explaining that this repository is a disposable fixture for testing Smithers in production. Do not change the binary or unrelated files. Validate the README requirements, local Markdown links, and source-grounded Wiki.\n')
await writeFile(join(output, 'fast.py'), fast)
await writeFile(join(output, 'slow.py'), slow)
await writeFile(join(output, 'manifest.json'), JSON.stringify({ formatVersion: 1, files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, createHash('sha256').update(text).digest('hex')])), setupBytes: Buffer.byteLength(setup) }, null, 2))
console.log(JSON.stringify({ output, files: Object.keys(files), setupBytes: Buffer.byteLength(setup) }))
