package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// gateTestRepoHost serves each change at one commit, and main's factory
// projection when one is set.
type gateTestRepoHost struct {
	services.LandingRepoHostClient
	commits map[string]string
	factory string
	calls   *atomic.Int64
}

// GetChange serves a change by its change id or its commit id.
func (h gateTestRepoHost) GetChange(_ context.Context, _, _, selector string) (repohost.Change, error) {
	if h.calls != nil {
		h.calls.Add(1)
	}
	for changeID, commitID := range h.commits {
		if selector == commitID {
			return repohost.Change{ChangeID: changeID, CommitID: commitID, ParentChangeIDs: []string{}}, nil
		}
	}
	return repohost.Change{ChangeID: selector, CommitID: h.commits[selector], ParentChangeIDs: []string{}}, nil
}

func (h gateTestRepoHost) GetChangeFiles(context.Context, string, string, string) ([]repohost.ChangeFile, error) {
	return nil, nil
}

func (h gateTestRepoHost) GetFileAtChange(_ context.Context, _, _, changeID, path string) (repohost.FileContent, error) {
	if h.factory != "" && changeID == "9999999999999999999999999999999999999999" && path == ".smithers/factory.json" {
		return repohost.FileContent{Content: h.factory}, nil
	}
	return repohost.FileContent{}, &repohost.StatusError{StatusCode: http.StatusNotFound}
}

// GetFileAtCommit serves the same files by the commit a bookmark names.
func (h gateTestRepoHost) GetFileAtCommit(ctx context.Context, owner, repo, commit, path string) (repohost.FileContent, error) {
	return h.GetFileAtChange(ctx, owner, repo, commit, path)
}

func (h gateTestRepoHost) ListDirectory(context.Context, string, string, string, string, string, int) ([]repohost.TreeEntry, error) {
	return nil, &repohost.StatusError{StatusCode: http.StatusNotFound}
}

func (h gateTestRepoHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return []repohost.Bookmark{
		{Name: "main", TargetChangeID: "mainchangezzzzzz", TargetCommitID: "9999999999999999999999999999999999999999"},
		{Name: "release", TargetChangeID: "releasechangezzz", TargetCommitID: "8888888888888888888888888888888888888888"},
	}, "", nil
}

// GetBookmark reads one bookmark the way the landing gate resolves its target.
func (h gateTestRepoHost) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	items, _, err := h.ListBookmarks(ctx, owner, repo, "", 100)
	if err != nil {
		return repohost.Bookmark{}, err
	}
	for _, bookmark := range items {
		if bookmark.Name == name {
			return bookmark, nil
		}
	}
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: http.StatusNotFound, Code: "bookmark_not_found"}
}

// landingGateFixture is a repository with two people and one commit per
// change, served through the assembled router.
type landingGateFixture struct {
	t         *testing.T
	ctx       context.Context
	q         *db.Queries
	pool      *pgxpool.Pool
	owner     db.User
	other     db.User
	repoID    int64
	router    http.Handler
	hostCalls *atomic.Int64
}

func newLandingGateFixture(t *testing.T, commits map[string]string) *landingGateFixture {
	t.Helper()
	return newLandingGateFixtureWithFactory(t, commits, "")
}

