package microsandbox

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/stretchr/testify/require"
)

// Account/root/tmpfs observations and the broker launch are simulated. Actual
// descriptor walks, file modes, locks, digest checks and replacements execute
// as this non-root test user; this is not a real-VM acceptance receipt.
func TestMachinedRootPlantInputs(t *testing.T) {
	// Drive production startup before the supplemental filesystem inventory.
	// No approved bundle means no CLI or root-side effect may be reached.
	r := &Runtime{workspaces: map[string]*workspace{"a": newWorkspace(metadata{ID: "a", Machine: "vm", State: "running"}, "")}}
	require.ErrorIs(t, r.EnsureMachined(t.Context(), "a"), ErrUnavailable)
	require.Nil(t, r.workspaces["a"].daemonBoot)

	require.NotZero(t, os.Geteuid())
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	script := `import importlib.util,os,stat,sys,tempfile,types,subprocess,hashlib
spec=importlib.util.spec_from_file_location("g",sys.argv[1]);g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
messages=[]
real_fail=g.fail
def recorded_fail(code,message):
 messages.append(message);real_fail(code,message)
g.fail=recorded_fail
# The fixture models root-protected ancestors independently of the host umask.
os.umask(0o022)
with tempfile.TemporaryDirectory() as root:
 root=os.path.realpath(root);g.PROTECTED_BASE=root
 os.makedirs(root+"/var/lib");os.chmod(root,0o700)
 # Positive controls must retain protected modes under a group-writable umask.
 for directory in (root+"/var",root+"/var/lib"):os.chmod(directory,0o755)
 real_open,real_stat,real_fstat=os.open,os.stat,os.fstat
 owners={}
 def observed(info):
  uid,gid=owners.get((info.st_dev,info.st_ino),(0,0))
  return types.SimpleNamespace(st_uid=uid,st_gid=gid,st_mode=info.st_mode,st_nlink=info.st_nlink,st_size=info.st_size,st_dev=info.st_dev,st_ino=info.st_ino)
 def chown(fd,uid,gid):
  info=real_fstat(fd);owners[(info.st_dev,info.st_ino)]=(uid,gid)
 os.open=lambda p,*a,**kw:real_open(root if p=="/" else p,*a,**kw)
 os.stat=lambda *a,**kw:observed(real_stat(*a,**kw));os.fstat=lambda fd:observed(real_fstat(fd));os.fchown=chown
 os.geteuid=lambda:0;g.require_secret_tmpfs=lambda fd:None;g.secret_team=lambda:20000;g.prepare_system_identity=lambda:None;g.time.sleep=lambda n:None
 calls=[]
 def launch(argv,**kw):
  calls.append((argv,kw));return types.SimpleNamespace(poll=lambda:None)
 subprocess.Popen=launch
 program=bytearray(64);program[:6]=b'\x7fELF\x02\x01';program[18:20]=(183).to_bytes(2,'little');program=bytes(program)
 digest=hashlib.sha256(program).hexdigest()
 body=b'boot_id='+b'01'*16+b'\nrelay_secret='+b'02'*32+b'\ncredential='+b'03'*32+b'\ntopology=relay\n'
 for bad in [b'',b'x'*4097,body+b'credential=other\n',body.replace(b'relay',b'bridge'),body+b'executable=/workspace/a\n',body+b'\x00',body.replace(b'01',b'GG')]:
  try:g.machined_boot_body(bad)
  except SystemExit as error:assert error.code==3 and messages[-1]=='invalid machined boot authority',messages
  else:raise AssertionError('invalid authority accepted')
 assert not calls and not os.path.exists(root+'/run')
 assert not g.machined_program(digest)
 for mode in (0o775,0o757):
  os.chmod(root,mode)
  try:g.machined_program(digest,program)
  except SystemExit as error:assert error.code==3 and messages[-1]=='protected directory is not root-owned and protected',messages
  else:raise AssertionError('writable protected ancestor accepted')
  assert not calls
 os.chmod(root,0o700)
 g.machined_program(digest,program);assert g.machined_program(digest)
 assert g.start_machined(digest,body)=='started'
 assert len(calls)==1 and calls[0][0]==['/opt/smithers/bin/smithers-machined','broker']
 assert calls[0][1]['cwd']=='/' and calls[0][1]['env']=={'PATH':'/usr/bin:/bin','HOME':'/'}
 assert open(root+'/run/smithers/machined/boot','rb').read()==body
 assert stat.S_IMODE(real_stat(root+'/run/smithers/machined/boot').st_mode)==0o400
 assert open(root+'/run/smithers/env','rb').read()==b'{}'
 def locked(fd,op):raise BlockingIOError()
 g.fcntl.flock=locked
 assert g.start_machined(digest,body)=='current' and len(calls)==1
 try:g.machined_program(digest,program)
 except SystemExit as error:assert error.code==3 and messages[-1]=='machined update requires a stopped broker',messages
 else:raise AssertionError('serving executable replaced')
 try:g.start_machined(digest,body.replace(b'01',b'04'))
 except SystemExit as error:assert error.code==3 and messages[-1]=='serving machined boot differs from host authority',messages
 else:raise AssertionError('serving authority replaced')
 assert open(root+'/run/smithers/machined/boot','rb').read()==body and len(calls)==1
 os.geteuid=lambda:20001
 try:g.start_machined(digest,body)
 except SystemExit as error:assert error.code==3 and messages[-1]=='machined startup requires root',messages
 else:raise AssertionError('member started root broker')
`
	out, err := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py")).CombinedOutput()
	require.NoError(t, err, string(out))
}

