//go:build darwin

package native

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/compose"
	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
	"github.com/smithersai/smithers/packages/backend/postgres"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
	"github.com/stretchr/testify/require"
)

// installState is a private install state root with a path short enough for
// the owner socket (Darwin allows 104 bytes; t.TempDir holds the test name).
func installState(t *testing.T) string {
	t.Helper()
	state, err := os.MkdirTemp("", "ins07-")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, os.RemoveAll(state)) })
	require.NoError(t, os.Chmod(state, 0700))
	return state
}

// liveDatabase is the owner bridge's database half without its socket: the
// install hands backup the same supervised instance methods.
type liveDatabase struct {
	database *postgres.Instance
	at       time.Time
	dump     func(io.Writer) error
}

func (a *liveDatabase) Check(context.Context) error { return nil }
func (a *liveDatabase) DatabaseSize(ctx context.Context) (uint64, error) {
	if a.database == nil {
		return 1, nil
	}
	return a.database.DatabaseSize(ctx)
}
func (a *liveDatabase) Freeze(context.Context, string) (time.Time, error) { return a.at, nil }
func (a *liveDatabase) Renew(context.Context, string) error               { return nil }
func (a *liveDatabase) Reopen(context.Context, string) error              { return nil }
func (a *liveDatabase) Dump(ctx context.Context, target io.Writer) error {
	if a.dump != nil {
		return a.dump(target)
	}
	return a.database.Dump(ctx, target)
}
func (a *liveDatabase) Summary(context.Context) (hostbackup.Manifest, error) {
	return hostbackup.Manifest{Stack: json.RawMessage(`[{"number":1,"state":"working"}]`), BranchHeads: json.RawMessage(`{}`), MachineDisks: json.RawMessage(`[]`), RunJournals: json.RawMessage(`[]`)}, nil
}

type realInstall struct {
	t     *testing.T
	bin   string
	state string
}

func (f realInstall) start(state string) *postgres.Instance {
	f.t.Helper()
	database, err := postgres.Start(context.Background(), postgres.Config{BinDir: f.bin, StateDir: filepath.Join(state, "postgres"), Major: 18, StartupTimeout: 20 * time.Second})
	require.NoError(f.t, err)
	return database
}
func (f realInstall) stop(database *postgres.Instance) {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	require.NoError(f.t, database.Stop(ctx))
}
func (f realInstall) query(database *postgres.Instance, sql string) string {
	f.t.Helper()
	out, err := exec.Command(filepath.Join(f.bin, "psql"), "--dbname="+database.ConnectionString, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql).CombinedOutput()
	require.NoError(f.t, err, string(out))
	return strings.TrimSpace(string(out))
}

// rows is the observed table, one key=value per line in key order.
func (f realInstall) rows(database *postgres.Instance) string {
	return f.query(database, "SELECT key || '=' || value FROM backup_proof ORDER BY key")
}
func (f realInstall) authority(state string, calls *[]string, started func(bundle string)) *restoreAuthority {
	return &restoreAuthority{
		state:    state,
		postgres: postgres.Config{BinDir: f.bin, Major: 18, StartupTimeout: 20 * time.Second},
		isolation: func(context.Context) error {
			*calls = append(*calls, "isolation")
			return nil
		},
		start: func(_ context.Context, bundle string) error {
			*calls = append(*calls, "start")
			started(bundle)
			return nil
		},
	}
}

func flockExclusive(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}

func digest(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func write(t *testing.T, path, body string, mode os.FileMode) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0700))
	require.NoError(t, os.WriteFile(path, []byte(body), mode))
}

