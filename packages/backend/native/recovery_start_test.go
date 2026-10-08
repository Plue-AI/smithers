package native

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/compose"
	"github.com/smithersai/smithers/packages/backend/postgres"
	"github.com/stretchr/testify/require"
)

// reachesPostgres runs a start whose PostgreSQL programs are missing. A start
// the guards allow fails at "start owned postgres"; a refused one never gets
// there.
func reachesPostgres(t *testing.T, root string) (bool, error) {
	t.Helper()
	err := Run(context.Background(), Config{Postgres: postgres.Config{StateDir: filepath.Join(root, "postgres"), BinDir: filepath.Join(root, "missing-tools"), Major: 18}})
	require.Error(t, err)
	return strings.Contains(err.Error(), "start owned postgres"), err
}

// incompleteInstall is a state root whose marker records backup.
func incompleteInstall(t *testing.T, state Version) (root, backup string) {
	t.Helper()
	root = t.TempDir()
	require.NoError(t, WriteVersion(root, state))
	backup = filepath.Join(root, "backups", "1.2.3-20261007T010203.000000000Z")
	require.NoError(t, os.MkdirAll(backup, 0700))
	require.NoError(t, os.WriteFile(filepath.Join(root, ".upgrade-incomplete"), []byte(backup+"\n"), 0600))
	return root, backup
}

func currentRelease(t *testing.T) Version {
	t.Helper()
	head, err := product.HeadVersion()
	require.NoError(t, err)
	return Version{compose.BuildVersion, fmt.Sprint(head), "18"}
}

// A start runs while an upgrade or restore is incomplete only under that
// operation's own grant, and only while the operation's process is alive.
// Every other start refuses with the restore command, and no start changes
// the marker.
func TestRecoveryStartNeedsALiveGrantForTheMarkersBackup(t *testing.T) {
	root, backup := incompleteInstall(t, currentRelease(t))
	refusal := "upgrade incomplete; keep the app stopped; smthrs host restore " + backup
	refused := func(why string) {
		t.Helper()
		reached, err := reachesPostgres(t, root)
		require.False(t, reached, why)
		require.EqualError(t, err, refusal, why)
		require.NoDirExists(t, filepath.Join(root, "postgres"), why)
		marker, err := os.ReadFile(filepath.Join(root, ".upgrade-incomplete"))
		require.NoError(t, err)
		require.Equal(t, backup+"\n", string(marker), "a start never changes the marker")
	}
	grant := filepath.Join(root, recoveryGrantPath)
	write := func(value recoveryGrant) {
		t.Helper()
		raw, err := json.Marshal(value)
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(grant, raw, 0600))
	}
	birth, err := postgres.ProcessBirth(os.Getpid())
	require.NoError(t, err)

	refused("a plain start")

	revoke, err := grantRecoveryStart(root, backup)
	require.NoError(t, err)
	info, err := os.Stat(grant)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0600), info.Mode().Perm())
	reached, err := reachesPostgres(t, root)
	require.True(t, reached, "the operation's own start: %v", err)
	require.NoError(t, revoke())
	require.NoFileExists(t, grant)
	refused("a start after the grant was revoked")
	require.NoError(t, revoke(), "revoking twice is not an error")

	write(recoveryGrant{Backup: backup + "-other", PID: os.Getpid(), Birth: birth})
	refused("a grant for another backup")
	write(recoveryGrant{Backup: filepath.Dir(backup), PID: os.Getpid(), Birth: birth})
	refused("a grant for the backup's parent")
	write(recoveryGrant{Backup: backup, PID: os.Getpid(), Birth: "darwin:1:1"})
	refused("a PID the system gave to another program")
	write(recoveryGrant{Backup: backup, PID: os.Getpid()})
	refused("a grant without a start time")
	write(recoveryGrant{Backup: backup, PID: 1, Birth: birth})
	refused("a grant naming launchd")

	// The operation died: its grant is void although the file remains.
	operation := exec.Command("/bin/sleep", "60")
	require.NoError(t, operation.Start())
	operationBirth, err := postgres.ProcessBirth(operation.Process.Pid)
	require.NoError(t, err)
	write(recoveryGrant{Backup: backup, PID: operation.Process.Pid, Birth: operationBirth})
	reached, err = reachesPostgres(t, root)
	require.True(t, reached, "a start while the operation runs: %v", err)
	require.NoError(t, operation.Process.Kill())
	_ = operation.Wait()
	refused("a start after the operation was killed")

	require.NoError(t, os.WriteFile(grant, []byte("{not json"), 0600))
	refused("a malformed grant")
	require.NoError(t, os.WriteFile(grant, []byte(strings.Repeat(" ", 4097)), 0600))
	refused("an oversized grant")
	require.NoError(t, os.Remove(grant))
	valid := filepath.Join(root, "valid-grant")
	raw, err := json.Marshal(recoveryGrant{Backup: backup, PID: os.Getpid(), Birth: birth})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(valid, raw, 0600))
	require.NoError(t, os.Symlink(valid, grant))
	refused("a grant reached through a link")
}

