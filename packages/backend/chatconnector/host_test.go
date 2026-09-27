package chatconnector

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestDurableNodeHost(t *testing.T) {
	root, err := filepath.Abs("../../..")
	require.NoError(t, err)
	if _, err := os.Stat(filepath.Join(root, "node_modules/effect")); err != nil && os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") != "1" {
		t.Skip("run pnpm install for the durable connector host tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for _, args := range [][]string{
		{"node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--skipLibCheck", "--target", "esnext", "--module", "nodenext", "--allowImportingTsExtensions", "packages/backend/chatconnector/runtime.ts", "packages/backend/chatconnector/serve.ts", "packages/backend/chatconnector/runtime.test.ts", "packages/backend/chatconnector/delivery.test.ts"},
		{"--test", "packages/backend/chatconnector/runtime.test.ts", "packages/backend/chatconnector/delivery.test.ts"},
	} {
		cmd := exec.CommandContext(ctx, "node", args...)
		cmd.Dir = root
		output, err := cmd.CombinedOutput()
		require.NoError(t, err, string(output))
	}
}

func TestDisabledWithoutConfiguration(t *testing.T) {
	host, err := FromEnvironment(func(string) string { return "" }, "/tmp/data", ":4000")
	require.NoError(t, err)
	require.Nil(t, host)
}

func TestHostEnvironmentAndShutdown(t *testing.T) {
	root := t.TempDir()
	output := filepath.Join(root, "environment")
	config := filepath.Join(root, "config.json")
	require.NoError(t, os.WriteFile(config, []byte(`{"owner":"alice","repo":"demo"}`), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(root, "credential"), []byte("bootstrap"), 0600))
	script := filepath.Join(root, "host")
	require.NoError(t, os.WriteFile(script, []byte("#!/bin/sh\n/usr/bin/env > \""+output+"\"\nexec /bin/sleep 30\n"), 0700))
	env := map[string]string{
		"SMITHERS_CHAT_CONNECTOR_CONFIG":     config,
		"SMITHERS_CHAT_CONNECTOR_BUNDLE":     script,
		"SMITHERS_CHAT_CONNECTOR_TOKEN_FILE": filepath.Join(root, "credential"),
		"SMITHERS_NODE_BINARY":               "/bin/sh",
		"SMITHERS_SLACK_BOT_TOKEN":           "fixture-secret",
		"OPENAI_API_KEY":                     "must-not-inherit",
		"SMITHERS_DATABASE_URL":              "must-not-inherit",
		"PATH":                               "/usr/bin:/bin",
	}
	host, err := FromEnvironment(func(key string) string { return env[key] }, root, "0.0.0.0:64972")
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- host.Run(ctx, func(context.Context, string, string, string) (string, func(), error) {
			return "sync-token", func() {}, nil
		})
	}()
	require.Eventually(t, func() bool {
		contents, err := os.ReadFile(output)
		return err == nil && strings.Contains(string(contents), "SMITHERS_CHAT_CONNECTOR_STATE=")
	}, 3*time.Second, 10*time.Millisecond)
	contents, err := os.ReadFile(output)
	require.NoError(t, err)
	require.Contains(t, string(contents), "SMITHERS_CHAT_CONNECTOR_URL=http://127.0.0.1:64972")
	require.Contains(t, string(contents), "SMITHERS_CHAT_CONNECTOR_STATE="+filepath.Join(root, "chat-connectors"))
	require.Contains(t, string(contents), "SMITHERS_SLACK_BOT_TOKEN=fixture-secret")
	require.NotContains(t, string(contents), "must-not-inherit")
	require.NotContains(t, string(contents), "SMITHERS_CHAT_CONNECTOR_TOKEN_FILE="+env["SMITHERS_CHAT_CONNECTOR_TOKEN_FILE"]+"\n", "the bootstrap path must not enter the child")
	require.Contains(t, string(contents), "SMITHERS_CHAT_CONNECTOR_TOKEN_FILE="+filepath.Join(root, "chat-connectors", "credential-"))
	cancel()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("connector did not stop")
	}
}

func TestHostRequiresPersistentAbsolutePaths(t *testing.T) {
	_, err := FromEnvironment(func(key string) string {
		if key == "SMITHERS_CHAT_CONNECTOR_CONFIG" {
			return "relative.json"
		}
		return ""
	}, "", ":4000")
	require.Error(t, err)
}