// Backup, mutate, restore: the rows and trees return to the backup's, the
// later ones are kept aside, and a running install is refused untouched.
// It drives the production coordinators with the bundled PostgreSQL programs
// and the kernel clone; only the launchd start and the microVM doctor are
// stood in.
func TestRealBackupMutateRestoreReturnsTheBackupRows(t *testing.T) {
	bin, major := testdb.Tools(t)
	require.Equal(t, 18, major)
	f := realInstall{t: t, bin: bin, state: installState(t)}
	// The seeded rows and their digest are literals fixed before any
	// operation; the manifest is never the oracle for them.
	const seeded = "a=one\nb=two\nc=three"
	const want = "b401cc24e357f117b2406a6776b94ac195f38981d28b3af70da52ed8be7d9894"
	require.Equal(t, want, digest(seeded))

	live := f.start(f.state)
	stopped := false
	t.Cleanup(func() {
		if !stopped {
			f.stop(live)
		}
	})
	f.query(live, "CREATE TABLE backup_proof(key text PRIMARY KEY, value text NOT NULL); INSERT INTO backup_proof VALUES ('a','one'),('b','two'),('c','three')")
	require.Equal(t, want, digest(f.rows(live)))
	write(t, filepath.Join(f.state, "repositories/o/r/proof"), "files", 0600)
	write(t, filepath.Join(f.state, "config/secrets.json"), "install key", 0600)
	// One file of each durable class an install keeps beside its database.
	classes := map[string]string{"repositories/owner/repo/change": "repository", "blobs/chat/transcript": "chat", "blobs/approvals/pending": "approval", "blobs/artifacts/output": "artifact", "workspaces/run/file": "workspace", "config/instance.key": "credential"}
	for name, body := range classes {
		write(t, filepath.Join(f.state, name), body, 0600)
	}

	at := time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)
	backup, err := hostbackup.Backup(t.Context(), hostbackup.BackupConfig{FreeSpaceFloor: 1 << 20, State: f.state, Version: hostbackup.Version{Release: "1.2.3", Schema: 2, PostgresMajor: 18}, Authority: &liveDatabase{database: live, at: at}, Cloner: hostbackup.APFSCloner{}})
	require.NoError(t, err)
	require.Equal(t, filepath.Join(f.state, "backups", "1.2.3-20261007T010203.000000000Z"), backup)
	info, err := os.Stat(backup)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0700), info.Mode().Perm())
	info, err = os.Stat(filepath.Join(backup, "state/config/secrets.json"))
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0600), info.Mode().Perm())
	require.NoDirExists(t, filepath.Join(backup, "state/postgres"), "the live data directory is never cloned")

	// Later work, which a restore discards and keeps aside.
	f.query(live, "INSERT INTO backup_proof VALUES ('d','four'); UPDATE backup_proof SET value='changed' WHERE key='a'")
	write(t, filepath.Join(f.state, "repositories/o/r/proof"), "later", 0600)
	const mutated = "a=changed\nb=two\nc=three\nd=four"
	require.Equal(t, mutated, f.rows(live))
	installed := hostbackup.Version{Release: "1.3.0", Schema: 3, PostgresMajor: 18}

	t.Run("another account restores the backup while this install runs", func(t *testing.T) {
		other := filepath.Join(installState(t), "Smithers")
		var calls []string
		authority := f.authority(other, &calls, func(bundle string) {
			require.Empty(t, bundle, "a plain backup holds no bundle; the installed one starts")
			marker, err := os.ReadFile(filepath.Join(other, ".upgrade-incomplete"))
			require.NoError(t, err)
			require.Equal(t, backup+"\n", string(marker))
			restored := f.start(other)
			defer f.stop(restored)
			require.Equal(t, seeded, f.rows(restored))
		})
		restoredAt, err := hostbackup.Restore(t.Context(), hostbackup.RestoreConfig{State: other, Backup: backup, Version: installed, Authority: authority, Cloner: hostbackup.APFSCloner{}})
		require.NoError(t, err)
		require.Equal(t, at, restoredAt)
		require.Equal(t, []string{"isolation", "start"}, calls)
		info, err := os.Stat(other)
		require.NoError(t, err)
		require.Equal(t, os.FileMode(0700), info.Mode().Perm())
		proof, err := os.ReadFile(filepath.Join(other, "repositories/o/r/proof"))
		require.NoError(t, err)
		require.Equal(t, "files", string(proof))
		info, err = os.Stat(filepath.Join(other, "config/secrets.json"))
		require.NoError(t, err)
		require.Equal(t, os.FileMode(0600), info.Mode().Perm())
		for name, body := range classes {
			restored, err := os.ReadFile(filepath.Join(other, name))
			require.NoError(t, err, name)
			require.Equal(t, body, string(restored), name)
		}
		version, err := os.ReadFile(filepath.Join(other, "postgres/data/PG_VERSION"))
		require.NoError(t, err)
		require.Equal(t, "18\n", string(version))
		require.NoFileExists(t, filepath.Join(other, ".upgrade-incomplete"))
		require.NoError(t, postgres.Stopped(filepath.Join(other, "postgres")))
	})

	t.Run("a running install is refused untouched", func(t *testing.T) {
		var calls []string
		authority := f.authority(f.state, &calls, func(string) { t.Fatal("started a refused restore") })
		_, err := hostbackup.Restore(t.Context(), hostbackup.RestoreConfig{State: f.state, Backup: backup, Version: installed, Authority: authority, Cloner: hostbackup.APFSCloner{}})
		require.EqualError(t, err, "install_running: restore refuses a running install; run smthrs host stop first")
		require.Empty(t, calls)
		require.Equal(t, mutated, f.rows(live))
		proof, err := os.ReadFile(filepath.Join(f.state, "repositories/o/r/proof"))
		require.NoError(t, err)
		require.Equal(t, "later", string(proof))
		aside, err := filepath.Glob(filepath.Join(f.state, "backups/pre-restore-*"))
		require.NoError(t, err)
		require.Empty(t, aside)
		staged, err := filepath.Glob(filepath.Join(f.state, "backups/.partial-restore-*"))
		require.NoError(t, err)
		require.Empty(t, staged)
		require.NoFileExists(t, filepath.Join(f.state, ".upgrade-incomplete"))
	})

	f.stop(live)
	stopped = true

	t.Run("the stopped install returns to the backup", func(t *testing.T) {
		var calls []string
		authority := f.authority(f.state, &calls, func(string) {
			restored := f.start(f.state)
			defer f.stop(restored)
			require.Equal(t, seeded, f.rows(restored))
			require.Equal(t, want, digest(f.rows(restored)))
		})
		restoredAt, err := hostbackup.Restore(t.Context(), hostbackup.RestoreConfig{State: f.state, Backup: backup, Version: installed, Authority: authority, Cloner: hostbackup.APFSCloner{}})
		require.NoError(t, err)
		require.Equal(t, at, restoredAt)
		require.Equal(t, []string{"isolation", "start"}, calls)
		proof, err := os.ReadFile(filepath.Join(f.state, "repositories/o/r/proof"))
		require.NoError(t, err)
		require.Equal(t, "files", string(proof))
		secrets, err := os.ReadFile(filepath.Join(f.state, "config/secrets.json"))
		require.NoError(t, err)
		require.Equal(t, "install key", string(secrets))
		// The later trees and the later database are moved aside, never deleted.
		aside, err := filepath.Glob(filepath.Join(f.state, "backups/pre-restore-*"))
		require.NoError(t, err)
		require.Len(t, aside, 1)
		later, err := os.ReadFile(filepath.Join(aside[0], "repositories/o/r/proof"))
		require.NoError(t, err)
		require.Equal(t, "later", string(later))
		require.FileExists(t, filepath.Join(aside[0], "postgres/data/PG_VERSION"))
		require.NoFileExists(t, filepath.Join(f.state, ".upgrade-incomplete"))
		require.DirExists(t, backup, "the backup itself survives its restore")
	})
}

