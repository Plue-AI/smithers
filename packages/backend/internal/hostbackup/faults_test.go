package hostbackup

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// killAuthority runs a backup up to one phase, reports that it got there and
// then waits to be killed, as a backup command killed mid-run would be.
type killAuthority struct {
	backupAuthorityFixture
	phase, reached string
}

func (a *killAuthority) wait(phase string) {
	if a.phase != phase {
		return
	}
	if err := os.WriteFile(a.reached, []byte(phase), 0600); err != nil {
		panic(err)
	}
	select {}
}
func (a *killAuthority) Freeze(ctx context.Context, op string) (time.Time, error) {
	a.wait("drain")
	return a.backupAuthorityFixture.Freeze(ctx, op)
}
func (a *killAuthority) Dump(ctx context.Context, w io.Writer) error {
	a.wait("after the freeze")
	if _, err := io.WriteString(w, "seeded "); err != nil {
		return err
	}
	a.wait("pg_dump")
	_, err := io.WriteString(w, "database rows")
	return err
}
func (a *killAuthority) Summary(ctx context.Context) (Manifest, error) {
	a.wait("before the manifest")
	return a.backupAuthorityFixture.Summary(ctx)
}

type killCloner struct{ authority *killAuthority }

func (c killCloner) CloneAt(src *os.File, name string, dst *os.File, target string) error {
	c.authority.wait("clone")
	return backupCopyFixture{}.CloneAt(src, name, dst, target)
}

// TestBackupKillHelper is the backup command the kill-point test kills. It
// does nothing in an ordinary test run.
func TestBackupKillHelper(t *testing.T) {
	phase := os.Getenv("HOSTBACKUP_KILL_AT")
	if phase == "" {
		return
	}
	authority := &killAuthority{backupAuthorityFixture: backupAuthorityFixture{at: time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)}, phase: phase, reached: os.Getenv("HOSTBACKUP_REACHED")}
	_, err := Backup(context.Background(), BackupConfig{FreeSpaceFloor: testFreeSpaceFloor, State: os.Getenv("HOSTBACKUP_STATE"), Version: Version{"1.2.3", 2, 18}, Authority: authority, Cloner: killCloner{authority}})
	t.Fatalf("the backup finished instead of waiting at %q: %v", phase, err)
}

