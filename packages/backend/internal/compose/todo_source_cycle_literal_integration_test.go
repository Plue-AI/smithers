package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// The GitHub HTTP peer is the supported fake; polling, fetched delivery,
// item CAS, cancellation intents and the installed card router are production.
// Git implements the repository transport only; this is not guest evidence.
type todoSourceCycle struct {
	*installPollingComposition
	host        *pollingGitHost
	base        string
	upstreamDir string
	dispatcher  *flowdispatch.Service
	chooseActor func(*testing.T, string, string)
	call        func(*testing.T, int64, string, string, string) (int, map[string]any)
}

func newTodoSourceCycle(t *testing.T) *todoSourceCycle {
	t.Helper()
	t.Setenv("TMPDIR", t.TempDir())
	host := &pollingGitHost{dir: filepath.Join(t.TempDir(), "mirror.git")}
	require.NoError(t, host.git(t.Context(), nil, io.Discard, "init", "--bare", host.dir))
	var tree, commit bytes.Buffer
	require.NoError(t, host.git(t.Context(), strings.NewReader(""), &tree, "mktree"))
	require.NoError(t, host.git(t.Context(), nil, &commit, "commit-tree", strings.TrimSpace(tree.String()), "-m", "Literal main"))
	main := strings.TrimSpace(commit.String())
	require.NoError(t, host.git(t.Context(), nil, io.Discard, "update-ref", "refs/heads/main", main))
	gitRoot := t.TempDir()
	upstreamDir := filepath.Join(gitRoot, "acme", "app.git")
	require.NoError(t, os.MkdirAll(filepath.Dir(upstreamDir), 0700))
	output, err := exec.Command("git", "clone", "--bare", host.dir, upstreamDir).CombinedOutput()
	require.NoError(t, err, string(output))
	f := newInstallPollingComposition(t, true, gitRoot)
	t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", f.upstream.URL)
	f.stack = services.NewMythicalService(f.pool, host, services.WithMythicalNow(func() time.Time { return time.Unix(f.clock.Load(), 0).UTC() }))
	composeGitHubTodoPolling(f.stack, f.main, f.sync.synced, topology{})
	f.stack.SetOrchestration(services.NewMythicalGitHub(f.q, f.sync.connections, f.sync.userRepositories, f.sync.connections), nil, nil)
	f.stack.EnableTodoSteering()
	f.stack.SetTodoFlow(func(context.Context, int64, string) (string, error) { return rehearsalBuiltinTodoDigest(t), nil })
	credentials, err := f.credentials.Load(t.Context())
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `INSERT INTO github_app_installations(installation_id) VALUES($1)`, credentials.InstallationID)
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `INSERT INTO github_app_installation_repositories(installation_id,github_repository_id) VALUES($1,100)`, credentials.InstallationID)
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `INSERT INTO repo_connections(user_id,repo_owner,repo_name,repo_owner_lower,repo_name_lower,license_spdx_id,github_repository_id) VALUES($1,'acme','app','acme','app','MIT',100)`, f.user.ID)
	require.NoError(t, err)
	f.main = services.NewGitHubMainPullService(f.q, host, f.sync.connections, f.sync.connections)
	f.main.UseInstallPolicy()
	composeGitHubTodoPolling(f.stack, f.main, f.sync.synced, topology{})

	store, err := jobs.NewStore(f.pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: f.stack, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Fatal("source cycle must not launch a guest")
		return nil, nil
	})})
	require.NoError(t, err)
	f.stack.SetLauncher(dispatcher)
	require.NoError(t, f.stack.PollOnce(t.Context()))
	stack, err := f.q.GetMythicalStack(t.Context(), f.repository)
	require.NoError(t, err)
	require.Equal(t, "active", stack.State, stack.LastError)
	_, err = f.pool.Exec(t.Context(), `UPDATE users SET is_active=true WHERE id=$1`, f.user.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, f.repository, f.user.ID)
	require.NoError(t, err)
	require.NoError(t, f.q.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "owner.access", Value: json.RawMessage(fmt.Sprintf(`{"owner_login":"acme","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-08T00:00:00Z"}`, f.repository))}))
	sessionHash := strings.Repeat("c", 64)
	_, err = f.q.CreateAuthSession(t.Context(), db.CreateAuthSessionParams{UserID: f.user.ID, Username: f.user.Username, SessionKey: sessionHash, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)

	activeAuth := &middleware.AuthInfo{User: &f.user, SessionHash: sessionHash}
	actors := map[string]*middleware.AuthInfo{"acme": activeAuth}
	chooseActor := func(t *testing.T, login, role string) {
		t.Helper()
		if existing := actors[login]; existing != nil {
			activeAuth = existing
			return
		}
		user, err := f.q.CreateUser(t.Context(), db.CreateUserParams{Username: login, LowerUsername: login})
		require.NoError(t, err)
		_, err = f.pool.Exec(t.Context(), `UPDATE users SET is_active=true WHERE id=$1`, user.ID)
		require.NoError(t, err)
		user.IsActive = true
		_, err = f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, f.repository, user.ID, role)
		require.NoError(t, err)
		sum := sha256.Sum256([]byte(login + "-source-session"))
		hash := hex.EncodeToString(sum[:])
		_, err = f.q.CreateAuthSession(t.Context(), db.CreateAuthSessionParams{UserID: user.ID, Username: login, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		activeAuth = &middleware.AuthInfo{User: &user, SessionHash: hash}
		actors[login] = activeAuth
	}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := todoMergeComposeRouter(cfg, f.q, f.pool, &routes.MythicalHandler{Service: f.stack})
	call := func(t *testing.T, n int64, method, body, suffix string) (int, map[string]any) {
		t.Helper()
		path := fmt.Sprintf("/api/todos/%d%s", n, suffix)
		if strings.HasPrefix(suffix, "/api/") {
			path = suffix
		}
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Origin", cfg.Server.PublicURL)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", fmt.Sprintf("source-%d-%s-%s", n, suffix, body))
		request.Header.Set("X-CSRF-Token", "csrf")
		request.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), activeAuth))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		var card map[string]any
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &card), response.Body.String())
		return response.Code, card
	}
	return &todoSourceCycle{installPollingComposition: f, host: host, base: main, call: call, upstreamDir: upstreamDir, dispatcher: dispatcher, chooseActor: chooseActor}
}