// A dump the bundled pg_restore rejects never reaches the live install: the
// staged database is stopped, nothing moves and no marker is left.
func TestRealRestoreRefusesADumpPostgresRejects(t *testing.T) {
	bin, major := testdb.Tools(t)
	require.Equal(t, 18, major)
	f := realInstall{t: t, bin: bin, state: installState(t)}
	write(t, filepath.Join(f.state, "config/secrets.json"), "backup key", 0600)
	backup, err := hostbackup.Backup(t.Context(), hostbackup.BackupConfig{FreeSpaceFloor: 1 << 20, State: f.state, Version: hostbackup.Version{Release: "1.2.3", Schema: 2, PostgresMajor: 18}, Cloner: hostbackup.APFSCloner{},
		Authority: &liveDatabase{at: time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC), dump: func(target io.Writer) error {
			_, err := io.WriteString(target, "PGDMP is not followed by a dump")
			return err
		}}})
	require.NoError(t, err)
	write(t, filepath.Join(f.state, "config/secrets.json"), "live key", 0600)

	var calls []string
	authority := f.authority(f.state, &calls, func(string) { t.Fatal("started a refused restore") })
	_, err = hostbackup.Restore(t.Context(), hostbackup.RestoreConfig{State: f.state, Backup: backup, Version: hostbackup.Version{Release: "1.3.0", Schema: 3, PostgresMajor: 18}, Authority: authority, Cloner: hostbackup.APFSCloner{}})
	require.ErrorContains(t, err, "packaged pg_restore failed")
	require.Equal(t, []string{"isolation"}, calls)
	secrets, err := os.ReadFile(filepath.Join(f.state, "config/secrets.json"))
	require.NoError(t, err)
	require.Equal(t, "live key", string(secrets))
	require.NoFileExists(t, filepath.Join(f.state, ".upgrade-incomplete"))
	require.NoDirExists(t, filepath.Join(f.state, "postgres"))
	aside, err := filepath.Glob(filepath.Join(f.state, "backups/pre-restore-*"))
	require.NoError(t, err)
	require.Empty(t, aside)
	staged, err := filepath.Glob(filepath.Join(f.state, "backups/.partial-restore-*/postgres"))
	require.NoError(t, err)
	require.Len(t, staged, 1)
	require.NoError(t, postgres.Stopped(staged[0]), "the staged database is stopped after a failed load")
}

func TestRestoreAuthorityRefusals(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("installing user required")
	}
	t.Run("an answering owner socket is a running install", func(t *testing.T) {
		state := installState(t)
		require.NoError(t, os.Mkdir(filepath.Join(state, "run"), 0700))
		listener, err := net.Listen("unix", filepath.Join(state, "run/host.sock"))
		require.NoError(t, err)
		defer listener.Close()
		authority := &restoreAuthority{state: state}
		require.EqualError(t, authority.CheckStopped(t.Context()), "install_running: restore refuses a running install; run smthrs host stop first")
		require.NoError(t, listener.Close())
		require.NoError(t, authority.CheckStopped(t.Context()))
	})
	t.Run("a state root that never held an install is stopped and stays absent", func(t *testing.T) {
		state := filepath.Join(installState(t), "Smithers")
		require.NoError(t, (&restoreAuthority{state: state}).CheckStopped(t.Context()))
		require.NoDirExists(t, state)
	})
	t.Run("a held database lock is a running install", func(t *testing.T) {
		state := installState(t)
		require.NoError(t, os.Mkdir(filepath.Join(state, "postgres"), 0700))
		lock, err := os.OpenFile(filepath.Join(state, "postgres/owner.lock"), os.O_CREATE|os.O_RDWR, 0600)
		require.NoError(t, err)
		defer lock.Close()
		require.NoError(t, flockExclusive(lock))
		require.EqualError(t, (&restoreAuthority{state: state}).CheckStopped(t.Context()), "install_running: restore refuses a running install; run smthrs host stop first")
	})
	t.Run("cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		require.ErrorIs(t, (&restoreAuthority{state: installState(t)}).CheckStopped(ctx), context.Canceled)
	})
	t.Run("absent isolation and lifecycle refuse", func(t *testing.T) {
		authority := &restoreAuthority{state: installState(t)}
		require.EqualError(t, authority.CheckRetainedIsolation(t.Context(), hostbackup.Manifest{}), "host_maintenance_unavailable: restore requires microVM isolation for retained machine disks")
		require.EqualError(t, authority.StartRestored(t.Context(), ""), "host_maintenance_unavailable: restore requires the recovery start lifecycle")
	})
	t.Run("the database loads only into a fresh staging root of the bundled major", func(t *testing.T) {
		stage := installState(t)
		root, err := os.OpenRoot(stage)
		require.NoError(t, err)
		defer root.Close()
		authority := &restoreAuthority{state: installState(t), postgres: postgres.Config{BinDir: "/nonexistent/postgres/bin", Major: 18}}
		err = authority.RestoreDatabase(t.Context(), root, strings.NewReader("dump"), hostbackup.Version{Release: "1.2.3", Schema: 2, PostgresMajor: 17})
		require.EqualError(t, err, "wrong_version: postgres major")
		require.NoError(t, os.Mkdir(filepath.Join(stage, "postgres"), 0700))
		err = authority.RestoreDatabase(t.Context(), root, strings.NewReader("dump"), hostbackup.Version{Release: "1.2.3", Schema: 2, PostgresMajor: 18})
		require.EqualError(t, err, "unsafe_path: postgres")
		entries, err := os.ReadDir(filepath.Join(stage, "postgres"))
		require.NoError(t, err)
		require.Empty(t, entries)
	})
}