// Supplemental startup inventory: remove each host provider independently on
// fresh and retained boots. No guest CLI is installed, so reaching a helper,
// planting a binary or starting a privileged process would panic.
func TestMachinedStartupProvidersFailClosed(t *testing.T) {
	for _, retained := range []bool{false, true} {
		for _, missing := range []string{"bundle", "branch head", "item binding", "durable event consumer"} {
			t.Run(fmt.Sprintf("retained=%t/%s", retained, missing), func(t *testing.T) {
				r := &Runtime{config: Config{Bundle: &installbundle.Bundle{}}, workspaces: map[string]*workspace{"a": newWorkspace(metadata{ID: "a", Machine: "vm", State: "running"}, "")}}
				r.BindMachinedHost(func(context.Context, string) (string, error) {
					t.Fatal("head lookup before prerequisite checks")
					return strings.Repeat("1", 40), nil
				})
				r.BindMachinedItem(func(context.Context, string) (machined.ItemBinding, error) {
					t.Fatal("item lookup before prerequisite checks")
					return machined.ItemBinding{}, nil
				})
				if missing != "durable event consumer" {
					stop, err := r.machined.ConsumeEvents(t.Context(), func(context.Context, *machined.Link, string, machined.Event) (machined.Acknowledgement, error) {
						t.Fatal("event dispatch before admission")
						return machined.Acknowledgement{}, nil
					})
					require.NoError(t, err)
					t.Cleanup(stop)
				}
				switch missing {
				case "bundle":
					r.config.Bundle = nil
				case "branch head":
					r.machinedHead = nil
				case "item binding":
					r.machinedItem = nil
				}
				if retained {
					authority, err := r.machined.MintBoot("a", "vm")
					require.NoError(t, err)
					r.workspaces["a"].daemonBoot = &authority
				}
				before := r.workspaces["a"].daemonBoot
				err := r.EnsureMachined(t.Context(), "a")
				require.ErrorIs(t, err, ErrUnavailable)
				require.Equal(t, "microVM isolation is unavailable: installed machine host providers unavailable", err.Error())
				require.Same(t, before, r.workspaces["a"].daemonBoot)
				_, err = r.machined.Current("a")
				require.Error(t, err)
			})
		}
	}
}

func TestMachinedCancelledStartupDoesNotMintBoot(t *testing.T) {
	for _, retained := range []bool{false, true} {
		t.Run(fmt.Sprintf("retained=%t", retained), func(t *testing.T) {
			r := &Runtime{workspaces: map[string]*workspace{"a": newWorkspace(metadata{ID: "a", Machine: "vm", State: "running"}, "")}}
			if retained {
				authority, err := r.machined.MintBoot("a", "vm")
				require.NoError(t, err)
				r.workspaces["a"].daemonBoot = &authority
			}
			before := r.workspaces["a"].daemonBoot
			ctx, cancel := context.WithCancel(t.Context())
			cancel()
			require.ErrorIs(t, r.EnsureMachined(ctx, "a"), context.Canceled)
			require.Same(t, before, r.workspaces["a"].daemonBoot)
			_, err := r.machined.Current("a")
			require.Error(t, err)
		})
	}
}

// The root helper admits the boot file EnsureMachined writes, byte for byte:
// the daemon's parser (crates/smithers-machined/src/boot.rs) accepts the same
// item fields. A refusal here means no daemon starts in any real machine.
func TestGuestMachinedBootAdmitsHostItemBindings(t *testing.T) {
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	check := func(body []byte) ([]byte, error) {
		cmd := exec.Command(python, "-B", "-c", `import importlib.util,sys
spec=importlib.util.spec_from_file_location("g",sys.argv[1]);g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
g.machined_boot_body(sys.stdin.buffer.read())`, filepath.Join("guest", "smithers-guest.py"))
		cmd.Stdin = strings.NewReader(string(body))
		return cmd.CombinedOutput()
	}
	authority := machined.BootAuthority{ID: [16]byte{1}, Secret: [32]byte{2}, Credential: strings.Repeat("03", 32)}
	change, commit := strings.Repeat("k", 32), strings.Repeat("a", 40)
	for name, item := range map[string]machined.ItemBinding{
		"scratch": {}, "item": {Number: 7, Change: change}, "largest item": {Number: 1<<64 - 1, Change: strings.Repeat("z", 32)},
		"moved off": {Number: 7, Change: change, PreMoveCommit: commit},
	} {
		body, err := authority.FileForItem(0, item)
		require.NoError(t, err, name)
		out, err := check(body)
		require.NoError(t, err, "%s: %s", name, out)
	}
	for _, fields := range []string{
		"item_number=7\n", "item_change=" + change + "\n", "item_number=0\nitem_change=" + change + "\n",
		"item_number=7\nitem_change=main\n", "item_number=07\nitem_change=" + change + "\n",
		"item_number=18446744073709551616\nitem_change=" + change + "\n", "item_number=-1\nitem_change=" + change + "\n",
		"moved_off=" + commit + "\n", "item_number=0\nmoved_off=" + commit + "\n",
		"item_number=7\nitem_change=" + change + "\nmoved_off=" + strings.Repeat("A", 40) + "\n",
		"item_number=7\nitem_change=" + change + "\nitem_number=7\n", "item_number=0\nexecutable=/workspace/a\n",
	} {
		out, err := check(append(authority.File(0), fields...))
		require.Error(t, err, fields)
		require.Contains(t, string(out), "invalid machined boot authority", fields)
	}
}
