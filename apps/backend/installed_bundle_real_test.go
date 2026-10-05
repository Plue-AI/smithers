package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowmanifest"
)

// C-SEC-02 receipt: production microVM startup accepts a real assembled
// bundle (SMITHERS_INSTALLED_BUNDLE). It verifies the protected chain to the
// bundle, this backend's bytes, bin/msb, the Flow host manifest, the coding
// host and the Linux helper against the pinned manifest, qualifies the
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

	hostManifest := filepath.Join(bundle, "bin", "flow-hosts.json")
	registry, err := flowmanifest.Load(hostManifest)
	if err != nil {
		t.Fatal(err)
	}
	runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir(), filepath.Join(bundle, "bin", "smithers-backend"), hostManifest, registry.Coding.Executable, false)
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