// A backup restores from nothing but its own directory. It is archived,
// extracted under a state root with a different absolute path, and the
// original state is deleted before the restore: the second Mac of C-REL-06
// holds only what tar carried.
func TestRealRestoreFromAnArchivedBackupOnAnotherStateRoot(t *testing.T) {
	bin, major := testdb.Tools(t)
	require.Equal(t, 18, major)
	f := realInstall{t: t, bin: bin, state: installState(t)}
	const seeded = "a=one\nb=two\nc=three"
	live := f.start(f.state)
	f.query(live, "CREATE TABLE backup_proof(key text PRIMARY KEY, value text NOT NULL); INSERT INTO backup_proof VALUES ('a','one'),('b','two'),('c','three')")
	write(t, filepath.Join(f.state, "config/secrets.json"), "install key", 0600)
	write(t, filepath.Join(f.state, "workspaces/run/file"), "workspace", 0600)
	require.NoError(t, os.Symlink("../run/file", filepath.Join(f.state, "workspaces/run/readme")))
	at := time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)
	backup, err := hostbackup.Backup(t.Context(), hostbackup.BackupConfig{FreeSpaceFloor: 1 << 20, State: f.state, Version: hostbackup.Version{Release: "1.2.3", Schema: 2, PostgresMajor: 18}, Authority: &liveDatabase{database: live, at: at}, Cloner: hostbackup.APFSCloner{}})
	require.NoError(t, err)
	f.stop(live)

	// No path in a backup is absolute: the manifest never names this state root.
	manifest, err := os.ReadFile(filepath.Join(backup, "MANIFEST.json"))
	require.NoError(t, err)
	require.NotContains(t, string(manifest), f.state)
	require.NotContains(t, string(manifest), `"path": "/`)
	require.NotContains(t, string(manifest), `"link": "/`)

	archive := filepath.Join(installState(t), "backup.tar")
	out, err := exec.Command("/usr/bin/tar", "-C", filepath.Dir(backup), "-cf", archive, filepath.Base(backup)).CombinedOutput()
	require.NoError(t, err, string(out))
	other := filepath.Join(installState(t), "Library/Application Support/Smithers")
	require.NoError(t, os.MkdirAll(filepath.Join(other, "backups"), 0700))
	require.NoError(t, os.Chmod(other, 0700))
	out, err = exec.Command("/usr/bin/tar", "-C", filepath.Join(other, "backups"), "-xf", archive).CombinedOutput()
	require.NoError(t, err, string(out))
	require.NoError(t, os.RemoveAll(f.state))
	carried := filepath.Join(other, "backups", "1.2.3-20261007T010203.000000000Z")
	info, err := os.Stat(carried)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0700), info.Mode().Perm())

	var calls []string
	authority := f.authority(other, &calls, func(bundle string) {
		require.Empty(t, bundle)
		restored := f.start(other)
		defer f.stop(restored)
		require.Equal(t, seeded, f.rows(restored))
	})
	restoredAt, err := hostbackup.Restore(t.Context(), hostbackup.RestoreConfig{State: other, Backup: carried, Version: hostbackup.Version{Release: "1.2.3", Schema: 2, PostgresMajor: 18}, Authority: authority, Cloner: hostbackup.APFSCloner{}})
	require.NoError(t, err)
	require.Equal(t, at, restoredAt)
	require.Equal(t, []string{"isolation", "start"}, calls)
	secrets, err := os.ReadFile(filepath.Join(other, "config/secrets.json"))
	require.NoError(t, err)
	require.Equal(t, "install key", string(secrets))
	info, err = os.Stat(filepath.Join(other, "config/secrets.json"))
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0600), info.Mode().Perm())
	target, err := os.Readlink(filepath.Join(other, "workspaces/run/readme"))
	require.NoError(t, err)
	require.Equal(t, "../run/file", target)
	through, err := os.ReadFile(filepath.Join(other, "workspaces/run/readme"))
	require.NoError(t, err)
	require.Equal(t, "workspace", string(through))
	require.NoFileExists(t, filepath.Join(other, ".upgrade-incomplete"))
	require.DirExists(t, carried)
}

