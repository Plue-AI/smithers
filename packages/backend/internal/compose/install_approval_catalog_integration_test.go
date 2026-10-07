package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallApprovalCatalogDecisionsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	sessionID := uuid.NewString()
	_, err := f.pool.Exec(f.ctx, `INSERT INTO agent_sessions(id,repository_id,user_id,status) VALUES($1,$2,$3,'active')`, sessionID, f.repoID, f.owner.ID)
	require.NoError(t, err)
	cookie := "approval-person-cookie"
	sum := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	for _, cell := range []struct {
		name, scopes string
		system       bool
		status       int
		code         string
	}{
		{"session", "", false, 200, ""},
		{"delegated", "write:repository,via:codex", true, 403, "never"},
		{"run", "write:repository", true, 403, "permission"},
		{"legacy PAT", "write:repository", false, 403, "never"},
		{"read scope", "read:repository,via:codex", true, 403, "permission"},
	} {
		token := ""
		if cell.scopes != "" {
			token = f.token(f.owner, cell.name, cell.scopes, cell.system)
		}
		for _, decision := range []string{"approved", "rejected"} {
			t.Run(cell.name+"/"+decision, func(t *testing.T) {
				id := uuid.NewString()
				_, err := f.q.CreateApproval(f.ctx, db.CreateApprovalParams{ID: id, SessionID: sessionID, RepositoryID: f.repoID, Kind: "command", Title: "Run command", Payload: json.RawMessage(`{}`)})
				require.NoError(t, err)
				req := httptest.NewRequest("POST", "http://example.com/api/repos/gate-owner/app/approvals/"+id+"/decide", strings.NewReader(fmt.Sprintf(`{"decision":%q}`, decision)))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", "http://example.com")
				req.Header.Set("Smithers-Actor", "person")
				req.Header.Set("Smithers-Via", "smithers")
				if cell.scopes == "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
					req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
					req.Header.Set("X-CSRF-Token", "csrf")
				} else {
					req.Header.Set("Authorization", "Bearer "+token)
				}
				var commands []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
				out := httptest.NewRecorder()
				f.router.ServeHTTP(out, req)
				require.Equal(t, cell.status, out.Code, out.Body.String())
				command := "approval.approve"
				if decision == "rejected" {
					command = "approval.deny"
				}
				require.Equal(t, []string{command}, commands)
				row, err := f.q.GetApproval(f.ctx, id)
				require.NoError(t, err)
				if cell.code != "" {
					require.Contains(t, out.Body.String(), `"code":"`+cell.code+`"`)
					require.Equal(t, "pending", row.State)
					require.False(t, row.DecidedBy.Valid)
				} else {
					require.Equal(t, decision, row.State)
					require.Equal(t, f.owner.ID, row.DecidedBy.Int64)
				}
			})
		}
	}
	// Direct service entry has the same decision before row lookup or mutation.
	service := services.NewApprovalsService(f.q)
	service.ConfigureInstallAuthorization(f.q)
	info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "write:repository", Scopes: middleware.ParseTokenScopes("write:repository")}
	ctx := middleware.ContextWithAuthInfo(f.ctx, info)
	_, err = service.Decide(ctx, services.DecideApprovalInput{ApprovalID: uuid.NewString(), RepositoryID: f.repoID, UserID: f.owner.ID, Decision: "approved"})
	var access *services.AccessError
	require.ErrorAs(t, err, &access)
	require.Equal(t, "permission", access.Code)

	t.Run("revoked session cannot reuse decision", func(t *testing.T) {
		service.ConfigureInstallAuthorization(f.q, f.pool)
		id := uuid.NewString()
		_, err := f.q.CreateApproval(f.ctx, db.CreateApprovalParams{ID: id, SessionID: sessionID, RepositoryID: f.repoID, Kind: "command", Title: "Run command", Payload: json.RawMessage(`{}`)})
		require.NoError(t, err)
		info := &middleware.AuthInfo{User: &f.owner, SessionHash: hex.EncodeToString(sum[:])}
		ctx := middleware.ContextWithAuthInfo(f.ctx, info)
		decision, err := services.Authorize(ctx, f.q, "approval.approve")
		require.NoError(t, err)
		ctx = services.WithInstallAuthorization(ctx, "approval.approve", decision)
		require.NoError(t, f.q.DeleteAuthSession(f.ctx, info.SessionHash))
		_, err = service.Decide(ctx, services.DecideApprovalInput{ApprovalID: id, RepositoryID: f.repoID, UserID: f.owner.ID, Decision: "approved"})
		var access *services.AccessError
		require.ErrorAs(t, err, &access)
		require.Equal(t, 401, access.Status)
		require.Equal(t, "unauthenticated", access.Code)
		row, err := f.q.GetApproval(f.ctx, id)
		require.NoError(t, err)
		require.Equal(t, "pending", row.State)
		require.False(t, row.DecidedBy.Valid)
	})
}
