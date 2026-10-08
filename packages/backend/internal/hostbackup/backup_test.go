package hostbackup

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// testFreeSpaceFloor replaces the production 40 GiB floor so fixtures run on
// hosts with less free disk, such as CI runners.
// TestBackupDefaultFloorReservesFortyGiB covers the production value.
const testFreeSpaceFloor uint64 = 1 << 20

type backupAuthorityFixture struct {
	calls []string
	fail  string
	size  uint64
	at    time.Time
}

func (a *backupAuthorityFixture) step(name string) error {
	a.calls = append(a.calls, name)
	if a.fail == name {
		return errors.New(name)
	}
	return nil
}
func (a *backupAuthorityFixture) Check(context.Context) error { return a.step("check") }
func (a *backupAuthorityFixture) DatabaseSize(context.Context) (uint64, error) {
	return a.size, a.step("size")
}
func (a *backupAuthorityFixture) Freeze(context.Context, string) (time.Time, error) {
	return a.at, a.step("freeze")
}
func (a *backupAuthorityFixture) Renew(context.Context, string) error { return a.step("renew") }
func (a *backupAuthorityFixture) Dump(_ context.Context, w io.Writer) error {
	if err := a.step("dump"); err != nil {
		return err
	}
	_, err := io.WriteString(w, "seeded database rows")
	return err
}
func (a *backupAuthorityFixture) Summary(context.Context) (Manifest, error) {
	return Manifest{Stack: json.RawMessage(`[{"tip":"abc"}]`), BranchHeads: json.RawMessage(`{"branch":"def"}`), MachineDisks: json.RawMessage(`[]`), RunJournals: json.RawMessage(`[]`)}, a.step("summary")
}
func (a *backupAuthorityFixture) Reopen(ctx context.Context, _ string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return a.step("reopen")
}

type backupCopyFixture struct{ fail bool }

type drainingBackupFixture struct {
	backupAuthorityFixture
	renewed chan string
}

func (a *drainingBackupFixture) Renew(_ context.Context, op string) error {
	a.renewed <- op
	return nil
}
func (a *drainingBackupFixture) Freeze(ctx context.Context, op string) (time.Time, error) {
	select {
	case renewed := <-a.renewed:
		if renewed != op {
			return time.Time{}, errors.New("renewed another operation")
		}
		return a.at, nil
	case <-ctx.Done():
		return time.Time{}, context.Cause(ctx)
	}
}

func TestBackupRenewsWhileInitialDrainIsOutstanding(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	a := &drainingBackupFixture{backupAuthorityFixture: backupAuthorityFixture{at: time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)}, renewed: make(chan string, 1)}
	directory, err := Backup(ctx, BackupConfig{FreeSpaceFloor: testFreeSpaceFloor, State: t.TempDir(), Version: Version{"1.2.3", 2, 18}, Authority: a, Cloner: backupCopyFixture{}})
	require.NoError(t, err)
	_, err = VerifySnapshot(directory)
	require.NoError(t, err)
	require.Equal(t, "reopen", a.calls[len(a.calls)-1])
}

func (c backupCopyFixture) CloneAt(src *os.File, name string, dst *os.File, target string) error {
	if c.fail {
		return errors.New("capture failed")
	}
	data, err := os.ReadFile(filepath.Join(src.Name(), name))
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dst.Name(), target), data, 0600)
}

func TestBackupCoordinatesQuiescentManifest(t *testing.T) {
	state := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(state, "version.env"), []byte("seeded version"), 0600))
	for _, name := range []string{"postgres", "logs"} {
		require.NoError(t, os.Mkdir(filepath.Join(state, name), 0700))
		require.NoError(t, os.WriteFile(filepath.Join(state, name, "excluded"), []byte("must not capture"), 0600))
	}
	a := &backupAuthorityFixture{at: time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)}
	dir, err := Backup(t.Context(), BackupConfig{FreeSpaceFloor: testFreeSpaceFloor, State: state, Version: Version{"1.2.3", 2, 18}, Authority: a, Cloner: backupCopyFixture{}})
	require.NoError(t, err)
	require.Equal(t, []string{"check", "size", "freeze", "dump", "summary", "reopen"}, a.calls)
	require.Equal(t, "1.2.3-20261007T010203.000000000Z", filepath.Base(dir))
	m, err := VerifySnapshot(dir)
	require.NoError(t, err)
	require.Len(t, m.Files, 2)
	expected := map[string]string{"postgres.dump": "seeded database rows", "state/version.env": "seeded version"}
	for _, file := range m.Files {
		bytes, ok := expected[file.Path]
		require.True(t, ok)
		require.Equal(t, int64(len(bytes)), file.Size)
		require.Equal(t, fmt.Sprintf("%x", sha256.Sum256([]byte(bytes))), file.SHA256)
	}
	info, err := os.Stat(dir)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0700), info.Mode().Perm())
}

