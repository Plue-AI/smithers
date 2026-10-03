// Package localbootstrap prepares the durable, single-owner backend instance
// used by both the container and the native application's local mode.
package localbootstrap

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/repository"
)

const DefaultDataRoot = "./data"

var secretNames = []string{
	"SMITHERS_AUTH_SESSION_SECRET",
	"SMITHERS_LFS_SIGNING_SECRET",
	"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY",
	"SMITHERS_REPO_HOST_AUTH_TOKEN",
	"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN",
}

// retiredSecretName is the password owner's bootstrap token. GitHub sign-in
// with the one-time setup token replaced it; a secrets file written before
// that still holds it, and loading the file drops it.
const retiredSecretName = "SMITHERS_AUTH_BOOTSTRAP_TOKEN"

const (
	operatorKeyName          = "SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY"
	previousOperatorKeysName = "SMITHERS_WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS"
)

type secretFile struct {
	Version int               `json:"version"`
	Values  map[string]string `json:"values"`
}

// Runtime owns the local repository engine. The caller passes Client() to
// app.Config.Repository and closes this runtime after app.Run returns.
type Runtime struct{ repository *repository.Local }

func (r *Runtime) Client() *repository.Client         { return r.repository.Client() }
func (r *Runtime) Shutdown(ctx context.Context) error { return r.repository.Shutdown(ctx) }

// Prepare reopens durable secrets and storage under root, then starts the
// in-process repository engine. Explicit environment values take precedence;
// every missing secret is generated once and persisted with private mode.
func Prepare(root string) (*Runtime, error) {
	root, err := configure(root)
	if err != nil {
		return nil, err
	}
	cfg, err := repository.LoadConfig()
	if err != nil {
		return nil, fmt.Errorf("configure local repository: %w", err)
	}
	cfg.StoragePath = filepath.Join(root, "repositories")
	local, err := repository.OpenLocal(cfg)
	if err != nil {
		return nil, fmt.Errorf("open local repository: %w", err)
	}
	return &Runtime{repository: local}, nil
}

func configure(root string) (string, error) {
	if mode := strings.TrimSpace(os.Getenv("SMITHERS_AUTH_MODE")); mode != "" && mode != "selfhost" {
		return "", fmt.Errorf("local backend requires SMITHERS_AUTH_MODE=selfhost, got %q", mode)
	}
	if err := os.Setenv("SMITHERS_AUTH_MODE", "selfhost"); err != nil {
		return "", err
	}
	if strings.TrimSpace(root) == "" {
		root = strings.TrimSpace(os.Getenv("SMITHERS_DATA_ROOT"))
	}
	if root == "" {
		root = DefaultDataRoot
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve local data root: %w", err)
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("create local data root: %w", err)
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("local data root must be a real directory")
	}
	if err := os.Chmod(root, 0o700); err != nil {
		return "", fmt.Errorf("make local data root private: %w", err)
	}
	values, err := loadOrCreateSecrets(filepath.Join(root, "config"))
	if err != nil {
		return "", err
	}
	_, explicitOperatorKey := os.LookupEnv(operatorKeyName)
	for _, name := range secretNames {
		if value, exists := os.LookupEnv(name); exists {
			if strings.TrimSpace(value) == "" {
				return "", fmt.Errorf("%s is set but empty", name)
			}
			continue
		}
		if err := os.Setenv(name, values[name]); err != nil {
			return "", err
		}
	}
	// An interrupted rotation left the replaced key beside the new one; an
	// operator key from the environment brings its own previous keys.
	if previous, ok := values[previousOperatorKeysName]; ok && !explicitOperatorKey {
		if _, exists := os.LookupEnv(previousOperatorKeysName); !exists {
			if err := os.Setenv(previousOperatorKeysName, previous); err != nil {
				return "", err
			}
		}
	}
	for name, value := range map[string]string{
		"SMITHERS_DATA_ROOT":         root,
		"SMITHERS_BLOB_DATA_DIR":     filepath.Join(root, "blobs"),
		"SMITHERS_REPO_STORAGE_PATH": filepath.Join(root, "repositories"),
	} {
		if strings.TrimSpace(os.Getenv(name)) == "" {
			if err := os.Setenv(name, value); err != nil {
				return "", err
			}
		}
	}
	if err := configurePublicEndpoint(); err != nil {
		return "", err
	}
	if strings.TrimSpace(os.Getenv("SMITHERS_PUSH_HOOK_CALLBACK_URL")) == "" {
		address := strings.TrimSpace(os.Getenv("SMITHERS_SERVER_ADDR"))
		if address == "" {
			address = ":4000"
		}
		_, port, err := net.SplitHostPort(address)
		if err != nil || port == "" {
			return "", fmt.Errorf("invalid local server address %q", address)
		}
		if err := os.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_URL", "http://127.0.0.1:"+port+"/internal/repo-host/push-events"); err != nil {
			return "", err
		}
	}
	return root, nil
}

