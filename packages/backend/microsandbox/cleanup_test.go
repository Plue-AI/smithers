package microsandbox

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestFinalCaptureGuestRefusalPreservesReason(t *testing.T) {
	for _, active := range []bool{true, false} {
		t.Run(fmt.Sprint(active), func(t *testing.T) {
			r, _ := reclaimFakeMSB(t, 0)
			ws := addReclaimWorkspace(t, r, "capture", string(workspaceapi.WorkspaceRunning), "")
			message := "workspace mutation recovery required"
			if active {
				message = "active writer blocks final capture"
			}
			script := "#!/bin/sh\nprintf 'smithers-guest: " + message + "\\nextra\\tcontext\\n' >&2\nexit 125\n"
			require.NoError(t, os.WriteFile(r.cli.binary, []byte(script), 0700))
			err := r.WithCaptureWritersExcluded(t.Context(), ws.ID, func(context.Context) error {
				t.Fatal("refused fence must not capture or stop")
				return nil
			})
			require.ErrorContains(t, err, "smithers-guest: "+message+" extra context")
			require.NotContains(t, err.Error(), "\n")
			require.False(t, errors.Is(err, ErrUnavailable))
			require.Equal(t, active, errors.Is(err, workspaceapi.ErrCaptureWritersActive))
			require.Equal(t, string(workspaceapi.WorkspaceRunning), ws.State)
		})
	}
}

func TestFinalCaptureGuestDiagnosticIsBounded(t *testing.T) {
	r, _ := reclaimFakeMSB(t, 0)
	ws := addReclaimWorkspace(t, r, "capture", string(workspaceapi.WorkspaceRunning), "")
	script := "#!/bin/sh\nprintf '" + strings.Repeat("x", 8192) + "' >&2\nexit 125\n"
	require.NoError(t, os.WriteFile(r.cli.binary, []byte(script), 0700))
	err := r.WithCaptureWritersExcluded(t.Context(), ws.ID, func(context.Context) error { t.Fatal("capture admitted"); return nil })
	require.Error(t, err)
	require.Less(t, len(err.Error()), 4200)
}

func TestFinalCaptureMicroVMRequiresCurrentStoppedInventory(t *testing.T) {
	for _, tc := range []struct {
		name, status    string
		reclaimed, want bool
	}{
		{"stopped", "stopped", false, true},
		{"running", "running", false, false},
		{"missing", "", false, false},
		{"removed retry", "", true, true},
		{"unavailable", "unavailable", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _ := reclaimFakeMSB(t, 0)
			ws := addReclaimWorkspace(t, r, "capture", string(workspaceapi.WorkspaceStopped), "")
			ws.Reclaimed = tc.reclaimed
			body := "echo '[]'"
			if tc.status != "" {
				body = fmt.Sprintf("echo '[{\"name\":%q,\"status\":%q}]'", ws.Machine, tc.status)
			}
			if tc.status == "unavailable" {
				body = "exit 1"
			}
			require.NoError(t, os.WriteFile(r.cli.binary, []byte("#!/bin/sh\n"+body+"\n"), 0700))
			called := false
			err := r.WithCaptureWritersExcluded(t.Context(), ws.ID, func(context.Context) error { called = true; return nil })
			require.Equal(t, tc.want, called)
			if tc.want {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
			}
		})
	}
}

func TestFinalCaptureMicroVMAdapterExcludesUntilConfirmedStop(t *testing.T) {
	r, _ := reclaimFakeMSB(t, 0)
	ws := addReclaimWorkspace(t, r, "capture", string(workspaceapi.WorkspaceRunning), "")
	require.NoError(t, os.WriteFile(r.cli.binary, []byte("#!/bin/sh\ncase \"$1\" in\nexec) printf 'FENCED\\n'; dd bs=1 count=1 of=/dev/null 2>/dev/null;;\nlist) echo '[]';;\nesac\n"), 0700))
	err := r.WithCaptureWritersExcluded(t.Context(), ws.ID, func(ctx context.Context) error {
		_, err := r.StartWorkspace(t.Context(), ws.ID)
		require.ErrorIs(t, err, workspaceapi.ErrCleanupBusy)
		_, writeErr := r.CompareWriteFiles(t.Context(), ws.ID, []workspaceapi.FileMutation{{Path: "late", BaseDigest: "absent", Content: []byte("lost")}})
		require.ErrorIs(t, writeErr, workspaceapi.ErrCleanupBusy)
		require.NoError(t, r.StopWorkspace(ctx, ws.ID))
		return r.ReclaimWorkspaceDisk(ctx, ws.ID)
	})
	require.NoError(t, err)
	require.True(t, readReclaimMetadata(t, ws).Reclaimed)
}

