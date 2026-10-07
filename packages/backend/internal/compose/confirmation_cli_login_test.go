package compose

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Complete source CLI login against the install's OAuth route and GitHub fake.
// The returned token is read from the CLI's actual credential store.
func confirmationCLILogin(t *testing.T, ctx context.Context, origin, code, via string) string {
	t.Helper()
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	home := t.TempDir()
	browser := writeCLILoginBrowser(t, home, code)
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	argv := []string{filepath.Join(root, "packages/smithers/bin/smithers.mjs"), "login", origin, "--format", "json"}
	if via != "cli" {
		argv = append(argv, "--agent", via)
	}
	command := exec.CommandContext(ctx, node, argv...)
	command.Dir = root
	environment := []string{}
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "CLAUDECODE=") && !strings.HasPrefix(entry, "CODEX_") {
			environment = append(environment, entry)
		}
	}
	command.Env = append(environment, "HOME="+home, "XDG_CONFIG_HOME="+home, "XDG_DATA_HOME="+home, "SMITHERS_AUTH_FILE="+filepath.Join(home, "auth.json"), "SMITHERS_DISABLE_SYSTEM_KEYRING=1", "SMITHERS_API_ORIGIN="+origin, "SMITHERS_TOKEN=", "SMITHERS_TOKEN_FILE=", "BROWSER="+browser)
	if via == "claude-code" {
		command.Env = append(command.Env, "CLAUDECODE=1")
	}
	go func() {
		tick := time.NewTicker(50 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if _, err := os.Stat(filepath.Join(home, "browser-error.txt")); err == nil {
					cancel()
					return
				}
			}
		}
	}()
	output, err := command.CombinedOutput()
	if err != nil {
		diagnostic, _ := os.ReadFile(filepath.Join(home, "browser-error.txt"))
		t.Fatalf("CLI login: %v; %s; browser: %s", err, output, diagnostic)
	}
	var credential struct {
		Kind  string `json:"kind"`
		Via   string `json:"via"`
		Token string `json:"token"`
	}
	saved, err := os.ReadFile(filepath.Join(home, "auth.json"))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(saved, &credential))
	require.Equal(t, "delegated", credential.Kind)
	require.Equal(t, via, credential.Via)
	require.NotEmpty(t, credential.Token)
	require.NotContains(t, string(output), credential.Token)
	return credential.Token
}
