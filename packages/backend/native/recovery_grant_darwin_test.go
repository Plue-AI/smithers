//go:build darwin

package native

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/postgres"
	"github.com/stretchr/testify/require"
)

// PID reuse: the operation that wrote the grant has exited, and the system
// later gives its PID to another program. That program is alive, so the PID
// alone would satisfy the grant; its start time is its own, so it does not.
// The control is the same live process with its true start time.
func TestRecoveryGrantDoesNotSurvivePIDReuse(t *testing.T) {
	root, backup := incompleteInstall(t, currentRelease(t))
	refusal := "upgrade incomplete; keep the app stopped; smthrs host restore " + backup
	grant := func(pid int, birth string) {
		t.Helper()
		raw, err := json.Marshal(recoveryGrant{Backup: backup, PID: pid, Birth: birth})
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(root, recoveryGrantPath), raw, 0600))
	}
	refused := func(why string) {
		t.Helper()
		require.False(t, recoveryStartGranted(root, backup), why)
		reached, err := reachesPostgres(t, root)
		require.False(t, reached, why)
		require.EqualError(t, err, refusal, why)
	}

	// The operation: it wrote the grant with its PID and start time, then died.
	operation := exec.Command("/bin/sleep", "60")
	require.NoError(t, operation.Start())
	operationBirth, err := postgres.ProcessBirth(operation.Process.Pid)
	require.NoError(t, err)
	require.NoError(t, operation.Process.Kill())
	_ = operation.Wait()

	// Another program, alive now. The grant below carries its PID, as it
	// would had the system reused the operation's.
	other := exec.Command("/bin/sleep", "60")
	require.NoError(t, other.Start())
	reaped := false
	defer func() {
		if !reaped {
			_ = other.Process.Kill()
			_ = other.Wait()
		}
	}()
	pid := other.Process.Pid
	otherBirth, err := postgres.ProcessBirth(pid)
	require.NoError(t, err)
	require.NotEqual(t, operationBirth, otherBirth)

	grant(pid, operationBirth)
	refused("the PID is alive but started at another time")

	// The start time is compared exactly, to the microsecond.
	var seconds, microseconds int64
	_, err = fmt.Sscanf(otherBirth, "darwin:%d:%d", &seconds, &microseconds)
	require.NoError(t, err, "start times are darwin:<seconds>:<microseconds> on macOS")
	for _, birth := range []string{
		fmt.Sprintf("darwin:%d:%d", seconds, microseconds+1),
		fmt.Sprintf("darwin:%d:%d", seconds, microseconds-1),
		fmt.Sprintf("darwin:%d:%d", seconds+1, microseconds),
		fmt.Sprintf("darwin:%d:%d", seconds-1, microseconds),
		fmt.Sprintf("darwin:%d:0%d", seconds, microseconds),
		fmt.Sprintf("linux:%d", seconds),
		otherBirth + " ",
	} {
		grant(pid, birth)
		refused("start time " + birth + " is not the live process's " + otherBirth)
	}

	// Control: the same PID with its true start time is that process.
	grant(pid, otherBirth)
	require.True(t, recoveryStartGranted(root, backup))
	reached, err := reachesPostgres(t, root)
	require.True(t, reached, err)

	// Killed and not yet reaped, the process still holds its PID and start
	// time in the process table. It is not alive, and the grant is void.
	require.NoError(t, other.Process.Kill())
	require.Eventually(t, func() bool { return !recoveryStartGranted(root, backup) }, 5*time.Second, 5*time.Millisecond)
	refused("the PID is a zombie")
	_ = other.Wait()
	reaped = true
	refused("the PID has exited")
}
