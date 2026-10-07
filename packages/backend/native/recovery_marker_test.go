package native

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/postgres"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/unix"
)

// Run is the installed backend startup boundary. No PostgreSQL tool exists in
// these fixtures: the recovery guard must return before trying to start one.
func TestNativeStartupRecoveryMarkerInputs(t *testing.T) {
	for _, kind := range []string{"symlink outside", "symlink inside", "fifo", "directory", "oversized", "newline", "nul", "escape", "carriage", "empty", "valid", "maximum"} {
		t.Run(kind, func(t *testing.T) {
			state := t.TempDir()
			outside := filepath.Join(t.TempDir(), "sentinel")
			require.NoError(t, os.WriteFile(outside, []byte("outside-secret"), 0640))
			marker := filepath.Join(state, ".upgrade-incomplete")
			backup := "/backup with spaces/owner's backup"
			switch kind {
			case "symlink outside":
				require.NoError(t, os.Symlink(outside, marker))
			case "symlink inside":
				require.NoError(t, os.WriteFile(filepath.Join(state, "other"), []byte("inside-secret"), 0600))
				require.NoError(t, os.Symlink("other", marker))
			case "fifo":
				require.NoError(t, unix.Mkfifo(marker, 0600))
			case "directory":
				require.NoError(t, os.Mkdir(marker, 0700))
			case "oversized":
				require.NoError(t, os.WriteFile(marker, []byte(strings.Repeat("x", 4097)), 0600))
			case "newline", "nul", "escape", "carriage":
				control := map[string]string{"newline": "\n", "nul": "\x00", "escape": "\x1b", "carriage": "\r"}[kind]
				require.NoError(t, os.WriteFile(marker, []byte("/backup"+control+"injected\n"), 0600))
			case "empty":
				require.NoError(t, os.WriteFile(marker, nil, 0600))
			case "valid":
				require.NoError(t, os.WriteFile(marker, []byte(backup+"\n"), 0600))
			case "maximum":
				backup = "/" + strings.Repeat("x", 4094)
				require.NoError(t, os.WriteFile(marker, []byte(backup+"\n"), 0600))
			}
			before, err := os.Lstat(marker)
			require.NoError(t, err)
			finished := make(chan error, 1)
			go func() {
				finished <- Run(t.Context(), Config{StateDir: state, Postgres: postgres.Config{
					BinDir: filepath.Join(state, "absent-tools"), StateDir: filepath.Join(state, "postgres"), Major: 18,
				}})
			}()
			select {
			case err = <-finished:
			case <-time.After(time.Second):
				// Unblock a regressed FIFO read so even the failing fixture exits.
				if kind == "fifo" {
					fd, e := unix.Open(marker, unix.O_RDWR|unix.O_NONBLOCK, 0)
					if e == nil {
						_, _ = unix.Write(fd, []byte("backup\n"))
						_ = unix.Close(fd)
					}
				}
				t.Fatal("startup blocked reading recovery marker")
			}
			var guard *GuardError
			require.True(t, errors.As(err, &guard), "startup passed the recovery guard: %v", err)
			switch kind {
			case "valid", "maximum":
				require.Equal(t, "upgrade incomplete; keep the app stopped", guard.Reason)
				require.Equal(t, backup, guard.Backup)
				if kind == "valid" {
					require.Equal(t, "upgrade incomplete; keep the app stopped; smthrs host restore '/backup with spaces/owner'\\''s backup'", err.Error())
				}
			case "empty":
				require.Equal(t, "upgrade incomplete; recovery marker has no verified backup", guard.Reason)
				require.Empty(t, guard.Backup)
			default:
				require.Equal(t, "upgrade incomplete; recovery marker is unreadable", guard.Reason)
				require.Empty(t, guard.Backup)
				require.NotContains(t, err.Error(), "outside-secret")
				require.NotContains(t, err.Error(), "inside-secret")
			}
			after, err := os.Lstat(marker)
			require.NoError(t, err)
			require.True(t, os.SameFile(before, after))
			require.Equal(t, before.Mode(), after.Mode())
			bytes, err := os.ReadFile(outside)
			require.NoError(t, err)
			require.Equal(t, "outside-secret", string(bytes))
			info, err := os.Stat(outside)
			require.NoError(t, err)
			require.Equal(t, os.FileMode(0640), info.Mode().Perm())
			require.NoDirExists(t, filepath.Join(state, "postgres"))
			require.NoFileExists(t, filepath.Join(state, "version.env"))
		})
	}
}
