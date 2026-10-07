package compose

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallWikiWriteAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	store, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: filepath.Join(t.TempDir(), "wiki"), PublicBaseURL: cfg.Server.PublicURL, SigningKey: bytes.Repeat([]byte{0x31}, 32)})
	require.NoError(t, err)
	defer store.Close()
	wiki := services.NewWikiService(f.q, nil, services.WithWikiContent(store), services.WithWikiCollaboration(f.q, nil))
	todos := services.NewMythicalService(f.pool, nil)
	todos.SetWiki(wiki)
	todos.SetLearningWiki(wiki)
	router := buildRouterCompat(cfg, f.q, f.pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, wiki, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: todos}})
	cookie := "wiki-member"
	sum := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	run := f.token(f.owner, "wiki-run", "read:repository,write:repository", true)
	appAgent := f.token(f.other, "wiki-app", "read:repository,write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	external := f.token(f.owner, "wiki-external", "read:repository,write:repository,via:codex", true)
	call := func(t *testing.T, method, path, body, token, command string, status int) string {
		t.Helper()
		target := "/api/repos/gate-owner/app/wiki" + path
		if strings.HasPrefix(path, "/api/") {
			target = path
		}
		req := httptest.NewRequest(method, cfg.Server.PublicURL+target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", "wiki-authority-"+method+path)
		req.Header.Set("Origin", cfg.Server.PublicURL)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		} else {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
			req.Header.Set("X-CSRF-Token", "csrf")
		}
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{command}, decisions)
		return out.Body.String()
	}
	for _, actor := range []struct{ name, token string }{{"run", run}, {"external", external}} {
		for _, row := range []struct{ method, path, body, command string }{
			{"POST", "", `{"slug":"refused","title":"Refused","body":"No effect"}`, "wiki.create"},
			{"PATCH", "/refused", `{"body":"No effect"}`, "wiki.edit"},
			{"DELETE", "/refused", "", "wiki.delete"},
			{"PUT", "/attachments/refused-txt-75c47aa81c26?expected_revision=0&path=refused.txt", "No effect", "wiki.edit"},
		} {
			t.Run(actor.name+"/"+row.command, func(t *testing.T) {
				require.Contains(t, call(t, row.method, row.path, row.body, actor.token, row.command, 403), `"code":"permission"`)
			})
		}
	}
	t.Run("app create refuses without a confirmation consumer", func(t *testing.T) {
		require.Contains(t, call(t, "POST", "", `{"slug":"pending","title":"Pending","body":"Not created"}`, appAgent, "wiki.create", 503), `"code":"confirmation_unavailable"`)
	})
	var count int
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM wiki_pages WHERE repository_id=$1`, f.repoID).Scan(&count))
	require.Zero(t, count)
	t.Run("member creates edits and deletes a stored page", func(t *testing.T) {
		call(t, "POST", "", `{"slug":"decision","title":"Decision","body":"First decision"}`, "", "wiki.create", 201)
		call(t, "PATCH", "/decision", `{"body":"Revised decision","expected_revision":1}`, "", "wiki.edit", 200)
		require.Contains(t, call(t, "GET", "/decision", "", "", "wiki.read", 200), "Revised decision")
		var body string
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT body FROM wiki_pages WHERE repository_id=$1 AND slug='decision'`, f.repoID).Scan(&body))
		require.Equal(t, "Revised decision", body)
		call(t, "PATCH", "/decision", `{"body":"App decision","expected_revision":2}`, appAgent, "wiki.edit", 200)
		pending := call(t, "DELETE", "/decision", "", appAgent, "wiki.delete", 202)
		var receipt struct {
			Confirmation string `json:"confirmation"`
			State        string `json:"state"`
		}
		require.NoError(t, json.Unmarshal([]byte(pending), &receipt))
		require.Equal(t, "pending", receipt.State)
		require.NotEmpty(t, receipt.Confirmation)
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM wiki_pages WHERE repository_id=$1`, f.repoID).Scan(&count))
		require.Equal(t, 1, count, "an agent request must not delete the page")
		call(t, "POST", "/api/confirmations/"+receipt.Confirmation+"/approve", `{}`, "", "wiki.delete", 200)
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM wiki_pages WHERE repository_id=$1`, f.repoID).Scan(&count))
		require.Zero(t, count)
	})
	t.Run("member stores an attachment", func(t *testing.T) {
		data := "Stored attachment"
		sum := sha256.Sum256([]byte(data))
		slug := services.WikiAttachmentSlug("note.txt", hex.EncodeToString(sum[:]))
		call(t, "PUT", "/attachments/"+slug+"?expected_revision=0&path=note.txt", data, "", "wiki.edit", 200)
		page, err := f.q.GetWikiPageBySlug(f.ctx, db.GetWikiPageBySlugParams{RepositoryID: f.repoID, Slug: slug, Visibility: "public"})
		require.NoError(t, err)
		require.Contains(t, string(page.Attachment), hex.EncodeToString(sum[:]))
		require.Equal(t, data, call(t, "GET", fmt.Sprintf("/history/%d/1/content", page.ID), "", "", "wiki.read", 200))
	})
	require.Zero(t, f.hostCalls.Load())
}
