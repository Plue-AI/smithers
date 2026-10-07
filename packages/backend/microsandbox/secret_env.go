package microsandbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var secretMachineName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// putSecretEnvironment is the data-only caller of the guest's single atomic
// writer. The boot/daemon owner must establish the machine binding and assigned
// team identity before calling it. It does not select secret scope, persist
// values in workspace metadata, or install a helper from repository bytes.
// Kept private until the authenticated production boot provider is composed.
func (r *Runtime) putSecretEnvironment(ctx context.Context, machine string, values map[string]string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !secretMachineName.MatchString(machine) || len(values) > 1000 {
		return errors.New("invalid machine secret environment")
	}
	for name, value := range values {
		if !secretEnvironmentName(name) || !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
			return errors.New("invalid machine secret environment entry")
		}
	}
	// JSON null is not a replacement map: an empty map explicitly clears it.
	if values == nil {
		values = map[string]string{}
	}
	body, err := json.Marshal(values)
	if err != nil {
		return errors.New("encode machine secret environment")
	}
	if len(body) > 1<<20 {
		return errors.New("machine secret environment exceeds limit")
	}
	deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err = r.guest(deadline, machine, body, "put-env")
	if err != nil {
		if deadline.Err() != nil {
			return deadline.Err()
		}
		// Transport diagnostics can contain echoed stdin. Never project them into
		// a boot failure, API response or activity containing secret values.
		return fmt.Errorf("%w: replace machine secret environment", ErrUnavailable)
	}
	return nil
}

func secretEnvironmentName(name string) bool {
	if name == "" {
		return false
	}
	for i, c := range name {
		if c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || i > 0 && c >= '0' && c <= '9' {
			continue
		}
		return false
	}
	return true
}
