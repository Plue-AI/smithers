package microsandbox

import (
	"github.com/stretchr/testify/require"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestSecretScanTreatsHostilePathsAsData(t *testing.T) {
	require.NotZero(t, os.Geteuid())
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	code := `import importlib.util,json,os,sys,tempfile
spec=importlib.util.spec_from_file_location("g",sys.argv[1]);g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
with tempfile.TemporaryDirectory() as base:
 root=base+"/guest";os.mkdir(root)
 outside=base+"/canary";open(outside,"w").write("M"*40)
 os.symlink(outside,root+"/secret-link");os.symlink(base,root+"/parent-link");os.mkfifo(root+"/fifo")
 path=root+"/$(touch root-canary).py";open(path,"w").write("A"*40+"\\nraise Exception('never execute')")
 open(root+"/boundary","wb").write(b'x'*(1024*1024-20)+b'A'*40)
 result=g.scan_secret_sentinels(json.dumps({"ALL":"A"*40,"MAIN":"M"*40}),roots=(root,))
 assert result['files']==2 and not result['failures'],result
 assert [x['label'] for x in result['hits']]==['ALL','ALL'],result
 assert open(outside).read()=="M"*40
 assert not os.path.exists(root+"/root-canary")
 assert "A"*40 not in json.dumps(result)
 try:g.scan_secret_sentinels('{"ALL":"short"}',roots=(root,));raise AssertionError('accepted malformed sentinel')
 except SystemExit:pass
`
	output, err := exec.Command(python, "-B", "-c", code, filepath.Join("guest", "smithers-guest.py")).CombinedOutput()
	require.NoError(t, err, string(output))
}
