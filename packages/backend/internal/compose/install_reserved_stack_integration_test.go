package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Only guest observations and retained-object lookup are substituted. This is
// composed admission/SQL evidence, not packaged microVM acceptance.
type reservedSourceReader struct{ reads int }

func (r *reservedSourceReader) ReadWorkspaceSource(_ context.Context, _, _ string, request repohost.WorkspaceSourceRequest) (repohost.WorkspaceSourceReceipt, error) {
	r.reads++
	return repohost.WorkspaceSourceReceipt{Status: "retained", WorkspaceID: request.WorkspaceID, Ref: repohost.WorkspaceSourceRef(request.WorkspaceID, request.Source.CommitID), Source: request.Source}, nil
}

func TestInstallReservedStackOperationsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	row, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "reserved", TargetBookmark: "lane/1", Kind: "container", Status: "running"})
	require.NoError(t, err)
	base, head, tree := strings.Repeat("a", 40), strings.Repeat("b", 40), strings.Repeat("c", 40)
	runtime := &candidateHeadRuntime{head: head, change: strings.Repeat("k", 32), tree: tree, candidate: head, candidateTree: tree, operations: map[string]bool{}}
	objects := &reservedSourceReader{}
	machine := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceRuntime(runtime), services.WithWorkspaceSourceReader(objects))
	service := services.NewMythicalService(f.pool, nil, services.WithMythicalInstallAuthorization(true))
	service.SetOrchestration(nil, nil, services.NewWorkspaceMythicalLanes(machine))
	_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state,landed_main) VALUES($1,$2,'active',$3)`, f.repoID, f.owner.ID, base)
	require.NoError(t, err)
	var itemID string
	require.NoError(t, f.pool.QueryRow(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,number,stack_position,title,owner_id,attempt,generation,workspace_id,request_run_id,base_commit,candidate_base,candidate_head,candidate_verified,pr_head,flow_digest,plan,checks) VALUES($1,'todo','proposed',1,1,'Reserved',$2,1,7,$3,'current-run',$4,$4,$5,true,$5,$6,'{"checks":[]}','{"flowSource":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","run_attached":true}') RETURNING id::text`, f.repoID, f.owner.ID, row.ID, base, head, strings.Repeat("d", 64)).Scan(&itemID))
	_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'request')`, row.ID, f.repoID, itemID)
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: machine}, routerExtras{Mythical: &routes.MythicalHandler{Service: service}})
	scopes := "write:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.WorkspaceRestrictionScope(row.ID)
	token := f.token(f.owner, "reserved-current", scopes+","+middleware.AgentSessionRestrictionScope("current-run"), true)
	call := func(t *testing.T, bearer, operation, raw string, want int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("POST", fmt.Sprintf("http://example.com/api/repos/gate-owner/app/workspaces/%s/stack/%s", row.ID, operation), strings.NewReader(raw))
		req.Header.Set("Authorization", "Bearer "+bearer)
		req.Header.Set("Content-Type", "application/json")
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, want, out.Code, out.Body.String())
		require.Equal(t, []string{"stack." + operation}, decisions)
		return out
	}
	request := `{"requestId":"11111111-1111-4111-8111-111111111111"}`
	proposal := `{"requestId":"22222222-2222-4222-8222-222222222222","generation":7}`
	for _, credential := range []struct {
		name, scopes string
		system       bool
	}{
		{"unbound", scopes, true}, {"stale", scopes + ",agent-session:old-run", true}, {"delegated", "write:repository,via:smithers", false}, {"public", "write:repository", false},
	} {
		t.Run(credential.name, func(t *testing.T) {
			denied := f.token(f.owner, credential.name, credential.scopes, credential.system)
			before := runtime.calls
			reads := objects.reads
			for _, operation := range []string{"candidate", "propose"} {
				call(t, denied, operation, `not JSON`, 403)
			}
			require.Equal(t, before, runtime.calls)
			require.Equal(t, reads, objects.reads)
		})
	}
	t.Run("preflight does not capture", func(t *testing.T) {
		call(t, token, "candidate", request, 204)
		require.Zero(t, runtime.calls)
		require.Zero(t, objects.reads)
	})
	t.Run("authority fields cannot select another run", func(t *testing.T) {
		call(t, token, "candidate", `{"requestId":"11111111-1111-4111-8111-111111111111","runId":"replacement"}`, 400)
		require.Zero(t, runtime.calls)
	})
	source := repohost.WorkspaceSource{ChangeID: runtime.change, CommitID: head, TreeID: tree, ParentCommitIDs: []string{base}}
	input := services.ReservedStackInput{RequestID: "11111111-1111-4111-8111-111111111111", Source: &source}
	raw, err := json.Marshal(input)
	require.NoError(t, err)
	t.Run("equal tree reuses candidate and proposal", func(t *testing.T) {
		out := call(t, token, "candidate", string(raw), 200)
		require.JSONEq(t, fmt.Sprintf(`{"generation":7,"base":%q,"head":%q}`, base, head), out.Body.String())
		out = call(t, token, "propose", proposal, 200)
		require.JSONEq(t, fmt.Sprintf(`{"generation":7,"head":%q}`, head), out.Body.String())
		item, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
		require.NoError(t, err)
		require.True(t, item.CandidateVerified)
		require.EqualValues(t, 7, item.Generation)
	})
	t.Run("stale generation refuses before observation", func(t *testing.T) {
		before := runtime.calls
		call(t, token, "propose", strings.Replace(proposal, ":7", ":6", 1), 409)
		require.Equal(t, before, runtime.calls)
	})
	t.Run("changed tree invalidates publication", func(t *testing.T) {
		runtime.head = strings.Repeat("e", 40)
		runtime.tree = strings.Repeat("f", 40)
		call(t, token, "propose", proposal, 409)
		item, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
		require.NoError(t, err)
		require.False(t, item.CandidateVerified)
		require.Equal(t, head, item.PRHead)
		runtime.head = head
		runtime.tree = tree
		before := runtime.calls
		call(t, token, "propose", proposal, 409)
		require.Equal(t, before, runtime.calls)
	})

	t.Run("changed candidate waits for owning claim before generation allocation", func(t *testing.T) {
		runtime.head = strings.Repeat("e", 40)
		runtime.tree = strings.Repeat("f", 40)
		changed := repohost.WorkspaceSource{ChangeID: runtime.change, CommitID: runtime.head, TreeID: runtime.tree, ParentCommitIDs: []string{base}}
		body, err := json.Marshal(services.ReservedStackInput{RequestID: "33333333-3333-4333-8333-333333333333", Source: &changed})
		require.NoError(t, err)
		call(t, token, "candidate", string(body), 202)
		item, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
		require.NoError(t, err)
		require.EqualValues(t, 7, item.Generation)
		require.Equal(t, head, item.CandidateHead)
		require.False(t, item.CandidateVerified)
		var checks struct {
			Capture *services.MachineCapturePending `json:"capture"`
		}
		require.NoError(t, json.Unmarshal(item.Checks, &checks))
		require.NotNil(t, checks.Capture)
		require.Equal(t, runtime.head, checks.Capture.Head)
		require.Equal(t, repohost.WorkspaceSourceRef(row.ID, runtime.head), checks.Capture.SourceRef)
		pending, err := f.q.GetWorkspace(f.ctx, row.ID)
		require.NoError(t, err)
		require.NotEmpty(t, pending.CapturePending)
		beforeVersion := item.Version
		call(t, token, "candidate", string(body), 202)
		item, err = f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
		require.NoError(t, err)
		require.Equal(t, beforeVersion, item.Version)
	})
	t.Run("run replacement refuses before capture", func(t *testing.T) {
		_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='replacement' WHERE id=$1`, itemID)
		require.NoError(t, err)
		before := runtime.calls
		call(t, token, "candidate", request, 403)
		call(t, token, "propose", proposal, 403)
		require.Equal(t, before, runtime.calls)
	})
}
