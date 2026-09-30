package distribution_test

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/postgres"
)

const recoveryOldRelease = "SMITHERS_DISTRIBUTION_VERSION=0.0.9\nSMITHERS_SCHEMA_VERSION=1\nSMITHERS_POSTGRES_MAJOR=18\n"
const recoveryNewRelease = "SMITHERS_DISTRIBUTION_VERSION=0.1.0\nSMITHERS_SCHEMA_VERSION=2\nSMITHERS_POSTGRES_MAJOR=18\n"

func recoveryWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}

func recoveryUpgrade(t *testing.T, backup, data, backend string, env []string, wantExit int) {
	t.Helper()
	cmd := exec.Command("sh", "upgrade.sh", backup)
	cmd.Env = append(os.Environ(), append(env, "SMITHERS_DATA_ROOT="+data, "SMITHERS_BACKEND_BINARY="+backend)...)
	out, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if wantExit == 0 {
		if err != nil {
			t.Fatalf("successful migration: %v %s", err, out)
		}
		got, readErr := os.ReadFile(filepath.Join(data, "version.env"))
		if readErr != nil || string(got) != recoveryNewRelease {
			t.Errorf("new manifest: %q (%v)", got, readErr)
		}
		if !strings.Contains(string(out), "upgraded 0.0.9 to 0.1.0") || strings.Contains(string(out), "upgrade failed") {
			t.Errorf("success output: %q", out)
		}
		if _, markerErr := os.Stat(filepath.Join(data, ".upgrade-incomplete")); !os.IsNotExist(markerErr) {
			t.Errorf("successful upgrade retained marker: %v", markerErr)
		}
		return
	}
	if _, markerErr := os.Stat(filepath.Join(data, ".upgrade-incomplete")); markerErr != nil {
		t.Errorf("failed upgrade has no recovery marker: %v", markerErr)
	}
	if !errors.As(err, &exit) || exit.ExitCode() != wantExit {
		t.Errorf("migration exit code: want %d, got %v; output %s", wantExit, err, out)
	}
	text := strings.ToLower(string(out))
	for _, want := range []string{"upgrade failed", "restore", "later changes are lost", strings.ToLower(backup)} {
		if !strings.Contains(text, want) {
			t.Errorf("missing recovery diagnostic %q: %q", want, out)
		}
	}
	if strings.Contains(text, "upgraded") {
		t.Errorf("failure reported upgrade success: %q", out)
	}
	got, err := os.ReadFile(filepath.Join(data, "version.env"))
	if err != nil || string(got) != recoveryOldRelease {
		t.Errorf("installed manifest changed: %q (%v)", got, err)
	}
}

func TestFailedUpgradeReportsRecovery(t *testing.T) {
	for _, status := range []int{42, 43, 44, 137, 0} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			root := t.TempDir()
			data, backup, bin := filepath.Join(root, "data"), filepath.Join(root, "backup"), filepath.Join(root, "bin")
			recoveryWrite(t, filepath.Join(data, "version.env"), recoveryOldRelease)
			recoveryWrite(t, filepath.Join(root, "new.env"), recoveryNewRelease)
			recoveryWrite(t, filepath.Join(backup, "postgres.dump"), "database")
			if out, err := exec.Command("tar", "-cf", filepath.Join(backup, "files.tar"), "-T", "/dev/null").CombinedOutput(); err != nil {
				t.Fatalf("tar: %v %s", err, out)
			}
			recoveryWrite(t, filepath.Join(backup, "MANIFEST"), recoveryOldRelease+"POSTGRES_SHA256="+hash(t, filepath.Join(backup, "postgres.dump"))+"\nFILES_SHA256="+hash(t, filepath.Join(backup, "files.tar"))+"\n")
			if err := os.MkdirAll(bin, 0700); err != nil {
				t.Fatal(err)
			}
			executable(t, filepath.Join(bin, "flock"), "exit 0")
			if status == 44 {
				executable(t, filepath.Join(bin, "sync"), `case "$1" in *.tmp.*) exit 44;; *) exit 0;; esac`)
			}
			migrationStatus := status
			if status == 44 {
				migrationStatus = 0
			}
			termination := "exit " + strconv.Itoa(migrationStatus)
			if status == 137 {
				termination = `kill -KILL "$$"`
			}
			executable(t, filepath.Join(bin, "backend"), `[ "$#" = 2 ] && [ "$1" = migrate ] && [ "$2" = apply ] || exit 99; [ -s "$SMITHERS_DATA_ROOT/.upgrade-incomplete" ] || exit 98; `+termination)
			recoveryUpgrade(t, backup, data, filepath.Join(bin, "backend"), []string{"PATH=" + bin + ":" + os.Getenv("PATH"), "SMITHERS_LIB=./lib.sh", "SMITHERS_RELEASE_FILE=" + filepath.Join(root, "new.env"), "SMITHERS_DATABASE_URL=postgres://example/db", "DATABASE_URL="}, status)
		})
	}
}

