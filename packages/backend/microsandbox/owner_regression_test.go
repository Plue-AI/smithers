package microsandbox

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestOwnerFSIdentityEnvelope(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "msb")
	log := filepath.Join(dir, "args")

	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	helper, err := filepath.Abs("guest/smithers-guest.py")
	require.NoError(t, err)
	harness := fmt.Sprintf(`#!%s
import importlib.util,os,sys
spec=importlib.util.spec_from_file_location('guest',%s)
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
with open(%s,'w') as f: f.write('\n'.join(sys.argv[1:])+'\n')
g.os.geteuid=lambda: 0
def drop(user):
 assert user=='agent',user
 with open(%s,'w') as f: f.write(user)
g.drop_to=drop
g.main(sys.argv[sys.argv.index('run')+1:])
`, python, strconv.Quote(helper), strconv.Quote(log), strconv.Quote(filepath.Join(dir, "identity")))
	require.NoError(t, os.WriteFile(binary, []byte(harness), 0700))
	r := &Runtime{cli: &cli{binary: binary, home: dir}, workspaces: map[string]*workspace{"fixture": newWorkspace(metadata{ID: "fixture", Machine: "machine", State: "running"}, "")}}
	_, err = r.fileOperation(t.Context(), "fixture", dir, []byte("bytes"), "write", "file", "600")
	require.NoError(t, err)
	args, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Contains(t, string(args), "fs\nagent\nwrite\n")
	identity, err := os.ReadFile(filepath.Join(dir, "identity"))
	require.NoError(t, err)
	require.Equal(t, guestUser, string(identity))
	content, err := os.ReadFile(filepath.Join(dir, "file"))
	require.NoError(t, err)
	require.Equal(t, "bytes", string(content))
	boundaryPython(t, `
g.os.geteuid=lambda: 0
calls=[]
g.drop_to=lambda user: calls.append(user)
g.fs_write=lambda root,path,mode: calls.append((root,path,mode))
g.main(['fs','agent','write','/workspace','file','600'])
assert calls==['agent',('/workspace','file',0o600)],calls
for user in ('root','other','1500'):
 try: g.main(['fs',user,'write','/workspace','file','600'])
 except SystemExit: pass
 else: raise AssertionError('accepted '+user)
`)
}

func TestOwnerRootRecipeTransport(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "msb")
	log := filepath.Join(dir, "args")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > "+shellQuote(log)+"\ncat >/dev/null\nprintf '\\000SMITHERS-EXIT 0\\000' >&2\n"), 0700))
	e := environments{runtime: &Runtime{cli: &cli{binary: binary, home: dir}}}

	script := rootSyncScript
	_, err := e.runRoot(t.Context(), "machine", script)
	require.NoError(t, err)
	args, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Contains(t, string(args), "root-recipe\n"+scriptDigest(script)+"\n")
	require.NotContains(t, strings.TrimSpace(string(args)), "run\nexec")
	_, err = e.runRoot(t.Context(), "machine", playwrightSystemPackages)
	require.ErrorContains(t, err, "unapproved root recipe")
	_, err = e.runRoot(t.Context(), "machine", "id")
	require.ErrorContains(t, err, "unapproved root recipe")
}

// Root credential and process boundaries are instrumented; these tests never
// execute privileged commands on the host.
func TestOwnerRootRecipeGuestPins(t *testing.T) {
	script := rootSyncScript
	kind := "sync"
	boundaryPython(t, fmt.Sprintf(`
import subprocess
script=%s
digest=%s
scope={}
exec(%s,scope)
g.ROOT_RECIPE_DIGESTS=scope['ROOT_RECIPE_DIGESTS']
assert g.ROOT_RECIPE_DIGESTS[digest]==%s
assert 'apt' not in g.ROOT_RECIPE_DIGESTS.values()
calls=[]
g.os.geteuid=lambda: 0
g.os.write=lambda fd,body: calls.append(('trailer',body))
def run(argv,**kwargs):
 assert g.os.geteuid()==0
 assert argv[:4]==['/bin/bash','-c',script,'root-recipe']
 assert kwargs['env']['PATH']=='/usr/sbin:/usr/bin:/sbin:/bin'
 assert kwargs['env']['PYTHONPATH']==''
 calls.append(argv)
 return types.SimpleNamespace(returncode=0)
subprocess.run=run
request={'script':script}
assert g.run_root_recipe(digest,request)==0
assert len(calls)==2
for d,r in [(g.hashlib.sha256(b'id').hexdigest(),{'script':'id'}),(digest,{'script':'id'}),(digest,dict(request,argv=['id']))]:
 try: g.run_root_recipe(d,r)
 except SystemExit: pass
 else: raise AssertionError('unapproved recipe accepted')
if g.ROOT_RECIPE_DIGESTS[digest]=='sync':
 request['marker']={'kind':'dependencies','key':'a'*64,'name':'layer-fixture'}
 for key,value in [('kind','../../etc'),('key','bad'),('name','../bad')]:
  bad={'script':script,'marker':dict(request['marker'],**{key:value})}
  try: g.run_root_recipe(digest,bad)
  except SystemExit: pass
  else: raise AssertionError('unsafe marker accepted')
for user in ('root','other'):
 try: g.run_exec({'id':'fixture','user':user,'argv':['id']})
 except SystemExit: pass
 else: raise AssertionError('ordinary privileged exec accepted')
`, strconv.Quote(script), strconv.Quote(scriptDigest(script)), strconv.Quote(strings.Split(pinnedGuestBootstrap(), "import os,stat,sys,hashlib,secrets")[0]), strconv.Quote(kind)))
}