// The restore command itself, dispatched as the installed bundle's backend:
// it verifies the backup, runs the bundle's doctor, loads the dump with the
// bundle's PostgreSQL programs, moves the live trees aside, grants and runs
// the bundle's `smthrs host start --bundle`, and clears the marker. The
// bundle is a fixture whose PostgreSQL members exec the real PostgreSQL 18
// programs; its doctor and CLI record how they were run. launchd and a real
// microVM doctor are the Mac mini's to prove.
func TestRealDispatchedRestoreRunsFromTheInstalledBundle(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("installing user required")
	}
	bin, major := testdb.Tools(t)
	require.Equal(t, 18, major)
	old := compose.BuildVersion
	compose.BuildVersion = "1.3.0"
	t.Cleanup(func() { compose.BuildVersion = old })

	// The install that was backed up.
	source := realInstall{t: t, bin: bin, state: installState(t)}
	const seeded = "a=one\nb=two\nc=three"
	database := source.start(source.state)
	source.query(database, "CREATE TABLE backup_proof(key text PRIMARY KEY, value text NOT NULL); INSERT INTO backup_proof VALUES ('a','one'),('b','two'),('c','three')")
	write(t, filepath.Join(source.state, "repositories/o/r/proof"), "files", 0600)
	write(t, filepath.Join(source.state, "config/secrets.json"), "install key", 0600)
	at := time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)
	backup, err := hostbackup.Backup(t.Context(), hostbackup.BackupConfig{FreeSpaceFloor: 1 << 20, State: source.state, Version: hostbackup.Version{Release: "1.2.3", Schema: 2, PostgresMajor: 18}, Authority: &liveDatabase{database: database, at: at}, Cloner: hostbackup.APFSCloner{}})
	require.NoError(t, err)
	source.stop(database)

	// This Mac: a stopped install with later data, under the owner's home.
	home, err := os.MkdirTemp("/tmp", "ins07-")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, os.RemoveAll(home)) })
	home, err = filepath.EvalSymlinks(home)
	require.NoError(t, err)
	t.Setenv("HOME", home)
	hostile(t)
	state := filepath.Join(home, "Library/Application Support/Smithers")
	require.NoError(t, os.MkdirAll(state, 0700))
	write(t, filepath.Join(state, "config/secrets.json"), "live key", 0600)

	record := filepath.Join(t.TempDir(), "record")
	programs := map[string]string{
		"bin/smithers-backend": "#!/bin/sh\nprintf 'doctor %s\\n' \"$*\" >> '" + record + "'\n/usr/bin/env | /usr/bin/sed 's/=.*//' | /usr/bin/sort | /usr/bin/tr '\\n' ' ' >> '" + record + "'\necho >> '" + record + "'\nexit 0\n",
		"bin/smthrs": "#!/bin/sh\nprintf 'start %s\\n' \"$*\" >> '" + record + "'\n" +
			"printf 'marker ' >> '" + record + "'\n/bin/cat \"$HOME/Library/Application Support/Smithers/.upgrade-incomplete\" >> '" + record + "'\n" +
			"printf 'grant ' >> '" + record + "'\n/bin/cat \"$HOME/Library/Application Support/Smithers/backups/.recovery-start\" >> '" + record + "'\nexit 3\n",
	}
	for _, program := range postgresPrograms {
		programs["postgres/root/bin/"+program] = "#!/bin/sh\nexec '" + filepath.Join(bin, program) + "' \"$@\"\n"
	}
	bundle := newMaintenanceBundle(t, programs)

	stdout := os.Stdout
	reader, writer, err := os.Pipe()
	require.NoError(t, err)
	os.Stdout = writer
	handled, restoreErr := DispatchMaintenance(t.Context(), []string{"host-maintenance", "restore", backup}, bundle.executable)
	os.Stdout = stdout
	// The variables that were hostile to the command would also break this
	// test's own psql; the children above ran with them exported.
	for _, name := range []string{"DYLD_INSERT_LIBRARIES", "PGPASSFILE", "SMITHERS_DATABASE_URL", "GIT_SSH_COMMAND"} {
		require.NoError(t, os.Unsetenv(name))
	}
	require.NoError(t, writer.Close())
	printed, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.True(t, handled)
	require.NoError(t, restoreErr)
	require.Equal(t, "2026-10-07T01:02:03Z\n", string(printed), "the command prints the backup's time and nothing else")

	recorded, err := os.ReadFile(record)
	require.NoError(t, err)
	lines := strings.Split(strings.TrimSpace(string(recorded)), "\n")
	require.Len(t, lines, 5, string(recorded))
	require.Equal(t, "doctor microvm doctor", lines[0])
	names := strings.Fields(lines[1])
	for _, name := range names {
		require.Contains(t, []string{"HOME", "PATH", "SMITHERS_DATA_ROOT", "PWD", "SHLVL", "_", "OLDPWD"}, name, "the doctor inherited %s", name)
	}
	require.Contains(t, names, "SMITHERS_DATA_ROOT")
	require.Equal(t, "start host start --bundle "+bundle.root, lines[2])
	require.Equal(t, "marker "+backup, lines[3], "the start ran while the marker recorded this backup")
	var grant recoveryGrant
	require.NoError(t, json.Unmarshal([]byte(strings.TrimPrefix(lines[4], "grant ")), &grant))
	require.Equal(t, backup, grant.Backup)
	require.Equal(t, os.Getpid(), grant.PID)

	require.NoFileExists(t, filepath.Join(state, ".upgrade-incomplete"))
	require.NoFileExists(t, filepath.Join(state, recoveryGrantPath))
	proof, err := os.ReadFile(filepath.Join(state, "repositories/o/r/proof"))
	require.NoError(t, err)
	require.Equal(t, "files", string(proof))
	secrets, err := os.ReadFile(filepath.Join(state, "config/secrets.json"))
	require.NoError(t, err)
	require.Equal(t, "install key", string(secrets))
	aside, err := filepath.Glob(filepath.Join(state, "backups/pre-restore-*/config/secrets.json"))
	require.NoError(t, err)
	require.Len(t, aside, 1)
	later, err := os.ReadFile(aside[0])
	require.NoError(t, err)
	require.Equal(t, "live key", string(later))

	restored := realInstall{t: t, bin: bin, state: state}
	instance := restored.start(state)
	defer restored.stop(instance)
	require.Equal(t, seeded, restored.rows(instance))
}

