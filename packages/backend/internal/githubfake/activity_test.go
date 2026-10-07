package githubfake

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A person's push moves the branch in the Git fixture and appears in
// GitHub's repository activity with "actor", newest first, filtered by ref.
func TestPushAsRecordsRepositoryActivity(t *testing.T) {
	server, cfg, key := fixture(t)
	root := t.TempDir()
	seed := filepath.Join(root, "seed")
	git := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("/usr/bin/git", args...).CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	git("init", "-b", "main", seed)
	require.NoError(t, os.WriteFile(filepath.Join(seed, "JOURNEY.md"), []byte("canary\n"), 0600))
	git("-C", seed, "add", "JOURNEY.md")
	git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Seed")
	git("-C", seed, "branch", "smithers/retry")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "acme"), 0700))
	git("clone", "--bare", seed, filepath.Join(root, "acme/app.git"))
	server.mu.Lock()
	server.config.GitRoot = root
	server.mu.Unlock()
	before := git("--git-dir", filepath.Join(root, "acme/app.git"), "rev-parse", "refs/heads/smithers/retry")

	_, err := server.PushAs("acme/app", "smithers/retry", 202, "alice", "Nested", map[string]string{"dir/file.md": "x\n"})
	require.ErrorContains(t, err, "root paths only")
	first, err := server.PushAs("acme/app", "smithers/retry", 202, "alice", "Log each retry", map[string]string{"alice.md": "log\n"})
	require.NoError(t, err)
	second, err := server.PushAs("acme/app", "smithers/retry", 203, "dana", "Another", map[string]string{"alice.md": "log\nmore\n"})
	require.NoError(t, err)
	_, err = server.PushAs("acme/app", "main", 202, "alice", "Main", map[string]string{"main.md": "m\n"})
	require.NoError(t, err)
	require.Equal(t, second, git("--git-dir", filepath.Join(root, "acme/app.git"), "rev-parse", "refs/heads/smithers/retry"))
	require.Equal(t, first, git("--git-dir", filepath.Join(root, "acme/app.git"), "rev-parse", second+"^"))
	require.Equal(t, before, git("--git-dir", filepath.Join(root, "acme/app.git"), "rev-parse", first+"^"))
	require.Equal(t, "log\nmore", git("--git-dir", filepath.Join(root, "acme/app.git"), "show", second+":alice.md"))
	require.Equal(t, "canary", git("--git-dir", filepath.Join(root, "acme/app.git"), "show", second+":JOURNEY.md"))
	require.Equal(t, "alice", git("--git-dir", filepath.Join(root, "acme/app.git"), "log", "-1", "--format=%an", first))

	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	status, body = request(t, server, "GET", "/repos/acme/app/activity?ref=refs/heads/smithers/retry&direction=desc&per_page=100", access.Token, nil)
	require.Equal(t, 200, status, string(body))
	var events []struct {
		RawRef    string `json:"ref"`
		RawBefore string `json:"before"`
		RawAfter  string `json:"after"`
		Actor     struct {
			ID    int64  `json:"id"`
			Login string `json:"login"`
		} `json:"actor"`
	}
	require.NoError(t, json.Unmarshal(body, &events))
	require.Len(t, events, 2)
	require.Equal(t, "refs/heads/smithers/retry", events[0].RawRef)
	require.Equal(t, second, events[0].RawAfter)
	require.Equal(t, first, events[0].RawBefore)
	require.Equal(t, "dana", events[0].Actor.Login)
	require.Equal(t, first, events[1].RawAfter)
	require.Equal(t, before, events[1].RawBefore)
	require.Equal(t, int64(202), events[1].Actor.ID)
	require.NotContains(t, string(body), `"pusher"`)
	status, body = request(t, server, "GET", "/repos/acme/app/activity?ref=refs/heads/smithers/retry&per_page=1", access.Token, nil)
	require.Equal(t, 200, status)
	require.NoError(t, json.Unmarshal(body, &events))
	require.Len(t, events, 1)
	require.Equal(t, second, events[0].RawAfter)
	status, body = request(t, server, "GET", "/repos/acme/app/activity?ref=refs/heads/none", access.Token, nil)
	require.Equal(t, 200, status)
	require.JSONEq(t, `[]`, string(body))
}