func configurePublicEndpoint() error {
	address := strings.TrimSpace(os.Getenv("SMITHERS_SERVER_ADDR"))
	if address == "" {
		if port := strings.TrimSpace(os.Getenv("PORT")); port != "" {
			portNumber, err := strconv.Atoi(port)
			if err != nil || portNumber < 1 || portNumber > 65535 {
				return fmt.Errorf("invalid PORT %q", port)
			}
			address = ":" + port
			if err := os.Setenv("SMITHERS_SERVER_ADDR", address); err != nil {
				return err
			}
		} else {
			address = ":4000"
		}
	}
	if strings.TrimSpace(os.Getenv("SMITHERS_PUBLIC_URL")) != "" {
		return nil
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil || port == "" {
		return fmt.Errorf("invalid local server address %q", address)
	}
	if domain := strings.TrimSpace(os.Getenv("RAILWAY_PUBLIC_DOMAIN")); domain != "" {
		parsed, err := url.Parse("https://" + domain)
		if err != nil || parsed.Host != domain || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return fmt.Errorf("invalid RAILWAY_PUBLIC_DOMAIN %q", domain)
		}
		return os.Setenv("SMITHERS_PUBLIC_URL", "https://"+domain)
	}
	return os.Setenv("SMITHERS_PUBLIC_URL", "http://127.0.0.1:"+port)
}

func loadOrCreateSecrets(configDir string) (map[string]string, error) {
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return nil, fmt.Errorf("create local config directory: %w", err)
	}
	info, err := os.Lstat(configDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("local config directory must be a real directory")
	}
	if err := os.Chmod(configDir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(configDir, "secrets.json")
	if err := dropRetiredSecret(configDir, path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if values, err := readSecrets(path); err == nil {
		return values, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	values := make(map[string]string, len(secretNames))
	for _, name := range secretNames {
		if current, ok := os.LookupEnv(name); ok {
			if strings.TrimSpace(current) == "" {
				return nil, fmt.Errorf("%s is set but empty", name)
			}
			values[name] = current
			continue
		}
		bytes := make([]byte, 32)
		if _, err := rand.Read(bytes); err != nil {
			return nil, fmt.Errorf("generate %s: %w", name, err)
		}
		values[name] = hex.EncodeToString(bytes)
	}
	// Link publishes complete bytes without replacing a concurrent winner.
	if err := publishSecrets(configDir, values, func(staged string) error {
		if err := os.Link(staged, path); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return readSecrets(path)
}

// dropRetiredSecret rewrites a secrets file that still holds the retired
// bootstrap token without it.
func dropRetiredSecret(configDir, path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var data secretFile
	if json.Unmarshal(raw, &data) != nil {
		return nil // readSecrets reports the malformed file.
	}
	if _, ok := data.Values[retiredSecretName]; !ok {
		return nil
	}
	delete(data.Values, retiredSecretName)
	return publishSecrets(configDir, data.Values, func(staged string) error { return os.Rename(staged, path) })
}

// publishSecrets writes values to a private synced file in configDir, hands
// its path to publish, and syncs the directory.
func publishSecrets(configDir string, values map[string]string, publish func(staged string) error) error {
	file, err := os.CreateTemp(configDir, ".secrets-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	if err := json.NewEncoder(file).Encode(secretFile{Version: 1, Values: values}); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := publish(file.Name()); err != nil {
		return err
	}
	return syncDir(configDir)
}

// syncDir makes a published or removed name durable: a rotation must not
// reseal the database under a key the file system may still lose.
func syncDir(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	if err := dir.Sync(); err != nil {
		_ = dir.Close()
		return err
	}
	return dir.Close()
}

func readSecrets(path string) (map[string]string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("local secrets file must be a private regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var data secretFile
	decoder := json.NewDecoder(f)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&data); err != nil {
		return nil, fmt.Errorf("decode local secrets: %w", err)
	}
	if data.Version != 1 {
		return nil, fmt.Errorf("unsupported local secrets version %d", data.Version)
	}
	expected := len(secretNames)
	if previous, ok := data.Values[previousOperatorKeysName]; ok {
		if strings.TrimSpace(previous) == "" {
			return nil, fmt.Errorf("local secrets file has an empty %s", previousOperatorKeysName)
		}
		expected++
	}
	if len(data.Values) != expected {
		return nil, errors.New("local secrets file is incomplete")
	}
	for _, name := range secretNames {
		if strings.TrimSpace(data.Values[name]) == "" {
			return nil, fmt.Errorf("local secrets file has no %s", name)
		}
	}
	return data.Values, nil
}
