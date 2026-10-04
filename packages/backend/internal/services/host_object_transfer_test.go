package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestHostObjectTransferIgnoresInheritedExecutionConfiguration(t *testing.T) {
	dir := t.TempDir()
	canary := filepath.Join(dir, "executed")
	script := "#!/bin/sh\ntouch " + shellQuote(canary) + "\nexit 1\n"
	for _, name := range []string{"git", "git-remote-http", "askpass"} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(script), 0700))
	}
	global := filepath.Join(dir, "global")
	require.NoError(t, os.WriteFile(global, []byte("[url \"ext::sh -c touch "+canary+"\"]\n insteadOf = http://\n"), 0600))
	for key, value := range map[string]string{
		"PATH": dir, "HOME": dir, "GIT_CONFIG_GLOBAL": global,
		"GIT_CONFIG_SYSTEM": global, "GIT_EXEC_PATH": dir,
		"GIT_ASKPASS": filepath.Join(dir, "askpass"), "GIT_TRACE": canary,
		"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": dir,
		"LD_PRELOAD": filepath.Join(dir, "poison.so"), "DYLD_INSERT_LIBRARIES": filepath.Join(dir, "poison.dylib"),
	} {
		t.Setenv(key, value)
	}
	const head = "1111111111111111111111111111111111111111"
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/repo/info/refs":
			_, _ = w.Write([]byte(head + "\trefs/heads/main\n"))
		case "/repo/HEAD":
			_, _ = w.Write([]byte("ref: refs/heads/main\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	// Credentials may replace GIT_CONFIG_COUNT; argv must still enforce policy.
	env := append(nonInteractiveGitEnv(), gitBearerAuthEnv("fixture-token")...)
	out, err := runGitCombinedOutput(context.Background(), env, "ls-remote", server.URL+"/repo", "refs/heads/main")
	require.NoError(t, err, out)
	require.Equal(t, head+"\trefs/heads/main", strings.TrimSpace(out))
	require.Equal(t, "Bearer fixture-token", authorization)
	_, err = os.Stat(canary)
	require.True(t, os.IsNotExist(err))
}

func TestHostObjectTransferRefusesRepositoryHelpersAndRedirects(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "repo.git")
	out, err := exec.Command("/usr/bin/git", "init", "--bare", repo).CombinedOutput()
	require.NoError(t, err, string(out))
	canary := filepath.Join(dir, "executed")
	hook := filepath.Join(dir, "hook")
	require.NoError(t, os.WriteFile(hook, []byte("#!/bin/sh\ntouch "+shellQuote(canary)+"\n"), 0700))
	// Repository-local policy cannot enable an external transport or helper.
	config := "\n[protocol \"ext\"]\n allow = always\n[credential]\n helper = !" + hook + "\n[core]\n hooksPath = " + dir + "\n fsmonitor = " + hook + "\n alternateRefsCommand = " + hook + "\n[http]\n followRedirects = true\n"
	f, err := os.OpenFile(filepath.Join(repo, "config"), os.O_APPEND|os.O_WRONLY, 0600)
	require.NoError(t, err)
	_, err = f.WriteString(config)
	require.NoError(t, err)
	require.NoError(t, f.Close())
	for index, runner := range []func(context.Context, []string, ...string) (string, error){runGitCombinedOutput, runSourceRetentionGit} {
		out, err := runner(context.Background(), nonInteractiveGitEnv(), "--git-dir", repo, "ls-remote", "ext::"+hook)
		require.Error(t, err)
		if index == 0 {
			require.Contains(t, out, "transport 'ext' not allowed")
		}
		out, err = runner(context.Background(), nonInteractiveGitEnv(), "--git-dir", repo, "ls-remote", repo)
		require.Error(t, err)
		if index == 0 {
			require.Contains(t, out, "transport 'file' not allowed")
		}
	}
	requests := 0
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests++; http.Error(w, "unexpected", 500) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL+"/repo", http.StatusFound)
	}))
	defer redirect.Close()
	_, err = runGitCombinedOutput(context.Background(), nonInteractiveGitEnv(), "--git-dir", repo, "ls-remote", redirect.URL+"/repo")
	require.Error(t, err)
	require.Zero(t, requests)
	unauthorized := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusUnauthorized) }))
	defer unauthorized.Close()
	_, err = runGitCombinedOutput(context.Background(), nonInteractiveGitEnv(), "--git-dir", repo, "ls-remote", unauthorized.URL+"/repo")
	require.Error(t, err)
	_, err = os.Stat(canary)
	require.True(t, os.IsNotExist(err))
	counts, err := gitMirrorProgress(context.Background(), repo)
	require.NoError(t, err)
	require.Zero(t, counts.Objects.Done)
	bytes, err := gitMirrorObjectBytes(context.Background(), repo)
	require.NoError(t, err)
	require.Zero(t, bytes)
}
