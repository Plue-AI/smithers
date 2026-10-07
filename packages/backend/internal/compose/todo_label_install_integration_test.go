package compose

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// C-J2-02/C-SEC-03 through the actual single-owner install router and its
// background GitHub issue-events worker. No admission helper is invoked.
func TestTodoLabelInstallRosterBoundary(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_TODO_LABEL_REHEARSAL", "C-J2-02", "label-")
	const repo = "rehearsal-owner/app"
	if !r.install("Install ready") {
		return
	}
	r.fake.SetCollaborator(209, "carol", "write")
	if _, err := r.member("ben", 208, "write"); err != nil {
		t.Fatal(err)
	}
	team := r.fake.OpenIssue(repo, "ben", "Member label", "Freeze this body.")
	refused := r.fake.OpenIssue(repo, "ben", "Outsider label", "Start no work.")
	r.fake.LabelIssue(repo, team, "ben", "todo")
	r.fake.LabelIssue(repo, refused, "carol", "todo")
	r.step("member label and outsider refusal", "GitHub label → production sync → GET /api/todos", "member commits one frozen TODO; non-roster writer gets one reverted label and keyed comment", "T-STK-09", func() error {
		deadline := time.Now().Add(30 * time.Second)
		for {
			raw, err := r.expect("GET", "/api/todos", "", 200)
			if err != nil {
				return err
			}
			var todos []struct {
				N     int64 `json:"n"`
				Issue *struct {
					Number int64 `json:"number"`
				} `json:"issue"`
			}
			if err = json.Unmarshal(raw, &todos); err != nil {
				return err
			}
			count, unauthorized := 0, 0
			for _, todo := range todos {
				if todo.Issue != nil {
					if todo.Issue.Number == team {
						count++
					}
					if todo.Issue.Number == refused {
						unauthorized++
					}
				}
			}
			view, _ := r.fake.Issue(repo, refused)
			if unauthorized > 0 {
				return fmt.Errorf("non-roster writer admitted %d TODOs", unauthorized)
			}
			if count == 1 && len(view.Comments) == 1 && !containsTodoLabel(view.Labels) {
				if !strings.Contains(view.Comments[0].Body, "only members of this install can add `todo`") {
					return fmt.Errorf("wrong refusal: %s", view.Comments[0].Body)
				}
				r.actual = "one member TODO; outsider label removed with one keyed comment"
				return nil
			}
			if time.Now().After(deadline) {
				var sync, deliveries string
				_ = r.pool.QueryRow(r.ctx, `SELECT coalesce(json_agg(json_build_object('metadata',sync_metadata,'state',sync_state,'error',sync_error))::text,'[]') FROM github_synced_repos`).Scan(&sync)
				_ = r.pool.QueryRow(r.ctx, `SELECT coalesce(json_agg(json_build_object('operation',operation,'principal',principal_id,'state',state))::text,'[]') FROM product_job_requests WHERE operation='github.fetched'`).Scan(&deliveries)
				return fmt.Errorf("member TODOs=%d refused labels=%v comments=%d sync=%s deliveries=%s", count, view.Labels, len(view.Comments), sync, deliveries)
			}
			time.Sleep(100 * time.Millisecond)
		}
	})
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
		var projected string
		if err := r.pool.QueryRow(r.ctx, `SELECT payload->>'body' FROM github_synced_issues WHERE resource='issues' AND number=$1`, number).Scan(&projected); err != nil {
			return err
		}
		if projected != "Original snapshot body" {
			return fmt.Errorf("draft did not use the synced issue projection: %q", projected)
		}
		var comments int
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM github_synced_issue_comments WHERE issue_number=$1 AND source='conversation' AND payload->>'body'='Original discussion'`, number).Scan(&comments); err != nil {
			return err
		}
		if comments != 1 {
			return fmt.Errorf("synced snapshot discussion count=%d", comments)
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
func containsTodoLabel(labels []string) bool {
	for _, label := range labels {
		if label == "todo" {
			return true
		}
	}
	return false
}