// The dispatched command refuses, with the live install untouched, when its
// bundle cannot prove isolation or when the install is running.
func TestDispatchedRestoreRefusesBeforeMovingLiveData(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("installing user required")
	}
	old := compose.BuildVersion
	compose.BuildVersion = "1.3.0"
	t.Cleanup(func() { compose.BuildVersion = old })
	for _, tc := range []struct {
		name, refusal string
		programs      map[string]string
		running       bool
	}{
		{name: "the doctor fails", programs: map[string]string{"bin/smithers-backend": "#!/bin/sh\nexit 1\n"}, refusal: "host_maintenance_unavailable: microVM isolation is not ready on this Mac; run smthrs host status"},
		{name: "the install is running", running: true, refusal: "install_running: restore refuses a running install; run smthrs host stop first"},
		{name: "the bundle packages no PostgreSQL index", programs: map[string]string{"postgres/bundle.json": "{}"}, refusal: "host_maintenance_unavailable: restore runs from an installed bundle: not approved by the installed bundle: postgres/bundle.json is invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home, err := os.MkdirTemp("/tmp", "ins07-")
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, os.RemoveAll(home)) })
			t.Setenv("HOME", home)
			state := filepath.Join(home, "Library/Application Support/Smithers")
			require.NoError(t, os.MkdirAll(filepath.Join(state, "run"), 0700))
			write(t, filepath.Join(state, "config/secrets.json"), "live key", 0600)
			if tc.running {
				listener, err := net.Listen("unix", filepath.Join(state, "run/host.sock"))
				require.NoError(t, err)
				defer listener.Close()
			}
			bundle := newMaintenanceBundle(t, tc.programs)
			handled, err := DispatchMaintenance(t.Context(), []string{"host-maintenance", "restore", jsonBackup(t)}, bundle.executable)
			require.True(t, handled)
			require.EqualError(t, err, tc.refusal)
			secrets, err := os.ReadFile(filepath.Join(state, "config/secrets.json"))
			require.NoError(t, err)
			require.Equal(t, "live key", string(secrets))
			for _, absent := range []string{".upgrade-incomplete", "backups", "postgres"} {
				_, err := os.Lstat(filepath.Join(state, absent))
				require.True(t, os.IsNotExist(err), "%s exists after a refused restore", absent)
			}
		})
	}
}

// previousRelease is the old release's upgrade: its backup comes from the
// supervised database, and Homebrew, the bundle swap and the continuation
// are the production adapters.
type previousRelease struct {
	*liveDatabase
	*upgradeAuthority
}

