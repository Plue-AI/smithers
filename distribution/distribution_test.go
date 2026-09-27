package distribution_test

import (
	"context"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/postgres"
)

func executable(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\nset -eu\n"+body+"\n"), 0755); err != nil {
		t.Fatal(err)
	}
}
func run(t *testing.T, script string, env ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("sh", script)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}
func hash(t *testing.T, path string) string {
	t.Helper()
	out, err := exec.Command("sha256sum", path).Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.Fields(string(out))[0]
}

func TestContainerContract(t *testing.T) {
	b, err := os.ReadFile("Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	for _, required := range []string{"FROM postgres:18.6-bookworm", "./apps/backend", "flows/coding/build.mjs", "rust:1.98.0-bookworm", "node:26.5.0-bookworm", "libsmithers_ffi.so", "USER smithers", "CMD []"} {
		if !strings.Contains(text, required) {
			t.Errorf("missing %q", required)
		}
	}
	for _, forbidden := range []string{"/var/run/docker.sock", "--privileged", "/dev/kvm", "dockerd", "postgres -D"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("forbidden %q", forbidden)
		}
	}
}

// Every Go command under apps/ ships in the image; an unbuilt command is dead code.
func TestImageBuildsEveryAppCommand(t *testing.T) {
	b, err := os.ReadFile("Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	built := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.Contains(line, "go build") {
			continue
		}
		fields := strings.Fields(line)
		built[strings.TrimPrefix(fields[len(fields)-1], "./")] = true
	}
	cmd := exec.Command("go", "list", "-f", `{{if eq .Name "main"}}{{.Dir}}{{end}}`, "./apps/...")
	cmd.Dir = ".."
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range strings.Fields(string(out)) {
		rel, err := filepath.Rel(root, dir)
		if err != nil {
			t.Fatal(err)
		}
		if !built[filepath.ToSlash(rel)] {
			t.Errorf("Go command %s is not built by distribution/Dockerfile", rel)
		}
	}
}

