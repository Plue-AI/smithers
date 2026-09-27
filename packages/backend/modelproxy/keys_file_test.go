package modelproxy

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func writeKeys(t *testing.T, path, body string, mode os.FileMode) {
	t.Helper()
	require.NoError(t, os.WriteFile(path, []byte(body), mode))
	require.NoError(t, os.Chmod(path, mode))
}

// Keys are read from the file on every call, so a rotated key applies to the
// next call and a removed file offers nothing; no error quotes a key.
func TestFileKeysReadsEachKeyPerCall(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys.json")
	writeKeys(t, path, `{"anthropic":"sk-ant-first","openai":"sk-openai"}`, 0o600)
	keys, err := OpenKeysFile(path)
	require.NoError(t, err)
	require.Equal(t, []string{ProviderAnthropic, ProviderOpenAI}, keys.PlatformModelProviders())
	key, err := keys.PlatformModelKey(context.Background(), ProviderAnthropic)
	require.NoError(t, err)
	require.Equal(t, "sk-ant-first", key)

	writeKeys(t, path, `{"anthropic":"sk-ant-rotated","openai":"sk-openai"}`, 0o600)
	key, err = keys.PlatformModelKey(context.Background(), ProviderAnthropic)
	require.NoError(t, err)
	require.Equal(t, "sk-ant-rotated", key)

	_, err = keys.PlatformModelKey(context.Background(), ProviderCerebras)
	require.ErrorIs(t, err, ErrKeyMissing, "a provider absent at startup is not offered")

	writeKeys(t, path, `{"anthropic":"sk-ant-rotated","openai":"sk-openai"}`, 0o644)
	_, err = keys.PlatformModelKey(context.Background(), ProviderAnthropic)
	require.ErrorIs(t, err, ErrKeyMissing, "a file others can read is refused")
	require.NotContains(t, err.Error(), "sk-")

	require.NoError(t, os.Remove(path))
	_, err = keys.PlatformModelKey(context.Background(), ProviderOpenAI)
	require.ErrorIs(t, err, ErrKeyMissing)
}

func TestOpenKeysFileRefusesUnsafeOrInvalidFiles(t *testing.T) {
	dir := t.TempDir()
	for name, tc := range map[string]struct {
		body string
		mode os.FileMode
	}{
		"group readable":   {`{"anthropic":"sk-ant-secret"}`, 0o640},
		"not an object":    {`["sk-ant-secret"]`, 0o600},
		"invalid json":     {`{"anthropic":"sk-ant-secret"`, 0o600},
		"unknown provider": {`{"anthorpic":"sk-ant-secret"}`, 0o600},
		"placeholder":      {`{"anthropic":"replace-me"}`, 0o600},
		"swapped entry":    {`{"sk-ant-secret":"anthropic"}`, 0o600},
	} {
		path := filepath.Join(dir, name+".json")
		writeKeys(t, path, tc.body, tc.mode)
		_, err := OpenKeysFile(path)
		require.Error(t, err, name)
		require.NotContains(t, err.Error(), "sk-ant-secret", name)
	}
	_, err := OpenKeysFile(filepath.Join(dir, "missing.json"))
	require.Error(t, err)
	_, err = OpenKeysFile(dir)
	require.Error(t, err, "a directory is not a key file")
}

// Upstream overrides name known providers and plain HTTP(S) origins; an
// origin with credentials is refused without quoting them.
func TestParseUpstreams(t *testing.T) {
	none, err := ParseUpstreams("  ")
	require.NoError(t, err)
	require.Nil(t, none)
	upstreams, err := ParseUpstreams(`{"cerebras":"http://provider:8080","vercel":"https://gateway.internal/base"}`)
	require.NoError(t, err)
	require.Equal(t, map[string]string{"cerebras": "http://provider:8080", "vercel": "https://gateway.internal/base"}, upstreams)
	for _, raw := range []string{`[]`, `{"moonshot":"http://provider:8080"}`, `{"openai":"ftp://provider"}`,
		`{"openai":"http://user:hunter2@provider"}`, `{"openai":"http://provider?x=1"}`, `{"openai":"provider:8080"}`} {
		_, err := ParseUpstreams(raw)
		require.Error(t, err, raw)
		require.NotContains(t, err.Error(), "hunter2")
	}
}