// A failed upgrade rolls back. The old release backs up with its bundle and
// writes the marker; Homebrew (a stand-in that repoints the link and deletes
// the old keg, as `brew cleanup` does) installs the next release; that
// release cannot finish and refuses. The command exits with the marker in
// place and one restore command. Running it returns the rows to the backup's
// and starts the previous release from the bundle the backup kept, although
// its keg is gone. PostgreSQL 18 and the kernel clone are real.
func TestRealFailedUpgradeRestoresThePreviousRelease(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("installing user required")
	}
	bin, major := testdb.Tools(t)
	require.Equal(t, 18, major)
	release(t, "1.3.0")
	_, state := ownerHome(t)
	install := realInstall{t: t, bin: bin, state: state}
	const seeded = "a=one\nb=two\nc=three"
	live := install.start(state)
	stopped := false
	t.Cleanup(func() {
		if !stopped {
			install.stop(live)
		}
	})
	install.query(live, "CREATE TABLE backup_proof(key text PRIMARY KEY, value text NOT NULL); INSERT INTO backup_proof VALUES ('a','one'),('b','two'),('c','three')")
	write(t, filepath.Join(state, "config/secrets.json"), "install key", 0600)

	wrappers := func(programs map[string]string) map[string]string {
		for _, program := range postgresPrograms {
			programs["postgres/root/bin/"+program] = "#!/bin/sh\nexec '" + filepath.Join(bin, program) + "' \"$@\"\n"
		}
		return programs
	}
	const previousBackend = "#!/bin/sh\n# release 1.2.3\nexit 0\n"
	previous := newMaintenanceBundle(t, wrappers(map[string]string{"bin/smithers-backend": previousBackend}))
	record := filepath.Join(t.TempDir(), "record")
	next := newMaintenanceBundle(t, wrappers(map[string]string{
		"bin/smithers-backend": "#!/bin/sh\n# release 1.3.0\nexit 0\n",
		"bin/smthrs":           "#!/bin/sh\nprintf 'start %s\\n' \"$*\" >> '" + record + "'\nexit 3\n",
	}))
	homebrew := t.TempDir()
	keg, brew := filepath.Join(homebrew, "opt/smithers/libexec"), filepath.Join(homebrew, "bin/brew")
	require.NoError(t, os.MkdirAll(filepath.Dir(keg), 0755))
	require.NoError(t, os.MkdirAll(filepath.Dir(brew), 0755))
	require.NoError(t, os.Symlink(previous.root, keg))
	require.NoError(t, os.WriteFile(brew, []byte("#!/bin/sh\n[ \"$*\" = 'upgrade smithers' ] || exit 64\n/bin/rm '"+keg+"' && /bin/ln -s '"+next.root+"' '"+keg+"' && /bin/rm -rf '"+previous.root+"'\n"), 0755))

	host, err := openMaintenanceHost(previous.executable, state)
	require.NoError(t, err)
	at := time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)
	authority := previousRelease{
		liveDatabase: &liveDatabase{database: live, at: at},
		upgradeAuthority: &upgradeAuthority{host: host, brew: brew, keg: keg, healthWake: func(context.Context, string) error { return nil },
			// execve would replace this test; the upgraded backend's command
			// is dispatched in its place.
			replace: func(program string, args, _ []string) error {
				require.Equal(t, next.path("bin/smithers-backend"), program)
				_, err := DispatchMaintenance(t.Context(), args[1:], next.executable)
				return err
			}},
	}
	backup, err := hostbackup.Upgrade(t.Context(), hostbackup.UpgradeConfig{
		BackupConfig: hostbackup.BackupConfig{FreeSpaceFloor: 1 << 20, State: state, Bundle: previous.root, Version: hostbackup.Version{Release: "1.2.3", Schema: 2, PostgresMajor: 18}, Cloner: hostbackup.APFSCloner{}},
		Upgrade:      authority,
	})
	require.Equal(t, filepath.Join(state, "backups", "1.2.3-20261007T010203.000000000Z"), backup)
	// The refusal and its restore command appear twice only because the
	// upgraded backend's command returned here instead of replacing the
	// process: each release wraps the failure once.
	require.EqualError(t, err, "upgrade incomplete: upgrade incomplete: host_maintenance_unavailable: upgrade health wake requires machine admission (T-MCH-06); restore with smthrs host restore '"+backup+"'; restore with smthrs host restore '"+backup+"'")
	marker, err := os.ReadFile(filepath.Join(state, ".upgrade-incomplete"))
	require.NoError(t, err)
	require.Equal(t, backup+"\n", string(marker))
	require.NoDirExists(t, previous.root, "Homebrew removed the previous keg")
	linked, err := filepath.EvalSymlinks(keg)
	require.NoError(t, err)
	require.Equal(t, next.root, linked)
	require.Error(t, requireStartAllowed(state), "the next plain start refuses")
	require.NoFileExists(t, record, "the upgraded release started nothing")

	// Work after the backup is lost by the restore, and kept aside.
	install.query(live, "INSERT INTO backup_proof VALUES ('d','four')")
	install.stop(live)
	stopped = true

	handled, err := DispatchMaintenance(t.Context(), []string{"host-maintenance", "restore", backup}, next.executable)
	require.True(t, handled)
	require.NoError(t, err)
	recorded, err := os.ReadFile(record)
	require.NoError(t, err)
	require.Equal(t, "start host start --bundle "+filepath.Join(state, "bundle")+"\n", string(recorded), "the previous release starts from the bundle the backup kept")
	kept, err := os.ReadFile(filepath.Join(state, "bundle/bin/smithers-backend"))
	require.NoError(t, err)
	require.Equal(t, previousBackend, string(kept))
	require.NoFileExists(t, filepath.Join(state, ".upgrade-incomplete"))
	require.NoFileExists(t, filepath.Join(state, recoveryGrantPath))
	require.NoError(t, requireStartAllowed(state))
	restored := install.start(state)
	defer install.stop(restored)
	require.Equal(t, seeded, install.rows(restored))
	aside, err := filepath.Glob(filepath.Join(state, "backups/pre-restore-*/postgres/data/PG_VERSION"))
	require.NoError(t, err)
	require.Len(t, aside, 1, "the later database is kept aside")
}

// everything records every entry below root: its type and mode, and its
// bytes' digest or its link target. Two equal inventories mean nothing was
// created, removed, rewritten, retargeted or had its mode changed.
func everything(t *testing.T, root string) map[string]string {
	t.Helper()
	entries := map[string]string{}
	require.NoError(t, filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			entries[relative] = info.Mode().String() + " -> " + target
		case info.Mode().IsRegular():
			body, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			entries[relative] = info.Mode().String() + " " + digest(string(body))
		default:
			entries[relative] = info.Mode().String()
		}
		return nil
	}))
	return entries
}

