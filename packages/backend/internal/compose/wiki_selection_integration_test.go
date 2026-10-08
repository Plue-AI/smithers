package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

type recordedSelector struct {
	before func()
	inputs []json.RawMessage
	result string
	err    error
}

func (s *recordedSelector) SelectContext(_ context.Context, grant ports.ContextSelectionGrant) (json.RawMessage, error) {
	s.inputs = append(s.inputs, grant.Input)
	if s.before != nil {
		s.before()
	}
	return json.RawMessage(s.result), s.err
}

// T-FLW-10 through the composed install router with real PostgreSQL: a
// TODO's run credential reads its repository's wiki and asks the shared
// selector for pages, both bound to its own live TODO as wiki.read. The
// selector is a recorded fixture; C-J8-04's machine run is the reference host's.
func TestWikiPlanningSelectionComposedRoutePostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	content, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: filepath.Join(t.TempDir(), "wiki"), PublicBaseURL: "http://example.com", SigningKey: bytes.Repeat([]byte{0x32}, 32)})
	require.NoError(t, err)
	defer content.Close()
	wiki := services.NewWikiService(f.q, nil, services.WithWikiContent(content), services.WithWikiCollaboration(f.q, nil), services.WithWikiInstallAuthorization(f.q))
	for _, page := range []services.CreateWikiPageInput{
		{Title: "Retry policy", Slug: "retry-policy", Body: "Webhook retries use `retry()` with exponential backoff."},
		{Title: "Release process", Slug: "release-process", Body: "Releases ship on Tuesdays."},
	} {
		_, err = wiki.CreateWikiPage(f.ctx, &f.owner, "gate-owner", "app", page)
		require.NoError(t, err)
	}

	privateContext, err := services.WithWikiVisibility(f.ctx, "private")
	require.NoError(t, err)
	privatePage, err := wiki.CreateWikiPage(privateContext, &f.owner, "gate-owner", "app", services.CreateWikiPageInput{Title: "Private decision", Slug: "private-decision", Body: "private-wiki-only-marker"})
	require.NoError(t, err)
	selector := &recordedSelector{result: `{"context":[{"kind":"page","label":"Retry policy","ref":"retry-policy","revision":"1","reason":"Retry decision"}],"candidates":[],"model":"owner-fast","durationMs":3}`}
	router := func(cfgWiki bool, selector ports.ContextSelector) http.Handler {
		cfg := testConfigAllFlagsOn()
		cfg.FeatureFlags.Wiki = cfgWiki
		cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
		cfg.Server.PublicURL = "http://example.com"
		cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
		return buildRouterCompat(cfg, f.q, f.pool,
			&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
			&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, wiki, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
			nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
			routerExtras{WikiSelection: wikiSelection{queries: f.q, wiki: wiki, selector: selector}})
	}
	served := router(true, selector)

	// Two TODOs, each in its own lane, each with its own run.
	workspaces := []string{"31313131-3131-4131-a131-313131313131", "32323232-3232-4232-a232-323232323232"}
	_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active') ON CONFLICT DO NOTHING`, f.repoID, f.owner.ID)
	require.NoError(t, err)
	for i, workspace := range workspaces {
		_, err = f.pool.Exec(f.ctx, `INSERT INTO workspaces(id,repository_id,user_id,name) VALUES($1,$2,$3,$4)`, workspace, f.repoID, f.owner.ID, "lane-"+workspace[:2])
		require.NoError(t, err)
		var itemID string
		require.NoError(t, f.pool.QueryRow(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,number,stack_position,title,workspace_id,request_run_id,owner_id,attempt)
 VALUES($1,'todo','running',$2,$2,'Retry failed webhook deliveries',$3,$4,$5,1) RETURNING id::text`, f.repoID, 12+i, workspace, "selection-run-"+workspace[:2], f.owner.ID).Scan(&itemID))
		_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,$4)`, workspace, f.repoID, itemID, "lane-"+workspace[:2])
		require.NoError(t, err)
	}
	landing := func(workspace, run string) string {
		scopes := strings.Join(append([]string{"write:repository", middleware.RepositoryRestrictionScope(f.repoID), middleware.LandingWorkspaceScope(workspace)}, middleware.PathRestrictionScopes([]string{"**"})...), ",")
		if run != "" {
			scopes += "," + middleware.AgentSessionRestrictionScope(run)
		}
		return scopes
	}
	machineScopes := "read:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.WorkspaceRestrictionScope(workspaces[0])
	credentials := map[string]string{
		"machine": f.token(f.owner, "wsel-machine", machineScopes, true),
		"own":     f.token(f.owner, "wsel-own", landing(workspaces[0], "selection-run-31"), true),
		"stale":   f.token(f.owner, "wsel-stale", landing(workspaces[0], "selection-run-xx"), true),
		"unbound": f.token(f.owner, "wsel-unbound", landing(workspaces[0], ""), true),
		"person":  f.token(f.owner, "wsel-person", "read:repository,write:repository", false),
	}
	const editorSession = "wiki-edit-session"
	editorHash := sha256.Sum256([]byte(editorSession))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(editorHash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	call := func(handler http.Handler, credential, method, path, body string) (*httptest.ResponseRecorder, []string) {
		t.Helper()
		req := httptest.NewRequest(method, "http://example.com/api/repos/gate-owner/app/wiki"+path, strings.NewReader(body))
		if credential == "editor" {
			req.AddCookie(&http.Cookie{Name: "session", Value: editorSession})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
			req.Header.Set("X-CSRF-Token", "csrf")
			req.Header.Set("Origin", "http://example.com")
		} else {
			req.Header.Set("Authorization", "Bearer "+credentials[credential])
		}
		req.Header.Set("Content-Type", "application/json")
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, req)
		return out, decisions
	}

	for _, credential := range []string{"own", "machine"} {
		for _, path := range []string{"/private-decision?visibility=private", fmt.Sprintf("/history/%d/1/content?visibility=private", privatePage.ID), fmt.Sprintf("/history/%d?visibility=private", privatePage.ID), "/private-decision/revisions?visibility=private", "", "/navigation/index", "/search?q=Retry", "/history/events", "/retry-policy/document"} {
			t.Run("privacy/"+credential+path, func(t *testing.T) {
				out, decisions := call(served, credential, "GET", path, "")
				require.Equal(t, 403, out.Code, out.Body.String())
				require.Equal(t, []string{"wiki.read"}, decisions)
				require.NotContains(t, out.Body.String(), "private-wiki-only-marker")
			})
		}
		publicPage, err := f.q.GetWikiPageBySlug(f.ctx, db.GetWikiPageBySlugParams{RepositoryID: f.repoID, Visibility: "public", Slug: "retry-policy"})
		require.NoError(t, err)
		for _, path := range []string{"/retry-policy", "/retry-policy/revisions", fmt.Sprintf("/history/%d", publicPage.ID), fmt.Sprintf("/history/%d/1/content", publicPage.ID)} {
			t.Run("public/"+credential+path, func(t *testing.T) {
				out, decisions := call(served, credential, "GET", path, "")
				require.Equal(t, 200, out.Code, out.Body.String())
				require.Equal(t, []string{"wiki.read"}, decisions)
				require.Contains(t, out.Body.String(), "Webhook retries")
				require.NotContains(t, out.Body.String(), "private-wiki-only-marker")
			})
		}
	}
	t.Run("the own run reads the page it will cite", func(t *testing.T) {
		out, decisions := call(served, "own", "GET", "/retry-policy", "")
		require.Equal(t, 200, out.Code, out.Body.String())
		require.Equal(t, []string{"wiki.read"}, decisions)
		var page map[string]any
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &page))
		require.Equal(t, "0314a7d6edf2ad4b7057d059f7dfdf17df0ab800ec24b502f02ecb38c1bbed22", page["content_digest"])
		require.EqualValues(t, 1, page["revision"])
		require.Contains(t, page, "generated")
	})
	t.Run("the own run selects through the shared selector over wiki pages only", func(t *testing.T) {
		out, decisions := call(served, "own", "POST", "/selection", `{"prompt":"Retry failed webhook deliveries"}`)
		require.Equal(t, 200, out.Code, out.Body.String())
		require.Equal(t, []string{"wiki.read"}, decisions)
		require.JSONEq(t, `{"pages":[{"slug":"retry-policy","revision":1,"reason":"Retry decision"}],"model":"owner-fast","durationMs":3}`, out.Body.String())
		require.Len(t, selector.inputs, 1)
		require.NotContains(t, string(selector.inputs[0]), "private-wiki-only-marker")
		require.NotContains(t, string(selector.inputs[0]), "private-decision")
		var input struct {
			Prompt     string `json:"prompt"`
			Branch     string `json:"branch"`
			WikiOnly   bool   `json:"wikiOnly"`
			Candidates []struct {
				Item map[string]string `json:"item"`
			} `json:"candidates"`
		}
		require.NoError(t, json.Unmarshal(selector.inputs[0], &input))
		require.Equal(t, "Retry failed webhook deliveries", input.Prompt)
		var number int64
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT number FROM mythical_items WHERE workspace_id=$1`, workspaces[0]).Scan(&number))
		require.Equal(t, fmt.Sprintf("todo:%d", number), input.Branch)
		require.True(t, input.WikiOnly)
		refs := []string{}
		for _, candidate := range input.Candidates {
			require.Equal(t, "page", candidate.Item["kind"])
			refs = append(refs, candidate.Item["ref"]+"@"+candidate.Item["revision"])
		}
		require.ElementsMatch(t, []string{"retry-policy@1", "release-process@1"}, refs)
	})
	t.Run("other runs, unbound and person credentials are refused", func(t *testing.T) {
		before := len(selector.inputs)
		for _, credential := range []string{"stale", "unbound"} {
			for _, request := range [][2]string{{"GET", "/retry-policy"}, {"POST", "/selection"}} {
				out, _ := call(served, credential, request[0], request[1], `{"prompt":"Retry"}`)
				require.Equal(t, 403, out.Code, credential+" "+request[0])
				require.Contains(t, out.Body.String(), `"code":"permission"`)
			}
		}
		out, _ := call(served, "person", "POST", "/selection", `{"prompt":"Retry"}`)
		require.Equal(t, 403, out.Code, out.Body.String())
		require.Equal(t, before, len(selector.inputs))
	})

	t.Run("private selection is refused before the model", func(t *testing.T) {
		before := len(selector.inputs)
		out, decisions := call(served, "own", "POST", "/selection?visibility=private", `{"prompt":"Read private pages"}`)
		require.Equal(t, 403, out.Code, out.Body.String())
		require.Equal(t, []string{"wiki.read"}, decisions)
		require.Len(t, selector.inputs, before)
	})
	t.Run("selection expiry refuses model output", func(t *testing.T) {
		sum := sha256.Sum256([]byte(credentials["own"]))
		hash := hex.EncodeToString(sum[:])
		selector.before = func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, hash)
			require.NoError(t, err)
		}
		defer func() {
			selector.before = nil
			_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()+interval '1 hour' WHERE token_hash=$1`, hash)
			require.NoError(t, err)
		}()
		out, decisions := call(served, "own", "POST", "/selection", `{"prompt":"Retry"}`)
		require.Equal(t, 401, out.Code, out.Body.String())
		require.Equal(t, []string{"wiki.read"}, decisions)
		require.NotContains(t, out.Body.String(), "Retry decision")
	})
	t.Run("direct service retains the actual public page subject", func(t *testing.T) {
		sum := sha256.Sum256([]byte(credentials["own"]))
		hash := hex.EncodeToString(sum[:])
		stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
		require.NoError(t, err)
		scopes := landing(workspaces[0], "selection-run-31")
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hash, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)})
		var commands []string
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		page, err := wiki.GetWikiPage(ctx, &f.owner, "gate-owner", "app", "retry-policy")
		require.NoError(t, err)
		require.Contains(t, page.Body, "Webhook retries")
		require.Equal(t, []string{"wiki.read"}, commands)
		subject, err := services.InstallExecutionWikiSubject(ctx, f.q, f.repoID, "wiki.public-page", "retry-policy")
		require.NoError(t, err)
		commands = nil
		decision, err := services.Authorize(ctx, f.q, "wiki.read", subject)
		require.NoError(t, err)
		bound := services.WithInstallAuthorization(ctx, "wiki.read", decision, subject)
		denied := func(err error) {
			var refusal *services.AccessError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, 403, refusal.Status)
		}
		_, err = wiki.GetWikiPage(bound, &f.owner, "gate-owner", "app", "release-process")
		denied(err)
		_, err = wiki.GetWikiIndex(bound, &f.owner, "gate-owner", "app")
		denied(err)
		_, _, err = wiki.ListWikiPages(bound, &f.owner, "gate-owner", "app", services.ListWikiPagesInput{})
		denied(err)
		private, err := services.WithWikiVisibility(bound, "private")
		require.NoError(t, err)
		_, err = wiki.GetWikiPage(private, &f.owner, "gate-owner", "app", "retry-policy")
		denied(err)
		_, err = wiki.GetWikiPage(bound, &f.other, "gate-owner", "app", "retry-policy")
		denied(err)
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET attempt=2 WHERE repository_id=$1 AND workspace_id=$2`, f.repoID, workspaces[0])
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET attempt=1 WHERE repository_id=$1 AND workspace_id=$2`, f.repoID, workspaces[0])
			require.NoError(t, err)
		}()
		_, err = wiki.GetWikiPage(bound, &f.owner, "gate-owner", "app", "retry-policy")
		denied(err)
		require.Equal(t, []string{"wiki.read"}, commands)
	})
	t.Run("selection failures refuse, never an empty vault", func(t *testing.T) {
		for _, tc := range []struct {
			name     string
			selector ports.ContextSelector
			body     string
			status   int
		}{
			{"invalid body", selector, `{"prompt":" "}`, 400},
			{"unknown field", selector, `{"prompt":"Retry","kinds":["file"]}`, 400},
			{"no selector", nil, `{"prompt":"Retry"}`, 503},
			{"selector error", &recordedSelector{err: errors.New("host down")}, `{"prompt":"Retry"}`, 503},
			{"foreign ref", &recordedSelector{result: `{"context":[{"kind":"page","ref":"secrets","revision":"1","reason":"x"}],"model":"m"}`}, `{"prompt":"Retry"}`, 503},
			{"wrong revision", &recordedSelector{result: `{"context":[{"kind":"page","ref":"retry-policy","revision":"7","reason":"x"}],"model":"m"}`}, `{"prompt":"Retry"}`, 503},
			{"file item", &recordedSelector{result: `{"context":[{"kind":"file","ref":"retry-policy","revision":"1","reason":"x"}],"model":"m"}`}, `{"prompt":"Retry"}`, 503},
		} {
			t.Run(tc.name, func(t *testing.T) {
				out, _ := call(router(true, tc.selector), "own", "POST", "/selection", tc.body)
				require.Equal(t, tc.status, out.Code, out.Body.String())
			})
		}
		out, _ := call(router(false, selector), "own", "POST", "/selection", `{"prompt":"Retry"}`)
		require.NotEqual(t, 200, out.Code, "a disabled wiki gate is not an empty vault")
	})

	t.Run("selection then person edit binds the read to the edited revision", func(t *testing.T) {
		selected, _ := call(served, "own", "POST", "/selection", `{"prompt":"Retry failed webhook deliveries"}`)
		require.Equal(t, 200, selected.Code, selected.Body.String())
		require.JSONEq(t, `{"pages":[{"slug":"retry-policy","revision":1,"reason":"Retry decision"}],"model":"owner-fast","durationMs":3}`, selected.Body.String())
		edited, _ := call(served, "editor", "PATCH", "/retry-policy", "{\"body\":\"Webhook retries use `retryFixed(5000)`.\",\"expected_revision\":1}")
		require.Equal(t, 200, edited.Code, edited.Body.String())
		read, decisions := call(served, "own", "GET", "/retry-policy", "")
		require.Equal(t, 200, read.Code, read.Body.String())
		require.Equal(t, []string{"wiki.read"}, decisions)
		var page services.WikiPageResponse
		require.NoError(t, json.Unmarshal(read.Body.Bytes(), &page))
		require.EqualValues(t, 2, page.Revision)
		require.Equal(t, "Webhook retries use `retryFixed(5000)`.", page.Body)
		require.Equal(t, "e47d2d025a859ead6080b931b2b718bfa2937244433746068d08770278b36c7c", page.ContentDigest)
		history, _ := call(served, "own", "GET", fmt.Sprintf("/history/%d/1/content", page.ID), "")
		require.Equal(t, 200, history.Code, history.Body.String())
		require.Equal(t, "Webhook retries use `retry()` with exponential backoff.", history.Body.String())
	})
	t.Run("an expired run credential is refused", func(t *testing.T) {
		sum := sha256.Sum256([]byte(credentials["own"]))
		_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=$2 WHERE token_hash=$1`, hex.EncodeToString(sum[:]), time.Now().Add(-time.Minute))
		require.NoError(t, err)
		out, _ := call(served, "own", "POST", "/selection", `{"prompt":"Retry"}`)
		require.Equal(t, 401, out.Code, out.Body.String())
	})
	require.Zero(t, f.hostCalls.Load())
}
