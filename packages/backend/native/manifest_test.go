package native

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
	"github.com/stretchr/testify/require"
)

func jsonBackup(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	stage := filepath.Join(root, ".partial-test")
	require.NoError(t, os.Mkdir(stage, 0700))
	require.NoError(t, os.WriteFile(filepath.Join(stage, "postgres.dump"), []byte("independently seeded database bytes"), 0600))
	m := hostbackup.Manifest{Version: "1.2.3", SchemaVersion: 2, PostgresMajor: 18, QuiesceOp: "backup-fixture", QuiesceTime: time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC), Stack: json.RawMessage(`[]`), BranchHeads: json.RawMessage(`{}`), MachineDisks: json.RawMessage(`[]`), RunJournals: json.RawMessage(`[]`)}
	require.NoError(t, hostbackup.WriteManifest(stage, m))
	return filepath.Join(root, "1.2.3-20261005T000000.000000000Z")
}

func TestNativeRestoreUsesCanonicalJSONManifest(t *testing.T) {
	backup := jsonBackup(t)
	version, err := VerifyBackup(backup)
	require.NoError(t, err)
	require.Equal(t, Version{"1.2.3", "2", "18"}, version)
	target := t.TempDir()
	require.NoError(t, CheckRestore(backup, Version{"1.3.0", "3", "18"}, target, false))
	for _, version := range []Version{{"1.2.2", "2", "18"}, {"1.3.0", "1", "18"}, {"1.3.0", "3", "17"}} {
		require.Error(t, CheckRestore(backup, version, target, false))
	}
	require.ErrorContains(t, CheckRestore(backup, Version{"1.3.0", "3", "18"}, target, true), "running install")
	require.NoError(t, os.WriteFile(filepath.Join(backup, "postgres.dump"), []byte("changed after manifest"), 0600))
	require.ErrorContains(t, CheckRestore(backup, Version{"1.3.0", "3", "18"}, target, false), "hash_mismatch")
	entries, err := os.ReadDir(target)
	require.NoError(t, err)
	require.Empty(t, entries)
}

func TestNativeReleaseDowngradeRefusesBeforeMarkerOrMigration(t *testing.T) {
	backup := jsonBackup(t)
	root := t.TempDir()
	require.NoError(t, WriteVersion(root, Version{"1.2.3", "2", "18"}))
	migrated := false
	err := Upgrade(t.Context(), root, backup, Version{"1.2.2", "2", "18"}, &UpgradeSteps{Migrate: func(context.Context) error { migrated = true; return nil }})
	require.ErrorContains(t, err, "release downgrade from 1.2.3 to 1.2.2 is refused")
	require.False(t, migrated)
	_, err = os.Lstat(filepath.Join(root, ".upgrade-incomplete"))
	require.True(t, os.IsNotExist(err))
	body, err := os.ReadFile(filepath.Join(root, "version.env"))
	require.NoError(t, err)
	require.Equal(t, "SMITHERS_DISTRIBUTION_VERSION=1.2.3\nSMITHERS_SCHEMA_VERSION=2\nSMITHERS_POSTGRES_MAJOR=18\n", string(body))
}
