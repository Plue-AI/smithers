package localbootstrap

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func writeTestSecrets(t *testing.T, root string, values map[string]string) string {
	t.Helper()
	configDir := filepath.Join(root, "config")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := publishSecrets(configDir, values, func(staged string) error {
		return os.Rename(staged, filepath.Join(configDir, "secrets.json"))
	}); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(configDir, "secrets.json")
}

func testSecretValues() map[string]string {
	values := map[string]string{}
	for _, name := range secretNames {
		values[name] = "value-of-" + strings.ToLower(name)
	}
	return values
}

func TestConfigureExportsPreviousOperatorKeysOfAnInterruptedRotation(t *testing.T) {
	clearBootstrapEnvironment(t)
	t.Setenv(previousOperatorKeysName, "")
	_ = os.Unsetenv(previousOperatorKeysName)
	root := t.TempDir()
	values := testSecretValues()
	values[previousOperatorKeysName] = "replaced-key"
	writeTestSecrets(t, root, values)
	if _, err := configure(root); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv(previousOperatorKeysName); got != "replaced-key" {
		t.Fatalf("previous keys = %q", got)
	}
	if got := os.Getenv(operatorKeyName); got != values[operatorKeyName] {
		t.Fatalf("operator key = %q", got)
	}

	// An explicit previous-keys value wins over the file.
	t.Setenv(previousOperatorKeysName, "explicit-previous")
	if _, err := configure(root); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv(previousOperatorKeysName); got != "explicit-previous" {
		t.Fatalf("explicit previous keys replaced: %q", got)
	}

	// An operator key from the environment never adopts the file's previous keys.
	_ = os.Unsetenv(previousOperatorKeysName)
	t.Setenv(operatorKeyName, "environment-operator-key")
	if _, err := configure(root); err != nil {
		t.Fatal(err)
	}
	if value, set := os.LookupEnv(previousOperatorKeysName); set {
		t.Fatalf("file previous keys leaked beside an environment key: %q", value)
	}
}

func TestReadSecretsValidatesPreviousOperatorKeys(t *testing.T) {
	root := t.TempDir()
	values := testSecretValues()
	values[previousOperatorKeysName] = " "
	path := writeTestSecrets(t, root, values)
	if _, err := readSecrets(path); err == nil || !strings.Contains(err.Error(), "empty "+previousOperatorKeysName) {
		t.Fatalf("blank previous keys accepted: %v", err)
	}
	values = testSecretValues()
	values["SMITHERS_UNKNOWN"] = "x"
	path = writeTestSecrets(t, root, values)
	if _, err := readSecrets(path); err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("unknown secret accepted: %v", err)
	}
	values = testSecretValues()
	values[previousOperatorKeysName] = "old"
	path = writeTestSecrets(t, root, values)
	read, err := readSecrets(path)
	if err != nil || read[previousOperatorKeysName] != "old" {
		t.Fatalf("previous keys not read: %v %v", read, err)
	}
}

type resealCall struct {
	current  string
	previous []string
}

