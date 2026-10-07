package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallRetainedReadCommandsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cookie := "retained-read-member"
	sum := sha256.Sum256([]byte(cookie))
	_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	landing, err := f.q.CreateLandingRequest(f.ctx, db.CreateLandingRequestParams{RepositoryID: f.repoID, AuthorID: f.owner.ID, Title: "Stored review", TargetBookmark: "main", StackSize: 1})
	require.NoError(t, err)
	_, err = f.q.CreateLandingRequestReview(f.ctx, db.CreateLandingRequestReviewParams{LandingRequestID: landing.ID, ReviewerID: pgtype.Int8{Int64: f.owner.ID, Valid: true}, ReviewerKind: "human", Type: "comment", Body: "Stored review body", ChangeRevisions: []byte(`{}`)})
	require.NoError(t, err)
	_, err = f.q.CreateLandingRequestComment(f.ctx, db.CreateLandingRequestCommentParams{LandingRequestID: landing.ID, UserID: pgtype.Int8{Int64: f.owner.ID, Valid: true}, Side: "both", Body: "Stored note"})
	require.NoError(t, err)
	run := f.token(f.owner, "retained-read-run", "read:repository,write:repository", true)
	call := func(path, command, token string, status int) string {
		t.Helper()
		req := httptest.NewRequest("GET", "http://example.com/api/repos/gate-owner/app"+path, nil)
		if token == "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		} else {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		var commands []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		f.router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{command}, commands)
		return out.Body.String()
	}
	for _, row := range []struct{ path, command, content string }{
		{"/landings", "prs.list", "Stored review"},
		{fmt.Sprintf("/landings/%d", landing.Number), "prs.view", "Stored review"},
		{fmt.Sprintf("/landings/%d/changes", landing.Number), "prs.view", "[]"},
		{fmt.Sprintf("/landings/%d/diff", landing.Number), "prs.view", `"changes":[]`},
		{fmt.Sprintf("/landings/%d/conflicts", landing.Number), "prs.view", `"has_conflicts":false`},
		{fmt.Sprintf("/landings/%d/reviews", landing.Number), "prs.view", "Stored review body"},
		{fmt.Sprintf("/landings/%d/comments", landing.Number), "prs.view", "Stored note"},
	} {
		t.Run("member"+row.path, func(t *testing.T) {
			require.Contains(t, call(row.path, row.command, "", 200), row.content)
		})
	}
	// Every retained alias below must reach the stated command before a run
	// could inspect repository-wide or another execution's data.
	for _, row := range []struct{ path, command string }{
		{"/landings", "prs.list"}, {"/landings/1", "prs.view"}, {"/landings/1/changes", "prs.view"},
		{"/landings/1/diff", "prs.view"}, {"/landings/1/land/append", "prs.view"},
		{"/landings/1/comments", "prs.view"}, {"/landings/1/conflicts", "prs.view"}, {"/landings/1/reviews", "prs.view"},
	} {
		t.Run("run"+row.path, func(t *testing.T) {
			require.Contains(t, call(row.path, row.command, run, 403), `"code":"permission"`)
		})
	}
	// Review readers above use real SQL records; the unrelated repository host
	// fixture must not substitute for a read dependency in this proof.
	require.Zero(t, f.hostCalls.Load())
}
