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
}

func (h gateTestRepoHost) GetChange(_ context.Context, _, _, changeID string) (repohost.Change, error) {
	return repohost.Change{ChangeID: changeID, CommitID: h.commits[changeID], ParentChangeIDs: []string{}}, nil
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

func (h gateTestRepoHost) ListDirectory(context.Context, string, string, string, string, string, int) ([]repohost.TreeEntry, error) {
	return nil, &repohost.StatusError{StatusCode: http.StatusNotFound}
}

func (h gateTestRepoHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return []repohost.Bookmark{{Name: "main", TargetChangeID: "mainchangezzzzzz", TargetCommitID: "9999999999999999999999999999999999999999"}}, "", nil
}

// landingGateFixture is a repository with two people and one commit per
// change, served through the assembled router.
type landingGateFixture struct {
	t      *testing.T
	ctx    context.Context
	q      *db.Queries
	pool   *pgxpool.Pool
	owner  db.User
	other  db.User
	repoID int64
	router http.Handler
}

func newLandingGateFixture(t *testing.T, commits map[string]string) *landingGateFixture {
	t.Helper()
	return newLandingGateFixtureWithFactory(t, commits, "")
}

// newLandingGateFixtureWithFactory serves factory as main's
// .smithers/factory.json.
func newLandingGateFixtureWithFactory(t *testing.T, commits map[string]string, factory string) *landingGateFixture {
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
	router := buildRouter(
		testConfigAllFlagsOn(), q, pool,
		&routes.RepoHandler{Service: services.NewRepoService(q, nil, "")},
		nil,
		&routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{},
		&routes.DeployKeyHandler{Service: services.NewDeployKeyService(q)},
		&routes.LabelHandler{}, &routes.OrgHandler{},
		&routes.LandingHandler{Service: services.NewLandingService(q, gateTestRepoHost{commits: commits, factory: factory})},
		nil, nil, nil,
		&routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil,
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil,
		nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil,
		&routes.ProtectedBookmarkHandler{Service: services.NewProtectedBookmarkService(q)},
		&routes.CommitStatusHandler{Service: services.NewCommitStatusService(q)},
		nil,
		&routes.JJVCSHandler{RepoResolver: q},
		&routes.AgentInternalHandler{},
		nil, nil,
		&routes.ApprovalsHandler{Enabled: true},
		nil, nil,
		nil, nil, nil,
		nil, nil, nil,
		&routes.RepositoryJobHandler{},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
	return &landingGateFixture{t: t, ctx: ctx, q: q, pool: pool, owner: owner, other: other, repoID: repoID, router: router}
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
	rec = serve(run, http.MethodPut, ownPath+"/land", `{"commit_id":"2222222222222222222222222222222222222222"}`)
	assert.Equal(t, http.StatusAccepted, rec.Code, "a run could not land its own change: %s", rec.Body.String())

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