// newLandingGateFixtureWithFactory serves factory as main's
// .smithers/factory.json.
func newLandingGateFixtureWithFactory(t *testing.T, commits map[string]string, factory string, installFlags ...bool) *landingGateFixture {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "gate-owner", LowerUsername: "gate-owner", DisplayName: "Gate owner"})
	require.NoError(t, err)
	other, err := q.CreateUser(ctx, db.CreateUserParams{Username: "gate-other", LowerUsername: "gate-other", DisplayName: "Gate other"})
	require.NoError(t, err)
	repoID := ciTestRepo(t, pool, owner.ID, "app")
	_, err = pool.Exec(ctx, `INSERT INTO collaborators (repository_id, user_id, permission) VALUES ($1, $2, 'write')`, repoID, other.ID)
	require.NoError(t, err)
	for changeID, commitID := range commits {
		_, err = q.UpsertChange(ctx, db.UpsertChangeParams{RepositoryID: repoID, ChangeID: changeID, CommitID: commitID, ParentChangeIds: []byte("[]")})
		require.NoError(t, err)
		_, err = q.RecordChangeRevision(ctx, db.RecordChangeRevisionParams{RepositoryID: repoID, ChangeID: changeID, CommitID: commitID, Source: "push", OperationIds: []string{}})
		require.NoError(t, err)
	}
	install := len(installFlags) > 0 && installFlags[0]
	cfg := testConfigAllFlagsOn()
	calls := &atomic.Int64{}
	var vcsClient *repohost.Client
	if install {
		cfg.Auth.Mode = "selfhost"
		cfg.Auth.SessionCookieName = "session"
		cfg.Server.PublicURL = "http://example.com"
		cfg.Server.AllowedOrigins = []string{"http://example.com"}
		_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
		require.NoError(t, err)
		binding := fmt.Sprintf(`{"owner_login":"gate-owner","repository_name":"app","repository_id":%d}`, repoID)
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-06T12:00:00Z"}`)}))
		vcsClient = repohost.NewLocalClientWithStagingEndpoint(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); w.WriteHeader(500) }), "fixture-token", "http://127.0.0.1:1", true)
	}
	router := buildRouter(
		cfg, q, pool,
		&routes.RepoHandler{Service: services.NewRepoService(q, nil, "")},
		nil,
		&routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{},
		&routes.DeployKeyHandler{Service: services.NewDeployKeyService(q)},
		&routes.LabelHandler{}, &routes.OrgHandler{},
		&routes.LandingHandler{Service: services.NewLandingService(q, gateTestRepoHost{commits: commits, factory: factory, calls: calls}, services.WithLandingInstallMainMirror(install))},
		nil, nil,
		&routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil,
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil,
		&routes.ProtectedBookmarkHandler{Service: services.NewProtectedBookmarkService(q)},
		&routes.CommitStatusHandler{Service: services.NewCommitStatusService(q)},
		nil,
		&routes.JJVCSHandler{RepoResolver: q, RepoHost: vcsClient},
		&routes.AgentInternalHandler{},
		nil, nil,
		&routes.ApprovalsHandler{Enabled: true, Service: services.NewApprovalsService(q)},
		nil,
		nil, nil, nil,
		nil, nil, nil,
		&routes.RepositoryJobHandler{},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
	return &landingGateFixture{t: t, ctx: ctx, q: q, pool: pool, owner: owner, other: other, repoID: repoID, router: router, hostCalls: calls}
}

func (f *landingGateFixture) landing(title string, authorID int64, changeID string) db.LandingRequest {
	f.t.Helper()
	landing, err := f.q.CreateLandingRequest(f.ctx, db.CreateLandingRequestParams{
		RepositoryID: f.repoID, Title: title, AuthorID: authorID, TargetBookmark: "main", StackSize: 1,
	})
	require.NoError(f.t, err)
	_, err = f.q.AddLandingRequestChange(f.ctx, db.AddLandingRequestChangeParams{LandingRequestID: landing.ID, ChangeID: changeID, PositionInStack: 1})
	require.NoError(f.t, err)
	return landing
}

// token mints user's access token; a system-issued one is a run credential.
func (f *landingGateFixture) token(user db.User, name, scopes string, systemIssued bool) string {
	f.t.Helper()
	plaintext := "smithers_" + hex.EncodeToString([]byte(name + "-token-padding-bytes-xx"))[:40]
	sum := sha256.Sum256([]byte(plaintext))
	hash := hex.EncodeToString(sum[:])
	_, err := f.q.CreateAccessToken(f.ctx, db.CreateAccessTokenParams{
		UserID: user.ID, Name: name, TokenHash: hash, TokenLastEight: hash[len(hash)-8:],
		SystemIssued: systemIssued, Scopes: scopes,
		ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
	})
	require.NoError(f.t, err)
	return plaintext
}

func (f *landingGateFixture) serve(bearer, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/api/repos/gate-owner/app"+path, bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req)
	return rec
}

