package hostbackup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type upgradeFixture struct {
	backupAuthorityFixture
	state string
	t     *testing.T
}

func (a *upgradeFixture) CheckUpgrade(context.Context) error { return a.step("upgrade-check") }
func (a *upgradeFixture) BrewUpgrade(context.Context) error {
	marker, err := os.ReadFile(filepath.Join(a.state, ".upgrade-incomplete"))
	require.NoError(a.t, err)
	directory := string(marker[:len(marker)-1])
	_, err = VerifySnapshot(directory)
	require.NoError(a.t, err)
	require.NotContains(a.t, a.calls, "reopen")
	return a.step("brew")
}
func (a *upgradeFixture) Continue(_ context.Context, backup string) error {
	marker, err := os.ReadFile(filepath.Join(a.state, ".upgrade-incomplete"))
	require.NoError(a.t, err)
	require.Equal(a.t, backup+"\n", string(marker))
	return a.step("continue")
}

func TestUpgradeBackupPrecedesHomebrewAndRetainsFreeze(t *testing.T) {
	for _, fail := range []string{"upgrade-check", "check", "dump", "brew", "continue", ""} {
		t.Run(fail, func(t *testing.T) {
			state := t.TempDir()
			bundle := filepath.Join(t.TempDir(), "bundle")
			a := &upgradeFixture{backupAuthorityFixture: backupAuthorityFixture{fail: fail, at: time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)}, state: state, t: t}
			require.NoError(t, os.Mkdir(bundle, 0700))
			require.NoError(t, os.WriteFile(filepath.Join(bundle, "backend"), []byte("old release bytes"), 0600))
			dir, err := Upgrade(t.Context(), UpgradeConfig{BackupConfig: BackupConfig{FreeSpaceFloor: testFreeSpaceFloor, State: state, Bundle: bundle, Version: Version{"1.2.3", 2, 18}, Cloner: recursiveCopyFixture{}}, Upgrade: a})
			require.Error(t, err)
			if fail == "upgrade-check" || fail == "check" || fail == "dump" {
				require.NotContains(t, a.calls, "brew")
				require.NoFileExists(t, filepath.Join(state, ".upgrade-incomplete"))
				return
			}
			var recovery *UpgradeError
			require.True(t, errors.As(err, &recovery))
			require.Equal(t, dir, recovery.Backup)
			require.Contains(t, err.Error(), "smthrs host restore '"+dir+"'")
			require.NotContains(t, a.calls, "reopen")
			marker, e := os.ReadFile(filepath.Join(state, ".upgrade-incomplete"))
			require.NoError(t, e)
			require.Equal(t, dir+"\n", string(marker))
			bytes, e := os.ReadFile(filepath.Join(dir, "bundle/backend"))
			require.NoError(t, e)
			require.Equal(t, "old release bytes", string(bytes))
		})
	}
}

type recursiveCopyFixture struct{}

func (recursiveCopyFixture) CloneAt(src *os.File, name string, dst *os.File, target string) error {
	source, destination := filepath.Join(src.Name(), name), filepath.Join(dst.Name(), target)
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		output := filepath.Join(destination, rel)
		if entry.IsDir() {
			return os.Mkdir(output, 0700)
		}
		bytes, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(output, bytes, 0600)
	})
}

func TestUpgradeRecoveryHintQuotesBackupArgument(t *testing.T) {
	require.Equal(t, `'/a b/it'"'"'s'`, shellArgument("/a b/it's"))
}

type continuationFixture struct {
	backupAuthorityFixture
	state string
	t     *testing.T
	op    string
}

func (a *continuationFixture) Migrate(context.Context) error { return a.guarded("migrate") }
func (a *continuationFixture) Ready(context.Context) error   { return a.guarded("ready") }
func (a *continuationFixture) HealthWake(_ context.Context, op string) error {
	a.op = op
	return a.guarded("health-wake")
}
func (a *continuationFixture) guarded(step string) error {
	require.FileExists(a.t, filepath.Join(a.state, ".upgrade-incomplete"))
	return a.step(step)
}

func TestUpgradeContinuationRequiresMigrationReadinessAndIsolatedWake(t *testing.T) {
	for _, fail := range []string{"check", "migrate", "ready", "health-wake", "reopen", ""} {
		t.Run(fail, func(t *testing.T) {
			backup := restoreFixture(t)
			state := t.TempDir()
			require.NoError(t, os.WriteFile(filepath.Join(state, ".upgrade-incomplete"), []byte(backup+"\n"), 0600))
			a := &continuationFixture{backupAuthorityFixture: backupAuthorityFixture{fail: fail}, state: state, t: t}
			err := ContinueUpgrade(t.Context(), UpgradeContinuationConfig{State: state, Backup: backup, Version: Version{"1.3.0", 3, 18}, Authority: a})
			if fail == "" {
				require.NoError(t, err)
				require.Equal(t, []string{"check", "migrate", "ready", "health-wake", "reopen"}, a.calls)
				require.NoFileExists(t, filepath.Join(state, ".upgrade-incomplete"))
				m, e := VerifySnapshot(backup)
				require.NoError(t, e)
				require.Equal(t, m.QuiesceOp, a.op)
			} else {
				require.ErrorContains(t, err, fail)
				require.FileExists(t, filepath.Join(state, ".upgrade-incomplete"))
				require.Equal(t, fail, a.calls[len(a.calls)-1])
			}
		})
	}
}

func TestUpgradeContinuationRefusesWrongMarkerAndMissingProviders(t *testing.T) {
	backup := restoreFixture(t)
	state := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(state, ".upgrade-incomplete"), []byte("another backup\n"), 0600))
	cfg := UpgradeContinuationConfig{State: state, Backup: backup, Version: Version{"1.3.0", 3, 18}}
	require.ErrorContains(t, ContinueUpgrade(t.Context(), cfg), "marker does not match backup")
	require.NoError(t, os.WriteFile(filepath.Join(state, ".upgrade-incomplete"), []byte(backup+"\n"), 0600))
	require.ErrorContains(t, ContinueUpgrade(t.Context(), cfg), "continuation providers required")
	require.FileExists(t, filepath.Join(state, ".upgrade-incomplete"))
}