func TestBackupFailuresNeverPublishAndReopen(t *testing.T) {
	for _, fail := range []string{"check", "size", "freeze", "dump", "summary", "capture"} {
		t.Run(fail, func(t *testing.T) {
			state := t.TempDir()
			require.NoError(t, os.WriteFile(filepath.Join(state, "secret"), []byte("original"), 0600))
			a := &backupAuthorityFixture{fail: fail, at: time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)}
			dir, err := Backup(t.Context(), BackupConfig{FreeSpaceFloor: testFreeSpaceFloor, State: state, Version: Version{"1.2.3", 2, 18}, Authority: a, Cloner: backupCopyFixture{fail: fail == "capture"}})
			require.Error(t, err)
			require.Empty(t, dir)
			bytes, err := os.ReadFile(filepath.Join(state, "secret"))
			require.NoError(t, err)
			require.Equal(t, "original", string(bytes))
			if fail == "dump" || fail == "summary" || fail == "capture" {
				require.Equal(t, "reopen", a.calls[len(a.calls)-1])
			} else {
				require.NotContains(t, a.calls, "reopen")
			}
			require.NoError(t, filepath.WalkDir(state, func(path string, d os.DirEntry, err error) error {
				require.NoError(t, err)
				require.NotEqual(t, "MANIFEST.json", d.Name())
				return nil
			}))
		})
	}
}

func TestBackupSpaceRefusalPrecedesFreeze(t *testing.T) {
	a := &backupAuthorityFixture{size: ^uint64(0)}
	_, err := Backup(t.Context(), BackupConfig{FreeSpaceFloor: testFreeSpaceFloor, State: t.TempDir(), Version: Version{"1.2.3", 2, 18}, Authority: a, Cloner: backupCopyFixture{}})
	require.ErrorContains(t, err, "insufficient_space")
	require.Equal(t, []string{"check", "size"}, a.calls)
}

func TestBackupPreservesRunFilesWithoutTransientOwnerSocket(t *testing.T) {
	// Darwin limits Unix socket paths to 104 bytes and t.TempDir includes the
	// full test name, so this socket fixture takes a short directory.
	state, err := os.MkdirTemp("", "run-")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, os.RemoveAll(state)) })
	require.NoError(t, os.Mkdir(filepath.Join(state, "run"), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(state, "run/request.json"), []byte("persisted request"), 0600))
	listener, err := net.Listen("unix", filepath.Join(state, "run/host.sock"))
	require.NoError(t, err)
	defer listener.Close()
	a := &backupAuthorityFixture{at: time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)}
	dir, err := Backup(t.Context(), BackupConfig{FreeSpaceFloor: testFreeSpaceFloor, State: state, Version: Version{"1.2.3", 2, 18}, Authority: a, Cloner: backupCopyFixture{}})
	require.NoError(t, err)
	manifest, err := VerifySnapshot(dir)
	require.NoError(t, err)
	require.Len(t, manifest.Files, 2)
	require.NoFileExists(t, filepath.Join(dir, "state/run/host.sock"))
	bytes, err := os.ReadFile(filepath.Join(dir, "state/run/request.json"))
	require.NoError(t, err)
	require.Equal(t, "persisted request", string(bytes))
}

// TestBackupDefaultFloorReservesFortyGiB proves a config without a floor
// reserves the production 40 GiB. A fake volume stands in for the real disk.
func TestBackupDefaultFloorReservesFortyGiB(t *testing.T) {
	require.Equal(t, uint64(40<<30), FreeSpaceFloor)
	for _, tc := range []struct {
		name    string
		free    uint64
		size    uint64
		refused bool
	}{
		{"below floor", FreeSpaceFloor - 1, 0, true},
		{"floor would be consumed", FreeSpaceFloor, 1, true},
		{"above floor", FreeSpaceFloor + 1<<20, 1 << 20, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := t.TempDir()
			var asked []string
			a := &backupAuthorityFixture{size: tc.size, at: time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)}
			dir, err := Backup(t.Context(), BackupConfig{State: state, Version: Version{"1.2.3", 2, 18}, Authority: a, Cloner: backupCopyFixture{},
				AvailableBytes: func(dir string) (uint64, error) {
					asked = append(asked, dir)
					return tc.free, nil
				}})
			require.Equal(t, []string{state}, asked)
			if !tc.refused {
				require.NoError(t, err)
				_, err = VerifySnapshot(dir)
				require.NoError(t, err)
				return
			}
			requireCode(t, err, InsufficientSpace)
			require.Empty(t, dir)
			require.Equal(t, []string{"check", "size"}, a.calls)
			entries, err := os.ReadDir(state)
			require.NoError(t, err)
			require.Empty(t, entries)
		})
	}
}

func TestBackupFreeSpaceReadFailureRefuses(t *testing.T) {
	a := &backupAuthorityFixture{}
	_, err := Backup(t.Context(), BackupConfig{State: t.TempDir(), Version: Version{"1.2.3", 2, 18}, Authority: a, Cloner: backupCopyFixture{},
		AvailableBytes: func(string) (uint64, error) { return 0, errors.New("statfs failed") }})
	require.ErrorContains(t, err, "statfs failed")
	require.Equal(t, []string{"check", "size"}, a.calls)
}