func TestRealFailedUpgradeRecoveryPostgreSQL(t *testing.T) {
	bin := os.Getenv("SMITHERS_POSTGRES_TEST_BIN")
	if bin == "" {
		t.Skip("SMITHERS_POSTGRES_TEST_BIN is required")
	}
	major, err := strconv.Atoi(os.Getenv("SMITHERS_POSTGRES_TEST_MAJOR"))
	if err != nil || major != 18 {
		t.Fatalf("recovery requires PostgreSQL 18, got %q", os.Getenv("SMITHERS_POSTGRES_TEST_MAJOR"))
	}
	root := t.TempDir()
	start := func(name string) *postgres.Instance {
		p, err := postgres.Start(context.Background(), postgres.Config{BinDir: bin, StateDir: filepath.Join(root, name), Major: major, StartupTimeout: 20 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := p.Stop(ctx); err != nil {
				t.Errorf("stop PostgreSQL: %v", err)
			}
		})
		return p
	}
	query := func(p *postgres.Instance, sql string) string {
		cmd := exec.Command(filepath.Join(bin, "psql"), "--dbname="+p.ConnectionString, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("psql: %v %s", err, out)
		}
		return strings.TrimSpace(string(out))
	}
	source := start("source-pg")
	query(source, "CREATE TABLE recovery_proof(value text NOT NULL); INSERT INTO recovery_proof VALUES ('old data')")
	data := filepath.Join(root, "data")
	proofs := map[string]string{"repositories/owner/repo/proof": "repository", "blobs/chat/proof": "chat", "workspaces/run/proof": "workspace", "config/instance.key": "old credential"}
	for name, value := range proofs {
		recoveryWrite(t, filepath.Join(data, name), value)
	}
	recoveryWrite(t, filepath.Join(data, "version.env"), recoveryOldRelease)
	oldRelease, newRelease := filepath.Join(root, "old.env"), filepath.Join(root, "new.env")
	recoveryWrite(t, oldRelease, recoveryOldRelease)
	recoveryWrite(t, newRelease, recoveryNewRelease)
	helpers := filepath.Join(root, "helpers")
	if err := os.Mkdir(helpers, 0700); err != nil {
		t.Fatal(err)
	}
	executable(t, filepath.Join(helpers, "flock"), "exit 0")
	common := []string{"PATH=" + helpers + ":" + bin + ":" + os.Getenv("PATH"), "SMITHERS_LIB=./lib.sh", "DATABASE_URL=", "PGPASSWORD="}
	out, err := run(t, "backup.sh", append(common, "SMITHERS_RELEASE_FILE="+oldRelease, "SMITHERS_DATABASE_URL="+source.ConnectionString, "SMITHERS_DATA_ROOT="+data, "SMITHERS_BACKUP_ROOT="+filepath.Join(root, "backups"))...)
	if err != nil {
		t.Fatalf("backup: %v %s", err, out)
	}
	backup := strings.TrimSpace(out)
	backend := filepath.Join(helpers, "partial-migration")
	executable(t, backend, `[ "$#" = 2 ] && [ "$1" = migrate ] && [ "$2" = apply ] || exit 99
psql --dbname="$SMITHERS_DATABASE_URL" -v ON_ERROR_STOP=1 -c "UPDATE recovery_proof SET value = 'partial migration'; ALTER TABLE recovery_proof ADD COLUMN partial text; CREATE TABLE partial_only(value text)" >/dev/null
exit 42`)
	recoveryUpgrade(t, backup, data, backend, append(common, "SMITHERS_RELEASE_FILE="+newRelease, "SMITHERS_DATABASE_URL="+source.ConnectionString), 42)
	if got := query(source, "SELECT value FROM recovery_proof"); got != "partial migration" {
		t.Fatalf("partial migration was not executed: %q", got)
	}
	if got := query(source, "SELECT count(*) FROM information_schema.columns WHERE table_name='recovery_proof' AND column_name='partial'"); got != "1" {
		t.Fatalf("partial schema missing: %q", got)
	}
	for name := range proofs {
		recoveryWrite(t, filepath.Join(data, name), "changed after backup")
	}

	rejectRestore := func(release, destination, database, want string) {
		cmd := exec.Command("sh", "restore.sh", backup)
		cmd.Env = append(os.Environ(), append(common, "SMITHERS_RELEASE_FILE="+release, "SMITHERS_DATABASE_URL="+database, "SMITHERS_DATA_ROOT="+destination)...)
		out, err := cmd.CombinedOutput()
		if err == nil || !strings.Contains(string(out), want) {
			t.Fatalf("unsafe restore accepted: %v %s", err, out)
		}
	}
	rejectRestore(newRelease, filepath.Join(root, "wrong-release"), source.ConnectionString, "backup distribution version is incompatible")
	rejectRestore(oldRelease, data, source.ConnectionString, "restore target data root is not empty")
	if got := query(source, "SELECT value FROM recovery_proof"); got != "partial migration" {
		t.Fatalf("failed source changed during restore refusals: %q", got)
	}
	if got := query(source, "SELECT count(*) FROM information_schema.columns WHERE table_name='recovery_proof'"); got != "2" {
		t.Fatalf("failed source schema changed: %q", got)
	}
	if got, err := os.ReadFile(filepath.Join(data, "config/instance.key")); err != nil || string(got) != "changed after backup" {
		t.Fatalf("failed source credential changed: %q %v", got, err)
	}
	target := start("target-pg")
	restored := filepath.Join(root, "restored")
	if err := os.Mkdir(restored, 0700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", "restore.sh", backup)
	cmd.Env = append(os.Environ(), append(common, "SMITHERS_RELEASE_FILE="+oldRelease, "SMITHERS_DATABASE_URL="+target.ConnectionString, "SMITHERS_DATA_ROOT="+restored)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("restore old backup: %v %s", err, out)
	}
	if got := query(target, "SELECT value FROM recovery_proof"); got != "old data" {
		t.Errorf("restored database content: %q", got)
	}
	if got := query(target, "SELECT count(*) FROM information_schema.columns WHERE table_name='recovery_proof'"); got != "1" {
		t.Errorf("old schema not restored: %q columns", got)
	}
	if got := query(target, "SELECT count(*) FROM information_schema.tables WHERE table_name='partial_only'"); got != "0" {
		t.Errorf("partial migration table survived: %q", got)
	}
	proofs["version.env"] = recoveryOldRelease
	for name, want := range proofs {
		path := filepath.Join(restored, name)
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Errorf("restored %s: %q (%v)", name, got, err)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Errorf("%s permissions: %o", name, info.Mode().Perm())
		}
	}
	for _, dir := range []string{restored, filepath.Join(restored, "config"), filepath.Join(restored, "repositories/owner/repo")} {
		info, err := os.Stat(dir)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0700 {
			t.Errorf("%s permissions: %o", dir, info.Mode().Perm())
		}
	}
}