func (f *todoSourceCycle) item(t *testing.T, n int64, engine string, checks map[string]any, paused bool) db.MythicalItem {
	t.Helper()
	ctx := t.Context()
	branch := fmt.Sprintf("smithers/literal-%d", n)
	upstream := &pollingGitHost{dir: f.upstreamDir}
	var tree, head bytes.Buffer
	require.NoError(t, upstream.git(ctx, nil, &tree, "rev-parse", f.base+"^{tree}"))
	require.NoError(t, upstream.git(ctx, nil, &head, "commit-tree", strings.TrimSpace(tree.String()), "-p", f.base, "-m", fmt.Sprintf("Literal TODO %d", n)))
	require.NoError(t, upstream.git(ctx, nil, io.Discard, "update-ref", "refs/heads/"+branch, strings.TrimSpace(head.String())))
	installation := int64(351502) + pollingFixtureSequence.Load()
	token, err := f.sync.connections.CreateGitHubInstallationToken(ctx, installation, services.GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"pull_requests": "write"}})
	require.NoError(t, err)
	request, err := http.NewRequest("POST", f.upstream.URL+"/repos/acme/app/pulls", strings.NewReader(fmt.Sprintf(`{"title":"Literal","head":%q,"base":"main"}`, branch)))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token.Token)
	response, err := f.upstream.Client().Do(request)
	require.NoError(t, err)
	require.Equal(t, 201, response.StatusCode)
	var pull githubfake.Pull
	require.NoError(t, json.NewDecoder(response.Body).Decode(&pull))
	require.NoError(t, response.Body.Close())
	checks["todo"] = true
	checks["branch"] = branch
	checks["flowSource"] = strings.Repeat("a", 40)
	raw, err := json.Marshal(checks)
	require.NoError(t, err)
	item, _, err := f.q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: f.repository, State: engine, Checks: raw})
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=$2,owner_id=$3,title='Literal',attempt=1,request_run_id='run-1',workspace_id='11111111-1111-4111-8111-111111111111',flow_digest=$4,pr_number=$5,pr_state='open',pr_head=$6,candidate_head=$6,candidate_verified=true,paused_at=CASE WHEN $7 THEN '2026-10-02T12:00:00Z'::timestamptz ELSE NULL END,next_attempt_at=$8 WHERE id=$1`, item.ID, n, f.user.ID, rehearsalBuiltinTodoDigest(t), pull.Number, pull.Head.SHA, paused, time.Unix(f.clock.Load(), 0).UTC())
	require.NoError(t, err)

	item, err = f.q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", f.repository), PrincipalID: fmt.Sprintf("user:%d", f.user.ID)}
	projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": fmt.Sprintf("%x-%x-%x-%x-%x", item.ID.Bytes[0:4], item.ID.Bytes[4:6], item.ID.Bytes[6:8], item.ID.Bytes[8:10], item.ID.Bytes[10:16]), "attempt": 1, "generation": item.Generation, "phase": "todo"})
	require.NoError(t, err)
	_, err = f.dispatcher.Admit(ctx, flowdispatch.LaunchRequest{Scope: scope, RequestID: fmt.Sprintf("literal-launch-%d", n), FlowID: "todo", Payload: json.RawMessage(`{}`), Projection: projection, Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: item.WorkspaceID, BindingKind: "mythical-item", BindingID: fmt.Sprintf("%x-%x-%x-%x-%x", item.ID.Bytes[0:4], item.ID.Bytes[4:6], item.ID.Bytes[6:8], item.ID.Bytes[8:10], item.ID.Bytes[10:16])}, Pin: &flowruntime.Pin{Flow: "todo", SourceCommit: strings.Repeat("a", 40), ExecutionDigest: item.FlowDigest.String}})
	require.NoError(t, err)
	return item
}

func (f *todoSourceCycle) cycle(t *testing.T) {
	t.Helper()
	require.NoError(t, f.sync.synced.RetryStreams(t.Context()))
	_, err := f.q.RequestMythicalStack(t.Context(), f.repository)
	require.NoError(t, err)
	require.NoError(t, f.stack.PollOnce(t.Context()))
}

// Read one real refs cycle through the same owner-bound GitHub sync used by
// the install. Only this service writes the mirror's main bookmark.
func (f *todoSourceCycle) refs(t *testing.T) {
	t.Helper()
	_, err := f.q.RequestGithubMainPull(t.Context(), f.repository)
	require.NoError(t, err)
	require.NoError(t, f.main.PollOnce(t.Context()))
}

func (f *todoSourceCycle) ingest(t *testing.T, item db.MythicalItem, request json.RawMessage, paused ...bool) {
	t.Helper()
	f.ingestState(t, item, request, jobs.StateWaiting, paused...)
}

func (f *todoSourceCycle) ingestState(t *testing.T, item db.MythicalItem, request json.RawMessage, state jobs.State, paused ...bool) {
	t.Helper()
	id := fmt.Sprintf("%x-%x-%x-%x-%x", item.ID.Bytes[0:4], item.ID.Bytes[4:6], item.ID.Bytes[6:8], item.ID.Bytes[8:10], item.ID.Bytes[10:16])
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", f.repository), PrincipalID: fmt.Sprintf("user:%d", f.user.ID)}
	projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": id, "attempt": 1, "generation": item.Generation, "phase": "todo", "flowDigest": item.FlowDigest.String, "flowSource": strings.Repeat("a", 40)})
	require.NoError(t, err)
	run := &flowruntime.Run{RunID: "run-1", Status: "running"}
	if request != nil {
		run.PendingWaits = []flowruntime.PendingWait{{RunID: "step-3", Token: "choice-token", Name: "choice", Request: request}}
	}
	if len(paused) > 0 && paused[0] {
		run.PendingWaits = append(run.PendingWaits, flowruntime.PendingWait{RunID: "child", Token: "pause-token", Name: "resume#1", Reason: "approval", Request: json.RawMessage(`{"kind":"pause"}`)})
	}
	require.NoError(t, f.stack.ProjectFlowRuntime(t.Context(), flowdispatch.ProjectionUpdate{State: state, Scope: scope, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, FlowID: "todo", ExecutionDigest: item.FlowDigest.String, RunID: "run-1", Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: item.WorkspaceID, BindingKind: "mythical-item", BindingID: id}, Run: run}}))
}

// C-STK-08 sequences 2, 6, 7 and 8: real runtime ingestion and installed
// HTTP controls followed by a person merge on fake GitHub, refs and pulls.
func TestTodoFoldedGitHubMergeSequences(t *testing.T) {
	for _, sequence := range []struct {
		name, engine            string
		question, paused, steer bool
	}{
		{"6-merge-during-steer", "proposed", false, false, true},
		{"7-merge-with-question", "running", true, false, false},
		{"8-merge-while-paused", "running", true, true, false},
	} {
		t.Run(sequence.name, func(t *testing.T) {
			f := newTodoSourceCycle(t)
			item := f.item(t, 1, sequence.engine, map[string]any{"run_launched": true, "run_attached": true, "attempts": []map[string]any{{"attempt": 1, "run_id": "run-1"}}}, false)
			stop := f.start(t)
			defer stop()
			if sequence.steer {
				status, receipt := f.call(t, 1, "POST", `{"steer":"Keep the accepted change small"}`, "")
				require.Equal(t, 202, status, receipt)
				status, card := f.call(t, 1, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, "working", card["state"])
			}
			if sequence.paused {
				status, receipt := f.call(t, 1, "POST", `{"op":"stop"}`, "")
				require.Equal(t, 202, status, receipt)
			}
			question := ""
			if sequence.question {
				f.ingest(t, item, json.RawMessage(`{"kind":"ask","prompt":"Backoff or fixed delay?"}`), sequence.paused)
				status, card := f.call(t, 1, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, "needs_you", card["state"])
				question = card["waits"].([]any)[0].(map[string]any)["id"].(string)
				if !sequence.paused {

					// Folded sequence 2: an open question refuses Stop before any signal.
					var before int
					require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&before))
					status, receipt := f.call(t, 1, "POST", `{"op":"stop"}`, "")
					require.Equal(t, 409, status, receipt)
					require.Equal(t, "conflict", receipt["class"])
					var after int
					require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&after))
					require.Equal(t, before, after)
				}
			}
			if sequence.paused {
				row, err := f.q.GetMythicalItem(t.Context(), item.ID)
				require.NoError(t, err)
				require.True(t, row.PausedAt.Valid, "runtime park owns the pause fact")
			}

			f.upstream.MergeAsPerson("acme/app", item.PRNumber.Int64)
			f.refs(t)
			f.cycle(t)
			require.Eventually(t, func() bool {
				row, err := f.q.GetMythicalItem(t.Context(), item.ID)
				return err == nil && row.State == "landed"
			}, 10*time.Second, 20*time.Millisecond)
			status, card := f.call(t, 1, "GET", "", "")
			require.Equal(t, 200, status, card)
			require.Equal(t, "merged", card["state"])
			require.Empty(t, card["waits"])
			row, err := f.q.GetMythicalItem(t.Context(), item.ID)
			require.NoError(t, err)
			require.False(t, row.PausedAt.Valid)
			var merged int
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_merged'`).Scan(&merged))
			require.Equal(t, 1, merged)
			var cancelled bool
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT cancellation_requested FROM product_job_requests WHERE request_id='literal-launch-1' AND operation='flow.runtime.launch'`).Scan(&cancelled))
			require.True(t, cancelled)
			if question != "" {
				f.chooseActor(t, "alice", "write")
				var before int
				require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&before))
				f.chooseActor(t, "alice", "write")
				status, receipt := f.call(t, 1, "POST", fmt.Sprintf(`{"wait":%q,"answer":"Backoff"}`, question), "/answer")
				require.Equal(t, 409, status, receipt)
				var after int
				require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&after))
				require.Equal(t, before, after, "a late answer never reaches the run")
			}
			for _, write := range f.upstream.Writes() {
				require.NotContains(t, string(write.Body), "convertPullRequestToDraft")
			}
			f.clock.Add(46)
			f.cycle(t)
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_merged'`).Scan(&merged))
			require.Equal(t, 1, merged)
		})
	}
}