func TestRotateOperatorKeyRecordsResealsAndRetires(t *testing.T) {
	clearBootstrapEnvironment(t)
	root := t.TempDir()
	original := testSecretValues()
	path := writeTestSecrets(t, root, original)

	var calls []resealCall
	failing := errors.New("database unreachable")
	resumed, err := RotateOperatorKey(context.Background(), root, func(_ context.Context, current string, previous []string) error {
		calls = append(calls, resealCall{current, previous})
		return failing
	})
	if !errors.Is(err, failing) || resumed {
		t.Fatalf("rotate = %v, %v", resumed, err)
	}
	// The failed reseal leaves both keys recorded, every other secret intact.
	interrupted, err := readSecrets(path)
	if err != nil {
		t.Fatal(err)
	}
	newKey := interrupted[operatorKeyName]
	if newKey == original[operatorKeyName] || len(newKey) != 64 {
		t.Fatalf("new key = %q", newKey)
	}
	if interrupted[previousOperatorKeysName] != original[operatorKeyName] {
		t.Fatal("the replaced key was not recorded as previous")
	}
	for _, name := range secretNames {
		if name != operatorKeyName && interrupted[name] != original[name] {
			t.Fatalf("%s changed", name)
		}
	}
	if len(calls) != 1 || calls[0].current != newKey || len(calls[0].previous) != 1 || calls[0].previous[0] != original[operatorKeyName] {
		t.Fatalf("reseal calls = %#v", calls)
	}

	// A rerun resumes with the key already written and retires the old one.
	resumed, err = RotateOperatorKey(context.Background(), root, func(_ context.Context, current string, previous []string) error {
		calls = append(calls, resealCall{current, previous})
		return nil
	})
	if err != nil || !resumed {
		t.Fatalf("resume = %v, %v", resumed, err)
	}
	if calls[1].current != newKey || calls[1].previous[0] != original[operatorKeyName] {
		t.Fatalf("resumed reseal = %#v", calls[1])
	}
	final, err := readSecrets(path)
	if err != nil {
		t.Fatal(err)
	}
	if final[operatorKeyName] != newKey {
		t.Fatal("resume changed the new key")
	}
	if _, ok := final[previousOperatorKeysName]; ok {
		t.Fatal("previous key not retired")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("secrets file mode: %v %v", info, err)
	}

	// A fresh rotation generates another key.
	if _, err := RotateOperatorKey(context.Background(), root, func(_ context.Context, current string, previous []string) error {
		calls = append(calls, resealCall{current, previous})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if calls[2].current == newKey || calls[2].previous[0] != newKey {
		t.Fatalf("second rotation = %#v", calls[2])
	}
}

func TestRotateOperatorKeyRefusals(t *testing.T) {
	clearBootstrapEnvironment(t)
	noReseal := func(context.Context, string, []string) error { t.Fatal("reseal ran"); return nil }
	ctx := context.Background()

	if _, err := RotateOperatorKey(ctx, t.TempDir(), nil); err == nil {
		t.Fatal("nil reseal accepted")
	}
	if _, err := RotateOperatorKey(ctx, t.TempDir(), noReseal); err == nil || !strings.Contains(err.Error(), "no local secrets file") {
		t.Fatalf("missing secrets file: %v", err)
	}

	root := t.TempDir()
	values := testSecretValues()
	values[operatorKeyName] = "key,with,commas"
	path := writeTestSecrets(t, root, values)
	if _, err := RotateOperatorKey(ctx, root, noReseal); err == nil || !strings.Contains(err.Error(), "comma") {
		t.Fatalf("comma key: %v", err)
	}
	if got, _ := readSecrets(path); got[operatorKeyName] != "key,with,commas" {
		t.Fatal("a refused rotation changed the file")
	}

	root = t.TempDir()
	writeTestSecrets(t, root, testSecretValues())
	lock, err := os.OpenFile(filepath.Join(root, ".maintenance.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	if _, err := RotateOperatorKey(ctx, root, noReseal); err == nil || !strings.Contains(err.Error(), "Smithers is running") {
		t.Fatalf("running app: %v", err)
	}
	_ = lock.Close()

	t.Setenv(operatorKeyName, "environment-operator-key")
	if _, err := RotateOperatorKey(ctx, root, noReseal); !errors.Is(err, ErrOperatorKeyFromEnvironment) {
		t.Fatalf("environment key: %v", err)
	}
	_ = os.Unsetenv(operatorKeyName)

	// The data root defaults to SMITHERS_DATA_ROOT.
	t.Setenv("SMITHERS_DATA_ROOT", root)
	if _, err := RotateOperatorKey(ctx, "", func(context.Context, string, []string) error { return nil }); err != nil {
		t.Fatalf("data root from environment: %v", err)
	}
}
