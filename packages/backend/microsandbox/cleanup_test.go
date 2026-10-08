package microsandbox

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

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
		require.ErrorIs(t, r.WriteFile(t.Context(), ws.ID, "late", []byte("lost"), 0600), workspaceapi.ErrCleanupBusy)
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
	boundaryPython(t, `
import contextlib,io,pathlib
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);store=root/'store';writers=root/'writers'
 store.mkdir();writers.mkdir();(writers/'cgroup.events').write_text('populated 0\nfrozen 1\n')
 g.ROOT_UID=os.geteuid()
 @contextlib.contextmanager
 def coordinator(exclusive=False):
  assert exclusive
  fd=os.open(store,os.O_RDONLY|os.O_DIRECTORY)
  try:yield fd
  finally:os.close(fd)
 g.writer_coordinator=coordinator
 calls=[]
 def safe(path,**kwargs):
  assert path==g.CGROUP_ROOT and kwargs=={'trusted':True,'create':False}
  return os.open(writers,os.O_RDONLY|os.O_DIRECTORY)
 g.safe_directory=safe
 def freeze(fd,value):calls.append(value)
 g.mutation_freeze=freeze
 g.os.sync=lambda:calls.append('sync')
 original_read=g.os.read
 release=b'R'
 def read(fd,n):
  if fd==0:
   assert n==1 and calls==[True,'sync'],'writers released before final capture'
   return release
  return original_read(fd,n)
 g.os.read=read
 g.select.select=lambda *args:([0],[],[])
 output=io.StringIO();g.sys.stdout=output
 g.final_capture_fence()
 assert output.getvalue()=='FENCED\n' and calls==[True,'sync',False]
 calls.clear();release=b''
 try:g.final_capture_fence();raise AssertionError('disconnected fence accepted')
 except SystemExit as error:assert error.code==125
 assert calls==[True,'sync',False]
 calls.clear();(writers/'cgroup.events').write_text('populated 1\nfrozen 1\n')
 try:g.final_capture_fence();raise AssertionError('active writer accepted')
 except SystemExit as error:assert error.code==125
 assert calls==[True,False]
 calls.clear();(store/'pending').symlink_to(root/'branch-journal')
 try:g.final_capture_fence();raise AssertionError('pending recovery accepted')
 except SystemExit as error:assert error.code==125
 assert calls==[]
`)
}