func (f *landingGateFixture) idOf(rec *httptest.ResponseRecorder) int64 {
	f.t.Helper()
	var body struct {
		ID int64 `json:"id"`
	}
	require.NoError(f.t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
	return body.ID
}

// A run credential acts as its user but no person makes the request. Through
// the assembled router it cannot take a person's decision on a landing: it
// cannot acknowledge a review comment (which resolves it and can unblock
// the landing), dismiss a person's review, land or queue someone else's
// landing, or report a commit status that required checks trust. A landing
// it opens is agent-authored. It keeps an agent's work: comments, marking
// its own landing's comments done, reopening, and landing its own change.
func TestRunCredentialCannotClearHumanLandingGatesPostgres(t *testing.T) {
	commits := map[string]string{
		"othrchangeaaaaaa":  "1111111111111111111111111111111111111111",
		"ownchangebbbbbbb":  "2222222222222222222222222222222222222222",
		"newchangecccccccc": "3333333333333333333333333333333333333333",
	}
	f := newLandingGateFixture(t, commits)
	ctx, q, pool, owner, other := f.ctx, f.q, f.pool, f.owner, f.other
	serve, idOf := f.serve, f.idOf
	othersLanding := f.landing("Someone else's change", other.ID, "othrchangeaaaaaa")
	ownLanding := f.landing("Own change", owner.ID, "ownchangebbbbbbb")

	write := string(middleware.ScopeWriteRepository)
	runs := map[string]string{
		"bound agent run":   f.token(owner, "gate-run", write+","+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.AgentSessionRestrictionScope("s1"), true),
		"unbound agent run": f.token(owner, "gate-unbound", write, true),
	}
	person := f.token(owner, "gate-person", write, false)

	unresolved := func(landingID int64) int64 {
		count, err := q.CountUnresolvedLandingRequestThreads(ctx, landingID)
		require.NoError(t, err)
		return count
	}
	activeTasks := func(landingID int64) int {
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM landing_tasks WHERE landing_request_id = $1`, landingID).Scan(&count))
		return count
	}
	othersPath := fmt.Sprintf("/landings/%d", othersLanding.Number)
	ownPath := fmt.Sprintf("/landings/%d", ownLanding.Number)

	// The owner, as a person, asks for a fix on someone else's landing, and
	// that landing's author marks it done.
	rec := serve(person, http.MethodPost, othersPath+"/comments", `{"body":"please fix","commit_id":"1111111111111111111111111111111111111111"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	thread := idOf(rec)
	_, err := q.MarkLandingRequestThreadDone(ctx, db.MarkLandingRequestThreadDoneParams{
		DoneBy: pgtype.Int8{Int64: other.ID, Valid: true}, ResolvedInRevision: []byte(`{}`), ID: thread, LandingRequestID: othersLanding.ID,
	})
	require.NoError(t, err)
	require.Equal(t, int64(1), unresolved(othersLanding.ID))

	for name, run := range runs {
		rec = serve(run, http.MethodPost, fmt.Sprintf("%s/threads/%d/ack", othersPath, thread), `{}`)
		assert.Equal(t, http.StatusForbidden, rec.Code, "%s acknowledged its user's review comment: %s", name, rec.Body.String())
		assert.Contains(t, rec.Body.String(), "run credential", name)
		assert.Equal(t, int64(1), unresolved(othersLanding.ID), "%s resolved its user's review comment", name)

		for _, attempt := range []struct{ method, path, body string }{
			{http.MethodPut, othersPath + "/land", `{"commit_id":"1111111111111111111111111111111111111111"}`},
			{http.MethodPut, othersPath + "/land/append", `{"commit_id":"1111111111111111111111111111111111111111"}`},
			{http.MethodPost, othersPath + "/auto-land", `{"enabled":true}`},
			{http.MethodDelete, othersPath + "/auto-land", ``},
			{http.MethodPatch, othersPath, `{"state":"closed"}`},
			{http.MethodPatch, othersPath, `{"target_bookmark":"release"}`},
		} {
			rec = serve(run, attempt.method, attempt.path, attempt.body)
			assert.Equal(t, http.StatusForbidden, rec.Code, "%s: %s %s on someone else's landing: %s", name, attempt.method, attempt.path, rec.Body.String())
			assert.Contains(t, rec.Body.String(), "run credential", "%s: %s %s", name, attempt.method, attempt.path)
		}
		// Editing the words stays open to any writer.
		rec = serve(run, http.MethodPatch, othersPath, `{"title":"Someone else's change"}`)
		assert.Equal(t, http.StatusOK, rec.Code, "%s: %s", name, rec.Body.String())
		assert.Zero(t, activeTasks(othersLanding.ID), "%s queued someone else's landing", name)

		rec = serve(run, http.MethodPost, "/statuses/1111111111111111111111111111111111111111", `{"context":"ci/test","status":"success"}`)
		assert.Equal(t, http.StatusForbidden, rec.Code, "%s reported a commit status: %s", name, rec.Body.String())
	}
	var statuses int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM commit_statuses WHERE repository_id = $1`, f.repoID).Scan(&statuses))
	assert.Zero(t, statuses, "a run credential's commit status was recorded")

	// The owner's own token acknowledges and reports a status.
	rec = serve(person, http.MethodPost, fmt.Sprintf("%s/threads/%d/ack", othersPath, thread), `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Zero(t, unresolved(othersLanding.ID))
	rec = serve(person, http.MethodPost, "/statuses/1111111111111111111111111111111111111111", `{"context":"ci/test","status":"success"}`)
	assert.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	// The repository CI receipt's context is the server's to record.
	rec = serve(person, http.MethodPost, "/statuses/1111111111111111111111111111111111111111", `{"context":"Repository-CI/any@1.abc","status":"success"}`)
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM commit_statuses WHERE repository_id = $1`, f.repoID).Scan(&statuses))
	assert.Equal(t, 1, statuses, "the reserved context was recorded")

	// An agent's work stays open to a run: it comments on its own landing,
	// marks the comment done, reopens it, and lands its own change.
	run := runs["bound agent run"]
	rec = serve(run, http.MethodPost, ownPath+"/comments", `{"body":"note","commit_id":"2222222222222222222222222222222222222222"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	ownThread := idOf(rec)
	rec = serve(run, http.MethodPost, fmt.Sprintf("%s/threads/%d/done", ownPath, ownThread), `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = serve(run, http.MethodPost, fmt.Sprintf("%s/threads/%d/ack", ownPath, ownThread), `{}`)
	assert.Equal(t, http.StatusForbidden, rec.Code, "a run acknowledged a comment: %s", rec.Body.String())
	rec = serve(run, http.MethodPost, fmt.Sprintf("%s/threads/%d/reopen", ownPath, ownThread), `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = serve(person, http.MethodPost, fmt.Sprintf("%s/threads/%d/done", ownPath, ownThread), `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = serve(person, http.MethodPost, fmt.Sprintf("%s/threads/%d/ack", ownPath, ownThread), `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	// Landing its person's own landing onto main is a person's decision
	// (D-23); the person lands it.
	rec = serve(run, http.MethodPut, ownPath+"/land", `{"commit_id":"2222222222222222222222222222222222222222"}`)
	assert.Equal(t, http.StatusForbidden, rec.Code, "a run landed its person's landing onto main: %s", rec.Body.String())
	rec = serve(person, http.MethodPut, ownPath+"/land", `{"commit_id":"2222222222222222222222222222222222222222"}`)
	assert.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())

	// A landing a run opens is agent-authored, so agent policies apply to it.
	for name, bearer := range map[string]string{"bound agent run": run, "unbound agent run": runs["unbound agent run"], "person": person} {
		rec = serve(bearer, http.MethodPost, "/landings", `{"title":"new","target_bookmark":"main","change_ids":["newchangecccccccc"]}`)
		require.Equal(t, http.StatusCreated, rec.Code, "%s: %s", name, rec.Body.String())
		var created struct {
			AgentAuthored bool `json:"agent_authored"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
		assert.Equal(t, name != "person", created.AgentAuthored, "%s: agent_authored", name)
	}
}

// Every install credential is refused before protected refs reach repo-host.
func TestInstallProtectedBookmarkMutationMatrixPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, map[string]string{"protected-change": "1111111111111111111111111111111111111111"}, "", true)
	_, err := f.pool.Exec(f.ctx, `INSERT INTO protected_bookmarks(repository_id,pattern) VALUES($1,'release*')`, f.repoID)
	require.NoError(t, err)
	landing := f.landing("Protected", f.owner.ID, "protected-change")
	_, err = f.pool.Exec(f.ctx, `UPDATE landing_requests SET target_bookmark='release-stable' WHERE id=$1`, landing.ID)
	require.NoError(t, err)
	tokens := map[string]string{
		"delegated":  f.token(f.owner, "protected-codex", "write:repository,via:codex", true),
		"legacy PAT": f.token(f.owner, "protected-pat", "write:repository", false),
		"run":        f.token(f.owner, "protected-run", "write:repository", true),
		"machine":    f.token(f.owner, "protected-machine", "write:repository,workspace:owned-box", true),
	}
	cookie := "protected-session"
	sum := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	tokens["session"] = ""
	for kind, token := range tokens {
		for _, operation := range []struct{ method, path, body string }{
			{"POST", "/bookmarks", `{"name":"release-stable","target_change_id":"protected-change"}`},
			{"DELETE", "/bookmarks/release-stable", `{}`},
			{"PUT", fmt.Sprintf("/landings/%d/land", landing.Number), `{"commit_id":"1111111111111111111111111111111111111111"}`},
			{"POST", fmt.Sprintf("/landings/%d/auto-land", landing.Number), `{"enabled":true}`},
		} {
			req := httptest.NewRequest(operation.method, "/api/repos/gate-owner/app"+operation.path, bytes.NewBufferString(operation.body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "http://example.com")
			if kind == "session" {
				req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
				req.Header.Set("X-CSRF-Token", "csrf")
			} else {
				req.Header.Set("Authorization", "Bearer "+token)
			}
			w := httptest.NewRecorder()
			f.router.ServeHTTP(w, req)
			// The legacy Land door is absent before authentication for every
			// credential kind. Mounted bookmark and queue doors still refuse
			// protected mutations before any repo-host effect.
			if operation.method == http.MethodPut {
				require.Equal(t, 404, w.Code, "%s %s: %s", operation.method, operation.path, w.Body.String())
				require.Zero(t, f.hostCalls.Load(), "retired door reached repo-host")
				continue
			}
			require.Equal(t, 403, w.Code, "%s %s %s: %s", kind, operation.method, operation.path, w.Body.String())
			var body map[string]any
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
			require.Equal(t, "permission", body["class"])
			require.Equal(t, "permission", body["code"])
			require.Zero(t, f.hostCalls.Load(), "refusal reached repo-host")
		}
	}
	var queued int
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM landing_tasks`).Scan(&queued))
	require.Zero(t, queued)
}
