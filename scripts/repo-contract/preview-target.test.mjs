import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '../..');
test('backendGo runs the main suite after a failed scoped preview suite and reports both', () => {
  const source = readFileSync(join(root,'PACKAGE.ts'),'utf8').split('const backendGo =')[1];
  const shell = JSON.parse(source.match(/shell:\s*("(?:[^"\\]|\\.)*")/)[1]);
  const directory = mkdtempSync(join(tmpdir(),'preview-go-'));
  try {
    const calls = join(directory,'calls');
    writeFileSync(join(directory,'go'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\ncase "$*" in *smithers_preview*) echo "--- FAIL: TestPreviewFixture"; exit 9;; esac\necho main-suite-ran\n', {mode:0o755});
    const result = spawnSync('bash',['-c',shell.slice(shell.indexOf('log=$(mktemp)'))],{encoding:'utf8',env:{...process.env,PATH:`${directory}:${process.env.PATH}`,CALLS:calls}});
    assert.equal(result.status,9,result.stdout+result.stderr);
    assert.match(result.stdout,/main-suite-ran/);
    assert.match(result.stderr,/TestPreviewFixture/);
    const commands = readFileSync(calls,'utf8').trim().split('\n');
    assert.equal(commands.length,2);
    assert.match(commands[0],/-count=1 -tags smithers_preview -run \^TestPreview .*internal\/services/);
    assert.doesNotMatch(commands[1],/distribution/);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
test('preview shell acceptance works without ripgrep and requires clean SIGTERM shutdown', () => {
  const directory = mkdtempSync(join(tmpdir(),'preview-shell-'));
  try {
    mkdirSync(join(directory,'bin'));
    const docker = `#!/bin/sh
case "$1 $2" in
'image inspect') case "$3" in --format) echo 1000000;; *) printf '%s\\n' '[{"Config":{"Env":[],"Labels":{"org.opencontainers.image.revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}]';; esac;;
'history --no-trunc') echo 'ARG BUILD_SHA';;
'run -d') echo fixture;;
'inspect --format') case "$3" in *HostIp*) echo 127.0.0.1;; *ExitCode*) echo 0;; esac;;
'inspect smithers-preview-'*) echo '[{"Config":{"Env":[]}}]';;
'exec '*) case "$3" in id) echo 1000;; cat) case "$4" in /proc/1/status) printf 'Uid:\\t1000 1000 1000 1000\\n';; *) echo '0: 00000000:1F90 00000000:0000 0A';; esac;; esac;;
'stop -t') exit 0;;
esac
`;
    writeFileSync(join(directory,'bin/docker'),docker,{mode:0o755});
    writeFileSync(join(directory,'bin/curl'),`#!/bin/sh
case "$*" in *api/bootstrap*) echo '{"capabilities":["install"]}';; *workspaces*) while [ "$1" != --output ]; do shift; done; printf '%s' '{"code":"machines_disabled","message":"Machines are off in this preview."}' > "$2"; printf 503;; *readyz*) exit 0;; *) echo '<html></html>';; esac
`,{mode:0o755});
    // The source contract guards against accidentally relying on the host's rg.
    assert.doesNotMatch(readFileSync(join(root,'distribution/test-preview.sh'),'utf8'),/\brg\b/);
    const result=spawnSync('bash',[join(root,'distribution/test-preview.sh')],{encoding:'utf8',env:{...process.env,PATH:`${directory}/bin:${process.env.PATH}`,SMITHERS_DOCKER_SKIP_BUILD:'1',SMITHERS_BUILD_SHA:'a'.repeat(40)}});
    assert.equal(result.status,0,result.stdout+result.stderr);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
test('release never publishes the preview image',()=>assert.doesNotMatch(readFileSync(join(root,'.github/workflows/release.yml'),'utf8'),/publish-image|distribution-image-tag|test-image/));

test('preview image bounds shutdown and protects context secrets', () => {
  const dockerfile=readFileSync(join(root,'distribution/Dockerfile'),'utf8');
  assert.match(dockerfile,/STOPSIGNAL SIGTERM/);
  assert.match(dockerfile,/SMITHERS_SERVER_SHUTDOWN_TIMEOUT=5s/);
  assert.doesNotMatch(dockerfile,/\$\$\{PORT/);
  const script=readFileSync(join(root,'distribution/test-preview.sh'),'utf8');
  assert.match(script,/State.ExitCode.* = 0/);
  assert.match(script,/Date.now\(\)/);
  const ignored=readFileSync(join(root,'.dockerignore'),'utf8').split('\n');
  for (const pattern of ['.env','.env.*','**/.dev.vars']) assert.ok(ignored.includes(pattern));
});
