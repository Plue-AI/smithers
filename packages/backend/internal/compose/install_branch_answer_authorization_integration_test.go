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

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallBranchAnswerAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewMythicalService(f.pool, nil)
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: service}})
	cookie := "branch-answer-member"
	sum := sha256.Sum256([]byte(cookie))
	_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	head := strings.Repeat("a", 40)
	checks := fmt.Sprintf(`{"todo":true,"branch":"smithers/access-answer","foreignHead":%q,"waits":[{"id":"outside","kind":"foreign_push","sha":%q,"prompt":"Outside push","since":"2026-10-07T00:00:00Z"}]}`, head, head)
	item, _, err := f.q.InsertMythicalItem(f.ctx, db.MythicalItem{RepositoryID: f.repoID, State: "blocked", Checks: []byte(checks)})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET source='todo',number=41,owner_id=$2,pr_number=41,pr_state='open',pr_head=$3,candidate_head=$4,candidate_verified=true WHERE id=$1`, item.ID, f.owner.ID, strings.Repeat("b", 40), strings.Repeat("c", 40))
	require.NoError(t, err)
	before, err := f.q.GetMythicalItem(f.ctx, item.ID)
	require.NoError(t, err)
	call := func(op, revision, key string, status int) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, cfg.Server.PublicURL+"/api/branches/smithers%2Faccess-answer", strings.NewReader(fmt.Sprintf(`{"op":%q,"id":"outside","revision":%q}`, op, revision)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("X-CSRF-Token", "csrf")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		commands := []string{}
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{"branch." + op}, commands)
	}
	// The Member's role is evaluated for the resolved body command, not as an owner-only route.
	call("discard-foreign", head, "member-discard", 403)
	call("bring-in", strings.Repeat("d", 40), "member-stale", 409)
	untouched, err := f.q.GetMythicalItem(f.ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, before, untouched)
	_, err = f.pool.Exec(f.ctx, `UPDATE collaborators SET permission='admin' WHERE repository_id=$1 AND user_id=$2`, f.repoID, f.other.ID)
	require.NoError(t, err)
	call("discard-foreign", head, "maintainer-discard", 202)
	call("discard-foreign", head, "maintainer-discard", 202)
	after, err := f.q.GetMythicalItem(f.ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, head, after.PRHead)
	require.Equal(t, before.CandidateHead, after.CandidateHead)
	var projection struct {
		ForeignHead string
		Waits       []map[string]any
	}
	require.NoError(t, json.Unmarshal(after.Checks, &projection))
	require.Empty(t, projection.ForeignHead)
	require.Equal(t, f.other.Username, projection.Waits[0]["answered_by"])
	require.Equal(t, "discard-foreign", projection.Waits[0]["answer"])
	var count int
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_discard-foreign'`).Scan(&count))
	require.Equal(t, 1, count)
}
