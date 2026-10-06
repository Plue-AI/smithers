package compose

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/stretchr/testify/require"
)

// Accepted-tree fixtures stand in for a completed machine run; ingress,
// polling, durable delivery and the person's TODO card use the composed install.
func TestTODOGitHubCloseReopenComposedInstall(t *testing.T) {
	t.Setenv("REHEARSAL_INSTALLATION_ID", "93")
	r := newRehearsal(t, "SMITHERS_GH03_REHEARSAL", "C-J10-08", "gh03-life-")
	r.stepBudget = 2 * time.Minute
	r.client.Timeout = 30 * time.Second
	require.True(t, r.setupSource())
	token, err := r.token("write:repository")
	require.NoError(t, err)
	work := filepath.Join(t.TempDir(), "candidate")
	_, err = r.gitDoor(token, "clone", "-q", r.origin+"/rehearsal-owner/app.git", work)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(work, "lifecycle.txt"), []byte("accepted change\n"), 0600))
	_, err = r.gitDoor(token, "-C", work, "add", "lifecycle.txt")
	require.NoError(t, err)
	_, err = r.gitDoor(token, "-C", work, "commit", "-q", "-m", "accepted lifecycle fixture")
	require.NoError(t, err)
	head, err := r.gitDoor(token, "-C", work, "rev-parse", "HEAD")
	require.NoError(t, err)
	const branch = "smithers/lifecycle-fixture"
	_, err = r.gitDoor(token, "-C", work, "push", "-q", "origin", "HEAD:refs/heads/gh03-life-candidate")
	require.NoError(t, err)
	_, err = r.gitDoor(token, "-C", work, "push", "-q", filepath.Join(r.gitRoot, "rehearsal-owner", "app.git"), "HEAD:refs/heads/"+branch)
	require.NoError(t, err)
	codec, err := webhook.NewSecretCodec("rehearsal-encryption-key")
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(r.pool, codec)
	connections := services.NewRepoConnectionService(r.pool, credentials)
	access, err := connections.CreateGitHubInstallationToken(r.ctx, 93, services.GitHubTokenScope{AllRepositories: true, Permissions: map[string]string{"pull_requests": "write"}})
	require.NoError(t, err)
	fakeRequest := func(method, path, body string) {
		req, err := http.NewRequest(method, r.fake.URL+path, bytes.NewBufferString(body))
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+access.Token)
		resp, err := r.fake.Client().Do(req)
		require.NoError(t, err)
		require.Less(t, resp.StatusCode, 300)
		require.NoError(t, resp.Body.Close())
	}
	fakeRequest("POST", "/repos/rehearsal-owner/app/pulls", `{"title":"Lifecycle","head":"smithers/lifecycle-fixture","base":"main","body":"accepted","draft":false}`)
	require.Eventually(t, func() bool {
		var state string
		err := r.pool.QueryRow(r.ctx, `SELECT state FROM mythical_stacks`).Scan(&state)
		return err == nil && state == "active"
	}, 30*time.Second, 50*time.Millisecond)
	data, err := r.expect("POST", "/api/todos", `{"title":"Lifecycle","prompt":"accepted change","acceptance":["passes"]}`, 202)
	require.NoError(t, err)
	var filed struct {
		N int64 `json:"n"`
	}
	require.NoError(t, json.Unmarshal(data, &filed))
	require.Positive(t, filed.N)
	// Hold the fixture during the real stack bootstrap; no repository run starts.
	_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET version=version+1,state='blocked',candidate_base=$2,candidate_head=$3,candidate_verified=true,pr_head=$3,pr_number=1,pr_state='open',pr_url='https://github.com/rehearsal-owner/app/pull/1',attempt=1,checks='{"branch":"smithers/lifecycle-fixture"}' WHERE number=$1`, filed.N, r.mainCommit, head)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		var state string
		err := r.pool.QueryRow(r.ctx, `SELECT state FROM mythical_stacks`).Scan(&state)
		return err == nil && state == "active"
	}, 20*time.Second, 50*time.Millisecond)
	_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET version=version+1,state='proposed' WHERE number=$1`, filed.N)
	require.NoError(t, err)
	hint := func(action string) {
		payload := []byte(fmt.Sprintf(`{"action":%q,"number":1,"installation":{"id":93},"repository":{"id":100,"name":"app","full_name":"rehearsal-owner/app","owner":{"login":"rehearsal-owner"}},"pull_request":{"number":1,"head":{"ref":%q,"sha":%q}}}`, action, branch, head))
		mac := hmac.New(sha256.New, []byte("webhook"))
		_, err := mac.Write(payload)
		require.NoError(t, err)
		req, err := http.NewRequest("POST", r.origin+"/webhooks/github", bytes.NewReader(payload))
		require.NoError(t, err)
		req.Header.Set("X-GitHub-Event", "pull_request")
		req.Header.Set("X-GitHub-Delivery", uuid.NewString())
		req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		resp, err := r.client.Do(req)
		require.NoError(t, err)
		require.Less(t, resp.StatusCode, 300)
		require.NoError(t, resp.Body.Close())
	}
	cardState := func(want string) bool {
		status, data, err := r.request("GET", fmt.Sprintf("/api/todos/%d", filed.N), "")
		if err != nil || status != 200 {
			return false
		}
		var card struct {
			State string `json:"state"`
		}
		return json.Unmarshal(data, &card) == nil && card.State == want
	}
	sealed, err := credentials.Load(r.ctx)
	require.NoError(t, err)
	require.Equal(t, int64(93), sealed.InstallationID)
	var binding string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT json_build_object('id',id,'installation',installation_id,'github',github_repository_id,'metadata',sync_metadata,'state',sync_state)::text FROM github_synced_repos WHERE owner_login='rehearsal-owner' AND repo_name='app'`).Scan(&binding))
	t.Log("sync binding", binding)
	var source struct {
		Installation int64 `json:"installation"`
		Github       int64 `json:"github"`
		Metadata     bool  `json:"metadata"`
	}
	require.NoError(t, json.Unmarshal([]byte(binding), &source))
	require.Equal(t, int64(93), source.Installation)
	require.Equal(t, int64(100), source.Github)
	require.True(t, source.Metadata)
	fakeRequest("PATCH", "/repos/rehearsal-owner/app/pulls/1", `{"state":"closed"}`)
	hint("closed")
	require.Eventually(t, func() bool { return cardState("dropped") }, 20*time.Second, 50*time.Millisecond)
	hint("closed")
	fakeRequest("PATCH", "/repos/rehearsal-owner/app/pulls/1", `{"state":"open"}`)
	hint("reopened")
	require.Eventually(t, func() bool { return cardState("in_review") }, 20*time.Second, 50*time.Millisecond)
	hint("reopened")
	var attempt int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT attempt FROM mythical_items WHERE number=$1`, filed.N).Scan(&attempt))
	require.Equal(t, 1, attempt)
	var dropped, reopened int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FILTER(WHERE event_type='todo.github_dropped'),count(*) FILTER(WHERE event_type='todo.github_in_review') FROM product_job_events`).Scan(&dropped, &reopened))
	require.Equal(t, 1, dropped)
	require.Equal(t, 1, reopened)
}