func TestTodoGitHubSourceTransitionLiteralCases(t *testing.T) {
	f := newTodoSourceCycle(t)
	// Literal product sources include every persisted phase. Draft is the
	// uncommitted composer, covered by the creation/placement HTTP tests.
	sources := []struct {
		name, engine     string
		attached, paused bool
		wait             bool
	}{
		{"queued", "queued", false, false, false}, {"starting", "running", false, false, false},
		{"working", "running", true, false, false}, {"needs_you", "running", true, false, true},
		{"paused", "running", true, true, false}, {"failed", "blocked", true, false, false},
		{"in_review", "proposed", true, false, false}, {"merged", "landed", true, false, false},
		{"dropped", "cancelled", true, false, false},
	}
	type fixture struct {
		item              db.MythicalItem
		name, trigger, to string
		accepted          bool
	}
	var fixtures []fixture
	n := int64(0)
	for _, source := range sources {
		for _, trigger := range []string{"merged", "closed"} {
			n++
			checks := map[string]any{"run_launched": source.name != "queued", "run_attached": source.attached}
			if source.name == "queued" {
				checks["retries"] = []map[string]any{{"attempt": 2}}
			}
			if source.wait {
				checks["waits"] = []map[string]any{{"id": "question", "kind": "question", "prompt": "Choose", "since": "2026-10-02T12:00:00Z"}, {"id": "foreign", "kind": "foreign_push", "prompt": "Push", "since": "2026-10-02T12:00:01Z"}}
			}
			item := f.item(t, n, source.engine, checks, source.paused)
			status, card := f.call(t, n, "GET", "", "")
			require.Equal(t, 200, status, card)
			require.Equal(t, source.name, card["state"])
			accepted := source.name != "merged"
			to := "merged"
			if trigger == "closed" {
				accepted = source.name != "merged" && source.name != "dropped"
				to = "dropped"
			}
			if !accepted {
				to = source.name
			}
			fixtures = append(fixtures, fixture{item, source.name, trigger, to, accepted})
			f.upstream.UpdatePull("acme/app", item.PRNumber.Int64, func(p *githubfake.Pull) {
				p.State = "closed"
				if trigger == "merged" {
					p.Merged = true
					at := time.Unix(f.clock.Load(), 0).UTC()
					p.MergedAt = &at
					p.MergeCommitSHA = f.base
				}
			})
		}
	}
	stop := f.start(t)
	defer stop()
	f.cycle(t)
	accepted, refused := 0, 0
	for _, fixture := range fixtures {
		t.Run(fixture.name+"/"+fixture.trigger, func(t *testing.T) {
			require.Eventually(t, func() bool {
				var n int
				err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND payload->>'number'=$1 AND state='completed'`, fmt.Sprint(fixture.item.PRNumber.Int64)).Scan(&n)
				return err == nil && n > 0
			}, 10*time.Second, 20*time.Millisecond)
			status, card := f.call(t, fixture.item.Number.Int64, "GET", "", "")
			require.Equal(t, 200, status, card)
			require.Equal(t, fixture.to, card["state"])
			var events int
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type=$1 AND data->>'item'=$2`, "todo.github_"+fixture.to, fmt.Sprintf("%x-%x-%x-%x-%x", fixture.item.ID.Bytes[0:4], fixture.item.ID.Bytes[4:6], fixture.item.ID.Bytes[6:8], fixture.item.ID.Bytes[8:10], fixture.item.ID.Bytes[10:16])).Scan(&events))
			if fixture.accepted {
				var cancelled bool
				require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT cancellation_requested_at IS NOT NULL FROM product_job_requests WHERE request_id=$1 AND operation='flow.runtime.launch'`, fmt.Sprintf("literal-launch-%d", fixture.item.Number.Int64)).Scan(&cancelled))
				require.True(t, cancelled, "GitHub terminal fact must atomically request launch cancellation")
				accepted++
				require.Equal(t, 1, events)
				var raw []byte
				require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT data FROM product_job_events WHERE event_type=$1 AND data->>'n'=$2`, "todo.github_"+fixture.to, fmt.Sprint(fixture.item.Number.Int64)).Scan(&raw))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(raw, &fact))
				require.Equal(t, fixture.name, fact["from"])
				require.Equal(t, fixture.to, fact["to"])
				require.Equal(t, "github", fact["actor"].(map[string]any)["id"])

				row, err := f.q.GetMythicalItem(t.Context(), fixture.item.ID)
				require.NoError(t, err)
				require.False(t, row.PausedAt.Valid)
				var checks struct {
					Waits   []services.TodoWait `json:"waits"`
					Merging any                 `json:"merging"`
				}
				require.NoError(t, json.Unmarshal(row.Checks, &checks))
				for _, wait := range checks.Waits {
					require.NotNil(t, wait.SettledAt)
				}
				require.Nil(t, checks.Merging)
				require.Empty(t, card["waits"])
				require.NotContains(t, card, "needs_you")
			} else {
				refused++
				require.Zero(t, events)
			}
		})
	}
	require.Equal(t, 15, accepted)
	require.Equal(t, 3, refused)
	t.Logf("literal source-cycle matrix: %d accepted, %d terminal no-ops", accepted, refused)
	// A second fetch is delivery replay, never another terminal transition.
	f.clock.Add(46)
	f.cycle(t)
	for _, fixture := range fixtures {
		var n int
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type=$1 AND data->>'n'=$2`, "todo.github_"+fixture.to, fmt.Sprint(fixture.item.Number.Int64)).Scan(&n))
		require.LessOrEqual(t, n, 1)
	}
}

// C-STK-08 sequences 1, 4 and 9: independent waits originate from runtime and
// a real GitHub refs cycle. Answer and Discard enter their installed routes.
func TestTodoFoldedQuestionAndForeignPushSequences(t *testing.T) {
	for _, mode := range []string{"question", "failed", "paused", "failed-during-branch-wait"} {
		failed := mode == "failed" || mode == "failed-during-branch-wait"
		paused := mode == "paused"
		t.Run(mode, func(t *testing.T) {
			f := newTodoSourceCycle(t)
			engine, initial := "running", "working"
			if mode == "failed" {
				engine, initial = "blocked", "failed"
			}
			item := f.item(t, 1, engine, map[string]any{"run_launched": true, "run_attached": true, "attempts": []map[string]any{{"attempt": 1, "run_id": "run-1"}}}, false)
			fact := func(kind, from, to string) {
				t.Helper()
				var n int
				require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type=$1`, kind).Scan(&n))
				require.Equal(t, 1, n, "one committed fact for %s", kind)
				var raw []byte
				require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT data FROM product_job_events WHERE event_type=$1`, kind).Scan(&raw))
				var event map[string]any
				require.NoError(t, json.Unmarshal(raw, &event))
				require.Equal(t, from, event["from"], kind)
				require.Equal(t, to, event["to"], kind)
			}
			stop := f.start(t)
			defer stop()
			question := ""
			if !failed && !paused {
				f.ingest(t, item, json.RawMessage(`{"kind":"ask","prompt":"Backoff or fixed delay?"}`))
				status, card := f.call(t, 1, "GET", "", "")
				require.Equal(t, 200, status, card)
				question = card["waits"].([]any)[0].(map[string]any)["id"].(string)
				fact("todo.run_updated", "working", "needs_you")
			}
			head, err := f.upstream.PushAs("acme/app", "smithers/literal-1", 208, "alice", "Alice's outside change", map[string]string{"outside.txt": "Alice's retained bytes\n"})
			require.NoError(t, err)
			f.refs(t)
			require.Eventually(t, func() bool {
				row, err := f.q.GetMythicalItem(t.Context(), item.ID)
				return err == nil && strings.Contains(string(row.Checks), head) && strings.Contains(string(row.Checks), "foreign_push")
			}, 10*time.Second, 20*time.Millisecond)
			status, card := f.call(t, 1, "GET", "", "")
			require.Equal(t, 200, status, card)
			require.Equal(t, "needs_you", card["state"])
			waits := card["waits"].([]any)
			require.Len(t, waits, 1+boolQuestionInt(!failed && !paused))
			foreign := waits[0].(map[string]any)
			require.Equal(t, "foreign_push", foreign["kind"])
			foreignID := foreign["id"].(string)
			pushFrom := initial
			if question != "" {
				pushFrom = "needs_you"
			}
			fact("todo.foreign_push", pushFrom, "needs_you")
			if mode == "failed-during-branch-wait" {
				f.ingestState(t, item, nil, jobs.StateUncertain)
				fact("todo.run_updated", "needs_you", "needs_you")
				row, err := f.q.GetMythicalItem(t.Context(), item.ID)
				require.NoError(t, err)
				require.Equal(t, "blocked", row.State)
				status, card = f.call(t, 1, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, "needs_you", card["state"])
				require.Len(t, card["waits"], 1)
				initial = "failed"
			}
			// The source commit is retained before its Needs you fact becomes visible.
			var kept bytes.Buffer
			require.NoError(t, f.host.git(t.Context(), nil, &kept, "rev-parse", "refs/smithers/kept/"+head))
			require.Equal(t, head, strings.TrimSpace(kept.String()))
			if !failed && !paused {
				f.chooseActor(t, "alice", "write")
				status, receipt := f.call(t, 1, "POST", fmt.Sprintf(`{"wait":%q,"answer":"Backoff"}`, question), "/answer")
				require.Equal(t, 202, status, receipt)
				status, card = f.call(t, 1, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, "needs_you", card["state"])
				require.Len(t, card["waits"], 1)
				fact("todo.answered", "needs_you", "needs_you")
				require.Equal(t, "foreign_push", card["waits"].([]any)[0].(map[string]any)["kind"])
				row, err := f.q.GetMythicalItem(t.Context(), item.ID)
				require.NoError(t, err)
				var facts struct {
					Waits []services.TodoWait `json:"waits"`
				}
				require.NoError(t, json.Unmarshal(row.Checks, &facts))
				for _, wait := range facts.Waits {
					if wait.ID == question {
						require.NotNil(t, wait.SettledAt)
						require.Equal(t, "Backoff", wait.Answer)
						require.Equal(t, "alice", wait.AnsweredBy)
					} else {
						require.Nil(t, wait.SettledAt)
					}
				}
			}
			if paused {
				status, receipt := f.call(t, 1, "POST", `{"op":"stop"}`, "")
				require.Equal(t, 202, status, receipt)
				f.ingest(t, item, nil, true)
				status, card = f.call(t, 1, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, "needs_you", card["state"])
				row, err := f.q.GetMythicalItem(t.Context(), item.ID)
				require.NoError(t, err)
				require.True(t, row.PausedAt.Valid)
				initial = "paused"
			}

			f.chooseActor(t, "ben", "admin")
			status, receipt := f.call(t, 1, "POST", fmt.Sprintf(`{"op":"discard-foreign","id":%q,"revision":%q}`, foreignID, head), "/api/branches/smithers%2Fliteral-1")
			require.Equal(t, 202, status, receipt)
			status, card = f.call(t, 1, "GET", "", "")
			require.Equal(t, 200, status, card)
			require.Equal(t, initial, card["state"])
			fact("todo.foreign_discard-foreign", "needs_you", initial)
			require.Empty(t, card["waits"])
			if failed {
				f.chooseActor(t, "acme", "admin")
				status, receipt = f.call(t, 1, "POST", `{"op":"retry"}`, "")
				require.Equal(t, 202, status, receipt)
				require.EqualValues(t, 2, receipt["attempt"])
				status, card = f.call(t, 1, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, "queued", card["state"])
				fact("todo.retried", "failed", "queued")
			}
			// Discard changes the publication lease; it does not erase Alice's data.
			kept.Reset()
			require.NoError(t, f.host.git(t.Context(), nil, &kept, "show", head+":outside.txt"))
			require.Equal(t, "Alice's retained bytes\n", kept.String())
		})
	}
}

func TestTodoForeignPushSourceTransitionLiteralCases(t *testing.T) {
	f := newTodoSourceCycle(t)
	sources := []struct {
		name, engine                         string
		launched, attached, paused, question bool
		accepted                             bool
	}{
		{"queued", "queued", false, false, false, false, true},
		{"starting", "running", true, false, false, false, true},
		{"working", "running", true, true, false, false, true},
		{"needs_you", "running", true, true, false, true, true},
		{"paused", "running", true, true, true, false, true},
		{"failed", "blocked", true, true, false, false, true},
		{"in_review", "proposed", true, true, false, false, true},
		{"merged", "landed", true, true, false, false, false},
		{"dropped", "cancelled", true, true, false, false, false},
	}
	type fixture struct {
		item               db.MythicalItem
		state, head        string
		accepted, question bool
	}
	var fixtures []fixture
	for i, source := range sources {
		checks := map[string]any{"run_launched": source.launched, "run_attached": source.attached}
		if source.name == "queued" {
			checks["retries"] = []map[string]any{{"attempt": 2}}
		}
		if source.question {
			checks["waits"] = []map[string]any{{"id": "question", "kind": "question", "prompt": "Choose", "since": "2026-10-02T12:00:00Z"}}
		}
		n := int64(i + 1)
		item := f.item(t, n, source.engine, checks, source.paused)
		status, card := f.call(t, n, "GET", "", "")
		require.Equal(t, 200, status, card)
		require.Equal(t, source.name, card["state"])
		head, err := f.upstream.PushAs("acme/app", fmt.Sprintf("smithers/literal-%d", n), 208, "alice", "Outside push", map[string]string{"outside.txt": "Alice\n"})
		require.NoError(t, err)
		fixtures = append(fixtures, fixture{item, source.name, head, source.accepted, source.question})
	}
	stop := f.start(t)
	defer stop()
	f.refs(t)
	accepted, refused := 0, 0
	for _, fixture := range fixtures {
		t.Run(fixture.state, func(t *testing.T) {
			var events int
			count := func() int {
				require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_push' AND data->>'n'=$1`, fmt.Sprint(fixture.item.Number.Int64)).Scan(&events))
				return events
			}
			if fixture.accepted {
				accepted++
				require.Eventually(t, func() bool { return count() == 1 }, 10*time.Second, 20*time.Millisecond)
				status, card := f.call(t, fixture.item.Number.Int64, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, "needs_you", card["state"])
				waits := card["waits"].([]any)
				require.Len(t, waits, 1+boolQuestionInt(fixture.question))
				require.Equal(t, "foreign_push", waits[0].(map[string]any)["kind"])
				row, err := f.q.GetMythicalItem(t.Context(), fixture.item.ID)
				require.NoError(t, err)
				require.Equal(t, fixture.item.State, row.State)
				require.Equal(t, fixture.item.PausedAt, row.PausedAt)
				var raw []byte
				require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT data FROM product_job_events WHERE event_type='todo.foreign_push' AND data->>'n'=$1`, fmt.Sprint(fixture.item.Number.Int64)).Scan(&raw))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(raw, &fact))
				require.Equal(t, fixture.state, fact["from"])
				require.Equal(t, "needs_you", fact["to"])
				require.Equal(t, "alice", fact["actor"].(map[string]any)["login"])
				require.Equal(t, fact["by"], fact["actor"])
			} else {
				refused++
				require.Zero(t, count())
				row, err := f.q.GetMythicalItem(t.Context(), fixture.item.ID)
				require.NoError(t, err)
				require.Equal(t, fixture.item.State, row.State)
			}
		})
	}
	require.Equal(t, 7, accepted)
	require.Equal(t, 2, refused)
	t.Logf("literal foreign-push source matrix: %d accepted, %d terminal refusals", accepted, refused)
	f.refs(t)
	for _, fixture := range fixtures {
		var n int
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_push' AND data->>'n'=$1`, fmt.Sprint(fixture.item.Number.Int64)).Scan(&n))
		require.Equal(t, boolQuestionInt(fixture.accepted), n)
	}
}