func TestIncompleteUpgradeRefusesOperations(t *testing.T) {
	for _, script := range []string{"entrypoint.sh", "backup.sh", "upgrade.sh"} {
		t.Run(script, func(t *testing.T) {
			root := t.TempDir()
			data, bin := filepath.Join(root, "data"), filepath.Join(root, "bin")
			recoveryWrite(t, filepath.Join(data, "version.env"), recoveryOldRelease)
			recoveryWrite(t, filepath.Join(data, ".upgrade-incomplete"), "verified-backup")
			recoveryWrite(t, filepath.Join(root, "old.env"), recoveryOldRelease)
			if err := os.Mkdir(bin, 0700); err != nil {
				t.Fatal(err)
			}
			executable(t, filepath.Join(bin, "flock"), "exit 0")
			executable(t, filepath.Join(bin, "pg_dump"), `printf called >"$CALLED"; exit 99`)
			executable(t, filepath.Join(bin, "backend"), `printf called >"$CALLED"; exit 99`)
			args := []string{script}
			if script == "upgrade.sh" {
				args = append(args, filepath.Join(root, "missing-backup"))
			}
			cmd := exec.Command("sh", args...)
			called := filepath.Join(root, "called")
			cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "SMITHERS_LIB=./lib.sh", "SMITHERS_RELEASE_FILE="+filepath.Join(root, "old.env"), "SMITHERS_DATA_ROOT="+data, "SMITHERS_DATABASE_URL=postgres://example/db", "SMITHERS_AUTH_MODE=selfhost", "SMITHERS_BACKUP_ROOT="+filepath.Join(root, "backups"), "SMITHERS_BACKEND_BINARY="+filepath.Join(bin, "backend"), "CALLED="+called)
			out, err := cmd.CombinedOutput()
			if err == nil || !strings.Contains(string(out), "upgrade incomplete") || !strings.Contains(string(out), "restore") {
				t.Errorf("operation did not refuse incomplete upgrade: %v %s", err, out)
			}
			if _, err := os.Stat(called); !os.IsNotExist(err) {
				t.Errorf("unsafe external operation executed: %v", err)
			}
			if got, err := os.ReadFile(filepath.Join(data, ".upgrade-incomplete")); err != nil || string(got) != "verified-backup" {
				t.Errorf("recovery marker changed: %q %v", got, err)
			}
		})
	}
}
