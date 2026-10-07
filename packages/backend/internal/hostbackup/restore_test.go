package hostbackup

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type restoreAuthorityFixture struct {
	calls []string
	fail  string
	dump  string
}

func (a *restoreAuthorityFixture) step(name string) error {
	a.calls = append(a.calls, name)
	if name == a.fail {
		return errors.New(name)
	}
	return nil
}
func (a *restoreAuthorityFixture) CheckStopped(context.Context) error { return a.step("stopped") }
func (a *restoreAuthorityFixture) CheckRetainedIsolation(context.Context, Manifest) error {
	return a.step("isolation")
}
func (a *restoreAuthorityFixture) RestoreDatabase(_ context.Context, root *os.Root, r io.Reader, _ Version) error {
	if err := a.step("database"); err != nil {
		return err
	}
	bytes, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	a.dump = string(bytes)
	if err := root.Mkdir("postgres", 0700); err != nil {
		return err
	}
	return root.WriteFile("postgres/restored", bytes, 0600)
}
func (a *restoreAuthorityFixture) StartRestored(context.Context) error { return a.step("start") }
func restoreFixture(t *testing.T) string {
	state := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(state, "secret"), []byte("backup secret"), 0600))
	dir, err := Backup(t.Context(), BackupConfig{State: state, Version: Version{"1.2.3", 2, 18}, Authority: &backupAuthorityFixture{at: time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)}, Cloner: backupCopyFixture{}})
	require.NoError(t, err)
	return dir
}
func TestRestoreStagesBeforeMovingLiveTrees(t *testing.T) {
	backup := restoreFixture(t)
	state := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(state, "secret"), []byte("live secret"), 0600))
	a := &restoreAuthorityFixture{}
	at, err := Restore(t.Context(), RestoreConfig{State: state, Backup: backup, Version: Version{"1.3.0", 3, 18}, Authority: a, Cloner: backupCopyFixture{}})
	require.NoError(t, err)
	require.Equal(t, time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC), at)
	require.Equal(t, []string{"stopped", "isolation", "database", "start"}, a.calls)
	require.Equal(t, "seeded database rows", a.dump)
	bytes, err := os.ReadFile(filepath.Join(state, "secret"))
	require.NoError(t, err)
	require.Equal(t, "backup secret", string(bytes))
	retained, err := filepath.Glob(filepath.Join(state, "backups/pre-restore-*/secret"))
	require.NoError(t, err)
	require.Len(t, retained, 1)
	bytes, err = os.ReadFile(retained[0])
	require.NoError(t, err)
	require.Equal(t, "live secret", string(bytes))
	require.NoFileExists(t, filepath.Join(state, ".upgrade-incomplete"))
}
func TestRestoreRefusalsPreserveLiveState(t *testing.T) {
	for _, fail := range []string{"stopped", "isolation", "database", "capture"} {
		t.Run(fail, func(t *testing.T) {
			backup := restoreFixture(t)
			state := t.TempDir()
			require.NoError(t, os.WriteFile(filepath.Join(state, "secret"), []byte("live"), 0600))
			a := &restoreAuthorityFixture{fail: fail}
			_, err := Restore(t.Context(), RestoreConfig{State: state, Backup: backup, Version: Version{"1.3.0", 3, 18}, Authority: a, Cloner: backupCopyFixture{fail: fail == "capture"}})
			require.Error(t, err)
			require.NotContains(t, a.calls, "start")
			bytes, err := os.ReadFile(filepath.Join(state, "secret"))
			require.NoError(t, err)
			require.Equal(t, "live", string(bytes))
			retained, err := filepath.Glob(filepath.Join(state, "backups/pre-restore-*"))
			require.NoError(t, err)
			require.Empty(t, retained)
		})
	}
}

func TestRestoreStartupFailureRetainsRecoveryMarker(t *testing.T) {
	backup := restoreFixture(t)
	state := t.TempDir()
	a := &restoreAuthorityFixture{fail: "start"}
	_, err := Restore(t.Context(), RestoreConfig{State: state, Backup: backup, Version: Version{"1.3.0", 3, 18}, Authority: a, Cloner: backupCopyFixture{}})
	require.ErrorContains(t, err, "start")
	marker, err := os.ReadFile(filepath.Join(state, ".upgrade-incomplete"))
	require.NoError(t, err)
	require.Equal(t, backup+"\n", string(marker))
	retained, err := filepath.Glob(filepath.Join(state, "backups/pre-restore-*"))
	require.NoError(t, err)
	require.Len(t, retained, 1)
}
