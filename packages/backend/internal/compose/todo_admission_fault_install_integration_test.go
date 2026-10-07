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

	"github.com/stretchr/testify/require"
)

// Inject only a PostgreSQL commit fault; admission still enters through the
// composed install router and production issue-events worker.
func TestTodoAdmissionInstallRollbackAndRace(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_TODO_LABEL_REHEARSAL", "C-J2-02", "admission-fault-")
	if !r.install("Install ready") {
		return
	}
	const repo = "rehearsal-owner/app"
	r.fake.SetCollaborator(208, "ben", "write")
	_, err := r.member("ben", 208, "write")
	require.NoError(t, err)
	number := r.fake.OpenIssue(repo, "ben", "Atomic issue", "Frozen race body")
	raw, err := r.expect("GET", fmt.Sprintf("/api/issues/%d", number), "", 200)
	require.NoError(t, err)
	var read struct {
		Digest string `json:"issue_digest"`
	}
	require.NoError(t, json.Unmarshal(raw, &read))
	require.Len(t, read.Digest, 64)
	_, err = r.pool.Exec(r.ctx, fmt.Sprintf(`CREATE SEQUENCE admission_fault_hits;
 CREATE FUNCTION admission_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.event_type='todo.created' AND (NEW.data->>'issue')::bigint=%d THEN PERFORM nextval('admission_fault_hits'); RAISE EXCEPTION 'injected admission failure'; END IF;
 RETURN NEW; END $$;
 CREATE TRIGGER admission_fault BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION admission_fault();`, number))
	require.NoError(t, err)
	event := r.fake.LabelIssue(repo, number, "ben", "todo")
	require.Eventually(t, func() bool {
		var hit bool
		return r.pool.QueryRow(r.ctx, `SELECT is_called FROM admission_fault_hits`).Scan(&hit) == nil && hit
	}, 30*time.Second, 100*time.Millisecond, "production poll must reach the injected fault")
	var count int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items WHERE issue_number=$1`, number).Scan(&count))
	require.Zero(t, count)
	var receipts int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.created' AND data->>'issue'=$1`, fmt.Sprint(number)).Scan(&receipts))
	require.Zero(t, receipts)
	// The fetch cursor owns durable shared-job delivery. The label consumer's
	// marker, which shares the TODO transaction, must remain unconsumed.
	var consumed bool
	marker := fmt.Sprintf("todo-label:%%:%d:%d", number, event)
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT EXISTS(SELECT 1 FROM install_settings WHERE key LIKE $1)`, marker).Scan(&consumed))
	require.False(t, consumed, "failed admission cannot consume the label")
	_, err = r.pool.Exec(r.ctx, `DROP TRIGGER admission_fault ON product_job_events; DROP FUNCTION admission_fault(); DROP SEQUENCE admission_fault_hits`)
	require.NoError(t, err)
	// Two browser commits compete with the worker's retry, using the original
	// author-bound snapshot. Avoid the rehearsal recorder's mutable last-result
	// fields in the concurrent HTTP requests.
	body := fmt.Sprintf(`{"title":"Edited race draft","prompt":"Resolve the frozen issue","issue":%d,"issue_digest":%q}`, number, read.Digest)
	start := make(chan struct{})
	failures := make(chan error, 2)
	var workers sync.WaitGroup
	for i := 0; i < 2; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			<-start
			request, err := http.NewRequestWithContext(r.ctx, "POST", r.origin+"/api/todos", strings.NewReader(body))
			if err != nil {
				failures <- err
				return
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", r.origin)
			request.Header.Set("Idempotency-Key", fmt.Sprintf("race-%d", i))
			for _, cookie := range r.jar.Cookies(request.URL) {
				if cookie.Name == "__csrf" {
					request.Header.Set("X-CSRF-Token", cookie.Value)
				}
			}
			response, err := r.client.Do(request)
			if err != nil {
				failures <- err
				return
			}
			data, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil {
				failures <- err
				return
			}
			if response.StatusCode == 409 {
				var refusal struct {
					Code  string `json:"code"`
					Class string `json:"class"`
				}
				if json.Unmarshal(data, &refusal) == nil && refusal.Code == "issue_has_todo" && refusal.Class == "conflict" {
					return
				}
			}
			if response.StatusCode != 202 {
				failures <- fmt.Errorf("commit %d: %s", response.StatusCode, data)
			}
		}(i)
	}
	close(start)
	workers.Wait()
	close(failures)
	for err := range failures {
		require.NoError(t, err)
	}
	require.Eventually(t, func() bool {
		return r.pool.QueryRow(r.ctx, `SELECT EXISTS(SELECT 1 FROM install_settings WHERE key LIKE $1)`, marker).Scan(&consumed) == nil && consumed
	}, 30*time.Second, 100*time.Millisecond)
	var revisions int
	var bodyRead string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*),min(jsonb_array_length(revisions)),min(issue_body) FROM mythical_items WHERE issue_number=$1`, number).Scan(&count, &revisions, &bodyRead))
	require.Equal(t, 1, count)
	require.Equal(t, 1, revisions)
	require.Equal(t, "Frozen race body", bodyRead)
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.created' AND data->>'issue'=$1`, fmt.Sprint(number)).Scan(&receipts))
	require.Equal(t, 1, receipts)
	// A second issue faults after remote success, before local acknowledgment.
	noticeIssue := r.fake.OpenIssue(repo, "ben", "Notice retry", "Notice body")
	raw, err = r.expect("GET", fmt.Sprintf("/api/issues/%d", noticeIssue), "", 200)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &read))
	_, err = r.pool.Exec(r.ctx, fmt.Sprintf(`CREATE SEQUENCE notice_fault_hits;
 CREATE FUNCTION notice_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.issue_number=%d AND OLD.checks ? 'notice' AND NOT NEW.checks ? 'notice' THEN
 PERFORM nextval('notice_fault_hits'); RAISE EXCEPTION 'injected notice acknowledgment failure'; END IF;
 RETURN NEW; END $$;
 CREATE TRIGGER notice_fault BEFORE UPDATE ON mythical_items FOR EACH ROW EXECUTE FUNCTION notice_fault();`, noticeIssue))
	require.NoError(t, err)
	body = fmt.Sprintf(`{"title":"Notice retry","prompt":"Resolve notice body","issue":%d,"issue_digest":%q}`, noticeIssue, read.Digest)
	_, err = r.expect("POST", "/api/todos", body, 202)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		var hit bool
		return r.pool.QueryRow(r.ctx, `SELECT is_called FROM notice_fault_hits`).Scan(&hit) == nil && hit
	}, 30*time.Second, 100*time.Millisecond)
	view, ok := r.fake.Issue(repo, noticeIssue)
	require.True(t, ok)
	require.Contains(t, view.Labels, "todo")
	require.Len(t, view.Comments, 1, "remote success precedes the local acknowledgment fault")
	require.Contains(t, view.Comments[0].Body, "Committed as")
	var pending bool
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT checks ? 'notice' FROM mythical_items WHERE issue_number=$1`, noticeIssue).Scan(&pending))
	require.True(t, pending)
	_, err = r.pool.Exec(r.ctx, `DROP TRIGGER notice_fault ON mythical_items; DROP FUNCTION notice_fault(); DROP SEQUENCE notice_fault_hits`)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		return r.pool.QueryRow(r.ctx, `SELECT checks ? 'notice' FROM mythical_items WHERE issue_number=$1`, noticeIssue).Scan(&pending) == nil && !pending
	}, 30*time.Second, 100*time.Millisecond)
	view, ok = r.fake.Issue(repo, noticeIssue)
	require.True(t, ok)
	require.Len(t, view.Comments, 1, "retry reuses the keyed remote comment")

}
