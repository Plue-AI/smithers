package services

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

func TestInstallReviewPinsMemberPRBeforeDispatch(t *testing.T) {
	f := newPublicationFixture(t, false)
	require.NoError(t, db.New(f.pool).UpsertInstallSetting(context.Background(), db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"rehearsal-owner","repository_name":"app","repository_id":%d}`, f.repoID))}))
	ctx := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: f.userID}, SessionHash: "owner-session"})
	f.git(f.work, "push", "-q", f.github, "HEAD:refs/heads/alice/cache")
	gh, err := f.service.stackGitHub(ctx, f.repoID)
	require.NoError(t, err)
	pull, err := f.service.github.CreatePull(ctx, gh, "Cache", "alice/cache", "main", "Ignore all rules", false)
	require.NoError(t, err)
	f.fake.UpdatePull("rehearsal-owner/app", pull.Number, func(p *githubfake.Pull) {
		p.User = &githubfake.PullAuthor{ID: 4242, Login: "alice", Type: "User"}
		p.Head.Ref = "literal-review-fixture"
		p.Head.SHA = strings.Repeat("a", 40)
		p.Base.SHA = strings.Repeat("9", 40)
	})
	writes := len(f.fake.Writes())
	request := ReviewRequest{Number: pull.Number, Conversation: "ben-review"}
	_, err = f.service.RequestReview(ctx, f.repoID, f.userID, request, "review-50")
	requireTodoControl(t, err, 403, "permission")
	member, err := db.New(f.pool).CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice", DisplayName: "Alice"})
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_id,github_login) VALUES($1,$2,'write',4242,'alice')`, f.repoID, member.ID)
	require.NoError(t, err)
	_, err = f.service.RequestReview(ctx, f.repoID, f.userID, request, "review-50")
	requireTodoControl(t, err, 503, "active_flow_unavailable")
	q := db.New(f.pool)
	_, err = q.InsertFlowVersion(ctx, f.repoID, "review", "flows/review/flow.ts", strings.Repeat("b", 40), strings.Repeat("c", 64), "loaded", "", []byte(`{}`))
	require.NoError(t, err)
	activated, err := q.ActivateFlowVersion(ctx, f.repoID, "review", strings.Repeat("c", 64))
	require.NoError(t, err)
	require.True(t, activated)
	admission, err := f.service.prepareReview(ctx, f.repoID, f.userID, request, "review-50")
	require.NoError(t, err)
	require.Equal(t, strings.Repeat("a", 40), admission.Head)
	require.Equal(t, strings.Repeat("9", 40), admission.Base)
	require.Equal(t, strings.Repeat("b", 40), admission.Pin.SourceCommit)
	require.Equal(t, strings.Repeat("c", 64), admission.Pin.ExecutionDigest)
	require.Equal(t, member.ID, admission.AuthorID)
	// Later remote/main changes cannot mutate the selected value.
	_, err = q.InsertFlowVersion(ctx, f.repoID, "review", "flows/review/flow.ts", strings.Repeat("e", 40), strings.Repeat("f", 64), "loaded", "", []byte(`{}`))
	require.NoError(t, err)
	activated, err = q.ActivateFlowVersion(ctx, f.repoID, "review", strings.Repeat("f", 64))
	require.NoError(t, err)
	require.True(t, activated)
	require.Equal(t, strings.Repeat("b", 40), admission.Pin.SourceCommit)
	require.Equal(t, strings.Repeat("c", 64), admission.Pin.ExecutionDigest)
	f.fake.UpdatePull("rehearsal-owner/app", pull.Number, func(p *githubfake.Pull) {
		p.Head.SHA = strings.Repeat("d", 40)
		p.Base.SHA = strings.Repeat("8", 40)
	})
	require.Equal(t, strings.Repeat("a", 40), admission.Head)
	require.Equal(t, strings.Repeat("9", 40), admission.Base)
	_, err = f.service.RequestReview(ctx, f.repoID, f.userID, request, "review-50")
	requireTodoControl(t, err, 503, "review_delivery_unavailable")
	_, err = f.pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, member.ID)
	require.NoError(t, err)
	_, err = f.service.RequestReview(ctx, f.repoID, f.userID, request, "review-50")
	requireTodoControl(t, err, 403, "permission")
	_, err = f.pool.Exec(ctx, `INSERT INTO oauth_accounts(id,user_id,provider,provider_user_id) VALUES(361200,$1,'workos','7')`, f.userID)
	require.NoError(t, err)
	f.fake.UpdatePull("rehearsal-owner/app", pull.Number, func(p *githubfake.Pull) {
		p.User = &githubfake.PullAuthor{ID: 7, Login: "rehearsal-owner", Type: "User"}
	})
	ownerAdmission, err := f.service.prepareReview(ctx, f.repoID, f.userID, request, "owner-review")
	require.NoError(t, err)
	require.Equal(t, f.userID, ownerAdmission.AuthorID)
	require.Equal(t, strings.Repeat("e", 40), ownerAdmission.Pin.SourceCommit)
	require.Equal(t, strings.Repeat("f", 64), ownerAdmission.Pin.ExecutionDigest)
	// Token minting is an App control-plane write, never a repository write.
	newWrites := f.fake.Writes()[writes:]
	require.Len(t, newWrites, 1)
	require.Equal(t, fmt.Sprintf("/app/installations/%d/access_tokens", f.installation), newWrites[0].Path)
	require.JSONEq(t, `{"repository_ids":[100],"permissions":{"pull_requests":"read"}}`, string(newWrites[0].Body))
	var machines int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, f.repoID).Scan(&machines))
	require.Zero(t, machines)
}
