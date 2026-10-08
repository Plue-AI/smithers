package compose

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// This uses the complete install composition, native mirror, production poll,
// reset adapter and loader dispatch. The rehearsal's confined process machines
// are Linux execution evidence, not C-SEC-02 microVM isolation evidence.
func TestMainResetProductionComposedInstall(t *testing.T) {
	runMainResetProductionInstall(t, "SMITHERS_MAIN_RESET_REHEARSAL")
}

func runMainResetProductionInstall(t *testing.T, enable string) {
	r := newRehearsal(t, enable, "C-J10-07", "main-reset-")
	require.True(t, r.setupSource())
	require.True(t, r.setupMachine())
	require.NoError(t, r.waitStackActive())
	ctx := r.ctx
	var repository int64
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT id FROM repositories WHERE name='app'`).Scan(&repository))
	gitDir := filepath.Join(r.gitRoot, "rehearsal-owner", "app.git")
	git := func(args ...string) string {
		t.Helper()
		c := exec.CommandContext(ctx, "git", append([]string{"--git-dir", gitDir}, args...)...)
		c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.test", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.test")
		out, err := c.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	old := git("rev-parse", "refs/heads/main")
	// Let the initial loader finish before crashing a later reset. This
	// isolates reset recovery from recovery of an unrelated interrupted load.
	require.Eventually(t, func() bool {
		var loaded string
		err := r.pool.QueryRow(ctx, `SELECT loaded_commit FROM flow_loads WHERE repository_id=$1`, repository).Scan(&loaded)
		return err == nil && loaded == old
	}, 90*time.Second, 200*time.Millisecond, "initial production flow load")
	tree := git("rev-parse", old+"^{tree}")
	rewritten := git("commit-tree", tree, "-m", "Rewritten main")
	git("update-ref", "refs/heads/main", rewritten)
	_, err := r.expect("POST", "/api/github/sync", `{}`, 202)
	require.NoError(t, err)
	var attention struct {
		ID  string `json:"id"`
		Old string `json:"old"`
		New string `json:"new"`
	}
	require.Eventually(t, func() bool {
		var raw []byte
		err := r.pool.QueryRow(ctx, `SELECT a FROM mythical_stacks, jsonb_array_elements(attention) a WHERE repository_id=$1 AND a->>'kind'='force_push' AND a->>'settled_at' IS NULL`, repository).Scan(&raw)
		return err == nil && json.Unmarshal(raw, &attention) == nil && attention.New == rewritten
	}, 45*time.Second, 100*time.Millisecond, "poll must open production attention: %s", r.logs.String())
	require.Equal(t, old, attention.Old)
	ownerHome, err := r.openLive(r.jar)
	require.NoError(t, err)
	_, err = ownerHome.subscribe("home")
	require.NoError(t, err)
	frame, err := ownerHome.latest("home", 5*time.Second, func(frame liveFrame) bool {
		return strings.Contains(string(frame.Data), attention.ID)
	})
	require.NoError(t, err)
	require.Contains(t, string(frame.Data), `"main.reset-to-github"`)
	require.Contains(t, string(frame.Data), rewritten)
	ownerHome.stop()
	observed, err := r.repoClient.GetBookmark(ctx, "rehearsal-owner", "app", "main")
	require.NoError(t, err)
	require.Equal(t, old, observed.TargetCommitID)
	// Existing reviewed/working and merged TODOs are fixture inputs. Paused
	// writers make the post-reset pending projection independently observable.
	q := db.New(r.pool)
	for i, state := range []string{"proposed", "running", "landed"} {
		item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repository, State: state, Checks: json.RawMessage(`{"todo":true}`)})
		require.NoError(t, err)
		_, err = r.pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=$2::bigint,stack_position=CASE WHEN state='landed' THEN NULL ELSE $2::bigint END,title=$3,owner_id=(SELECT user_id FROM self_host_owners),candidate_base=$4,candidate_head=$4,candidate_verified=true,paused_at=now(),pr_merge_commit=CASE WHEN state='landed' THEN $4 ELSE '' END WHERE id=$1`, item.ID, i+1, fmt.Sprintf("Reset TODO %d", i+1), old)
		require.NoError(t, err)
	}
	_, err = r.expect("POST", "/api/todos/1/merge", fmt.Sprintf(`{"reviewed_head_sha":%q}`, old), 409)
	require.NoError(t, err)
	token, err := r.token("write:repository")
	require.NoError(t, err)
	request, err := http.NewRequestWithContext(ctx, "POST", r.origin+"/api/stack/attention/"+attention.ID, strings.NewReader(fmt.Sprintf(`{"old":%q,"new":%q}`, old, rewritten)))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	refusal, err := http.DefaultClient.Do(request)
	require.NoError(t, err)
	refusedBody, err := io.ReadAll(refusal.Body)
	require.NoError(t, err)
	require.NoError(t, refusal.Body.Close())
	require.Equal(t, 403, refusal.StatusCode, string(refusedBody))
	require.Contains(t, string(refusedBody), `"code":"never"`)
	for i, permission := range []string{"admin", "write"} {
		member, err := r.member(fmt.Sprintf("reset-person-%d", i), int64(820+i), permission)
		require.NoError(t, err)
		refused, err := r.expectAs(member, "POST", "/api/stack/attention/"+attention.ID, fmt.Sprintf(`{"old":%q,"new":%q}`, old, rewritten), 403)
		require.NoError(t, err)
		require.Contains(t, string(refused), `"code":"permission"`)
	}
	// An owner press bound to an outdated GitHub tip refreshes the same attention.
	latest := git("commit-tree", tree, "-m", "Second rewrite")
	git("update-ref", "refs/heads/main", latest)
	body, _ := json.Marshal(map[string]string{"old": old, "new": rewritten})
	_, err = r.expect("POST", "/api/stack/attention/"+attention.ID, string(body), 409)
	require.NoError(t, err)
	var current string
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT a->>'new' FROM mythical_stacks,jsonb_array_elements(attention) a WHERE repository_id=$1 AND a->>'id'=$2`, repository, attention.ID).Scan(&current))
	require.Equal(t, latest, current)
	observed, err = r.repoClient.GetBookmark(ctx, "rehearsal-owner", "app", "main")
	require.NoError(t, err)
	require.Equal(t, old, observed.TargetCommitID)
	body, _ = json.Marshal(map[string]string{"old": old, "new": latest})
	// Fail the settlement transaction after the real locked ref write. The
	// committed intent must be enough for an independently composed worker.
	_, err = r.pool.Exec(ctx, `CREATE FUNCTION fail_main_reset_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reset_intent->>'settled'='true' THEN RAISE EXCEPTION 'reset settlement fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_main_reset_settlement BEFORE UPDATE ON github_main_pulls FOR EACH ROW EXECUTE FUNCTION fail_main_reset_settlement()`)
	require.NoError(t, err)
	_, err = r.expect("POST", "/api/stack/attention/"+attention.ID, string(body), 500)
	require.NoError(t, err)
	observed, err = r.repoClient.GetBookmark(ctx, "rehearsal-owner", "app", "main")
	require.NoError(t, err)
	require.Equal(t, latest, observed.TargetCommitID)
	var open bool
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT a->>'settled_at' IS NULL FROM mythical_stacks,jsonb_array_elements(attention) a WHERE repository_id=$1 AND a->>'id'=$2`, repository, attention.ID).Scan(&open))
	require.True(t, open)
	r.stopBackend()
	_, err = r.pool.Exec(t.Context(), `DROP TRIGGER fail_main_reset_settlement ON github_main_pulls; DROP FUNCTION fail_main_reset_settlement()`)
	require.NoError(t, err)
	r.restartBackend()
	ctx = r.ctx
	require.Eventually(t, func() bool {
		var settled bool
		err := r.pool.QueryRow(ctx, `SELECT COALESCE((reset_intent->>'settled')::bool,false) FROM github_main_pulls WHERE repository_id=$1`, repository).Scan(&settled)
		return err == nil && settled
	}, 30*time.Second, 100*time.Millisecond)

	observed, err = r.repoClient.GetBookmark(ctx, "rehearsal-owner", "app", "main")
	require.NoError(t, err)
	require.Equal(t, latest, observed.TargetCommitID)
	var settled bool
	var actor int64
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT (reset_intent->>'settled')::bool,(reset_intent->>'actor_id')::bigint FROM github_main_pulls WHERE repository_id=$1`, repository).Scan(&settled, &actor))
	require.True(t, settled)
	require.Positive(t, actor)
	require.Eventually(t, func() bool {
		var landed, state string
		err := r.pool.QueryRow(ctx, `SELECT landed_main,state FROM mythical_stacks WHERE repository_id=$1`, repository).Scan(&landed, &state)
		return err == nil && landed == latest && state == "active"
	}, 45*time.Second, 100*time.Millisecond, "rewritten main must rebuild through the stack worker: %s", r.logs.String())
	var pendingItems int
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1 AND number IN (1,2) AND reason='rebase_pending' AND checks->'rebase'->>'onto'=$2 AND NOT candidate_verified`, repository, latest).Scan(&pendingItems))
	require.Equal(t, 2, pendingItems)
	var mergedState, mergedReason string
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT state,reason FROM mythical_items WHERE repository_id=$1 AND number=3`, repository).Scan(&mergedState, &mergedReason))
	require.Equal(t, "landed", mergedState)
	require.Equal(t, "commit no longer on main after a force push", mergedReason)
	// Loading is admitted on an ephemeral workspace pinned to the new main.
	require.Eventually(t, func() bool {
		var deliveries int
		err := r.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE request_id LIKE $1`, fmt.Sprintf("flow-load:%d:%%:%s", repository, latest)).Scan(&deliveries)
		return err == nil && deliveries == 1
	}, 45*time.Second, 100*time.Millisecond, "main-moved must reach the production machine flow loader")
	// A duplicate press uses the persisted reset key, without another stack update.
	var generation int64
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT (a->>'main_moved_generation')::bigint FROM mythical_stacks,jsonb_array_elements(attention) a WHERE repository_id=$1 AND a->>'id'=$2`, repository, attention.ID).Scan(&generation))
	_, err = r.expect("POST", "/api/stack/attention/"+attention.ID, string(body), 200)
	require.NoError(t, err)
	var repeated int64
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT (a->>'main_moved_generation')::bigint FROM mythical_stacks,jsonb_array_elements(attention) a WHERE repository_id=$1 AND a->>'id'=$2`, repository, attention.ID).Scan(&repeated))
	require.Equal(t, generation, repeated)
	// Reuse the production intent receipt as the durable input to recovery
	// at old and at a legitimate concurrent third tip. Only the fault setup
	// changes persisted crash state; recomposition runs the real journal fold.
	var recoveryReceipt []byte
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT reset_intent FROM github_main_pulls WHERE repository_id=$1`, repository).Scan(&recoveryReceipt))
	for _, third := range []bool{false, true} {
		r.stopBackend()
		ctx = t.Context()
		future := git("commit-tree", tree, "-m", fmt.Sprintf("Unwritten reset %t", third))
		want := latest
		if third {
			want = git("commit-tree", tree, "-p", latest, "-m", "Concurrent main advance")
			git("update-ref", "refs/heads/main", want)
			require.NoError(t, r.repoClient.WithMachineRepository(ctx, "rehearsal-owner", "app", func(path string) error {
				for _, args := range [][]string{{"fetch", gitDir, "refs/heads/main"}, {"update-ref", "refs/heads/main", want, latest}} {
					c := exec.CommandContext(ctx, "git", append([]string{"--git-dir", path}, args...)...)
					if out, err := c.CombinedOutput(); err != nil {
						return fmt.Errorf("concurrent ref: %w: %s", err, out)
					}
				}
				return nil
			}))
			require.NoError(t, r.repoClient.ImportRefs(ctx, "rehearsal-owner", "app"))
		}
		_, err = r.pool.Exec(ctx, `UPDATE mythical_stacks SET attention=(SELECT jsonb_agg(CASE WHEN a->>'id'=$2 THEN (a-'settled_at'-'settled_by'-'main_moved_generation') || jsonb_build_object('old',$3::text,'new',$4::text) ELSE a END) FROM jsonb_array_elements(attention) a) WHERE repository_id=$1`, repository, attention.ID, latest, future)
		require.NoError(t, err)
		_, err = r.pool.Exec(ctx, `UPDATE github_main_pulls SET reset_intent=($4::jsonb-'settled') || jsonb_build_object('old',$2::text,'new',$3::text) WHERE repository_id=$1`, repository, latest, future, recoveryReceipt)
		require.NoError(t, err)
		r.restartBackend()
		ctx = r.ctx
		require.Eventually(t, func() bool {
			var retired bool
			err := r.pool.QueryRow(ctx, `SELECT reset_intent IS NULL FROM github_main_pulls WHERE repository_id=$1`, repository).Scan(&retired)
			return err == nil && retired
		}, 30*time.Second, 100*time.Millisecond)
		observed, err := r.repoClient.GetBookmark(ctx, "rehearsal-owner", "app", "main")
		require.NoError(t, err)
		require.Equal(t, want, observed.TargetCommitID)
		var open bool
		require.NoError(t, r.pool.QueryRow(ctx, `SELECT a->>'settled_at' IS NULL FROM mythical_stacks,jsonb_array_elements(attention) a WHERE repository_id=$1 AND a->>'id'=$2`, repository, attention.ID).Scan(&open))
		require.True(t, open)
		var deliveries int
		require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE request_id LIKE $1`, fmt.Sprintf("flow-load:%d:%%:%s", repository, future)).Scan(&deliveries))
		require.Zero(t, deliveries, "unwritten resets never load repository code")
	}
	for _, write := range r.fake.Writes() {
		require.False(t, strings.Contains(write.Path, "git-receive-pack"), "sync never pushes GitHub")
	}
}
