package localbootstrap

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func clearBootstrapEnvironment(t *testing.T) {
	t.Helper()
	names := append([]string{}, secretNames...)
	names = append(names, "SMITHERS_AUTH_MODE", "SMITHERS_DATA_ROOT", "SMITHERS_BLOB_DATA_DIR", "SMITHERS_REPO_STORAGE_PATH", "SMITHERS_PUSH_HOOK_CALLBACK_URL", "SMITHERS_SERVER_ADDR", "SMITHERS_PUBLIC_URL", "PORT", "RAILWAY_PUBLIC_DOMAIN")
	for _, name := range names {
		value, exists := os.LookupEnv(name)
		name := name
		t.Cleanup(func() {
			if exists {
				_ = os.Setenv(name, value)
			} else {
				_ = os.Unsetenv(name)
			}
		})
		_ = os.Unsetenv(name)
	}
}

func TestConfigurePersistsSecretsAndStoragePaths(t *testing.T) {
	clearBootstrapEnvironment(t)
	root := t.TempDir()
	first, err := configure(root)
	if err != nil {
		t.Fatal(err)
	}
	if first != root {
		t.Fatalf("root = %q, want %q", first, root)
	}
	if got := os.Getenv("SMITHERS_AUTH_MODE"); got != "selfhost" {
		t.Fatalf("auth mode: %q", got)
	}
	initial := map[string]string{}
	for _, name := range secretNames {
		initial[name] = os.Getenv(name)
		if len(initial[name]) < 32 {
			t.Fatalf("%s is too short", name)
		}
		_ = os.Unsetenv(name)
	}
	if _, err := configure(root); err != nil {
		t.Fatal(err)
	}
	for _, name := range secretNames {
		if got := os.Getenv(name); got != initial[name] {
			t.Fatalf("%s rotated across reopen", name)
		}
	}
	if got := os.Getenv("SMITHERS_REPO_STORAGE_PATH"); got != filepath.Join(root, "repositories") {
		t.Fatalf("repository path: %q", got)
	}
	if got := os.Getenv("SMITHERS_BLOB_DATA_DIR"); got != filepath.Join(root, "blobs") {
		t.Fatalf("blob path: %q", got)
	}
	if got := os.Getenv("SMITHERS_PUSH_HOOK_CALLBACK_URL"); got != "http://127.0.0.1:4000/internal/repo-host/push-events" {
		t.Fatalf("push callback: %q", got)
	}
	if got := os.Getenv("SMITHERS_PUBLIC_URL"); got != "http://127.0.0.1:4000" {
		t.Fatalf("public origin: %q", got)
	}
	info, err := os.Stat(filepath.Join(root, "config", "secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("secrets permissions: %o", info.Mode().Perm())
	}
}

func TestConfigureRejectsMultitenantLocalMode(t *testing.T) {
	clearBootstrapEnvironment(t)
	_ = os.Setenv("SMITHERS_AUTH_MODE", "multitenant")
	if _, err := configure(t.TempDir()); err == nil || !strings.Contains(err.Error(), "requires SMITHERS_AUTH_MODE=selfhost") {
		t.Fatalf("expected local auth mode rejection, got %v", err)
	}
}

func TestRailwayEndpointUsesPortAndHTTPSDomain(t *testing.T) {
	clearBootstrapEnvironment(t)
	_ = os.Setenv("PORT", "4242")
	_ = os.Setenv("RAILWAY_PUBLIC_DOMAIN", "smithers.example.test")
	if _, err := configure(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("SMITHERS_SERVER_ADDR"); got != ":4242" {
		t.Fatalf("bind: %q", got)
	}
	if got := os.Getenv("SMITHERS_PUBLIC_URL"); got != "https://smithers.example.test" {
		t.Fatalf("public origin: %q", got)
	}
	if got := os.Getenv("SMITHERS_PUSH_HOOK_CALLBACK_URL"); got != "http://127.0.0.1:4242/internal/repo-host/push-events" {
		t.Fatalf("callback: %q", got)
	}
}

func TestExplicitPublicURLWinsOverRailwayDomain(t *testing.T) {
	clearBootstrapEnvironment(t)
	_ = os.Setenv("SMITHERS_SERVER_ADDR", ":8443")
	_ = os.Setenv("SMITHERS_PUBLIC_URL", "https://own.example.test")
	_ = os.Setenv("RAILWAY_PUBLIC_DOMAIN", "other.example.test")
	if _, err := configure(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("SMITHERS_PUBLIC_URL"); got != "https://own.example.test" {
		t.Fatalf("public origin: %q", got)
	}
}

func TestConfigureKeepsExplicitSecretAndFailsClosedOnCorruption(t *testing.T) {
	clearBootstrapEnvironment(t)
	root := t.TempDir()
	const supplied = "explicit-session-secret-with-adequate-length"
	_ = os.Setenv(secretNames[0], supplied)
	if _, err := configure(root); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv(secretNames[0]); got != supplied {
		t.Fatalf("explicit secret changed: %q", got)
	}
	path := filepath.Join(root, "config", "secrets.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var persisted secretFile
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.Values[secretNames[0]] != supplied {
		t.Fatal("explicit secret was not persisted")
	}
	if err := os.WriteFile(path, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := configure(root); err == nil || !strings.Contains(err.Error(), "decode local secrets") {
		t.Fatalf("corrupt secret file must fail closed: %v", err)
	}
}

func TestConcurrentSecretCreationKeepsOneIdentity(t *testing.T) {
	clearBootstrapEnvironment(t)
	configDir := filepath.Join(t.TempDir(), "config")
	const workers = 8
	results := make([]map[string]string, workers)
	errors := make([]error, workers)
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(i int) { defer wg.Done(); results[i], errors[i] = loadOrCreateSecrets(configDir) }(i)
	}
	wg.Wait()
	for i := range results {
		if errors[i] != nil {
			t.Fatal(errors[i])
		}
		if !reflect.DeepEqual(results[i], results[0]) {
			t.Fatal("concurrent bootstrap created different identities")
		}
	}
}

// A secrets file written while the password owner existed still holds the
// bootstrap token. It reopens with the same secrets and without the token.
func TestConfigureDropsTheRetiredBootstrapToken(t *testing.T) {
	clearBootstrapEnvironment(t)
	root := t.TempDir()
	if _, err := configure(root); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "config", "secrets.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var persisted secretFile
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatal(err)
	}
	initial := map[string]string{}
	for name, value := range persisted.Values {
		initial[name] = value
	}
	persisted.Values[retiredSecretName] = "old-bootstrap-token"
	data, err = json.Marshal(persisted)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	clearBootstrapEnvironment(t)
	if _, err := configure(root); err != nil {
		t.Fatalf("a secrets file holding the retired token must reopen: %v", err)
	}
	for _, name := range secretNames {
		if got := os.Getenv(name); got != initial[name] {
			t.Fatalf("%s changed across reopen", name)
		}
	}
	if _, ok := os.LookupEnv(retiredSecretName); ok {
		t.Fatalf("%s is exported", retiredSecretName)
	}
	values, err := readSecrets(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(values, initial) {
		t.Fatalf("secrets file = %v, want %v", values, initial)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("secrets permissions: %o", info.Mode().Perm())
	}
}