// With no marker a start is ordinary, whatever grant file is left behind.
func TestStaleRecoveryGrantDoesNotAffectACompleteInstall(t *testing.T) {
	root, backup := incompleteInstall(t, currentRelease(t))
	revoke, err := grantRecoveryStart(root, backup)
	require.NoError(t, err)
	t.Cleanup(func() { _ = revoke() })
	require.NoError(t, os.Remove(filepath.Join(root, ".upgrade-incomplete")))
	reached, err := reachesPostgres(t, root)
	require.True(t, reached, err)
}

// A granted start keeps the version guards: it migrates forward from the
// restored state and never starts on a binary older than that state.
func TestRecoveryStartKeepsTheVersionGuards(t *testing.T) {
	head, err := product.HeadVersion()
	require.NoError(t, err)
	old := compose.BuildVersion
	t.Cleanup(func() { compose.BuildVersion = old })
	compose.BuildVersion = "1.3.0"
	for _, tc := range []struct {
		name    string
		state   Version
		allowed bool
		refusal string
	}{
		{name: "the restored state is older", state: Version{"1.2.3", fmt.Sprint(head - 1), "18"}, allowed: true},
		{name: "the restored state is this release", state: Version{"1.3.0", fmt.Sprint(head), "18"}, allowed: true},
		{name: "the restored state is newer", state: Version{"1.4.0", fmt.Sprint(head), "18"}, refusal: "state version 1.4.0 is newer than binary version 1.3.0; smthrs host restore '<backup>'"},
		{name: "the restored schema is newer", state: Version{"1.3.0", fmt.Sprint(head + 1), "18"}, refusal: fmt.Sprintf("state schema %d is newer than binary schema %d; smthrs host restore '<backup>'", head+1, head)},
		{name: "another PostgreSQL major", state: Version{"1.2.3", fmt.Sprint(head), "17"}, refusal: "backup tools require PostgreSQL 18, state declares 17"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, backup := incompleteInstall(t, tc.state)
			revoke, err := grantRecoveryStart(root, backup)
			require.NoError(t, err)
			t.Cleanup(func() { _ = revoke() })
			reached, err := reachesPostgres(t, root)
			require.Equal(t, tc.allowed, reached, err)
			if !tc.allowed {
				require.EqualError(t, err, tc.refusal)
			}
		})
	}
}

func TestRecoveryGrantRefusesUnsafeInputs(t *testing.T) {
	root, backup := incompleteInstall(t, currentRelease(t))
	for name, tc := range map[string][2]string{
		"relative state":  {"state", backup},
		"relative backup": {root, "backups/1.2.3"},
		"unclean backup":  {root, backup + "/../other"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := grantRecoveryStart(tc[0], tc[1])
			require.EqualError(t, err, "recovery start grant requires absolute state and backup directories")
		})
	}
	require.NoError(t, os.Chmod(filepath.Join(root, "backups"), 0755))
	_, err := grantRecoveryStart(root, backup)
	require.EqualError(t, err, "unsafe_path: backups")
	require.NoFileExists(t, filepath.Join(root, recoveryGrantPath))
	_, err = grantRecoveryStart(t.TempDir(), backup)
	require.Error(t, err, "a state root without backups/ holds no backup to recover")
}
