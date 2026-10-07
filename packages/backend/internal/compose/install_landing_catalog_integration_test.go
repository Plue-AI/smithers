package compose

import (
	"bytes"
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

// The retained review HTTP door consumes the catalog decision, including its
// actor split, rather than the historical owner/person shortcut.
func TestInstallLandingCatalogDecisionsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, map[string]string{"reviewchangeaaaa": "1111111111111111111111111111111111111111"}, "", true)
	landing := f.landing("Review", f.other.ID, "reviewchangeaaaa")
	cookie := "install-review-catalog-session"
	sum := sha256.Sum256([]byte(cookie))
	_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	issuer := services.NewAuthService(f.q, cfg.Auth, nil, nil)
	issuer.Members = &services.Members{Pool: f.pool}
	delegated, err := issuer.CreateToken(f.ctx, f.owner.ID, services.CreateTokenRequest{Name: "review-codex", Via: "codex", Scopes: []string{"repo", "user"}})
	require.NoError(t, err)
	run := f.token(f.owner, "review-run", "write:repository", true)
	for _, cell := range []struct {
		name, token string
		status      int
		code        string
	}{
		{"external excluded", delegated.Token, 403, "permission"},
		{"run excluded", run, 403, "permission"},
		{"person acknowledges", "", 200, ""},
	} {
		t.Run(cell.name, func(t *testing.T) {
			thread, err := f.q.CreateLandingRequestComment(f.ctx, db.CreateLandingRequestCommentParams{LandingRequestID: landing.ID, UserID: pgtype.Int8{Int64: f.owner.ID, Valid: true}, Body: "Fix", Side: "right", CommitID: "1111111111111111111111111111111111111111"})
			require.NoError(t, err)
			_, err = f.q.MarkLandingRequestThreadDone(f.ctx, db.MarkLandingRequestThreadDoneParams{ID: thread.ID, LandingRequestID: landing.ID, DoneBy: pgtype.Int8{Int64: f.other.ID, Valid: true}, ResolvedInRevision: []byte(`{}`)})
			require.NoError(t, err)
			req := httptest.NewRequest("POST", fmt.Sprintf("http://example.com/api/repos/gate-owner/app/landings/%d/threads/%d/ack", landing.Number, thread.ID), bytes.NewBufferString(`{}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "http://example.com")
			req.Header.Set("Smithers-Actor", "person")
			req.Header.Set("Smithers-Via", "smithers")
			if cell.token != "" {
				req.Header.Set("Authorization", "Bearer "+cell.token)
			} else {
				req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
				req.Header.Set("X-CSRF-Token", "csrf")
			}
			var decisions []string
			req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) {
				decisions = append(decisions, command)
			}))
			out := httptest.NewRecorder()
			f.router.ServeHTTP(out, req)
			require.Equal(t, cell.status, out.Code, out.Body.String())
			require.Equal(t, []string{"review.ack"}, decisions, "router and service share one decision")
			var state string
			require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT state FROM landing_request_comments WHERE id=$1`, thread.ID).Scan(&state))
			if cell.code != "" {
				require.Contains(t, out.Body.String(), `"code":"`+cell.code+`"`)
				require.Equal(t, "done", state)
			} else {
				require.Equal(t, "resolved", state)
			}
		})
	}
}