func TestOwnerRootRecipeRejectsAlteredPinnedBytesBeforeExecution(t *testing.T) {
	pinned := rootSyncScript
	name := "sync"
	digest := scriptDigest(pinned)
	t.Run(name, func(t *testing.T) {
		sentinel := filepath.Join(t.TempDir(), "executed")
		altered := pinned + "; touch " + shellQuote(sentinel)
		boundaryPython(t, fmt.Sprintf(`
import contextlib,io,json
import subprocess
exec(%s,globals())
g.ROOT_RECIPE_DIGESTS=ROOT_RECIPE_DIGESTS
g.os.geteuid=lambda: 0
g.os.write=lambda fd,body: len(body)
def run(argv,**kwargs):
 if %s in argv[2]: open(%s,'w').close()
 return types.SimpleNamespace(returncode=0)
subprocess.run=run
request={'script':%s}
g.sys.stdin=io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))
stderr=io.StringIO()
try:
 with contextlib.redirect_stderr(stderr): g.main(['root-recipe',%s])
except SystemExit as error:
 assert error.code==125,error.code
else: raise AssertionError('altered pinned recipe accepted')
assert 'root recipe digest mismatch' in stderr.getvalue(),stderr.getvalue()
assert not os.path.exists(%s),'altered recipe executed'

# Matching bytes with an unpinned digest must fail before execution too.
g.sys.stdin=io.TextIOWrapper(io.BytesIO(json.dumps({'script':%s}).encode()))
stderr=io.StringIO()
try:
 with contextlib.redirect_stderr(stderr): g.main(['root-recipe',%s])
except SystemExit as error:
 assert error.code==125,error.code
else: raise AssertionError('unapproved digest accepted')
assert 'unapproved root recipe digest' in stderr.getvalue(),stderr.getvalue()
assert not os.path.exists(%s),'unapproved recipe executed'
	`, strconv.Quote(strings.Split(pinnedGuestBootstrap(), "import os,stat,sys,hashlib,secrets")[0]), strconv.Quote(sentinel), strconv.Quote(sentinel), strconv.Quote(altered), strconv.Quote(digest), strconv.Quote(sentinel), strconv.Quote(pinned), strconv.Quote(strings.Repeat("f", 64)), strconv.Quote(sentinel)))
	})
}

// T-MCH-10 + T-SEC-01: privileged code is pinned; main's package rows are
// positional data. Reject hostile envelopes before any root subprocess starts.
func TestOwnerToolchainRootRecipeValidatedData(t *testing.T) {
	layer := toolchainLayer{Packages: []string{"libssl-dev"}, Postgres: "17"}
	body, err := json.Marshal(map[string]any{"script": toolchainSystemScript, "toolchain": map[string]any{"packages": layer.Packages, "postgres": layer.Postgres, "environment": layer.environment()}})
	require.NoError(t, err)
	boundaryPython(t, fmt.Sprintf(`
import copy, json, subprocess
exec(%s,globals())
g.ROOT_RECIPE_DIGESTS=ROOT_RECIPE_DIGESTS
g.os.geteuid=lambda: 0
g.os.write=lambda fd,body: len(body)
request=json.loads(%s)
digest=%s
calls=[]
def run(argv,**kwargs):
 assert argv[:4]==['/bin/bash','-c',request['script'],'root-recipe']
 assert argv[4]=='17' and argv[6:]==['libssl-dev']
 assert json.loads(argv[5])==request['toolchain']['environment']
 assert kwargs['env']['PATH']=='/usr/sbin:/usr/bin:/sbin:/bin'
 assert kwargs['env']['PYTHONPATH']==''
 assert 'BASH_ENV' not in kwargs['env']
 calls.append(argv)
 return types.SimpleNamespace(returncode=0)
subprocess.run=run
assert g.run_root_recipe(digest,request)==0
assert len(calls)==1
bad=[]
for packages in [['-oRoot::Cmd=id'],['x;id'],['../etc'],['x']*65,'libssl-dev',[1]]:
 r=copy.deepcopy(request); r['toolchain']['packages']=packages; bad.append(r)
for postgres in ['17;id','../etc',17,'123']:
 r=copy.deepcopy(request); r['toolchain']['postgres']=postgres; bad.append(r)
r=copy.deepcopy(request); r['toolchain']['environment']['BASH_ENV']='/workspace/evil'; bad.append(r)
r=copy.deepcopy(request); r['toolchain']['environment']['PATH']='x\n'; bad.append(r)
r=copy.deepcopy(request); r['toolchain']['extra']='id'; bad.append(r)
r=copy.deepcopy(request); r['argv']=['id']; bad.append(r)
r=copy.deepcopy(request); r['script']+='; id'; bad.append(r)
for r in bad:
 try: g.run_root_recipe(digest,r)
 except SystemExit as error: assert error.code==125
 else: raise AssertionError('hostile toolchain accepted')
assert len(calls)==1,'rejected request executed'
`, strconv.Quote(strings.Split(pinnedGuestBootstrap(), "import os,stat,sys,hashlib,secrets")[0]), strconv.Quote(string(body)), strconv.Quote(scriptDigest(toolchainSystemScript))))
}
