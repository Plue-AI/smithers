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
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: service}, Members: &routes.MembersHandler{Service: &services.Members{Pool: f.pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}}})
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
	t.Run("machine credential also binds the current run", func(t *testing.T) {
		machineScopes := "write:repository," + middleware.RepositoryRestrictionScope(f.repoID) + ",workspace:" + workspace.ID
		unboundMachine := f.token(f.owner, "candidate-machine-unbound", machineScopes, true)
		staleMachine := f.token(f.owner, "candidate-machine-stale", machineScopes+","+middleware.AgentSessionRestrictionScope("previous-run"), true)
		currentMachine := f.token(f.owner, "candidate-machine-current", machineScopes+","+middleware.AgentSessionRestrictionScope("current-run"), true)
		before := reads.Load()
		call(unboundMachine, input, 403)
		call(staleMachine, input, 403)
		require.Equal(t, before, reads.Load(), "machine refusal precedes retained-object reads")
		call(currentMachine, input, 202)
		afterReplay = reads.Load()
		_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='replacement-run',generation=generation+1 WHERE id=$1`, itemID)
		require.NoError(t, err)
		replacement := input
		replacement.RequestRunID = "replacement-run"
		call(currentMachine, replacement, 403)
		require.Equal(t, afterReplay, reads.Load(), "old machine cannot select a replacement run in the body")
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='current-run',generation=7 WHERE id=$1`, itemID)
		require.NoError(t, err)
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

	t.Run("member sponsor submits without becoming the stack actor", func(t *testing.T) {
		memberSource := git("", "commit-tree", tree, "-p", base, "-m", "Member candidate")
		git("", "update-ref", repohost.WorkspaceSourceRef(workspace.ID, memberSource), memberSource)
		_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$2,request_run_id='member-run',generation=8,state='delivering',request_outcome='validated',candidate_head='',candidate_verified=false WHERE id=$1`, itemID, f.other.ID)
		require.NoError(t, err)
		memberScopes := "write:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.LandingWorkspaceScope(workspace.ID) + "," + middleware.AgentSessionRestrictionScope("member-run")
		memberRun := f.token(f.other, "member-candidate", memberScopes, true)
		memberInput := input
		memberInput.Source, memberInput.RequestRunID = memberSource, "member-run"
		before := reads.Load()
		call(run, memberInput, 403)
		require.Equal(t, before, reads.Load(), "former sponsor cannot read or submit the replacement run")
		call(memberRun, memberInput, 202)
		retained, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
		require.NoError(t, err)
		require.Equal(t, memberSource, retained.CandidateHead)
		require.True(t, retained.CandidateVerified)
		require.Equal(t, f.other.ID, retained.OwnerID.Int64)
		stack, err := f.q.GetMythicalStack(f.ctx, f.repoID)
		require.NoError(t, err)
		require.Equal(t, f.owner.ID, stack.ActorUserID.Int64, "sponsor attribution does not rewrite factory ownership")
		var approvals int
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM approvals`).Scan(&approvals))
		require.Zero(t, approvals)
		t.Run("removal revokes sponsored and independent machine credentials", func(t *testing.T) {
			// The run was minted before transfer. Its lifetime belongs to the
			// original sponsor, even after another person owns the TODO.
			_, err := f.pool.Exec(f.ctx, `UPDATE collaborators SET github_id=199,github_login='gate-other' WHERE user_id=$1`, f.other.ID)
			require.NoError(t, err)
			_, err = f.pool.Exec(f.ctx, `INSERT INTO oauth_accounts(user_id,provider,provider_user_id,profile_data) VALUES($1,'workos','199','{}')`, f.other.ID)
			require.NoError(t, err)
			cookie := "revocation-owner-cookie"
			sum := sha256.Sum256([]byte(cookie))
			_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
			require.NoError(t, err)
			otherWorkspace, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "other-subject", TargetBookmark: "lane/2", Kind: "container", Status: "running"})
			require.NoError(t, err)
			var otherItem string
			require.NoError(t, f.pool.QueryRow(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,number,stack_position,title,workspace_id,request_run_id,owner_id,attempt)
 VALUES($1,'todo','delivering',2,2,'Other subject',$2,'member-run',$3,1) RETURNING id::text`, f.repoID, otherWorkspace.ID, f.owner.ID).Scan(&otherItem))
			_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'other')`, otherWorkspace.ID, f.repoID, otherItem)
			require.NoError(t, err)
			otherSubject := f.token(f.other, "other-subject", strings.Replace(memberScopes, workspace.ID, otherWorkspace.ID, 1), true)
			machine := f.token(f.other, "member-machine", "write:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(workspace.ID), true)
			cli := f.token(f.other, "member-cli", "read:repository,via:cli", true)
			app := f.token(f.other, "member-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
			memberRequest := func(method, path, body string) *httptest.ResponseRecorder {
				req := httptest.NewRequest(method, "http://example.com"+path, strings.NewReader(body))
				req.Header.Set("Origin", "http://example.com")
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-CSRF-Token", "csrf-fixture")
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
				req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				return out
			}
			read := func(token string, want int) {
				req := httptest.NewRequest("GET", "http://example.com/api/repos/gate-owner/app/mythical", nil)
				req.Header.Set("Authorization", "Bearer "+token)
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, want, out.Code, out.Body.String())
			}
			read(memberRun, 200)
			read(cli, 200)
			read(app, 200)
			read(otherSubject, 403)
			_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$2,request_run_id='owner-replacement',generation=generation+1 WHERE id=$1`, itemID, f.owner.ID)
			require.NoError(t, err)
			read(memberRun, 403)
			read(machine, 403)
			started := time.Now()
			out := memberRequest("DELETE", "/api/members/gate-other", "")
			require.Equal(t, 204, out.Code, out.Body.String())
			for _, token := range []string{memberRun, otherSubject, machine, cli, app} {
				read(token, 401)
			}
			var tokens int
			require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM access_tokens WHERE user_id=$1`, f.other.ID).Scan(&tokens))
			require.Zero(t, tokens, "physical deletion is part of the removal commit")
			require.LessOrEqual(t, time.Since(started), 5*time.Second)
			// Restore through the real GitHub-backed member route. The fixture
			// serves GitHub only; admission, token loading and storage stay real.
			github := &rosterGitHub{roles: map[string]string{"gate-other": "write"}}
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.URL.Path = strings.Replace(r.URL.Path, "/repos/gate-owner/app", "/repos/owner/app", 1)
				github.serve(w, r)
			}))
			defer provider.Close()
			t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)
			out = memberRequest("POST", "/api/members", `{"login":"gate-other"}`)
			require.Equal(t, 204, out.Code, out.Body.String())
			for _, token := range []string{memberRun, otherSubject, machine, cli, app} {
				read(token, 401)
			}
			freshScopes := strings.Replace(memberScopes, "member-run", "owner-replacement", 1)
			fresh := f.token(f.owner, "owner-resumed", freshScopes, true)
			read(fresh, 200)
			retained, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
			require.NoError(t, err)
			require.Equal(t, memberSource, retained.CandidateHead, "revocation retains the delivered work")
		})

	})

}
