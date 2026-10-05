package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
)

func TestExternalDatabaseURL(t *testing.T) {
	t.Setenv("SMITHERS_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", "postgres://railway.example/smithers")
	got, err := externalDatabaseURL()
	if err != nil || got != "postgres://railway.example/smithers" {
		t.Fatalf("DATABASE_URL fallback = %q, %v", got, err)
	}
	if os.Getenv("SMITHERS_DATABASE_URL") != got {
		t.Fatal("DATABASE_URL was not mapped to the backend configuration")
	}
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://explicit.example/smithers")
	got, err = externalDatabaseURL()
	if err != nil || got != "postgres://explicit.example/smithers" {
		t.Fatalf("explicit backend URL = %q, %v", got, err)
	}
	t.Setenv("SMITHERS_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", "")
	if _, err := externalDatabaseURL(); err == nil {
		t.Fatal("missing external PostgreSQL URL was accepted")
	}
}

func TestMigrationWithoutDatabaseDoesNotPrepareLocalState(t *testing.T) {
	root := t.TempDir()
	t.Setenv("SMITHERS_DATA_ROOT", root)
	t.Setenv("SMITHERS_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", "")
	if err := run(context.Background(), []string{"migrate", "status"}); err == nil {
		t.Fatal("migration without PostgreSQL was accepted")
	}
	if _, err := os.Stat(filepath.Join(root, "config")); !os.IsNotExist(err) {
		t.Fatalf("migration prepared server secrets: %v", err)
	}
}

// An installed bundle without its packaged Flow hosts refuses to serve
// before local state is prepared; beside a bundle no variable can supply
// another manifest.
func TestServeRequiresPackagedFlowHostsBeforePreparingLocalState(t *testing.T) {
	bundle := installedBundleFixture(t)
	if err := os.Remove(bundle.hostManifest); err != nil {
		t.Fatal(err)
	}
	bundle.writeManifest(t)
	root := filepath.Join(bundletest.ProtectedTempDir(t), "data")
	err := serveInstalled(t, bundle, func(env map[string]string) {
		env["SMITHERS_DATA_ROOT"] = root
		delete(env, "SMITHERS_FLOW_HOST_MANIFEST")
	})
	if err == nil || !strings.Contains(err.Error(), "SMITHERS_FLOW_HOST_MANIFEST") {
		t.Fatalf("missing Flow bundle = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "config")); !os.IsNotExist(err) {
		t.Fatalf("missing Flow bundle prepared local secrets: %v", err)
	}
}

func TestCreditsWithoutDatabaseFails(t *testing.T) {
	t.Setenv("SMITHERS_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", "")
	if err := run(context.Background(), []string{"credits", "balance", "-owner", "user:alice"}); err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Fatalf("credits without PostgreSQL = %v", err)
	}
}

func TestProductionRefusesUnsafeIsolationBeforeInputs(t *testing.T) {
	for _, mode := range []string{"", "process", "container"} {
		for _, native := range []string{"", "/unused/postgres"} {
			t.Run(mode+native, func(t *testing.T) {
				root := t.TempDir()
				t.Setenv("SMITHERS_WORKSPACE_ISOLATION", mode)
				t.Setenv("SMITHERS_NATIVE_POSTGRES_BIN", native)
				t.Setenv("SMITHERS_DATABASE_URL", "postgres://unused")
				t.Setenv("SMITHERS_DATA_ROOT", root)
				t.Setenv("SMITHERS_PLATFORM_MODEL_KEYS_FILE", filepath.Join(root, "absent-keys"))
				t.Setenv("SMITHERS_FLOW_HOST_MANIFEST", filepath.Join(root, "absent-manifest"))
				if err := run(context.Background(), nil); err == nil || !strings.Contains(err.Error(), "process isolation is tests-only") {
					t.Fatalf("early isolation refusal = %v", err)
				}
				entries, err := os.ReadDir(root)
				if err != nil || len(entries) != 0 {
					t.Fatalf("startup produced state: %v, %v", entries, err)
				}
			})
		}
	}
}

func TestDoctorRemainsServerFreeWithoutIsolation(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "")
	root := t.TempDir()
	t.Setenv("SMITHERS_DATA_ROOT", root)
	if err := run(context.Background(), []string{"microvm", "invalid"}); err == nil || !strings.Contains(err.Error(), "usage: smithers-backend microvm doctor") {
		t.Fatalf("doctor dispatch = %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("doctor produced server state: %v, %v", entries, err)
	}
}
