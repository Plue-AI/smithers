package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallCandidateAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	workspace, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "candidate", TargetBookmark: "lane/1", Kind: "container", Status: "running"})
	require.NoError(t, err)
	// Real retained Git objects and upload-pack advertisement; no authorization,
	// membership, candidate store or service is replaced by a test implementation.
	gitDir := t.TempDir()
	git := func(input string, args ...string) string {
		t.Helper()
		command := exec.CommandContext(t.Context(), "git", append([]string{"--git-dir=" + gitDir}, args...)...)
		command.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.com", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.com")
		command.Stdin = strings.NewReader(input)
		out, err := command.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	git("", "init", "--bare")
	tree := git("", "mktree")
	base := git("", "commit-tree", tree, "-m", "base")
	source := git("", "commit-tree", tree, "-p", base, "-m", "candidate")
	git("", "update-ref", repohost.WorkspaceSourceRef(workspace.ID, source), source)
	var reads atomic.Int64
	host := repohost.NewLocalClientWithStagingEndpoint(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		command := exec.CommandContext(r.Context(), "git", "upload-pack", "--advertise-refs", gitDir)
		out, err := command.Output()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/x-git-upload-pack-advertisement")
		_, _ = w.Write(out)
	}), "candidate-fixture", "http://127.0.0.1:1", true)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, f.repoID, f.owner.ID)
	require.NoError(t, err)
	var itemID string
	require.NoError(t, f.pool.QueryRow(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,number,stack_position,title,workspace_id,request_run_id,request_outcome,base_commit,generation,owner_id,attempt)
 VALUES($1,'todo','delivering',1,1,'Candidate',$2,'current-run','validated',$3,7,$4,1) RETURNING id::text`, f.repoID, workspace.ID, base, f.owner.ID).Scan(&itemID))
	_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'request')`, workspace.ID, f.repoID, itemID)
	require.NoError(t, err)
	service := services.NewMythicalService(f.pool, host, services.WithMythicalInstallAuthorization(true))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: service}})
	scopes := "write:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.LandingWorkspaceScope(workspace.ID) + "," + middleware.AgentSessionRestrictionScope("current-run")
	run := f.token(f.owner, "candidate-run", scopes, true)
	delegated := f.token(f.owner, "candidate-agent", "write:repository,via:codex", true)
	unbound := f.token(f.owner, "candidate-unbound", "write:repository,"+middleware.RepositoryRestrictionScope(f.repoID), true)
	t.Run("delivery reads only its own execution state", func(t *testing.T) {
		for _, cell := range []struct {
			path   string
			status int
		}{{"/api/repos/gate-owner/app/mythical", 200}, {"/api/user/repos", 403}, {"/api/repos/gate-owner/app/mythical/items/" + itemID, 403}} {
			req := httptest.NewRequest("GET", "http://example.com"+cell.path, nil)
			req.Header.Set("Authorization", "Bearer "+run)
			decisions := []string{}
			req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, cell.status, out.Code, out.Body.String())
			require.Equal(t, []string{"repo.read"}, decisions)
			if cell.status == 200 {
				require.JSONEq(t, `{"state":"active"}`, out.Body.String())
			}
		}
	})
	input := services.MythicalLaneSubmission{WorkspaceID: workspace.ID, Base: base, Source: source, RequestRunID: "current-run", Summary: "Retained candidate"}
	call := func(token string, submission services.MythicalLaneSubmission, status int) {
		t.Helper()
		raw, err := json.Marshal(submission)
		require.NoError(t, err)
		req := httptest.NewRequest("PUT", "http://example.com/api/repos/gate-owner/app/mythical/lanes", bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{"stack.candidate"}, decisions)
	}
	for _, token := range []string{delegated, unbound} {
		call(token, input, 403)
	}
	stale := input
	stale.RequestRunID = "previous-run"
	call(run, stale, 403)
	require.Zero(t, reads.Load(), "refused candidates do not even read repository refs")
	call(run, input, 202)
	row, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
	require.NoError(t, err)
	require.Equal(t, source, row.CandidateHead)
	require.Equal(t, "integrating", row.State)
	call(run, input, 202)
	afterReplay := reads.Load()
	t.Run("stack lock precedes repository reads on replay", func(t *testing.T) {
		tx, err := f.pool.Begin(f.ctx)
		require.NoError(t, err)
		defer func() { _ = tx.Rollback(context.Background()) }()
		_, err = tx.Exec(f.ctx, `SELECT repository_id FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, f.repoID)
		require.NoError(t, err)
		raw, err := json.Marshal(input)
		require.NoError(t, err)
		ctx, cancel := context.WithTimeout(f.ctx, time.Second)
		defer cancel()
		req := httptest.NewRequest("PUT", "http://example.com/api/repos/gate-owner/app/mythical/lanes", bytes.NewReader(raw)).WithContext(ctx)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+run)
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.ErrorIs(t, ctx.Err(), context.DeadlineExceeded)
		require.NotEqual(t, 202, out.Code, out.Body.String())
		require.Equal(t, afterReplay, reads.Load(), "admission waits behind publication before reading refs")
		require.NoError(t, tx.Rollback(f.ctx))
		call(run, input, 202)
		afterReplay = reads.Load()
	})
	t.Run("merge fence and closed items refuse equal-source replay before repository reads", func(t *testing.T) {
		for _, state := range []string{"merging", "landed", "cancelled", "rejected", "declined", "skipped"} {
			t.Run(state, func(t *testing.T) {
				if state == "merging" {
					_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET pending_op=jsonb_build_object('kind','merge','target','1','desired',$2::text,'state','intended') WHERE id=$1`, itemID, source)
				} else {
					_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET state=$2,pending_op=NULL WHERE id=$1`, itemID, state)
				}
				require.NoError(t, err)
				call(run, input, 409)
				require.Equal(t, afterReplay, reads.Load())
				retained, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
				require.NoError(t, err)
				require.Equal(t, source, retained.CandidateHead)
				require.True(t, retained.CandidateVerified)
			})
		}
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET state='integrating',pending_op=NULL WHERE id=$1`, itemID)
		require.NoError(t, err)
		call(run, input, 202)
		afterReplay = reads.Load()
	})
	call(run, stale, 403)
	require.Equal(t, afterReplay, reads.Load(), "stale replay is refused before ref reads or receipt disclosure")
	_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='replacement-run',generation=generation+1 WHERE id=$1`, itemID)
	require.NoError(t, err)
	call(run, input, 403)
	require.Equal(t, afterReplay, reads.Load())
	var approvals int
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM approvals`).Scan(&approvals))
	require.Zero(t, approvals, "candidate submission grants no person approval")
	for _, kind := range []string{"generation", "payload", "revoked"} {
		t.Run("write fence "+kind, func(t *testing.T) {
			_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='current-run',generation=7 WHERE id=$1`, itemID)
			require.NoError(t, err)
			raw := f.token(f.owner, "fence-"+kind, scopes, true)
			digest := sha256.Sum256([]byte(raw))
			hash := hex.EncodeToString(digest[:])
			token, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
			require.NoError(t, err)
			info := &middleware.AuthInfo{User: &f.owner, TokenID: token.TokenID, TokenHash: hash, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes), IsTokenAuth: true, TokenSystemIssued: true}
			ctx := middleware.ContextWithAuthInfo(f.ctx, info)
			decisions := 0
			ctx = services.WithAuthorizationObserver(ctx, func(string) { decisions++ })
			subject, err := services.ResolveInstallCandidateSubject(ctx, f.q, f.repoID, input)
			require.NoError(t, err)
			decision, err := services.Authorize(ctx, f.q, "stack.candidate", subject)
			require.NoError(t, err)
			ctx = services.WithInstallAuthorization(ctx, "stack.candidate", decision, subject)
			submitted := input
			switch kind {
			case "generation":
				_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET generation=generation+1 WHERE id=$1`, itemID)
			case "payload":
				submitted.Summary = "Different payload after decision"
			case "revoked":
				_, err = f.pool.Exec(f.ctx, `DELETE FROM access_tokens WHERE id=$1`, token.TokenID)
			}
			require.NoError(t, err)
			before := reads.Load()
			_, err = service.SubmitLane(ctx, f.repoID, f.owner.ID, submitted)
			require.Error(t, err)
			if kind == "revoked" {
				require.ErrorContains(t, err, "Sign in again")
			}
			require.Equal(t, 1, decisions)
			require.Equal(t, before, reads.Load())
		})
	}

}
