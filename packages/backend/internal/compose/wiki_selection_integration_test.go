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
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

type recordedSelector struct {
	inputs []json.RawMessage
	result string
	err    error
}

func (s *recordedSelector) SelectContext(_ context.Context, grant ports.ContextSelectionGrant) (json.RawMessage, error) {
	s.inputs = append(s.inputs, grant.Input)
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
	wiki := services.NewWikiService(f.q, nil, services.WithWikiContent(content), services.WithWikiCollaboration(f.q, nil))
	for _, page := range []services.CreateWikiPageInput{
		{Title: "Retry policy", Slug: "retry-policy", Body: "Webhook retries use `retry()` with exponential backoff."},
		{Title: "Release process", Slug: "release-process", Body: "Releases ship on Tuesdays."},
	} {
		_, err = wiki.CreateWikiPage(f.ctx, &f.owner, "gate-owner", "app", page)
		require.NoError(t, err)
	}
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
	credentials := map[string]string{
		"own":     f.token(f.owner, "wsel-own", landing(workspaces[0], "selection-run-31"), true),
		"stale":   f.token(f.owner, "wsel-stale", landing(workspaces[0], "selection-run-xx"), true),
		"unbound": f.token(f.owner, "wsel-unbound", landing(workspaces[0], ""), true),
		"person":  f.token(f.owner, "wsel-person", "read:repository,write:repository", false),
	}
	call := func(handler http.Handler, credential, method, path, body string) (*httptest.ResponseRecorder, []string) {
		t.Helper()
		req := httptest.NewRequest(method, "http://example.com/api/repos/gate-owner/app/wiki"+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+credentials[credential])
		req.Header.Set("Content-Type", "application/json")
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, req)
		return out, decisions
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
	t.Run("an expired run credential is refused", func(t *testing.T) {
		sum := sha256.Sum256([]byte(credentials["own"]))
		_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=$2 WHERE token_hash=$1`, hex.EncodeToString(sum[:]), time.Now().Add(-time.Minute))
		require.NoError(t, err)
		out, _ := call(served, "own", "POST", "/selection", `{"prompt":"Retry"}`)
		require.Equal(t, 401, out.Code, out.Body.String())
	})
	require.Zero(t, f.hostCalls.Load())
}
