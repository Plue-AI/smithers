package native

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/postgres"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

const oldVersionEnv = "SMITHERS_DISTRIBUTION_VERSION=0.0.9\nSMITHERS_SCHEMA_VERSION=1\nSMITHERS_POSTGRES_MAJOR=18\n"
const newVersionEnv = "SMITHERS_DISTRIBUTION_VERSION=0.1.0\nSMITHERS_SCHEMA_VERSION=2\nSMITHERS_POSTGRES_MAJOR=18\n"

func fixtureVersionText(v Version) string {
	switch v {
	case oldRelease:
		return oldVersionEnv
	case newRelease:
		return newVersionEnv
	}
	return fmt.Sprintf("SMITHERS_DISTRIBUTION_VERSION=%s\nSMITHERS_SCHEMA_VERSION=%s\nSMITHERS_POSTGRES_MAJOR=%s\n", v.Version, v.Schema, v.Postgres)
}

func backupFixture(t *testing.T, v Version) string {
	t.Helper()
	root := t.TempDir()
	put(t, filepath.Join(root, "postgres.dump"), "database")
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	body := fixtureVersionText(v)
	if err := tw.WriteHeader(&tar.Header{Name: "version.env", Mode: 0600, Size: int64(len(body))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	put(t, filepath.Join(root, "files.tar"), b.String())
	manifestFixture(t, root, v)
	return root
}
func manifestFixture(t *testing.T, root string, v Version) {
	t.Helper()
	dump, err := os.ReadFile(filepath.Join(root, "postgres.dump"))
	if err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadFile(filepath.Join(root, "files.tar"))
	if err != nil {
		t.Fatal(err)
	}
	put(t, filepath.Join(root, "MANIFEST"), fixtureVersionText(v)+fmt.Sprintf("POSTGRES_SHA256=%x\nFILES_SHA256=%x\n", sha256.Sum256(dump), sha256.Sum256(files)))
}
func TestFailedUpgradeReportsRecovery(t *testing.T) {
	for _, status := range []int{42, 43, 44, 137, 0} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			root := t.TempDir()
			if err := WriteVersion(root, oldRelease); err != nil {
				t.Fatal(err)
			}
			backup := backupFixture(t, oldRelease)
			failure := fmt.Errorf("exit %d", status)
			steps := &UpgradeSteps{Migrate: func(context.Context) error {
				marker, err := os.ReadFile(filepath.Join(root, ".upgrade-incomplete"))
				if err != nil || strings.TrimSpace(string(marker)) != backup {
					t.Fatalf("migration before durable marker: %s %v", marker, err)
				}
				if status != 0 && status != 44 {
					return failure
				}
				return nil
			}}
			if status == 44 {
				steps.writeVersion = func(string, Version) error { return failure }
			}
			err := Upgrade(context.Background(), root, backup, newRelease, steps)
			got, readErr := ReadVersion(filepath.Join(root, "version.env"))
			if readErr != nil {
				t.Fatal(readErr)
			}
			if status == 0 {
				if err != nil || got != newRelease {
					t.Fatalf("success: %+v %v", got, err)
				}
				if _, err := os.Stat(filepath.Join(root, ".upgrade-incomplete")); !os.IsNotExist(err) {
					t.Fatal("marker survived success")
				}
				return
			}
			marker, markerErr := os.ReadFile(filepath.Join(root, ".upgrade-incomplete"))
			if markerErr != nil || strings.TrimSpace(string(marker)) != backup {
				t.Fatalf("failed upgrade lost recovery marker: %q %v", marker, markerErr)
			}
			if !errors.Is(err, failure) || got != oldRelease {
				t.Fatalf("failure lost or state advanced: %+v %v", got, err)
			}
			for _, want := range []string{"upgrade failed", "smthrs host restore " + backup, "later changes are lost"} {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("missing %s: %v", want, err)
				}
			}
			if err := EnsureVersion(root, newRelease); err == nil {
				t.Fatal("failed upgrade restarted")
			}
		})
	}
}
func TestManifestGuards(t *testing.T) {
	for _, name := range []string{"missing directory", "missing manifest", "missing dump", "missing files", "dump checksum", "files checksum", "unsafe path", "malformed"} {
		t.Run(name, func(t *testing.T) {
			root := backupFixture(t, oldRelease)
			switch name {
			case "missing directory":
				root = filepath.Join(root, "missing")
			case "missing manifest":
				os.Remove(filepath.Join(root, "MANIFEST"))
			case "missing dump":
				os.Remove(filepath.Join(root, "postgres.dump"))
			case "missing files":
				os.Remove(filepath.Join(root, "files.tar"))
			case "dump checksum":
				put(t, filepath.Join(root, "postgres.dump"), "changed")
			case "files checksum":
				put(t, filepath.Join(root, "files.tar"), "changed")
			case "malformed":
				put(t, filepath.Join(root, "MANIFEST"), "bad")
			case "unsafe path":
				var b bytes.Buffer
				tw := tar.NewWriter(&b)
				tw.WriteHeader(&tar.Header{Name: "../escape", Size: 0})
				tw.Close()
				put(t, filepath.Join(root, "files.tar"), b.String())
				manifestFixture(t, root, oldRelease)
			}
			if _, err := VerifyBackup(root); err == nil {
				t.Fatal("unsafe backup accepted")
			}
		})
	}
}
func TestRealFailedUpgradeRecoveryPostgreSQL(t *testing.T) {
	bin, major := testdb.Tools(t)
	if major != 18 {
		t.Fatalf("recovery requires PostgreSQL 18, got %d", major)
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
				t.Error(err)
			}
		})
		return p
	}
	command := func(name string, args ...string) string {
		out, err := exec.Command(filepath.Join(bin, name), args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v %s", name, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	query := func(p *postgres.Instance, sql string) string {
		return command("psql", "--dbname="+p.ConnectionString, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql)
	}
	source := start("source-pg")
	query(source, "CREATE TABLE recovery_proof(value text NOT NULL); INSERT INTO recovery_proof VALUES ('old data')")
	data := filepath.Join(root, "data")
	proofs := map[string]string{"repositories/owner/repo/proof": "repository", "blobs/chat/proof": "chat", "workspaces/run/proof": "workspace", "config/instance.key": "old credential"}
	for name, value := range proofs {
		put(t, filepath.Join(data, name), value)
	}
	if err := WriteVersion(data, oldRelease); err != nil {
		t.Fatal(err)
	}
	backup := backupFixture(t, oldRelease)
	command("pg_dump", "--dbname="+source.ConnectionString, "--format=custom", "--no-owner", "--file="+filepath.Join(backup, "postgres.dump"))
	cmd := exec.Command("tar", "-C", data, "-cf", filepath.Join(backup, "files.tar"), ".")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("tar: %v %s", err, out)
	}
	manifestFixture(t, backup, oldRelease)
	err := Upgrade(context.Background(), data, backup, newRelease, &UpgradeSteps{Migrate: func(context.Context) error {
		query(source, "UPDATE recovery_proof SET value = 'partial migration'; ALTER TABLE recovery_proof ADD COLUMN partial text; CREATE TABLE partial_only(value text)")
		return errors.New("exit 42")
	}})
	if err == nil {
		t.Fatal("failed migration accepted")
	}
	for name := range proofs {
		put(t, filepath.Join(data, name), "changed after backup")
	}
	if err := CheckRestore(backup, newRelease, data, false); err == nil {
		t.Fatal("wrong release accepted")
	}
	if err := CheckRestore(backup, oldRelease, data, false); err == nil {
		t.Fatal("nonempty target accepted")
	}
	if err := CheckRestore(backup, oldRelease, t.TempDir(), true); err == nil {
		t.Fatal("running install accepted")
	}
	if got := query(source, "SELECT value FROM recovery_proof"); got != "partial migration" {
		t.Fatal(got)
	}
	if got := query(source, "SELECT count(*) FROM information_schema.columns WHERE table_name='recovery_proof'"); got != "2" {
		t.Fatal(got)
	}
	got, _ := os.ReadFile(filepath.Join(data, "config/instance.key"))
	if string(got) != "changed after backup" {
		t.Fatal(string(got))
	}
	target := start("target-pg")
	restored := t.TempDir()
	if err := CheckRestore(backup, oldRelease, restored, false); err != nil {
		t.Fatal(err)
	}
	command("pg_restore", "--dbname="+target.ConnectionString, "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", filepath.Join(backup, "postgres.dump"))
	cmd = exec.Command("tar", "-C", restored, "-xpf", filepath.Join(backup, "files.tar"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("tar: %v %s", err, out)
	}
	if got := query(target, "SELECT value FROM recovery_proof"); got != "old data" {
		t.Fatal(got)
	}
	if got := query(target, "SELECT count(*) FROM information_schema.columns WHERE table_name='recovery_proof'"); got != "1" {
		t.Fatal(got)
	}
	if got := query(target, "SELECT count(*) FROM information_schema.tables WHERE table_name='partial_only'"); got != "0" {
		t.Fatal(got)
	}
	proofs["version.env"] = fixtureVersionText(oldRelease)
	for name, want := range proofs {
		path := filepath.Join(restored, name)
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Fatalf("%s: %q %v", name, got, err)
		}
		info, _ := os.Stat(path)
		if info.Mode().Perm() != 0600 {
			t.Fatal(info.Mode())
		}
	}
	for _, dir := range []string{restored, filepath.Join(restored, "config"), filepath.Join(restored, "repositories/owner/repo")} {
		info, err := os.Stat(dir)
		if err != nil || info.Mode().Perm() != 0700 {
			t.Fatalf("%s permissions: %v %v", dir, info, err)
		}
	}
}
