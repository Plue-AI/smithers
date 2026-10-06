package compose

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// Make TODO uses the composed install routes, real PostgreSQL, and fake GitHub.
func TestTodoFromIssueInstallSnapshot(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_TODO_SNAPSHOT_REHEARSAL", "C-J2-01", "snapshot-")
	const repo = "rehearsal-owner/app"
	if !r.install("Install ready") {
		return
	}
	r.fake.SetCollaborator(208, "ben", "write")
	if _, err := r.expect("POST", "/api/members", `{"login":"ben"}`, 204); err != nil {
		t.Fatal(err)
	}
	r.step("original issue snapshot", "GET /api/issues/{n} → remote edit → POST /api/todos", "authorized digest keeps the original discussion; unknown digest admits nothing", "T-STK-09", func() error {
		number := r.fake.OpenIssue(repo, "ben", "Snapshot title", "Original snapshot body")
		r.fake.CommentIssue(repo, number, "carol", "Original discussion")
		raw, err := r.expect("GET", fmt.Sprintf("/api/issues/%d", number), "", 200)
		if err != nil {
			return err
		}
		var read struct {
			Digest string `json:"issue_digest"`
		}
		if err = json.Unmarshal(raw, &read); err != nil {
			return err
		}
		if len(read.Digest) != 64 {
			return fmt.Errorf("no snapshot digest: %s", raw)
		}
		r.fake.EditIssue(repo, number, "carol", "Changed title", "Changed body")
		body := func(digest string) string {
			data, _ := json.Marshal(map[string]any{"title": "Edited draft title", "prompt": "Edited draft prompt", "issue": number, "issue_digest": digest})
			return string(data)
		}
		code, _, err := r.keyed("POST", "/api/todos", body(strings.Repeat("f", 64)), "unknown-snapshot")
		if err != nil {
			return err
		}
		if code != 409 {
			return fmt.Errorf("unknown snapshot status %d", code)
		}
		code, data, err := r.keyed("POST", "/api/todos", body(read.Digest), "original-snapshot")
		if err != nil {
			return err
		}
		if code != 202 {
			return fmt.Errorf("snapshot commit %d: %s", code, data)
		}
		var receipt struct {
			N int64 `json:"n"`
		}
		if err = json.Unmarshal(data, &receipt); err != nil {
			return err
		}
		var originalBody string
		var context []byte
		if err = r.pool.QueryRow(r.ctx, `SELECT issue_body,checks->'issue_context' FROM mythical_items WHERE number=$1`, receipt.N).Scan(&originalBody, &context); err != nil {
			return err
		}
		if originalBody != "Original snapshot body" || !strings.Contains(string(context), "Original discussion") || strings.Contains(string(context), "Changed body") {
			return fmt.Errorf("wrong frozen snapshot: %s %s", originalBody, context)
		}
		r.actual = "original issue and discussion retained after remote edit; unknown digest refused"
		return nil
	})
}
