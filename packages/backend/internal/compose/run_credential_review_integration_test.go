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
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// reviewTestRepoHost serves one change at one commit.
type reviewTestRepoHost struct {
	services.LandingRepoHostClient
	changeID, commitID string
}

func (h reviewTestRepoHost) GetChange(context.Context, string, string, string) (repohost.Change, error) {
	return repohost.Change{ChangeID: h.changeID, CommitID: h.commitID, ParentChangeIDs: []string{}}, nil
}

func (h reviewTestRepoHost) GetChangeFiles(context.Context, string, string, string) ([]repohost.ChangeFile, error) {
	return nil, nil
}

// A system-issued credential acts as its user, but an agent holds it, not
// that person. Through the assembled router, its landing review is an agent
// review: it never counts toward a protected bookmark's required human
// approvals and cannot dismiss a person's review. Human approval gates
// (approvals decide, repository-job plan approval) refuse it. The same
// user's own token still approves as a person.
func TestRunCredentialReviewIsNeverAHumanApprovalPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "review-owner", LowerUsername: "review-owner", DisplayName: "Review owner"})
	require.NoError(t, err)
	author, err := q.CreateUser(ctx, db.CreateUserParams{Username: "review-author", LowerUsername: "review-author", DisplayName: "Review author"})
	require.NoError(t, err)
	repoID := ciTestRepo(t, pool, owner.ID, "app")
	_, err = q.UpsertProtectedBookmark(ctx, db.UpsertProtectedBookmarkParams{
		RepositoryID: repoID, Pattern: "main", RequireReview: true, RequireHumanApprovals: 1,
		RequiredChecks: []string{}, RequiredStatusContexts: []string{}, RestrictPushTeams: []string{},
	})
	require.NoError(t, err)

	const changeID, commitID = "kxqpzwvnmlrsotuy", "1111111111111111111111111111111111111111"
	landing, err := q.CreateLandingRequest(ctx, db.CreateLandingRequestParams{
		RepositoryID: repoID, Title: "Author's change", AuthorID: author.ID, TargetBookmark: "main", StackSize: 1,
	})
	require.NoError(t, err)
	_, err = q.AddLandingRequestChange(ctx, db.AddLandingRequestChangeParams{LandingRequestID: landing.ID, ChangeID: changeID, PositionInStack: 1})
	require.NoError(t, err)
	_, err = q.UpsertChange(ctx, db.UpsertChangeParams{RepositoryID: repoID, ChangeID: changeID, CommitID: commitID, ParentChangeIds: []byte("[]")})
	require.NoError(t, err)
	_, err = q.RecordChangeRevision(ctx, db.RecordChangeRevisionParams{RepositoryID: repoID, ChangeID: changeID, CommitID: commitID, Source: "push", OperationIds: []string{}})
	require.NoError(t, err)

	token := func(name, scopes string, systemIssued bool) string {
		plaintext := "smithers_" + hex.EncodeToString([]byte(name + "-token-padding-bytes-xx"))[:40]
		sum := sha256.Sum256([]byte(plaintext))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{
			UserID: owner.ID, Name: name, TokenHash: hash, TokenLastEight: hash[len(hash)-8:],
			SystemIssued: systemIssued, Scopes: scopes,
			ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
		})
		require.NoError(t, err)
		return plaintext
	}
	write := string(middleware.ScopeWriteRepository)
	boundRun := token("review-run", write+","+middleware.RepositoryRestrictionScope(repoID)+","+middleware.AgentSessionRestrictionScope("s1"), true)
	unboundRun := token("review-unbound", write, true)
	person := token("review-person", write, false)

	router := buildRouter(
		testConfigAllFlagsOn(), q, pool,
		&routes.RepoHandler{Service: services.NewRepoService(q, nil, "")},
		nil,
		&routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{},
		&routes.DeployKeyHandler{Service: services.NewDeployKeyService(q)},
		&routes.LabelHandler{}, &routes.OrgHandler{},
		&routes.LandingHandler{Service: services.NewLandingService(q, reviewTestRepoHost{changeID: changeID, commitID: commitID})},
		nil, nil,
		&routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil,
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil,
		&routes.ProtectedBookmarkHandler{Service: services.NewProtectedBookmarkService(q)},
		nil, nil,
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
	serve := func(bearer, method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/repos/review-owner/app"+path, bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer "+bearer)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	humanApprovals := func() int64 {
		count, err := q.CountCurrentApprovedLandingRequestReviews(ctx, db.CountCurrentApprovedLandingRequestReviewsParams{LandingRequestID: landing.ID, RepositoryID: repoID})
		require.NoError(t, err)
		return count
	}
	reviews := fmt.Sprintf("/landings/%d/reviews", landing.Number)
	reviewRequest := func() string {
		var state string
		require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM landing_review_requests WHERE landing_request_id = $1 AND reviewer_id = $2`, landing.ID, owner.ID).Scan(&state))
		return state
	}
	approvers := func() []string {
		rows, err := q.ListChangeLandingApprovers(ctx, db.ListChangeLandingApproversParams{ChangeID: changeID, LandingRequestID: landing.ID})
		require.NoError(t, err)
		logins := []string{}
		for _, row := range rows {
			logins = append(logins, row.Login)
		}
		return logins
	}
	rec := serve(person, http.MethodPost, fmt.Sprintf("/landings/%d/review-requests", landing.Number), `{"reviewer":"review-owner"}`)
	require.Less(t, rec.Code, 300, rec.Body.String())

	for name, bearer := range map[string]string{"bound agent run": boundRun, "unbound agent run": unboundRun} {
		rec := serve(bearer, http.MethodPost, reviews, `{"type":"approve","commit_id":"`+commitID+`"}`)
		assert.NotEqual(t, http.StatusCreated, rec.Code, "%s approved as a person: %s", name, rec.Body.String())
		assert.Zero(t, humanApprovals(), "%s counted as a human approval", name)

		// Its LGTM is an agent review, as a bot's is.
		rec = serve(bearer, http.MethodPost, reviews, `{"verdict":"lgtm","confidence_bucket":"high","summary":"ok","commit_id":"`+commitID+`"}`)
		require.Equal(t, http.StatusCreated, rec.Code, "%s: %s", name, rec.Body.String())
		var review struct {
			ReviewerKind string `json:"reviewer_kind"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &review))
		assert.Equal(t, "agent", review.ReviewerKind, name)
		assert.Zero(t, humanApprovals(), "%s LGTM counted as a human approval", name)
		assert.Empty(t, approvers(), "%s LGTM named its user as an approver", name)

		// The CLI's review: a comment or change request needs no verdict;
		// an approval does.
		rec = serve(bearer, http.MethodPost, reviews, `{"type":"comment","body":"looked","commit_id":"`+commitID+`"}`)
		require.Equal(t, http.StatusCreated, rec.Code, "%s: %s", name, rec.Body.String())
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &review))
		assert.Equal(t, "agent", review.ReviewerKind, name)
		rec = serve(bearer, http.MethodPost, reviews, `{"type":"request_changes","body":"fix","commit_id":"`+commitID+`"}`)
		require.Equal(t, http.StatusCreated, rec.Code, "%s: %s", name, rec.Body.String())
		assert.Equal(t, "requested", reviewRequest(), "%s answered its user's review request", name)

		// Human approval gates refuse it.
		rec = serve(bearer, http.MethodPost, "/approvals/00000000-0000-0000-0000-000000000001/decide", `{"decision":"approved"}`)
		assert.Equal(t, http.StatusForbidden, rec.Code, "%s decided an approval: %s", name, rec.Body.String())
		rec = serve(bearer, http.MethodPost, "/repository-jobs/job/approvals", `{}`)
		assert.Equal(t, http.StatusForbidden, rec.Code, "%s approved a repository job plan: %s", name, rec.Body.String())
	}
	// A run reviews as its person's account, which names no reviewer agent
	// (D-22): even naming that login, its LGTM does not count.
	agentLGTMs, err := q.CountCurrentAgentLandingReviewCommits(ctx, db.CountCurrentAgentLandingReviewCommitsParams{LandingRequestID: landing.ID, CommitIds: []string{commitID}, ReviewerLogins: []string{"review-owner"}})
	require.NoError(t, err)
	assert.Zero(t, agentLGTMs)

	// The person's own token approves as a person.
	rec = serve(person, http.MethodPost, reviews, `{"type":"request_changes","body":"fix it","commit_id":"`+commitID+`"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var blocking struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &blocking))
	rec = serve(boundRun, http.MethodPatch, fmt.Sprintf("%s/%d", reviews, blocking.ID), `{"message":"dismissed by a run"}`)
	assert.Equal(t, http.StatusForbidden, rec.Code, "a run dismissed a person's review: %s", rec.Body.String())
	rec = serve(person, http.MethodPost, reviews, `{"type":"approve","commit_id":"`+commitID+`"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.Equal(t, int64(1), humanApprovals())
	assert.Equal(t, []string{"review-owner"}, approvers())
	assert.Equal(t, "fulfilled", reviewRequest())
	rec = serve(person, http.MethodPost, "/approvals/00000000-0000-0000-0000-000000000001/decide", `{"decision":"approved"}`)
	assert.NotEqual(t, http.StatusForbidden, rec.Code, rec.Body.String())
	rec = serve(person, http.MethodPost, "/repository-jobs/job/approvals", `{}`)
	assert.NotEqual(t, http.StatusForbidden, rec.Code, rec.Body.String())
}
