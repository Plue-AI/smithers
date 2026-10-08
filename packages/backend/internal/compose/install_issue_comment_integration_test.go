package compose

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// The catalog's canonical HTTP door, real OAuth sessions/token minting,
// confirmation consumer, durable worker, PostgreSQL and local GitHub fake.
func TestInstallIssueCommentComposed(t *testing.T) {
	t.Setenv("SMITHERS_ISSUE_COMMENT_REHEARSAL", "1")
	r := newRehearsal(t, "SMITHERS_ISSUE_COMMENT_REHEARSAL", "C-ACC-01", "comment-")
	require.True(t, r.install("Install ready"))
	const repo = "rehearsal-owner/app"
	number := r.fake.OpenIssue(repo, "rehearsal-owner", "A comment", "Body")
	path := fmt.Sprintf("/api/issues/%d/comments", number)
	await := func(t *testing.T, id string, state jobs.State) {
		t.Helper()
		require.Eventually(t, func() bool {
			var got string
			err := r.pool.QueryRow(r.ctx, "SELECT state FROM product_job_requests WHERE id=$1", id).Scan(&got)
			return err == nil && got == string(state)
		}, 15*time.Second, 20*time.Millisecond, "operation %s must reach %s", id, state)
	}
	comments := func() []string {
		t.Helper()
		issue, ok := r.fake.Issue(repo, number)
		require.True(t, ok)
		out := []string{}
		for _, comment := range issue.Comments {
			out = append(out, comment.Body)
		}
		return out
	}
	t.Run("session admits once and worker posts attributed comment", func(t *testing.T) {
		code, raw, err := r.keyed("POST", path, `{"body":"Ready"}`, "session-comment")
		require.NoError(t, err)
		require.Equal(t, 202, code, string(raw))
		var receipt jobs.RequestReceipt
		require.NoError(t, json.Unmarshal(raw, &receipt))
		require.Equal(t, "requested", receipt.Kind)
		code, replay, err := r.keyed("POST", path, `{"body":"Ready"}`, "session-comment")
		require.NoError(t, err)
		require.Equal(t, 202, code, string(replay))
		var again jobs.RequestReceipt
		require.NoError(t, json.Unmarshal(replay, &again))
		require.Equal(t, receipt.OperationID, again.OperationID)
		await(t, receipt.OperationID, jobs.StateCompleted)
		require.Len(t, comments(), 1)
		require.Contains(t, comments()[0], "Requested by @rehearsal-owner")
		code, raw, err = r.keyed("POST", path, `{"body":"Different"}`, "session-comment")
		require.NoError(t, err)
		require.Equal(t, 409, code, string(raw))
	})
	t.Run("invalid payload has no admission", func(t *testing.T) {
		for i, body := range []string{`{"body":""}`, `{"body":"x","number":999}`, `{"body":"x"} {}`} {
			code, raw, err := r.keyed("POST", path, body, fmt.Sprintf("invalid-%d", i))
			require.NoError(t, err)
			require.Equal(t, 400, code, string(raw))
		}
		require.Len(t, comments(), 1)
	})
	member, err := r.member("ben", 208, "write")
	require.NoError(t, err)
	raw, err := r.expectAs(member, "POST", "/api/user/tokens", `{"name":"comment-codex","via":"codex","scopes":["repo","user"]}`, 201)
	require.NoError(t, err)
	var token struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(raw, &token))
	require.NotEmpty(t, token.Token)
	delegated := func(method, url, body, key string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(method, r.origin+url, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+token.Token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("Smithers-Actor", "person")
		req.Header.Set("Smithers-Via", "smithers")
		resp, err := r.client.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		bytes, err := io.ReadAll(resp.Body)
		require.NoError(t, err)
		var result map[string]any
		require.NoError(t, json.Unmarshal(bytes, &result), string(bytes))
		return resp.StatusCode, result
	}
	t.Run("member agent requires its own private app confirmation", func(t *testing.T) {
		code, result := delegated("POST", path, `{"body":"Ben asks"}`, "agent-comment")
		require.Equal(t, 202, code, result)
		require.Len(t, result, 2)
		require.Equal(t, "pending", result["state"])
		id := result["confirmation"].(string)
		require.Len(t, comments(), 1)
		code, replay := delegated("POST", path, `{"body":"Ben asks"}`, "agent-comment")
		require.Equal(t, 202, code, replay)
		require.Equal(t, id, replay["confirmation"])
		code, result = delegated("POST", "/api/confirmations/"+id+"/approve", "{}", "agent-approve")
		require.Equal(t, 403, code, result)
		require.Len(t, comments(), 1)
		code, raw, err := r.keyed("POST", "/api/confirmations/"+id+"/approve", "{}", "wrong-person")
		require.NoError(t, err)
		require.Equal(t, 403, code, string(raw))
		_, err = r.expectAs(member, "POST", "/api/confirmations/"+id+"/approve", "{}", 200)
		require.NoError(t, err)
		_, err = r.expectAs(member, "POST", "/api/confirmations/"+id+"/approve", "{}", 200)
		require.NoError(t, err)
		require.Eventually(t, func() bool { return len(comments()) == 2 }, 15*time.Second, 20*time.Millisecond)
		require.Contains(t, comments()[1], "Ben asks")
		require.Contains(t, comments()[1], "Requested by @ben")
		var count int
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation=$1 AND payload->>'body'='Ben asks'`, "install.issue.comment").Scan(&count))
		require.Equal(t, 1, count)
	})
	t.Run("ambiguous response is uncertain without another comment", func(t *testing.T) {
		r.fake.LoseNextResponses(fmt.Sprintf("/repos/%s/issues/%d/comments", repo, number), 1)
		code, raw, err := r.keyed("POST", path, `{"body":"Lost reply"}`, "lost-comment")
		require.NoError(t, err)
		require.Equal(t, 202, code, string(raw))
		var receipt jobs.RequestReceipt
		require.NoError(t, json.Unmarshal(raw, &receipt))
		await(t, receipt.OperationID, jobs.StateUncertain)
		require.Len(t, comments(), 3)
		code, raw, err = r.keyed("POST", path, `{"body":"Lost reply"}`, "lost-comment")
		require.NoError(t, err)
		require.Equal(t, 202, code, string(raw))
		require.Len(t, comments(), 3)
	})
	t.Run("unresolved remote delivery does not block another admission", func(t *testing.T) {
		entered, release := make(chan struct{}), make(chan struct{})
		var releaseOnce sync.Once
		unblock := func() { releaseOnce.Do(func() { close(release) }) }
		defer unblock()
		r.fake.OnNextRequest("GET", fmt.Sprintf("/repos/%s/issues/%d/comments", repo, number), func() {
			close(entered)
			<-release
		})
		code, raw, err := r.keyed("POST", path, `{"body":"Held delivery"}`, "held-comment")
		require.NoError(t, err)
		require.Equal(t, 202, code, string(raw))
		select {
		case <-entered:
		case <-time.After(15 * time.Second):
			t.Fatal("worker never reached held GitHub read")
		}
		type response struct {
			status int
			raw    []byte
			err    error
		}
		var queued jobs.RequestReceipt
		admitted := make(chan response, 1)
		go func() {
			code, raw, err := r.keyedAs(member, "POST", path, `{"body":"Queued behind held delivery"}`, "queued-comment")
			admitted <- response{code, raw, err}
		}()
		select {
		case result := <-admitted:
			require.NoError(t, result.err)
			require.Equal(t, 202, result.status, string(result.raw))
			require.Len(t, comments(), 3, "both writes remain unresolved")
			require.NoError(t, json.Unmarshal(result.raw, &queued))
		case <-time.After(5 * time.Second):
			t.Fatal("admission waited on a running GitHub request")
		}
		// Removal can commit while the owner's slow write is unresolved.
		// The queued member credential must die before its worker sends anything.
		_, err = r.expect("DELETE", "/api/members/ben", "", 204)
		require.NoError(t, err)
		code, result := delegated("POST", path, `{"body":"After removal"}`, "removed-comment")
		require.Equal(t, 401, code, result)
		require.Equal(t, "unauthenticated", result["code"])
		unblock()
		var held jobs.RequestReceipt
		require.NoError(t, json.Unmarshal(raw, &held))
		await(t, held.OperationID, jobs.StateCompleted)
		await(t, queued.OperationID, jobs.StateFailed)
		require.Len(t, comments(), 4)
		require.NotContains(t, strings.Join(comments(), "\n"), "Queued behind held delivery")
	})

}
