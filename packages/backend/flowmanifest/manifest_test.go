package flowmanifest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func bundledManifest(t *testing.T) (string, map[string]rawHost) {
	t.Helper()
	directory := t.TempDir()
	hosts := map[string]rawHost{}
	for family, flows := range expectedFlows {
		name := "smithers-" + family + "-host-v10"
		contents := []byte("host:" + family)
		if err := os.WriteFile(filepath.Join(directory, name), contents, 0o755); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(contents)
		hosts[family] = rawHost{Executable: name, SHA256: hex.EncodeToString(digest[:]), Flows: flows}
	}
	return filepath.Join(directory, "flow-hosts.json"), hosts
}

func writeManifest(t *testing.T, path string, hosts map[string]rawHost) {
	t.Helper()
	data, err := json.Marshal(rawManifest{Version: 1, Hosts: hosts})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadVerifiesTheCodingHost(t *testing.T) {
	path, hosts := bundledManifest(t)
	writeManifest(t, path, hosts)
	registry, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if registry.Coding.Executable != filepath.Join(filepath.Dir(path), hosts["coding"].Executable) ||
		registry.Coding.SHA256 != hosts["coding"].SHA256 {
		t.Fatalf("wrong registry: %+v", registry)
	}
	if err := os.WriteFile(registry.Coding.Executable, []byte("altered host"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("tampered host accepted: %v", err)
	}
}

func TestLoadRejectsEscapedOrSubstitutedHost(t *testing.T) {
	path, hosts := bundledManifest(t)
	coding := hosts["coding"]
	coding.Executable = "../other-host"
	hosts["coding"] = coding
	writeManifest(t, path, hosts)
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "basename") {
		t.Fatalf("path escape accepted: %v", err)
	}
	coding.Executable = "smithers-coding-host-v10"
	hosts["coding"] = coding
	if err := os.Remove(filepath.Join(filepath.Dir(path), coding.Executable)); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(filepath.Dir(path), "other-host")
	if err := os.WriteFile(other, []byte("host:coding"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, filepath.Join(filepath.Dir(path), coding.Executable)); err != nil {
		t.Fatal(err)
	}
	writeManifest(t, path, hosts)
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "regular file") {
		t.Fatalf("symlinked host accepted: %v", err)
	}
}

func TestLoadRejectsMissingOrExtraFlow(t *testing.T) {
	for _, flows := range [][]string{nil, {"coding/dispatch", "librarian/history"}} {
		path, hosts := bundledManifest(t)
		coding := hosts["coding"]
		coding.Flows = flows
		hosts["coding"] = coding
		writeManifest(t, path, hosts)
		if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "unexpected flows") {
			t.Fatalf("flow host with %v accepted: %v", flows, err)
		}
	}
}

// The product gateway's librarian host is retired (#2194); a manifest that
// still ships it is a stale release, not an extra host to ignore.
func TestLoadRejectsTheRetiredLibrarianHost(t *testing.T) {
	path, hosts := bundledManifest(t)
	hosts["librarian"] = rawHost{Executable: hosts["coding"].Executable, SHA256: hosts["coding"].SHA256}
	writeManifest(t, path, hosts)
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "host set") {
		t.Fatalf("retired librarian host accepted: %v", err)
	}
}

func TestLoadManifestValidation(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func([]byte) []byte
	}{
		{"empty", func([]byte) []byte { return nil }},
		{"null", func([]byte) []byte { return []byte("null") }},
		{"unsupported_version", func(data []byte) []byte {
			return []byte(strings.Replace(string(data), `"version":1`, `"version":2`, 1))
		}},
		{"unknown_field", func(data []byte) []byte {
			return append([]byte(`{"unexpected":true,`), data[1:]...)
		}},
		{"unknown_host_field", func(data []byte) []byte {
			return []byte(strings.Replace(string(data), `"coding":{`, `"coding":{"unexpected":true,`, 1))
		}},
		{"unexpected_family", func(data []byte) []byte {
			return []byte(strings.Replace(string(data), `"coding":`, `"unknown":`, 1))
		}},
		{"trailing_json", func(data []byte) []byte { return append(data, []byte(` {}`)...) }},
		{"trailing_garbage", func(data []byte) []byte { return append(data, '!') }},
		{"oversized", func(data []byte) []byte {
			return append(data, []byte(strings.Repeat(" ", maxManifestBytes+1-len(data)))...)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			path, hosts := bundledManifest(t)
			data, err := json.Marshal(rawManifest{Version: 1, Hosts: hosts})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, test.change(data), 0o644); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil {
				t.Fatal("invalid manifest accepted")
			}
		})
	}
}

func TestLoadManifestAtSizeLimit(t *testing.T) {
	path, hosts := bundledManifest(t)
	data, err := json.Marshal(rawManifest{Version: 1, Hosts: hosts})
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, []byte(strings.Repeat(" ", maxManifestBytes-len(data)))...)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	registry, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(registry.Coding.Flows) != 1 || registry.Coding.Flows[0] != "coding/dispatch" {
		t.Fatalf("unexpected coding flows: %v", registry.Coding.Flows)
	}
}

func TestLoadRegularManifestSymlink(t *testing.T) {
	path, hosts := bundledManifest(t)
	writeManifest(t, path, hosts)
	link := filepath.Join(filepath.Dir(path), "manifest-link.json")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(link); err != nil {
		t.Fatalf("regular manifest symlink rejected: %v", err)
	}
}
