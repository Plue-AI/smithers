package postgres

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMaintenanceRequiresOwnedLiveInstance(t *testing.T) {
	for _, p := range []*Instance{nil, {}, {binDir: "relative", done: make(chan struct{})}} {
		if _, err := p.DatabaseSize(t.Context()); err == nil {
			t.Fatal("size accepted absent authority")
		}
		if err := p.Dump(t.Context(), io.Discard); err == nil {
			t.Fatal("dump accepted absent authority")
		}
		if err := p.RestoreDump(t.Context(), strings.NewReader("dump")); err == nil {
			t.Fatal("restore accepted absent authority")
		}
	}
	done := make(chan struct{})
	close(done)
	p := &Instance{binDir: "/owned/tools", done: done}
	if err := p.Dump(t.Context(), io.Discard); err == nil || err.Error() != "owned postgres is stopped" {
		t.Fatal(err)
	}
	p.done = make(chan struct{})
	if err := p.Dump(t.Context(), nil); err == nil {
		t.Fatal("nil writer accepted")
	}
	if err := p.RestoreDump(t.Context(), nil); err == nil {
		t.Fatal("nil reader accepted")
	}
	for _, connection := range []string{"postgres://127.0.0.1:123/postgres", "postgres://smithers:password@outside:123/postgres", "postgres://smithers:password@127.0.0.1:123/other", "postgres://smithers@127.0.0.1:123/postgres", "://"} {
		p.ConnectionString = connection
		if err := p.Dump(context.Background(), io.Discard); err == nil {
			t.Fatal("invalid connection accepted")
		}
	}
}

// The packaged tools take the database password from their environment,
// never from a command line: any host user can read another process's
// arguments. The password is the retired backup scripts' fixture, with the
// characters a connection URL must escape.
func TestMaintenanceToolsNeverReceiveThePasswordInArgv(t *testing.T) {
	p := &Instance{binDir: "/owned/tools", done: make(chan struct{}), ConnectionString: "postgres://smithers:hunter%402%2F%25@127.0.0.1:54321/postgres?sslmode=disable"}
	for _, program := range []string{"pg_dump", "pg_restore"} {
		cmd, err := p.maintenanceCommand(t.Context(), program, "--format=custom")
		if err != nil {
			t.Fatal(err)
		}
		if cmd.Path != "/owned/tools/"+program {
			t.Fatalf("%s resolved outside the packaged tools: %s", program, cmd.Path)
		}
		for _, argument := range cmd.Args {
			if strings.Contains(argument, "hunter") || strings.Contains(argument, "postgres://") {
				t.Fatalf("%s argument carries the credential: %q", program, argument)
			}
		}
		environment := map[string]string{}
		for _, entry := range cmd.Env {
			name, value, _ := strings.Cut(entry, "=")
			environment[name] = value
		}
		for name, want := range map[string]string{"PGPASSWORD": "hunter@2/%", "PGHOST": "127.0.0.1", "PGPORT": "54321", "PGUSER": "smithers", "PGDATABASE": "postgres"} {
			if environment[name] != want {
				t.Fatalf("%s %s = %q, want %q", program, name, environment[name], want)
			}
		}
		// An inherited libpq variable must not choose another database,
		// service file or credential store.
		for _, name := range []string{"PGSERVICE", "PGSERVICEFILE", "PGPASSFILE", "PGOPTIONS", "PGHOSTADDR"} {
			if _, inherited := environment[name]; inherited {
				t.Fatalf("%s inherited %s", program, name)
			}
		}
	}
}

// A restore never loads over a directory that already holds something.
func TestRestoreIntoRequiresAFreshDirectory(t *testing.T) {
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(state, "password"), []byte("kept"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := Config{BinDir: "/nonexistent/tools", StateDir: state, Major: 18}
	if err := RestoreInto(t.Context(), cfg, strings.NewReader("dump")); err == nil || err.Error() != "restore requires a fresh postgres state directory" {
		t.Fatalf("existing state: %v", err)
	}
	if err := RestoreInto(t.Context(), cfg, nil); err == nil || err.Error() != "restore dump source required" {
		t.Fatalf("absent dump: %v", err)
	}
	kept, err := os.ReadFile(filepath.Join(state, "password"))
	if err != nil || string(kept) != "kept" {
		t.Fatalf("existing state changed: %q %v", kept, err)
	}
}