func TestFinalCaptureMicroVMAdapterRefusesBadHandshakeAndCancellation(t *testing.T) {
	for _, mode := range []string{"bad", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			r, _ := reclaimFakeMSB(t, 0)
			ws := addReclaimWorkspace(t, r, "capture", string(workspaceapi.WorkspaceRunning), "")
			script := "#!/bin/sh\nprintf 'INVALID'\n"
			if mode == "cancel" {
				script = "#!/bin/sh\nexec /bin/sleep 5\n"
			}
			require.NoError(t, os.WriteFile(r.cli.binary, []byte(script), 0700))
			ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
			defer cancel()
			err := r.WithCaptureWritersExcluded(ctx, ws.ID, func(context.Context) error { t.Error("unconfirmed fence admitted capture"); return nil })
			require.Error(t, err)
			if mode == "cancel" {
				require.True(t, errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrUnavailable))
			}
			require.False(t, ws.Reclaimed)
			require.Equal(t, string(workspaceapi.WorkspaceRunning), ws.State)
		})
	}
}

// Supplemental fixed-input helper evidence. This does not qualify kernel
// cgroups or the real cleanup/broker security boundary on the reference mini.
func TestGuestFinalCaptureFenceFixedInputsAndFailureSupplemental(t *testing.T) {
	for _, scenario := range []string{"normal", "unknown_live", "root_live", "daemon_agent", "broker_agent", "wrong_binary", "control_child", "unreadable", "symlink", "pending", "disconnect", "freeze_failure", "thaw_failure", "new_child", "late_root_writer", "oversized", "malformed_uid", "missing_process", "missing_sessions"} {
		t.Run(scenario, func(t *testing.T) {
			boundaryPython(t, "scenario="+fmt.Sprintf("%q", scenario)+`

import contextlib,io,pathlib
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);store=root/'store';writers=root/'writers';proc=root/'proc'
 store.mkdir();writers.mkdir();proc.mkdir()
 (writers/'cgroup.procs').write_text('')
 # The real parent stays populated because of the control processes.
 (writers/'cgroup.events').write_text('populated 1\nfrozen 0\n')
 def group(name,populated=0,pids=''):
  child=writers/name;child.mkdir(mode=0o755)
  (child/'cgroup.procs').write_text(pids)
  (child/'cgroup.events').write_text('populated %d\nfrozen 0\n'%populated)
  (child/'cgroup.freeze').write_text('0')
  return child
 group('sessions');group('x123');group('unknown')
 group('broker',1,'353\n');group('daemon',1,'753\n')
 for pid,uid in [('353',0),('753',19998)]:
  child=proc/pid;child.mkdir()
  (child/'status').write_text('Name:\tsmithers-machin\nUid:\t%d\t%d\t%d\t%d\n'%((uid,)*4))
  (child/'exe').symlink_to('/opt/smithers/bin/smithers-machined')
 if scenario=='unknown_live':(writers/'unknown/cgroup.events').write_text('populated 1\nfrozen 0\n')
 if scenario=='root_live':(writers/'cgroup.procs').write_text('999\n')
 if scenario in ('daemon_agent','broker_agent'):
  (proc/('753' if scenario=='daemon_agent' else '353')/'status').write_text('Uid:\t19999\t19999\t19999\t19999\n')
 if scenario=='wrong_binary':
  (proc/'353/exe').unlink();(proc/'353/exe').symlink_to('/workspace/hostile')
 if scenario=='control_child':(writers/'daemon/hidden').mkdir()
 if scenario=='unreadable':(writers/'unknown/cgroup.events').unlink()
 if scenario=='symlink':(writers/'hidden').symlink_to(writers/'sessions',target_is_directory=True)
 if scenario=='pending':(store/'pending').symlink_to(root/'branch-journal')
 if scenario=='oversized':(writers/'unknown/cgroup.events').write_text('populated 0\nfrozen 0\n'+'x'*4097)
 if scenario=='malformed_uid':(proc/'753/status').write_text('Uid:\t19998\n')
 if scenario=='missing_process':(proc/'753/status').unlink()
 if scenario=='missing_sessions':
  import shutil
  shutil.rmtree(writers/'sessions')
 g.ROOT_UID=os.geteuid()
 @contextlib.contextmanager
 def coordinator(exclusive=False):
  assert exclusive
  fd=os.open(store,os.O_RDONLY|os.O_DIRECTORY)
  try:yield fd
  finally:os.close(fd)
 g.writer_coordinator=coordinator
 def safe(path,**kwargs):
  assert path==g.CGROUP_ROOT and kwargs=={'trusted':True,'create':False}
  return os.open(writers,os.O_RDONLY|os.O_DIRECTORY)
 g.safe_directory=safe
 original_open=os.open
 def open_fixture(path,*args,**kwargs):
  if isinstance(path,str) and path.startswith('/proc/'):
   path=str(proc/path.removeprefix('/proc/'))
  return original_open(path,*args,**kwargs)
 g.os.open=open_fixture
 calls=[];syncs=[]
 original_freeze=g.mutation_freeze
 def fdpath(fd):
  # The fixture names a directory descriptor: /proc on Linux, F_GETPATH on Darwin.
  if sys.platform=='darwin':
   import fcntl
   return pathlib.Path(fcntl.fcntl(fd,fcntl.F_GETPATH,bytes(1024)).split(b'\0',1)[0].decode())
  return pathlib.Path(os.readlink('/proc/self/fd/%d'%fd))
 def freeze(fd,value):
  child=fdpath(fd);name=child.name
  assert name not in ('writers','broker','daemon'),'control process frozen'
  calls.append((name,value))
  if value and scenario=='new_child' and name=='sessions':group('arriving')
  if value and scenario=='late_root_writer':(writers/'cgroup.procs').write_text('999\n')
  if value and scenario=='freeze_failure' and name=='unknown':raise OSError('freeze failed')
  if not value and scenario=='thaw_failure' and name=='unknown':raise OSError('thaw failed')
  events=child/'cgroup.events'
  if events.exists():
   text=events.read_text();text=text.replace('frozen %d'%(not value),'frozen %d'%value);events.write_text(text)
  original_freeze(fd,value)
 g.mutation_freeze=freeze
 g.os.sync=lambda:syncs.append('sync')
 original_read=g.os.read
 def read(fd,n):
  if fd==0:
   assert n==1 and syncs==['sync']
   assert calls==[('sessions',True),('unknown',True),('x123',True)]
   assert (writers/'broker/cgroup.freeze').read_text()=='0'
   assert (writers/'daemon/cgroup.freeze').read_text()=='0'
   return b'' if scenario=='disconnect' else b'R'
  return original_read(fd,n)
 g.os.read=read
 g.select.select=lambda *args:([0],[],[])
 output=io.StringIO();g.sys.stdout=output
 success=scenario=='normal'
 try:
  g.final_capture_fence()
  assert success,'unsafe capture admitted: '+scenario
 except (SystemExit,OSError) as error:
  assert not success,(scenario,error)
  if isinstance(error,SystemExit):assert error.code==125
 assert [name for name,value in calls if not value]==list(reversed([name for name,value in calls if value])),calls
 if calls:assert calls[0]==('sessions',True),calls
 if scenario in ('normal','disconnect','thaw_failure'):
  assert output.getvalue()=='FENCED\n'
 else:assert output.getvalue()==''
`)
		})
	}
}
