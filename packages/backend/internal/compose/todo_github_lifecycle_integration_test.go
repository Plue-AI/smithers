package compose

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/stretchr/testify/require"
)

// Accepted-tree fixtures stand in for a completed machine run; ingress,
// polling, durable delivery and the person's TODO card use the composed install.
func TestTODOGitHubCloseReopenComposedInstall(t *testing.T) {
	t.Setenv("REHEARSAL_INSTALLATION_ID", "93")
	r := newRehearsal(t, "SMITHERS_GH03_REHEARSAL", "C-J10-08", "gh03-life-", 25)
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
	var filed struct{ N int64 }
	var repository, owner int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT repository_id,actor_user_id FROM mythical_stacks`).Scan(&repository, &owner))
	// Seed the retained-candidate artifact that a completed stack.candidate
	// dispatch owns. This changes only the fixture's keep ref, never main.
	packCommand := exec.Command("/usr/bin/git", "-C", work, "pack-objects", "--stdout")
	packCommand.Stdin = strings.NewReader("")
	emptyPack, err := packCommand.Output()
	require.NoError(t, err)
	keep := repohost.MythicalReservedRefNS + "keep/" + head
	update := strings.Repeat("0", 40) + " " + head + " " + keep + "\x00report-status\n"
	body := bytes.NewBufferString(fmt.Sprintf("%04x%s0000", len(update)+4, update))
	_, err = body.Write(emptyPack)
	require.NoError(t, err)
	var retained bytes.Buffer
	require.NoError(t, r.repoClient.ProxyReceivePack(r.ctx, "rehearsal-owner", "app", body, &retained, repohost.ReceivePackMetadata{RepositoryID: repository, ControlPlane: true, PusherLogin: "fixture"}))
	require.Contains(t, retained.String(), "ok "+keep)

	// A completed machine-run fixture has no concurrent launch to overwrite its
	// accepted generation. Publication and all lifecycle effects remain real.
	require.NoError(t, r.pool.QueryRow(r.ctx, `INSERT INTO mythical_items(repository_id,source,state,issue_title,title,revisions,owner_id,candidate_base,candidate_head,candidate_verified,pr_head,pr_number,pr_state,pr_url,attempt,checks)
 VALUES ($1,'todo','proposing','Lifecycle','Lifecycle','[{"rev":1,"text":"accepted change","acceptance":["passes"],"by":{"person":"rehearsal-owner"},"at":"2026-10-02T12:00:00Z"}]',$2,$3,$4,true,$4,1,'open','https://github.com/rehearsal-owner/app/pull/1',1,'{"branch":"smithers/lifecycle-fixture"}') RETURNING number`, repository, owner, r.mainCommit, head).Scan(&filed.N))
	require.Positive(t, filed.N)
	t.Cleanup(func() {
		if !t.Failed() {
			return
		}
		diagnostic, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var status string
		if err := r.pool.QueryRow(diagnostic, `SELECT json_build_object('state',state,'reason',reason,'candidate_base',candidate_base,'candidate_head',candidate_head,'verified',candidate_verified,'pr_head',pr_head,'pending',pending_op,'manifests',checks->'prManifests')::text FROM mythical_items WHERE number=$1`, filed.N).Scan(&status); err == nil {
			t.Log("publication fixture", status)
		} else {
			t.Log("publication fixture read", err)
		}
	})

	_, err = r.pool.Exec(r.ctx, `UPDATE mythical_stacks SET requested_generation=requested_generation+1,next_attempt_at=clock_timestamp() WHERE repository_id=$1`, repository)
	require.NoError(t, err)
	// The composed stack worker binds the accepted head to an immutable manifest
	// before the same PR is consumed through the install's inbound worker.
	var publishedHead string
	require.Eventually(t, func() bool {
		var retained []byte
		err := r.pool.QueryRow(r.ctx, `SELECT checks->'prManifests',pr_head FROM mythical_items WHERE number=$1 AND state='proposed'`, filed.N).Scan(&retained, &publishedHead)
		if err != nil {
			return false
		}
		var manifests []struct {
			Head     string
			Included []any
		}
		if json.Unmarshal(retained, &manifests) != nil {
			return false
		}
		return len(manifests) == 1 && publishedHead != "" && manifests[0].Head == publishedHead && len(manifests[0].Included) == 0
	}, 30*time.Second, 50*time.Millisecond)
	hint := func(action string) {
		payload := []byte(fmt.Sprintf(`{"action":%q,"number":1,"installation":{"id":93},"repository":{"id":100,"name":"app","full_name":"rehearsal-owner/app","owner":{"login":"rehearsal-owner"}},"pull_request":{"number":1,"head":{"ref":%q,"sha":%q}}}`, action, branch, publishedHead))
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
	for _, smithersDrop := range []bool{false, true} {
		// Reopen's durable branch-restoration intent must settle before the
		// next control, just as any pending GitHub write must.
		require.Eventually(t, func() bool {
			var settled bool
			err := r.pool.QueryRow(r.ctx, `SELECT pending_op IS NULL FROM mythical_items WHERE number=$1`, filed.N).Scan(&settled)
			return err == nil && settled
		}, 30*time.Second, 50*time.Millisecond)
		// Completed run bindings must become historical on reopen, regardless
		// of whether the person closes on GitHub or presses Drop in Smithers.
		_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET request_run_id='ended-todo-run',vibe_run_id='ended-delivery',verify_run_id='ended-verify',checks=checks || '{"run_launched":true,"run_attached":true}'::jsonb WHERE number=$1`, filed.N)
		require.NoError(t, err)
		if smithersDrop {
			// GitHub accepts the close but loses its response. The composed
			// worker must reconcile it, including repeated browser delivery.
			beforeWrites := len(r.fake.Writes())
			r.fake.LoseNextResponses("/repos/rehearsal-owner/app/pulls/1", 1)
			code, data, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", filed.N), `{"op":"drop"}`, "lifecycle-drop")
			require.NoError(t, err)
			require.Equal(t, 202, code, string(data))
			replayCode, replayData, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", filed.N), `{"op":"drop"}`, "lifecycle-drop")
			require.NoError(t, err)
			require.Equal(t, code, replayCode, string(replayData))
			require.JSONEq(t, string(data), string(replayData))
			require.Eventually(t, func() bool {
				var settled bool
				err := r.pool.QueryRow(r.ctx, `SELECT pr_state='closed' AND pending_op IS NULL FROM mythical_items WHERE number=$1`, filed.N).Scan(&settled)
				return err == nil && settled
			}, 20*time.Second, 50*time.Millisecond)
			closes := 0
			for _, write := range r.fake.Writes()[beforeWrites:] {
				if write.Method != "PATCH" || write.Path != "/repos/rehearsal-owner/app/pulls/1" {
					continue
				}
				var payload struct{ State string }
				require.NoError(t, json.Unmarshal(write.Body, &payload))
				if payload.State == "closed" {
					closes++
					require.Equal(t, http.StatusBadGateway, write.Status, "the single close lost its response")
				}
			}
			require.Equal(t, 1, closes, "Drop replay and uncertain close must not send a second close")
			var facts int
			require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.dropped'`).Scan(&facts))
			require.Equal(t, 1, facts, "repeated browser delivery records one Drop")
		} else {
			fakeRequest("PATCH", "/repos/rehearsal-owner/app/pulls/1", `{"state":"closed"}`)
		}
		hint("closed")
		require.Eventually(t, func() bool { return cardState("dropped") }, 60*time.Second, 50*time.Millisecond)
		if !smithersDrop {
			githubLifecycleBrowserPhase(t, r, filed.N, "dropped")
		}
		hint("closed")
		fakeRequest("PATCH", "/repos/rehearsal-owner/app/pulls/1", `{"state":"open"}`)
		hint("reopened")
		require.Eventually(t, func() bool { return cardState("in_review") }, 60*time.Second, 50*time.Millisecond)
		if !smithersDrop {
			githubLifecycleBrowserPhase(t, r, filed.N, "in_review")
		}
		hint("reopened")
		var attempt int
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT attempt FROM mythical_items WHERE number=$1`, filed.N).Scan(&attempt))
		require.Equal(t, 1, attempt)
		var run, delivery, verification, candidate, evidenceRun string
		var launched, attached bool
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT request_run_id,vibe_run_id,verify_run_id,candidate_head,COALESCE((checks->>'run_launched')::boolean,false),COALESCE((checks->>'run_attached')::boolean,false),checks->'attempts'->0->>'run_id' FROM mythical_items WHERE number=$1`, filed.N).Scan(&run, &delivery, &verification, &candidate, &launched, &attached, &evidenceRun))
		require.Empty(t, run)
		require.Empty(t, delivery)
		require.Empty(t, verification)
		require.False(t, launched)
		require.False(t, attached)
		require.Equal(t, "ended-todo-run", evidenceRun)
		require.NotEmpty(t, candidate)
		// A restored proposal cannot silently swallow input or invalidate its
		// generation while retained-workspace restart admission is unavailable.
		code, data, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", filed.N), `{"steer":"Address the reopened review"}`, fmt.Sprintf("reopened-input-%v", smithersDrop))
		require.NoError(t, err)
		require.Equal(t, 503, code, string(data))
		var verified bool
		var inputs int
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT candidate_verified,jsonb_array_length(COALESCE(checks->'steers','[]'::jsonb)) FROM mythical_items WHERE number=$1`, filed.N).Scan(&verified, &inputs))
		require.True(t, verified)
		require.Zero(t, inputs)
		var dropped, reopened int
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FILTER(WHERE event_type='todo.github_dropped'),count(*) FILTER(WHERE event_type='todo.github_in_review') FROM product_job_events`).Scan(&dropped, &reopened))
		require.Equal(t, 1, dropped, "only GitHub Close emits a GitHub-dropped event")
		if smithersDrop {
			require.Equal(t, 2, reopened)
		} else {
			require.Equal(t, 1, reopened)
		}
	}
	// Qualify the confirmed transition from a paused TODO.
	_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET paused_at=clock_timestamp() WHERE number=$1`, filed.N)
	require.NoError(t, err)
	require.True(t, cardState("paused"))
	// A person's merge on GitHub is followed through the real mirror sync and
	// fetched-PR worker, without an in-product approval or second merge call.
	access, err = connections.CreateGitHubInstallationToken(r.ctx, 93, services.GitHubTokenScope{AllRepositories: true, Permissions: map[string]string{"pull_requests": "write", "contents": "write"}})
	require.NoError(t, err)
	fakeRequest("PUT", "/repos/rehearsal-owner/app/pulls/1/merge", fmt.Sprintf(`{"sha":%q,"merge_method":"squash"}`, publishedHead))
	code, _, err := r.keyed("POST", "/api/github/sync", "", "gh03-external-merge")
	require.NoError(t, err)
	require.Equal(t, 202, code)
	hint("closed")
	require.Eventually(t, func() bool { return cardState("merged") }, 60*time.Second, 100*time.Millisecond)
	githubLifecycleBrowserPhase(t, r, filed.N, "merged")
	var mergeCommit string
	var land []byte
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pr_merge_commit,checks->'land' FROM mythical_items WHERE number=$1`, filed.N).Scan(&mergeCommit, &land))
	require.NotEmpty(t, mergeCommit)
	// Production fetched-merge admission retains one background obligation,
	// even with no ephemeral allocator or qualified Learning runtime.
	var learningCount int
	var learningPayload []byte
	require.Eventually(t, func() bool {
		return r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='learning.admission' AND payload->>'todo'=$1`, fmt.Sprint(filed.N)).Scan(&learningCount) == nil && learningCount == 1
	}, 10*time.Second, 50*time.Millisecond)
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT payload FROM product_job_requests WHERE operation='learning.admission' AND payload->>'todo'=$1`, fmt.Sprint(filed.N)).Scan(&learningPayload))
	var intent map[string]any
	require.NoError(t, json.Unmarshal(learningPayload, &intent))
	require.Equal(t, mergeCommit, intent["commit"])
	require.Equal(t, float64(repository), intent["repository"])
	require.Equal(t, float64(owner), intent["actor"])
	var forbiddenLaunches int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch' AND payload->>'flowId'='learning'`).Scan(&forbiddenLaunches))
	require.Zero(t, forbiddenLaunches, "missing isolation/allocator cannot launch Learning")
	hint("closed")
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='learning.admission' AND payload->>'todo'=$1`, fmt.Sprint(filed.N)).Scan(&learningCount))
	require.Equal(t, 1, learningCount)

	require.True(t, len(land) == 0 || string(land) == "null", "external merge never invents approval")
	mirrored, err := r.gitDoor(token, "-C", work, "ls-remote", "origin", "refs/heads/main")
	require.NoError(t, err)
	require.Contains(t, mirrored, mergeCommit+"\trefs/heads/main")
	merges := 0
	for _, write := range r.fake.Writes() {
		if write.Method == "PUT" && write.Path == "/repos/rehearsal-owner/app/pulls/1/merge" {
			merges++
		}
	}
	require.Equal(t, 1, merges, "only the person's simulated GitHub merge")
}

// The browser observes only the real card. The test pauses between committed
// lifecycle phases; its acknowledgment never mutates product state.
func githubLifecycleBrowserPhase(t *testing.T, r *rehearsal, number int64, phase string, facts ...map[string]any) {
	path := os.Getenv("SMITHERS_GH03_BROWSER_HARNESS")
	if path == "" || os.Getenv("SMITHERS_GH03_BROWSER_PHASE") != "" && os.Getenv("SMITHERS_GH03_BROWSER_PHASE") != phase {
		return
	}
	origin, err := url.Parse(r.origin)
	require.NoError(t, err)
	cookies := []map[string]string{}
	for _, cookie := range r.jar.Cookies(origin) {
		cookies = append(cookies, map[string]string{"name": cookie.Name, "value": cookie.Value, "url": r.origin})
	}
	metadata := map[string]any{"origin": r.origin, "number": number, "phase": phase, "cookies": cookies}
	for _, extra := range facts {
		for key, value := range extra {
			metadata[key] = value
		}
	}
	data, err := json.Marshal(metadata)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(path+".tmp", data, 0600))
	require.NoError(t, os.Rename(path+".tmp", path))
	require.Eventually(t, func() bool {
		raw, err := os.ReadFile(path + ".ack")
		return err == nil && string(raw) == phase
	}, 90*time.Second, 100*time.Millisecond, "browser did not observe %s", phase)
}
