package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// A state directory nobody has owned is stopped, and the check leaves it
// exactly as it found it: restore runs it before it creates anything.
func TestStoppedIsReadOnly(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "postgres")
	if err := Stopped(missing); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(missing); !os.IsNotExist(err) {
		t.Fatalf("stopped check created the state directory: %v", err)
	}
	empty := t.TempDir()
	if err := Stopped(empty); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(empty)
	if err != nil || len(entries) != 0 {
		t.Fatalf("stopped check wrote into the state directory: %v %v", entries, err)
	}
	if err := Stopped("relative/postgres"); err == nil || err.Error() != "postgres state directory must be absolute" {
		t.Fatalf("relative state directory: %v", err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(empty, link); err != nil {
		t.Fatal(err)
	}
	if err := Stopped(link); err == nil || err.Error() != "postgres state path must be a directory, not a symbolic link" {
		t.Fatalf("linked state directory: %v", err)
	}
}

// A recorded postmaster PID that is alive refuses unless the owner record
// proves the system reused it for another program.
func TestStoppedIdentifiesARecordedLiveProcess(t *testing.T) {
	state := t.TempDir()
	data := filepath.Join(state, "data")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	// This test process stands in for a live PID named by a stale pid file.
	pid := os.Getpid()
	pidFile := fmt.Sprintf("%d\n%s\n1760000000\n5432\n/tmp\n127.0.0.1\n  5432001         0\nready   \n", pid, data)
	if err := os.WriteFile(filepath.Join(data, "postmaster.pid"), []byte(pidFile), 0600); err != nil {
		t.Fatal(err)
	}
	err := Stopped(state)
	if err == nil || err.Error() != "live postgres has no verifiable Smithers owner record; stop it manually before restoring" {
		t.Fatalf("unrecorded live process: %v", err)
	}
	record := func(value processRecord) {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(state, "postmaster.owner.json"), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	record(processRecord{PID: pid + 1, DataDir: data})
	err = Stopped(state)
	if err == nil || err.Error() != "live postgres owner record does not match its data directory; stop it manually before restoring" {
		t.Fatalf("record for another process: %v", err)
	}
	birth, executable, err := processIdentity(pid)
	if err != nil {
		t.Fatal(err)
	}
	record(processRecord{PID: pid, DataDir: data, Executable: executable, Birth: birth})
	if err := Stopped(state); !errors.Is(err, ErrRunning) {
		t.Fatalf("recorded live process: %v", err)
	}
	record(processRecord{PID: pid, DataDir: data, Executable: executable, Birth: "darwin:1:1"})
	if err := Stopped(state); err != nil {
		t.Fatalf("a reused PID is not this install's postmaster: %v", err)
	}
	// A recorded process that has exited is stopped.
	if err := os.WriteFile(filepath.Join(data, "postmaster.pid"), []byte("2147483646\n"+data+"\n1760000000\n5432\n/tmp\n127.0.0.1\n  5432001         0\nready   \n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := Stopped(state); err != nil {
		t.Fatalf("exited process: %v", err)
	}
}

func TestRealStoppedFollowsTheOwnedPostmaster(t *testing.T) {
	cfg := testConfig(t)
	instance, err := Start(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := Stopped(cfg.StateDir); !errors.Is(err, ErrRunning) {
		stopInstance(t, instance)
		t.Fatalf("running install reported stopped: %v", err)
	}
	stopInstance(t, instance)
	if err := Stopped(cfg.StateDir); err != nil {
		t.Fatalf("stopped install reported running: %v", err)
	}
}