// Guard variants are observed through fetched delivery, including its durable
// retry receipt. A GitHub merge cannot bypass mirrored-main containment.
func TestTodoGitHubSourceGuardVariants(t *testing.T) {
	t.Run("merge-not-on-main", func(t *testing.T) {
		f := newTodoSourceCycle(t)
		item := f.item(t, 1, "running", map[string]any{"run_launched": true, "run_attached": true}, false)
		stop := f.start(t)
		defer stop()
		f.upstream.MergeAsPerson("acme/app", item.PRNumber.Int64)
		f.cycle(t)
		require.Eventually(t, func() bool {
			var n int
			err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests r JOIN product_job_dispatches d ON d.operation_id=r.id WHERE r.operation='github.fetched.consume' AND r.principal_id='pulls' AND d.last_error LIKE '%waiting for mirrored main%'`).Scan(&n)
			return err == nil && n > 0
		}, 10*time.Second, 20*time.Millisecond)
		row, err := f.q.GetMythicalItem(t.Context(), item.ID)
		require.NoError(t, err)
		require.Equal(t, item.State, row.State)
		require.Equal(t, item.PRHead, row.PRHead)
		status, card := f.call(t, 1, "GET", "", "")
		require.Equal(t, 200, status, card)
		require.Equal(t, "working", card["state"])
		var events int
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_merged'`).Scan(&events))
		require.Zero(t, events)
		var cancelled bool
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT cancellation_requested FROM product_job_requests WHERE request_id='literal-launch-1' AND operation='flow.runtime.launch'`).Scan(&cancelled))
		require.False(t, cancelled)
		// Once the production sync mirrors main, the retained delivery completes.
		f.refs(t)
		f.cycle(t)
		require.Eventually(t, func() bool {
			row, err := f.q.GetMythicalItem(t.Context(), item.ID)
			return err == nil && row.State == "landed"
		}, 10*time.Second, 20*time.Millisecond)
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_merged'`).Scan(&events))
		require.Equal(t, 1, events)
	})
	t.Run("merge-fact-rollback", func(t *testing.T) {
		f := newTodoSourceCycle(t)
		item := f.item(t, 1, "running", map[string]any{"run_launched": true, "run_attached": true}, false)
		f.ingest(t, item, json.RawMessage(`{"kind":"ask","prompt":"Choose"}`))
		before, err := f.q.GetMythicalItem(t.Context(), item.ID)
		require.NoError(t, err)
		_, err = f.pool.Exec(t.Context(), `CREATE SEQUENCE terminal_fault_hits;
 CREATE FUNCTION terminal_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.event_type='todo.github_merged' THEN PERFORM nextval('terminal_fault_hits');RAISE EXCEPTION 'injected terminal fact failure';END IF;RETURN NEW;END $$;
 CREATE TRIGGER terminal_fault BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION terminal_fault()`)
		require.NoError(t, err)
		stop := f.start(t)
		defer stop()
		f.upstream.MergeAsPerson("acme/app", item.PRNumber.Int64)
		f.refs(t)
		f.cycle(t)
		require.Eventually(t, func() bool {
			var hit bool
			return f.pool.QueryRow(t.Context(), `SELECT is_called FROM terminal_fault_hits`).Scan(&hit) == nil && hit
		}, 10*time.Second, 20*time.Millisecond)
		after, err := f.q.GetMythicalItem(t.Context(), item.ID)
		require.NoError(t, err)
		require.Equal(t, before.State, after.State)
		require.JSONEq(t, string(before.Checks), string(after.Checks))
		require.Equal(t, before.PausedAt, after.PausedAt)
		var cancelled bool
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT cancellation_requested FROM product_job_requests WHERE request_id='literal-launch-1' AND operation='flow.runtime.launch'`).Scan(&cancelled))
		require.False(t, cancelled)
		var events int
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_merged'`).Scan(&events))
		require.Zero(t, events)
		status, card := f.call(t, 1, "GET", "", "")
		require.Equal(t, 200, status, card)
		require.Equal(t, "needs_you", card["state"])
		require.Len(t, card["waits"], 1)
		_, err = f.pool.Exec(t.Context(), `DROP TRIGGER terminal_fault ON product_job_events; DROP FUNCTION terminal_fault(); DROP SEQUENCE terminal_fault_hits`)
		require.NoError(t, err)
		require.Eventually(t, func() bool {
			row, err := f.q.GetMythicalItem(t.Context(), item.ID)
			return err == nil && row.State == "landed"
		}, 10*time.Second, 20*time.Millisecond)
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_merged'`).Scan(&events))
		require.Equal(t, 1, events)
	})

	for _, extra := range []int64{0, 1} {
		t.Run(fmt.Sprintf("reopen-seven-days-plus-%ds", extra), func(t *testing.T) {
			f := newTodoSourceCycle(t)
			item := f.item(t, 1, "proposed", map[string]any{"run_launched": true, "run_attached": true}, false)
			f.upstream.UpdatePull("acme/app", item.PRNumber.Int64, func(p *githubfake.Pull) { p.State = "closed" })
			stop := f.start(t)
			defer stop()
			f.cycle(t)
			require.Eventually(t, func() bool {
				row, err := f.q.GetMythicalItem(t.Context(), item.ID)
				return err == nil && row.State == "rejected"
			}, 10*time.Second, 20*time.Millisecond)
			closed, err := f.q.GetMythicalItem(t.Context(), item.ID)
			require.NoError(t, err)
			f.clock.Add(7*24*60*60 + extra)
			f.upstream.UpdatePull("acme/app", item.PRNumber.Int64, func(p *githubfake.Pull) { p.State = "open" })
			// An ordinary fetched source snapshot still reaches the consumer even
			// after its per-item follow window expires.
			require.NoError(t, f.sync.synced.TouchWebhook(t.Context(), "acme", "app", 100))
			f.cycle(t)
			if extra == 0 {
				require.Eventually(t, func() bool {
					row, err := f.q.GetMythicalItem(t.Context(), item.ID)
					return err == nil && row.State == "proposed"
				}, 10*time.Second, 20*time.Millisecond)
			} else {
				require.Eventually(t, func() bool {
					var n int
					err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='pulls' AND state='completed'`).Scan(&n)
					return err == nil && n >= 2
				}, 10*time.Second, 20*time.Millisecond)
				row, err := f.q.GetMythicalItem(t.Context(), item.ID)
				require.NoError(t, err)
				require.Equal(t, "rejected", row.State)
				require.Equal(t, closed.Attempt, row.Attempt)
			}
			want := boolQuestionInt(extra == 0)
			var events int
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`).Scan(&events))
			require.Equal(t, want, events)
			f.cycle(t)
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`).Scan(&events))
			require.Equal(t, want, events, "same reopen snapshot is applied once")
			if extra == 0 {
				row, err := f.q.GetMythicalItem(t.Context(), item.ID)
				require.NoError(t, err)
				require.Empty(t, row.RequestRunID)
				require.Equal(t, closed.Attempt, row.Attempt, "reopen never starts another attempt")
				status, card := f.call(t, 1, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, "in_review", card["state"])
			}
		})
	}
}
