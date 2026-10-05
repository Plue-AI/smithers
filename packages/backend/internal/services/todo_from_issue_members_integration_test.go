package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// Make TODO as roster members through the production FileTodo, the
// install's App and the GitHub fake, with real PostgreSQL (C-J2-01,
// C-SEC-03). The issue is read through the App as the stack's actor, so a
// member's own GitHub credential is never asked: a Member makes a TODO from
// a member's issue; an outsider's issue is a maintainer's to make (§10.2.1),
// and the maintainer's TODO from it is marked outsider.
func TestMembersMakeTodosFromIssuesThroughTheApp(t *testing.T) {
	f := newPublicationFixture(t, false)
	ctx := context.Background()
	const repo = "rehearsal-owner/app"
	q := db.New(f.pool)
	f.fake.SetCollaborator(8, "ben", "maintain")
	f.fake.SetCollaborator(9, "alice", "write")
	f.fake.SetCollaborator(10, "carol", "read")
	team := f.fake.OpenIssue(repo, "ben", "Say goodbye", "JOURNEY.md should end with a farewell.")
	outsider := f.fake.OpenIssue(repo, "carol", "Crash on start", "It crashes.")
	binding := fmt.Sprintf(`{"owner_login":"smithers-canary","repository_name":"smithers","repository_id":%d}`, f.repoID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	person := func(login, permission string) context.Context {
		t.Helper()
		var id int64
		require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,display_name) VALUES($1,$1,$1) RETURNING id`, login).Scan(&id))
		_, err := f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, f.repoID, id, permission)
		require.NoError(t, err)
		return middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: id}, SessionHash: login + "-session"})
	}
	alice, ben := person("alice", "write"), person("ben", "admin")
	digest := func(title, body string) string {
		sum := sha256.Sum256([]byte(title + "\x00" + body))
		return hex.EncodeToString(sum[:])
	}
	commit := func(as context.Context, number int64, title, body, key string) (MythicalItemView, error) {
		return f.service.FileTodo(as, f.repoID, middleware.AuthInfoFromContext(as).User.ID, MythicalTodoInput{Title: title, Prompt: body,
			Issue: &number, IssueDigest: digest(title, body), Request: key})
	}

	made, err := commit(alice, team, "Say goodbye", "JOURNEY.md should end with a farewell.", "alice-team")
	require.NoError(t, err)
	item, err := q.GetMythicalItemByNumber(ctx, f.repoID, made.Number)
	require.NoError(t, err)
	require.Equal(t, "issue", item.Source)
	require.EqualValues(t, team, item.IssueNumber.Int64)
	require.Equal(t, middleware.AuthInfoFromContext(alice).User.ID, item.CreatedBy.Int64)
	require.False(t, item.Outsider)

	_, err = commit(alice, outsider, "Crash on start", "It crashes.", "alice-outsider")
	var refused *AccessError
	require.ErrorAs(t, err, &refused)
	require.Equal(t, AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Only a maintainer can make a TODO from this issue"}, *refused)
	_, err = q.GetActiveMythicalItemByIssue(ctx, f.repoID, outsider)
	require.Error(t, err, "a refused Make TODO files nothing")

	made, err = commit(ben, outsider, "Crash on start", "It crashes.", "ben-outsider")
	require.NoError(t, err)
	item, err = q.GetMythicalItemByNumber(ctx, f.repoID, made.Number)
	require.NoError(t, err)
	require.EqualValues(t, outsider, item.IssueNumber.Int64)
	require.True(t, item.Outsider, "a maintainer's TODO from an outsider's text is marked outsider")
}
