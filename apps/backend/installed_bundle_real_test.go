package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// C-SEC-02 receipt: production microVM startup accepts a real assembled
// bundle (SMITHERS_INSTALLED_BUNDLE). It verifies the protected chain to the
// bundle, this backend's bytes, bin/msb, the guest kernel, the Flow host
// manifest, the coding host, the Linux helper, the engine library, node, the
// model host, PostgreSQL, git with its helpers and templates and the web app
// against the pinned manifest, qualifies the
// bundle's own msb, and logs the manifest's revision and sha256. The
// environment's msb variable is ignored.
func TestRealInstalledBundleStartsMicroVMIsolation(t *testing.T) {
	bundle := os.Getenv("SMITHERS_INSTALLED_BUNDLE")
	if bundle == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_INSTALLED_BUNDLE is required for the installed-bundle startup receipt")
		}
		t.Skip("SMITHERS_INSTALLED_BUNDLE is not set")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
	t.Setenv("SMITHERS_SERVER_ADDR", address)
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", "/bin/false")
	freeRelayPort(t)
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	parent := bundletest.ProtectedTempDir(t)
	postgres, err := filepath.Glob(filepath.Join(bundle, "postgres", "root", "opt", "homebrew", "Cellar", "postgresql@*", "*", "bin"))
	if err != nil || len(postgres) != 1 {
		t.Fatalf("the bundle's PostgreSQL directory: %v %v", postgres, err)
	}
	environment := map[string]string{"SMITHERS_DATA_ROOT": filepath.Join(parent, "data"),
		"SMITHERS_FLOW_HOST_MANIFEST": filepath.Join(bundle, "bin", "flow-hosts.json"),
		"SMITHERS_FFI_LIBRARY_PATH":   filepath.Join(bundle, "bin", "libsmithers_ffi.dylib"),
		"SMITHERS_NODE_BINARY":        filepath.Join(bundle, "bin", "node"), "SMITHERS_MODEL_HOST_BUNDLE": filepath.Join(bundle, "bin", "smithers-model-host"),
		"SMITHERS_NATIVE_POSTGRES_BIN": postgres[0], "SMITHERS_WEB_ROOT": filepath.Join(bundle, "views", "mainview"),
		"PATH":          filepath.Join(bundle, "bin") + string(filepath.ListSeparator) + "/usr/bin:/bin",
		"GIT_EXEC_PATH": filepath.Join(bundle, "libexec", "git-core"), "GIT_TEMPLATE_DIR": filepath.Join(bundle, "share", "git-core", "templates"),
		"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.DevNull}
	inputs, err := installedInputs(filepath.Join(bundle, "bin", "smithers-backend"), func(name string) string { return environment[name] })
	if err != nil {
		t.Fatalf("the installed bundle's inputs were refused: %v", err)
	}
	slog.Info("approved installed bundle", "bundle", inputs.bundle.Root(), "revision", inputs.bundle.Revision(), "manifest_sha256", inputs.bundle.ManifestSHA256())
	runtimes, err := openExecutionRuntimes(context.Background(), inputs.dataRoot, inputs.bundle, inputs.registry.Coding.Executable, false)
	if err != nil {
		t.Fatalf("the installed bundle was refused: %v", err)
	}
	if err := runtimes.Close(); err != nil {
		t.Fatal(err)
	}
	manifest, err := os.ReadFile(filepath.Join(bundle, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var declared struct {
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal(manifest, &declared); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(manifest)
	var receipt map[string]any
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) == nil && entry["msg"] == "approved installed bundle" {
			receipt = entry
		}
	}
	resolved, err := filepath.EvalSymlinks(bundle)
	if err != nil {
		t.Fatal(err)
	}
	if receipt == nil || receipt["revision"] != declared.Revision || receipt["manifest_sha256"] != hex.EncodeToString(sum[:]) || receipt["bundle"] != resolved {
		t.Fatalf("startup receipt = %v; want revision %s, manifest sha256 %x, bundle %s", receipt, declared.Revision, sum, resolved)
	}
	if evidence := os.Getenv("SMITHERS_FLOW_ISOLATION_EVIDENCE_DIR"); evidence != "" {
		body, _ := json.MarshalIndent(receipt, "", "  ")
		if err := os.MkdirAll(evidence, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(evidence, "installed-bundle-startup.json"), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}