func TestBackupRestorePreservesDurableClasses(t *testing.T) {
	root := t.TempDir()
	data, backups, bin := filepath.Join(root, "data"), filepath.Join(root, "backups"), filepath.Join(root, "bin")
	if err := os.MkdirAll(bin, 0700); err != nil {
		t.Fatal(err)
	}
	proofs := map[string]string{"repositories/owner/repo/change": "repository", "blobs/chat/transcript": "chat", "blobs/approvals/pending": "approval", "blobs/artifacts/output": "artifact", "workspaces/run/file": "workspace", "config/instance.key": "credential"}
	for name, value := range proofs {
		path := filepath.Join(data, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	version, _ := os.ReadFile("version.env")
	if err := os.WriteFile(filepath.Join(data, "version.env"), version, 0600); err != nil {
		t.Fatal(err)
	}
	executable(t, filepath.Join(bin, "flock"), "exit 0")
	executable(t, filepath.Join(bin, "pg_dump"), `out=; database=; while [ "$#" -gt 0 ]; do case "$1" in --file) out=$2; shift 2;; --dbname=*) database=${1#--dbname=}; shift;; *) shift;; esac; done; [ "$database" = postgres://example/db ]; printf database >"$out"`)
	executable(t, filepath.Join(bin, "psql"), `case " $* " in *" --dbname=postgres://example/db "*) printf '0\n';; *) exit 41;; esac`)
	marker := filepath.Join(root, "pg-restore")
	executable(t, filepath.Join(bin, "pg_restore"), `case " $* " in *" --dbname=postgres://example/db "*) printf restored >"$RESTORE_MARKER";; *) exit 42;; esac`)
	common := []string{"PATH=" + bin + ":" + os.Getenv("PATH"), "SMITHERS_LIB=./lib.sh", "SMITHERS_RELEASE_FILE=./version.env", "DATABASE_URL=postgres://example/db", "SMITHERS_DATABASE_URL="}
	out, err := run(t, "backup.sh", append(common, "SMITHERS_DATA_ROOT="+data, "SMITHERS_BACKUP_ROOT="+backups)...)
	if err != nil {
		t.Fatalf("backup: %v %s", err, out)
	}
	backup := strings.TrimSpace(out)
	restored := filepath.Join(root, "restored")
	if err := os.Mkdir(restored, 0700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", "restore.sh", backup)
	cmd.Env = append(os.Environ(), append(common, "SMITHERS_DATA_ROOT="+restored, "RESTORE_MARKER="+marker)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("restore: %v %s", err, out)
	}
	for name, want := range proofs {
		got, err := os.ReadFile(filepath.Join(restored, name))
		if err != nil || string(got) != want {
			t.Errorf("%s: %q %v", name, got, err)
		}
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("pg_restore not called")
	}
}

func TestFailedUpgradeLeavesManifest(t *testing.T) {
	root := t.TempDir()
	data, bin, backup := filepath.Join(root, "data"), filepath.Join(root, "bin"), filepath.Join(root, "backup")
	for _, d := range []string{data, bin, backup} {
		if err := os.MkdirAll(d, 0700); err != nil {
			t.Fatal(err)
		}
	}
	old := "SMITHERS_DISTRIBUTION_VERSION=0.0.9\nSMITHERS_SCHEMA_VERSION=1\nSMITHERS_POSTGRES_MAJOR=18\n"
	if err := os.WriteFile(filepath.Join(data, "version.env"), []byte(old), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(backup, "postgres.dump"), []byte("db"), 0600); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("tar", "-cf", filepath.Join(backup, "files.tar"), "-T", "/dev/null").CombinedOutput(); err != nil {
		t.Fatalf("tar: %v %s", err, out)
	}
	manifest := old + "POSTGRES_SHA256=" + hash(t, filepath.Join(backup, "postgres.dump")) + "\nFILES_SHA256=" + hash(t, filepath.Join(backup, "files.tar")) + "\n"
	if err := os.WriteFile(filepath.Join(backup, "MANIFEST"), []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	executable(t, filepath.Join(bin, "flock"), "exit 0")
	executable(t, filepath.Join(bin, "backend"), "exit 42")
	cmd := exec.Command("sh", "upgrade.sh", backup)
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "SMITHERS_LIB=./lib.sh", "SMITHERS_RELEASE_FILE=./version.env", "DATABASE_URL=postgres://x/db", "SMITHERS_DATABASE_URL=", "SMITHERS_DATA_ROOT="+data, "SMITHERS_BACKEND_BINARY="+filepath.Join(bin, "backend"))
	if err := cmd.Run(); err == nil {
		t.Fatal("failed migration accepted")
	}
	got, _ := os.ReadFile(filepath.Join(data, "version.env"))
	if string(got) != old {
		t.Fatal("manifest changed")
	}
}

func TestRealBackupRestorePostgreSQL(t *testing.T) {
	bin := os.Getenv("SMITHERS_POSTGRES_TEST_BIN")
	if bin == "" {
		t.Skip("SMITHERS_POSTGRES_TEST_BIN is required")
	}
	major, err := strconv.Atoi(os.Getenv("SMITHERS_POSTGRES_TEST_MAJOR"))
	if err != nil {
		t.Fatal(err)
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
			_ = p.Stop(ctx)
		})
		return p
	}
	query := func(p *postgres.Instance, sql string) string {
		u, _ := url.Parse(p.ConnectionString)
		pw, _ := u.User.Password()
		cmd := exec.Command(filepath.Join(bin, "psql"), p.ConnectionString, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql)
		cmd.Env = append(os.Environ(), "PGPASSWORD="+pw)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("psql: %v %s", err, out)
		}
		return strings.TrimSpace(string(out))
	}
	source := start("source-pg")
	query(source, "CREATE TABLE backup_proof(value text); INSERT INTO backup_proof VALUES ('survived')")
	sourceData := filepath.Join(root, "source-data")
	if err := os.MkdirAll(filepath.Join(sourceData, "repositories", "o", "r"), 0700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(sourceData, "repositories", "o", "r", "proof"), []byte("files"), 0600)
	version, _ := os.ReadFile("version.env")
	_ = os.WriteFile(filepath.Join(sourceData, "version.env"), version, 0600)
	fake := filepath.Join(root, "fake")
	_ = os.Mkdir(fake, 0700)
	executable(t, filepath.Join(fake, "flock"), "exit 0")
	backupRoot := filepath.Join(root, "backups")
	out, err := run(t, "backup.sh", "PATH="+fake+":"+bin+":"+os.Getenv("PATH"), "SMITHERS_LIB=./lib.sh", "SMITHERS_RELEASE_FILE=./version.env", "SMITHERS_DATABASE_URL="+source.ConnectionString, "SMITHERS_DATA_ROOT="+sourceData, "SMITHERS_BACKUP_ROOT="+backupRoot)
	if err != nil {
		t.Fatalf("backup: %v %s", err, out)
	}
	target := start("target-pg")
	targetData := filepath.Join(root, "target-data")
	_ = os.Mkdir(targetData, 0700)
	cmd := exec.Command("sh", "restore.sh", strings.TrimSpace(out))
	cmd.Env = append(os.Environ(), "PATH="+fake+":"+bin+":"+os.Getenv("PATH"), "SMITHERS_LIB=./lib.sh", "SMITHERS_RELEASE_FILE=./version.env", "SMITHERS_DATABASE_URL="+target.ConnectionString, "SMITHERS_DATA_ROOT="+targetData)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("restore: %v %s", err, b)
	}
	if got := query(target, "SELECT value FROM backup_proof"); got != "survived" {
		t.Fatalf("db %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(targetData, "repositories", "o", "r", "proof")); string(got) != "files" {
		t.Fatalf("files %q", got)
	}
}
