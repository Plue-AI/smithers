package compose

import (
	"context"
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

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
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
	// Owner-only Reset remains person-only for every production delegated profile.
	issuer := services.NewAuthService(q, config.AuthConfig{Mode: "selfhost"}, nil, nil)
	issuer.Members = &services.Members{Pool: r.pool}
	resetCells := []map[string]any{}
	for i, permission := range []string{"owner", "admin", "write"} {
		jar := http.CookieJar(r.jar)
		login := "rehearsal-owner"
		if permission != "owner" {
			login = fmt.Sprintf("reset-person-%d", i)
			jar, err = r.member(login, int64(820+i), permission)
			require.NoError(t, err)
			refused, err := r.expectAs(jar, "POST", "/api/stack/attention/"+attention.ID, fmt.Sprintf(`{"old":%q,"new":%q}`, old, rewritten), 403)
			require.NoError(t, err)
			require.Contains(t, string(refused), `"code":"permission"`)
			resetCells = append(resetCells, map[string]any{"role": permission, "profile": "session", "status": 403, "effects": 0})
		}
		user, err := q.GetUserByLowerUsername(ctx, login)
		require.NoError(t, err)
		for _, via := range []string{"cli", "codex", "claude-code", "smithers"} {
			t.Run("reset-access/"+permission+"/"+via, func(t *testing.T) {
				bearer := ""
				if via == "smithers" {
					token, err := issuer.MintForTurn(ctx, user.ID, liveAppTurnCredentialFixture(t, r.pool, user.ID), 1)
					require.NoError(t, err)
					bearer = token.Token
				} else {
					raw, err := r.expectAs(jar, "POST", "/api/user/tokens", fmt.Sprintf(`{"name":"reset-%s","via":%q,"scopes":["repo","user"]}`, via, via), 201)
					require.NoError(t, err)
					var token struct{ Token string }
					require.NoError(t, json.Unmarshal(raw, &token))
					bearer = token.Token
				}
				req, err := http.NewRequestWithContext(ctx, "POST", r.origin+"/api/stack/attention/"+attention.ID, strings.NewReader(fmt.Sprintf(`{"old":%q,"new":%q}`, old, rewritten)))
				require.NoError(t, err)
				req.Header.Set("Authorization", "Bearer "+bearer)
				req.Header.Set("Content-Type", "application/json")
				out, err := http.DefaultClient.Do(req)
				require.NoError(t, err)
				defer out.Body.Close()
				raw, err := io.ReadAll(out.Body)
				require.NoError(t, err)
				require.Equal(t, 403, out.StatusCode, string(raw))
				code := "never"
				if permission != "owner" {
					code = "permission"
				}
				require.Contains(t, string(raw), `"code":"`+code+`"`)
				observed, err := r.repoClient.GetBookmark(ctx, "rehearsal-owner", "app", "main")
				require.NoError(t, err)
				require.Equal(t, old, observed.TargetCommitID)
				var unsettled bool
				require.NoError(t, r.pool.QueryRow(ctx, `SELECT a->>'settled_at' IS NULL FROM mythical_stacks,jsonb_array_elements(attention) a WHERE repository_id=$1 AND a->>'id'=$2`, repository, attention.ID).Scan(&unsettled))
				require.True(t, unsettled)
				resetCells = append(resetCells, map[string]any{"role": permission, "profile": via, "status": 403, "code": code, "effects": 0})
			})
		}
	}
	require.Len(t, resetCells, 14)
	rawCells, err := json.MarshalIndent(resetCells, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "reset-access-matrix.json"), rawCells, 0600))
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
	// Stop a real HTTP reset at the upstream recheck inside the locked
	// expected-old write, after Prepare has committed its durable intent.
	// The first advertisement fetches objects; the second verifies the bound
	// upstream tip while the native mirror write lock is held.
	entered, release := make(chan struct{}), make(chan struct{})
	var released bool
	defer func() {
		if !released {
			close(release)
		}
	}()
	advertisement := "/rehearsal-owner/app.git/info/refs"
	r.fake.OnNextRequest("GET", advertisement, func() {
		r.fake.OnNextRequest("GET", advertisement, func() {
			close(entered)
			<-release
		})
	})
	requestCtx, cancelRequest := context.WithCancel(t.Context())
	defer cancelRequest()
	resetRequest, err := http.NewRequestWithContext(requestCtx, "POST", r.origin+"/api/stack/attention/"+attention.ID, strings.NewReader(string(body)))
	require.NoError(t, err)
	resetRequest.Header.Set("Content-Type", "application/json")
	resetRequest.Header.Set("Origin", r.origin)
	resetRequest.Header.Set("Idempotency-Key", r.keyPrefix+"interrupted-reset")
	for _, cookie := range r.jar.Cookies(resetRequest.URL) {
		if cookie.Name == "__csrf" {
			resetRequest.Header.Set("X-CSRF-Token", cookie.Value)
		}
	}
	resetDone := make(chan error, 1)
	go func() {
		response, err := (&http.Client{Jar: r.jar}).Do(resetRequest)
		if response != nil {
			_ = response.Body.Close()
		}
		resetDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(30 * time.Second):
		t.Fatal("reset did not reach locked upstream recheck")
	}
	var prepared bool
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT reset_intent->>'id'=$2 AND reset_intent->>'settled' IS DISTINCT FROM 'true' FROM github_main_pulls WHERE repository_id=$1`, repository, attention.ID).Scan(&prepared))
	require.True(t, prepared)
	var overtook bool
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended('github_main_operation:' || $1::text,0))`, fmt.Sprint(repository)).Scan(&overtook))
	require.False(t, overtook, "reset retains its repository claim through the locked write")
	// Retry acknowledges while reset owns the repository operation fence.
	// The admitted poll cannot overtake the reset or load the rewritten code.
	_, err = r.expect("POST", "/api/github/sync", `{}`, 202)
	require.NoError(t, err)
	mergeDone := make(chan error, 1)
	mergeRequest, err := http.NewRequestWithContext(t.Context(), "POST", r.origin+"/api/todos/1/merge", strings.NewReader(fmt.Sprintf(`{"reviewed_head_sha":%q}`, old)))
	require.NoError(t, err)
	mergeRequest.Header = resetRequest.Header.Clone()
	mergeRequest.Header.Set("Idempotency-Key", r.keyPrefix+"reset-racing-merge")
	go func() {
		response, err := (&http.Client{Jar: r.jar, Timeout: 30 * time.Second}).Do(mergeRequest)
		if response != nil {
			if response.StatusCode != 409 {
				err = fmt.Errorf("racing merge returned HTTP %d", response.StatusCode)
			}
			_ = response.Body.Close()
		}
		mergeDone <- err
	}()
	var prematureLoads int
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE request_id LIKE $1`, fmt.Sprintf("flow-load:%d:%%:%s", repository, latest)).Scan(&prematureLoads))
	require.Zero(t, prematureLoads)
	cancelRequest()
	require.Error(t, <-resetDone)
	require.Eventually(t, func() bool {
		var unlocked bool
		err := r.pool.QueryRow(t.Context(), `SELECT pg_try_advisory_xact_lock(hashtextextended('github_main_operation:' || $1::text,0))`, fmt.Sprint(repository)).Scan(&unlocked)
		return err == nil && unlocked
	}, 10*time.Second, 20*time.Millisecond, "cancelled HTTP reset releases its repository claim before upstream replies")
	close(release)
	released = true
	require.NoError(t, <-mergeDone)
	r.stopBackend()
	// The interrupted locked write must not move main. Recomposition folds
	// the actual production intent at old, retaining the owner's attention.
	observed, err = r.repoClient.GetBookmark(t.Context(), "rehearsal-owner", "app", "main")
	require.NoError(t, err)
	require.Equal(t, old, observed.TargetCommitID)
	r.restartBackend()
	ctx = r.ctx
	require.Eventually(t, func() bool {
		var retired bool
		err := r.pool.QueryRow(ctx, `SELECT reset_intent IS NULL FROM github_main_pulls WHERE repository_id=$1`, repository).Scan(&retired)
		return err == nil && retired
	}, 30*time.Second, 100*time.Millisecond)
	var stillOpen bool
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT a->>'settled_at' IS NULL FROM mythical_stacks,jsonb_array_elements(attention) a WHERE repository_id=$1 AND a->>'id'=$2`, repository, attention.ID).Scan(&stillOpen))
	require.True(t, stillOpen)
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
	// Pause only the existing stack consumer's scheduling, so recovery can
	// commit settlement before a second shutdown loses all in-memory wakes.
	_, err = r.pool.Exec(t.Context(), `CREATE FUNCTION hold_reset_consumer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.requested_generation > OLD.requested_generation THEN NEW.next_attempt_at := now()+interval '1 hour'; END IF; RETURN NEW; END $$; CREATE TRIGGER hold_reset_consumer BEFORE UPDATE ON mythical_stacks FOR EACH ROW EXECUTE FUNCTION hold_reset_consumer()`)
	require.NoError(t, err)
	r.restartBackend()
	ctx = r.ctx
	require.Eventually(t, func() bool {
		var settled bool
		err := r.pool.QueryRow(ctx, `SELECT COALESCE((reset_intent->>'settled')::bool,false) FROM github_main_pulls WHERE repository_id=$1`, repository).Scan(&settled)
		return err == nil && settled
	}, 30*time.Second, 100*time.Millisecond)
	var pendingGeneration int64
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT requested_generation FROM mythical_stacks WHERE repository_id=$1 AND processed_generation < requested_generation`, repository).Scan(&pendingGeneration))
	var undispatched int
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE request_id LIKE $1`, fmt.Sprintf("flow-load:%d:%%:%s", repository, latest)).Scan(&undispatched))
	require.Zero(t, undispatched)
	r.stopBackend()
	_, err = r.pool.Exec(t.Context(), `DROP TRIGGER hold_reset_consumer ON mythical_stacks; DROP FUNCTION hold_reset_consumer()`)
	require.NoError(t, err)
	_, err = r.pool.Exec(t.Context(), `UPDATE mythical_stacks SET next_attempt_at=now() WHERE repository_id=$1`, repository)
	require.NoError(t, err)
	r.restartBackend()
	ctx = r.ctx
	var recoveredGeneration int64
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT requested_generation FROM mythical_stacks WHERE repository_id=$1`, repository).Scan(&recoveredGeneration))
	require.Equal(t, pendingGeneration, recoveredGeneration, "settled reset must not enqueue a second generation")

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
	// Admission is not completion: the recovered reset must finish the real
	// guest load and preserve the person's served Active flow, too.
	require.Eventually(t, func() bool {
		var loaded, state string
		err := r.pool.QueryRow(ctx, `SELECT loaded_commit,state FROM flow_loads WHERE repository_id=$1`, repository).Scan(&loaded, &state)
		return err == nil && loaded == latest && state == "idle"
	}, 90*time.Second, 200*time.Millisecond, "recovered reset must complete its production flow load: %s", r.logs.String())
	card, err := r.flowCard("todo")
	require.NoError(t, err)
	require.NotEmpty(t, card.version("active"), "reset keeps the served TODO flow usable")
	var completedDeliveries int
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE request_id LIKE $1`, fmt.Sprintf("flow-load:%d:%%:%s", repository, latest)).Scan(&completedDeliveries))
	require.Equal(t, 1, completedDeliveries, "completion must not duplicate keyed admission")
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