// A backup command killed at any point leaves no directory with a manifest:
// only backups/.partial-*, which verification and restore refuse. The next
// backup still publishes. (The freeze such a command held reopens when its
// lease lapses; the install quiesce tests cover that.)
func TestBackupKilledAtEachPointLeavesNoManifest(t *testing.T) {
	for _, tc := range []struct {
		phase  string
		staged bool
	}{
		{"drain", false},
		{"after the freeze", true},
		{"pg_dump", true},
		{"clone", true},
		{"before the manifest", true},
	} {
		t.Run(tc.phase, func(t *testing.T) {
			state := t.TempDir()
			require.NoError(t, os.WriteFile(filepath.Join(state, "secret"), []byte("original"), 0600))
			reached := filepath.Join(t.TempDir(), "reached")
			command := exec.Command(os.Args[0], "-test.run=^TestBackupKillHelper$")
			command.Env = append(os.Environ(), "HOSTBACKUP_KILL_AT="+tc.phase, "HOSTBACKUP_STATE="+state, "HOSTBACKUP_REACHED="+reached)
			require.NoError(t, command.Start())
			killed := false
			defer func() {
				if !killed {
					_ = command.Process.Kill()
					_ = command.Wait()
				}
			}()
			deadline := time.Now().Add(30 * time.Second)
			for {
				if at, err := os.ReadFile(reached); err == nil && string(at) == tc.phase {
					break
				}
				require.True(t, time.Now().Before(deadline), "the backup never reached %q", tc.phase)
				time.Sleep(10 * time.Millisecond)
			}
			require.NoError(t, command.Process.Kill())
			err := command.Wait()
			killed = true
			require.EqualError(t, err, "signal: killed")

			require.NoError(t, filepath.WalkDir(state, func(path string, entry os.DirEntry, err error) error {
				require.NoError(t, err)
				require.NotEqual(t, "MANIFEST.json", entry.Name(), path)
				return nil
			}))
			secret, err := os.ReadFile(filepath.Join(state, "secret"))
			require.NoError(t, err)
			require.Equal(t, "original", string(secret))
			entries, err := os.ReadDir(filepath.Join(state, "backups"))
			if !tc.staged {
				require.True(t, os.IsNotExist(err), "nothing is staged before the freeze is ready: %v %v", entries, err)
			} else {
				require.NoError(t, err)
				require.Len(t, entries, 1)
				require.True(t, strings.HasPrefix(entries[0].Name(), ".partial-backup-"), entries[0].Name())
				partial := filepath.Join(state, "backups", entries[0].Name())
				info, err := os.Stat(partial)
				require.NoError(t, err)
				require.Equal(t, os.FileMode(0700), info.Mode().Perm())
				_, err = VerifySnapshot(partial)
				requireCode(t, err, Partial)
				live := t.TempDir()
				require.NoError(t, os.WriteFile(filepath.Join(live, "secret"), []byte("live"), 0600))
				authority := &restoreAuthorityFixture{}
				_, err = Restore(t.Context(), RestoreConfig{State: live, Backup: partial, Version: Version{"1.3.0", 3, 18}, Authority: authority, Cloner: backupCopyFixture{}})
				require.Error(t, err)
				require.Empty(t, authority.calls)
				kept, err := os.ReadFile(filepath.Join(live, "secret"))
				require.NoError(t, err)
				require.Equal(t, "live", string(kept))
			}

			// The install is usable again: the next backup publishes, and the
			// killed run's partial directory is never mistaken for a backup.
			next := &backupAuthorityFixture{at: time.Date(2026, 10, 7, 1, 3, 0, 0, time.UTC)}
			directory, err := Backup(t.Context(), BackupConfig{FreeSpaceFloor: testFreeSpaceFloor, State: state, Version: Version{"1.2.3", 2, 18}, Authority: next, Cloner: backupCopyFixture{}})
			require.NoError(t, err)
			require.Equal(t, "1.2.3-20261007T010300.000000000Z", filepath.Base(directory))
			manifest, err := VerifySnapshot(directory)
			require.NoError(t, err)
			for _, file := range manifest.Files {
				require.False(t, strings.Contains(file.Path, ".partial-"), file.Path)
			}
			after, err := os.ReadDir(filepath.Join(state, "backups"))
			require.NoError(t, err)
			want := 1
			if tc.staged {
				want = 2
			}
			require.Len(t, after, want)
		})
	}
}

// Five backups in a row: exactly the three newest remain.
func TestBackupKeepsTheThreeNewest(t *testing.T) {
	state := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(state, "secret"), []byte("original"), 0600))
	for second := 3; second <= 7; second++ {
		authority := &backupAuthorityFixture{at: time.Date(2026, 10, 7, 1, 2, second, 0, time.UTC)}
		_, err := Backup(t.Context(), BackupConfig{FreeSpaceFloor: testFreeSpaceFloor, State: state, Version: Version{"1.2.3", 2, 18}, Authority: authority, Cloner: backupCopyFixture{}})
		require.NoError(t, err)
	}
	entries, err := os.ReadDir(filepath.Join(state, "backups"))
	require.NoError(t, err)
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	require.Equal(t, []string{"1.2.3-20261007T010205.000000000Z", "1.2.3-20261007T010206.000000000Z", "1.2.3-20261007T010207.000000000Z"}, names)
	for _, name := range names {
		_, err := VerifySnapshot(filepath.Join(state, "backups", name))
		require.NoError(t, err)
	}
}