// The restore command refuses a backup whose MANIFEST records a link that
// resolves outside its tree: an absolute target, a chain of "..", a path
// through another link, and a link to a link that escapes. Each crafted link
// really reaches a directory outside the backup, and the manifest lists it,
// so only confinement can refuse it. Everything under the owner's home (the
// outside directory, the live install and the backup itself) is byte for
// byte, mode for mode what it was, and no bundled program ran.
func TestDispatchedRestoreRefusesManifestLinksThatLeaveTheBackup(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("installing user required")
	}
	release(t, "1.3.0")
	for _, tc := range []struct {
		name string
		// links maps a path in the backup to its target. In a target,
		// "<absolute>" is the outside directory's absolute path, "<outside>"
		// the path to it from the link's directory, written with "..", and
		// "<outside from run>" the same from the run/ directory beside the
		// link, where the in-tree link self points at ".".
		links   map[string]string
		escapes string
		refused string
	}{
		{name: "absolute target", links: map[string]string{"state/repositories": "<absolute>"}, escapes: "state/repositories", refused: "state/repositories"},
		{name: "chain of ..", links: map[string]string{"state/workspaces/escape": "<outside>"}, escapes: "state/workspaces/escape", refused: "state/workspaces/escape"},
		{name: "through another link", links: map[string]string{"state/workspaces/via": "run/self/<outside from run>"}, escapes: "state/workspaces/via", refused: "state/workspaces/via"},
		{name: "a link to a link that escapes", links: map[string]string{"state/workspaces/hop": "hop2", "state/workspaces/hop2": "<outside>"}, escapes: "state/workspaces/hop", refused: "state/workspaces/hop"},
		{name: "inside the backup but outside its tree", links: map[string]string{"state/workspaces/dump": "../../postgres.dump"}, refused: "state/workspaces/dump"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home, state := ownerHome(t)
			outside := filepath.Join(home, "outside")
			write(t, filepath.Join(outside, "sentinel"), "outside bytes", 0640)
			write(t, filepath.Join(state, "config/secrets.json"), "live key", 0600)

			// A real backup, published by the backup coordinator.
			source := filepath.Join(home, "source")
			write(t, filepath.Join(source, "workspaces/run/file"), "x", 0600)
			require.NoError(t, os.Symlink(".", filepath.Join(source, "workspaces/run/self")))
			published, err := hostbackup.Backup(t.Context(), hostbackup.BackupConfig{FreeSpaceFloor: 1 << 20, State: source, Version: hostbackup.Version{Release: "1.2.3", Schema: 2, PostgresMajor: 18}, Cloner: hostbackup.APFSCloner{},
				Authority: &liveDatabase{at: time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC), dump: func(target io.Writer) error {
					_, err := io.WriteString(target, "PGDMP fixture")
					return err
				}}})
			require.NoError(t, err)
			require.NoError(t, os.Mkdir(filepath.Join(state, "backups"), 0700))
			backup := filepath.Join(state, "backups", filepath.Base(published))
			require.NoError(t, os.Rename(published, backup))
			require.NoError(t, os.RemoveAll(source))
			_, err = hostbackup.VerifySnapshot(backup)
			require.NoError(t, err, "the backup is valid before it is crafted")

			// Craft it: plant each link and record it in the manifest.
			raw, err := os.ReadFile(filepath.Join(backup, "MANIFEST.json"))
			require.NoError(t, err)
			var manifest hostbackup.Manifest
			require.NoError(t, json.Unmarshal(raw, &manifest))
			for path, target := range tc.links {
				link := filepath.Join(backup, path)
				climb, err := filepath.Rel(filepath.Dir(link), outside)
				require.NoError(t, err)
				fromRun, err := filepath.Rel(filepath.Join(filepath.Dir(link), "run"), outside)
				require.NoError(t, err)
				for _, relative := range []string{climb, fromRun} {
					require.True(t, strings.HasPrefix(relative, "../../../"), relative)
					require.False(t, filepath.IsAbs(relative))
				}
				target = strings.NewReplacer("<outside from run>", fromRun, "<outside>", climb, "<absolute>", outside).Replace(target)
				t.Logf("%s -> %s", path, target)
				require.NoError(t, os.MkdirAll(filepath.Dir(link), 0700))
				require.NoError(t, os.Symlink(target, link))
				manifest.Files = append(manifest.Files, hostbackup.File{Path: path, Link: target})
			}
			raw, err = json.Marshal(manifest)
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(filepath.Join(backup, "MANIFEST.json"), raw, 0600))
			if tc.escapes != "" {
				// Not a vacuous case: followed, the link reaches the outside directory.
				reached, err := filepath.EvalSymlinks(filepath.Join(backup, tc.escapes))
				require.NoError(t, err)
				require.Equal(t, outside, reached)
				through, err := os.ReadFile(filepath.Join(backup, tc.escapes, "sentinel"))
				require.NoError(t, err)
				require.Equal(t, "outside bytes", string(through))
			}

			record := filepath.Join(t.TempDir(), "record")
			ran := "#!/bin/sh\necho ran >> '" + record + "'\nexit 0\n"
			bundle := newMaintenanceBundle(t, map[string]string{"bin/smithers-backend": ran, "bin/smthrs": ran})
			before := everything(t, home)

			handled, err := DispatchMaintenance(t.Context(), []string{"host-maintenance", "restore", backup}, bundle.executable)
			require.True(t, handled)
			require.EqualError(t, err, "unsafe_path: "+tc.refused)

			require.Equal(t, before, everything(t, home), "nothing under the owner's home changed")
			require.NoFileExists(t, record, "no bundled program ran")
			sentinel, err := os.ReadFile(filepath.Join(outside, "sentinel"))
			require.NoError(t, err)
			require.Equal(t, "outside bytes", string(sentinel))
			entries, err := os.ReadDir(outside)
			require.NoError(t, err)
			require.Len(t, entries, 1, "nothing was written into the outside directory")
		})
	}
}
