package localbootstrap

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/smithersai/smithers/packages/backend/internal/config"
)

// ErrOperatorKeyFromEnvironment refuses a file rotation when the operator key
// comes from the environment, which the file cannot change.
var ErrOperatorKeyFromEnvironment = errors.New(operatorKeyName + " is set in the environment: rotate it there, keep the old value in " +
	previousOperatorKeysName + ", restart, then run `keys reseal`")

// RotateOperatorKey replaces the operator key kept in root's secrets file,
// the key that seals provider connections, secrets and model credentials.
// It holds the data root's maintenance lock, which a running app holds, so
// the app must be stopped. The replaced key is recorded as previous before
// reseal moves every stored value to the new key, and retired only after
// reseal succeeds. A rotation interrupted in between resumes with the key it
// already wrote; resumed reports that case.
func RotateOperatorKey(ctx context.Context, root string, reseal func(ctx context.Context, current string, previous []string) error) (resumed bool, err error) {
	if reseal == nil {
		return false, errors.New("rotate operator key: reseal is required")
	}
	if _, set := os.LookupEnv(operatorKeyName); set {
		return false, ErrOperatorKeyFromEnvironment
	}
	if strings.TrimSpace(root) == "" {
		root = strings.TrimSpace(os.Getenv("SMITHERS_DATA_ROOT"))
	}
	if root == "" {
		root = DefaultDataRoot
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return false, fmt.Errorf("resolve local data root: %w", err)
	}
	configDir := filepath.Join(root, "config")
	path := filepath.Join(configDir, "secrets.json")
	if _, err := os.Lstat(path); err != nil {
		return false, fmt.Errorf("rotate operator key: no local secrets file: %w", err)
	}
	lock, err := os.OpenFile(filepath.Join(root, ".maintenance.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return false, fmt.Errorf("rotate operator key: %w", err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return false, errors.New("rotate operator key: Smithers is running; stop it first")
	}
	values, err := readSecrets(path)
	if err != nil {
		return false, err
	}
	replace := func(values map[string]string) error {
		return publishSecrets(configDir, values, func(staged string) error { return os.Rename(staged, path) })
	}
	_, resumed = values[previousOperatorKeysName]
	if !resumed {
		if strings.Contains(values[operatorKeyName], ",") {
			return false, errors.New("rotate operator key: the current key contains a comma and cannot be listed as a previous key")
		}
		fresh := make([]byte, 32)
		if _, err := rand.Read(fresh); err != nil {
			return false, fmt.Errorf("rotate operator key: %w", err)
		}
		values[previousOperatorKeysName] = values[operatorKeyName]
		values[operatorKeyName] = hex.EncodeToString(fresh)
		if err := replace(values); err != nil {
			return false, fmt.Errorf("rotate operator key: record the new key: %w", err)
		}
	}
	previous := config.WebhookConfig{PreviousSecretEncryptionKeys: values[previousOperatorKeysName]}.PreviousKeys()
	if err := reseal(ctx, values[operatorKeyName], previous); err != nil {
		return resumed, err
	}
	delete(values, previousOperatorKeysName)
	if err := replace(values); err != nil {
		return resumed, fmt.Errorf("rotate operator key: retire the previous key: %w", err)
	}
	return resumed, nil
}
