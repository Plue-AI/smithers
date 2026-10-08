package compose

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

// These are literal source facts over retained, real Git objects and the
// composed GitHub App publication worker. No guard, proposal transport or card
// projector is substituted. The candidate's completed verification is seeded;
// this matrix does not claim capture/guest verification qualification.
func TestTodoProposeSourceTransitionLiteralCases(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	cases := []struct {
		name, engine, wait                  string
		launched, attached, paused, propose bool
	}{
		{"queued", "queued", "", false, false, false, false},
		{"starting", "running", "", true, false, false, false},
		{"working", "proposing", "", true, true, false, true},
		{"needs_you", "proposing", "question", true, true, false, false},
		{"needs_you_branch", "proposing", "foreign_push", true, true, false, false},
		{"needs_you_approval", "proposing", "approval", true, true, false, false},
		{"needs_you_conflict", "proposing", "conflict", true, true, false, false},
		{"needs_you_moved_off", "proposing", "moved_off", true, true, false, false},
		{"paused", "proposing", "", true, true, true, false},
		{"failed", "blocked", "", true, true, false, false},
		{"in_review", "proposed", "", true, true, false, false},
		{"merged", "landed", "", true, true, false, false},
		{"dropped", "cancelled", "", true, true, false, false},
	}
	accepted, held := 0, 0
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newMergeFaultFixture(t)
			ctx := t.Context()
			f.service.SetPublicURL(f.server.URL)
			out, err := exec.CommandContext(ctx, "git", "-C", f.host, "update-ref", repohost.MythicalReservedRefNS+"keep/"+f.head, f.head).CombinedOutput()
			require.NoError(t, err, string(out))
			publicationWrites := func() []githubfake.Write {
				var out []githubfake.Write
				for _, w := range f.fake.Writes() {
					if strings.Contains(w.Path, "/pulls") || strings.Contains(w.Path, "/git/refs") || strings.HasSuffix(w.Path, "/git-receive-pack") {
						out = append(out, w)
					}
				}
				return out
			}
			stack, err := f.q.GetMythicalStack(ctx, f.repo)
			require.NoError(t, err)
			checks := map[string]any{"todo": true, "branch": "smithers/wave", "run_launched": c.launched, "run_attached": c.attached, "flowSource": stack.LandedMain, "attempts": []map[string]any{{"attempt": 1, "run_id": "bound-run"}}}
			if c.wait != "" {
				checks["waits"] = []map[string]any{{"id": "literal-wait", "kind": c.wait, "prompt": "Choose", "since": "2026-10-02T12:00:00Z"}}
			}
			raw, err := json.Marshal(checks)
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,attempt=1,request_run_id='bound-run',request_outcome='',flow_digest=$4,candidate_base=$5,base_commit=$5,candidate_head=$6,candidate_verified=true,plan='{"checks":[]}',pr_state=CASE WHEN $7 THEN '' ELSE 'open' END,paused_at=CASE WHEN $8 THEN now() ELSE NULL END,next_attempt_at='2026-10-02T00:00:00Z' WHERE id=$1`, f.item.ID, c.engine, raw, startFaultDigest, stack.LandedMain, f.head, c.name == "queued" || c.name == "starting", c.paused)
			require.NoError(t, err)
			writes := publicationWrites()
			var events int
			require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE principal_id=$1 AND state='in_review'`, "todo:"+uuid.UUID(f.item.ID.Bytes).String()).Scan(&events))
			_, err = f.q.RequestMythicalStack(ctx, f.repo)
			require.NoError(t, err)
			require.NoError(t, f.service.PollOnce(ctx))
			after, err := f.q.GetMythicalItem(ctx, f.item.ID)
			require.NoError(t, err)
			expected := c.name
			if c.wait != "" {
				expected = "needs_you"
			}
			if c.propose {
				accepted++
				require.Eventually(t, func() bool {
					_, err := f.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at='2026-10-02T00:00:00Z' WHERE id=$1`, f.item.ID)
					if err != nil {
						return false
					}
					_, err = f.q.RequestMythicalStack(ctx, f.repo)
					if err != nil {
						return false
					}
					if f.service.PollOnce(ctx) != nil {
						return false
					}
					after, err = f.q.GetMythicalItem(ctx, f.item.ID)

					return err == nil && after.State == "proposed"
				}, 10*time.Second, 20*time.Millisecond, "proposal did not settle")
				expected = "in_review"
				var count int
				require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE principal_id=$1 AND state='in_review'`, "todo:"+uuid.UUID(f.item.ID.Bytes).String()).Scan(&count))
				require.Equal(t, events+1, count)
				var data []byte
				require.NoError(t, f.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE principal_id=$1 AND state='in_review' ORDER BY sequence DESC LIMIT 1`, "todo:"+uuid.UUID(f.item.ID.Bytes).String()).Scan(&data))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(data, &fact))
				require.Equal(t, "working", fact["from"])
				require.Equal(t, "in_review", fact["to"])
				require.Equal(t, map[string]any{"kind": "system", "id": "stack"}, fact["actor"])
			} else {
				held++
				require.Equal(t, writes, publicationWrites(), "a held/non-offering source cannot publish")
				require.Equal(t, f.head, after.PRHead)
				var count int
				require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE principal_id=$1 AND state='in_review'`, "todo:"+uuid.UUID(f.item.ID.Bytes).String()).Scan(&count))
				require.Equal(t, events, count)
			}
			req, err := http.NewRequest("GET", fmt.Sprintf("%s/api/todos/%d", f.server.URL, f.number), nil)
			require.NoError(t, err)
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
			response, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer response.Body.Close()
			var card map[string]any
			require.NoError(t, json.NewDecoder(response.Body).Decode(&card))
			require.Equal(t, 200, response.StatusCode, card)
			require.Equal(t, expected, card["state"])
		})
	}
	require.Equal(t, 1, accepted)
	require.Equal(t, 12, held)
	t.Logf("literal proposal sources: %d offered, %d held/non-offering", accepted, held)
}
