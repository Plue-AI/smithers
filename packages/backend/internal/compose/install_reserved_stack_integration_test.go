package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
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
	store, err := jobs.NewStore(f.pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Error("admission must not contact the guest flow runtime")
		return nil, errors.New("runtime unavailable")
	})})
	require.NoError(t, err)
	service.SetOrchestration(nil, dispatcher, services.NewWorkspaceMythicalLanes(machine))
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
	t.Run("one decision cannot authorize substituted work", func(t *testing.T) {
		digest := sha256.Sum256([]byte(token))
		hash := hex.EncodeToString(digest[:])
		stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
		require.NoError(t, err)
		info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hash, RawScopes: stored.TokenScopes, Scopes: middleware.ParseTokenScopes(stored.TokenScopes)}
		for _, field := range []string{"request", "source", "proposal generation"} {
			t.Run(field, func(t *testing.T) {
				command, admitted := "stack.candidate", input
				if field == "proposal generation" {
					command = "stack.propose"
					admitted = services.ReservedStackInput{RequestID: input.RequestID, Generation: 7}
				}
				calls := 0
				ctx := services.WithAuthorizationObserver(middleware.ContextWithAuthInfo(f.ctx, info), func(string) { calls++ })
				subject, err := services.ResolveReservedStackSubject(ctx, f.q, f.repoID, row.ID)
				require.NoError(t, err)
				subject, err = services.BindReservedStackPayload(subject, command, admitted)
				require.NoError(t, err)
				decision, err := services.Authorize(ctx, f.q, command, subject)
				require.NoError(t, err)
				changed := admitted
				switch field {
				case "request":
					changed.RequestID = uuid.NewString()
				case "source":
					source := *admitted.Source
					source.CommitID = strings.Repeat("f", 40)
					changed.Source = &source
				case "proposal generation":
					changed.Generation++
				}
				before, reads := runtime.calls, objects.reads
				_, _, err = service.ReservedStackOperation(services.WithInstallAuthorization(ctx, command, decision, subject), f.repoID, row.ID, command, changed)
				var refused *services.AccessError
				require.ErrorAs(t, err, &refused)
				require.Equal(t, 403, refused.Status)
				require.Equal(t, 1, calls)
				require.Equal(t, before, runtime.calls)
				require.Equal(t, reads, objects.reads)
			})
		}
	})
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

	for _, provider := range []string{"verify launcher", "source reader", "guest runtime"} {
		t.Run("missing "+provider+" refuses before capture", func(t *testing.T) {
			defer service.SetOrchestration(nil, dispatcher, services.NewWorkspaceMythicalLanes(machine))
			switch provider {
			case "verify launcher":
				service.SetLauncher(nil)
			case "source reader":
				unavailable := services.NewWorkspaceService(f.q, services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceRuntime(runtime))
				service.SetOrchestration(nil, dispatcher, services.NewWorkspaceMythicalLanes(unavailable))
			case "guest runtime":
				unavailable := services.NewWorkspaceService(f.q, services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceSourceReader(objects))
				service.SetOrchestration(nil, dispatcher, services.NewWorkspaceMythicalLanes(unavailable))
			}
			before, reads := runtime.calls, objects.reads
			call(t, token, "candidate", request, 503)
			call(t, token, "candidate", string(raw), 503)
			require.Equal(t, before, runtime.calls)
			require.Equal(t, reads, objects.reads)
		})
	}
	t.Run("malformed source refuses before observation", func(t *testing.T) {
		before, reads := runtime.calls, objects.reads
		call(t, token, "candidate", strings.Replace(string(raw), tree, "invalid", 1), 400)
		require.Equal(t, before, runtime.calls)
		require.Equal(t, reads, objects.reads)
	})
	t.Run("consumed old-prefix source cannot become pending again", func(t *testing.T) {
		sealed := source
		sealed.CommitID = strings.Repeat("e", 40)
		body, err := json.Marshal(services.ReservedStackInput{RequestID: input.RequestID, Source: &sealed})
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET integration=jsonb_build_object('kind','captured','head',$2::text) WHERE id=$1`, itemID, sealed.CommitID)
		require.NoError(t, err)
		runtime.head, runtime.candidateTree = sealed.CommitID, strings.Repeat("f", 40)
		defer func() {
			runtime.head, runtime.candidateTree = head, tree
			_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET integration=NULL WHERE id=$1`, itemID)
			require.NoError(t, err)
		}()
		before, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
		require.NoError(t, err)
		reads := objects.reads
		call(t, token, "candidate", string(body), 409)
		after, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
		require.NoError(t, err)
		require.Equal(t, before.Version, after.Version)
		require.Equal(t, before.Generation, after.Generation)
		require.Equal(t, before.Checks, after.Checks)
		require.Equal(t, reads, objects.reads)
	})

	t.Run("first trusted attachment grants only the current host", func(t *testing.T) {
		hostID := uuid.NewString()
		_, err := f.pool.Exec(f.ctx, `INSERT INTO flow_runtime_host_bindings(id,tenant_id,principal_id,binding_kind,binding_id,repository_id,user_id,workspace_id,catalog_key,service_name,runtime_artifact_digest,source_revision,owner_generation,credential_ciphertext,credential_hash,state) VALUES($1,'fixture','fixture','mythical-item',$2,$3,$4,$5,'coding','fixture',$6,$7,1,'fixture',decode(repeat('00',32),'hex'),'running')`, hostID, itemID, f.repoID, f.owner.ID, row.ID, strings.Repeat("d", 64), base)
		require.NoError(t, err)
		scopes := strings.Join(append([]string{"write:repository", middleware.RepositoryRestrictionScope(f.repoID), middleware.LandingWorkspaceScope(row.ID)}, middleware.PathRestrictionScopes([]string{"**"})...), ",")
		older := f.token(f.owner, "old-host-"+hostID, scopes, true)
		_, err = f.pool.Exec(f.ctx, `UPDATE access_tokens SET name=$2,created_at=clock_timestamp()-interval '1 day' WHERE name=$1`, "old-host-"+hostID, "flow-host-landing-"+hostID)
		require.NoError(t, err)
		initial := f.token(f.owner, "flow-host-landing-"+hostID, scopes, true)
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET state='running',candidate_head='',candidate_base='',candidate_verified=false,pr_head='',request_run_id='',lane_started_at=clock_timestamp()-interval '1 second',checks=jsonb_set(jsonb_set(checks,'{run_attached}','false'),'{run_launched}','true') WHERE id=$1`, itemID)
		require.NoError(t, err)
		before := runtime.calls
		call(t, initial, "candidate", request, 403)
		projection, _ := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": itemID, "generation": 7, "attempt": 1, "phase": "todo", "flowDigest": strings.Repeat("d", 64), "flowSource": base})
		attachment := flowdispatch.ProjectionUpdate{State: jobs.StateRunning, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, FlowID: "todo", RunID: "current-run", ExecutionDigest: strings.Repeat("d", 64), Target: flowruntime.Target{WorkspaceID: row.ID, BindingKind: "mythical-item", BindingID: itemID}, Run: &flowruntime.FlowRuntimeRun{RunID: "current-run"}}}
		for _, mismatch := range []string{"retired", "other target", "other source"} {
			_, err = f.pool.Exec(f.ctx, `UPDATE flow_runtime_host_bindings SET state=CASE WHEN $2='retired' THEN 'retired' ELSE 'running' END,binding_id=CASE WHEN $2='other target' THEN 'other' ELSE $3 END,source_revision=CASE WHEN $2='other source' THEN repeat('e',40) ELSE $4 END WHERE id=$1`, hostID, mismatch, itemID, base)
			require.NoError(t, err)
			require.NoError(t, service.ProjectFlowRuntime(f.ctx, attachment))
			call(t, initial, "candidate", request, 403)
			_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='',checks=jsonb_set(checks,'{run_attached}','false') WHERE id=$1`, itemID)
			require.NoError(t, err)
		}
		_, err = f.pool.Exec(f.ctx, `UPDATE flow_runtime_host_bindings SET state='running',binding_id=$2,source_revision=$3 WHERE id=$1`, hostID, itemID, base)
		require.NoError(t, err)
		require.NoError(t, service.ProjectFlowRuntime(f.ctx, attachment))
		require.Equal(t, before, runtime.calls)
		call(t, initial, "candidate", request, 204)
		// Restore this fixture's seeded verified result after initial attachment.
		// Candidate generation/verification is proven by the owning-worker
		// PostgreSQL/Git campaign, not by this admission fixture.
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET state='proposed',candidate_head=$2,candidate_base=$3,candidate_verified=true,pr_head=$2 WHERE id=$1`, itemID, head, base)
		require.NoError(t, err)
		call(t, initial, "propose", proposal, 200)
		beforeOlder := runtime.calls
		call(t, older, "candidate", request, 403)
		require.Equal(t, beforeOlder, runtime.calls, "an older-attempt token gets no first-run grant")
		// Actual packaged native dispatch against this composed router. The
		// feature-enabled local helper substitutes provisioning only; no code
		// or branch artifact is installed or executed as root.
		if helper := os.Getenv("SMITHERS_STK12_NATIVE_HELPER"); helper != "" {
			server := httptest.NewUnstartedServer(nil)
			defer server.Close()
			nativeConfig := cfg
			nativeConfig.Server.PublicURL = "http://" + server.Listener.Addr().String()
			nativeConfig.Server.AllowedOrigins = []string{nativeConfig.Server.PublicURL}
			server.Config.Handler = githubAppSetupComposeRouter(nativeConfig, f.pool, nil, &routes.WorkspaceHandler{Service: machine}, routerExtras{Mythical: &routes.MythicalHandler{Service: service}})
			server.Start()
			directory := t.TempDir()
			configPath := filepath.Join(directory, "workspace-coding.json")
			config, _ := json.Marshal(map[string]any{"version": 1, "workspaceId": row.ID, "repositoryId": f.repoID, "actorId": f.owner.ID, "repositoryPath": directory, "repositorySlug": "gate-owner/app", "apiBaseUrl": server.URL + "/api", "gitUrl": server.URL + "/gate-owner/app.git", "credentialSocket": "/tmp/absent-native-credential"})
			require.NoError(t, os.WriteFile(configPath, config, 0600))
			root, err := filepath.Abs("../../../..")
			require.NoError(t, err)
			cmd := exec.CommandContext(t.Context(), "node", "--experimental-strip-types", filepath.Join(root, "flows/test/coding-reserved-install-rehearsal.mjs"))
			cmd.Env = append(os.Environ(), "SMITHERS_WORKSPACE_CODING_CONFIG="+configPath, "SMITHERS_NATIVE_REPOSITORY_TOKEN="+initial, "SMITHERS_STK12_REPOSITORY_PATH="+directory, "SMITHERS_STK12_NATIVE_HELPER="+helper)
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			output, err := cmd.Output()
			require.NoError(t, err, stderr.String())
			require.JSONEq(t, fmt.Sprintf(`{"generation":7,"head":%q}`, head), string(output))
			entries, err := os.ReadDir(directory)
			require.NoError(t, err)
			require.Len(t, entries, 1, "proposal never opens or locks the native repository")
			// Candidate traverses the same production Action and native provider,
			// sealing real JJ bytes. Only live guest observations and the source
			// object acknowledgment are fixtures; this is not microVM acceptance.
			init := exec.CommandContext(t.Context(), "jj", "git", "init", "--colocate")
			init.Dir = directory
			initOutput, err := init.CombinedOutput()
			require.NoError(t, err, string(initOutput))
			require.NoError(t, os.WriteFile(filepath.Join(directory, "MEMBER.md"), []byte("native candidate bytes\n"), 0600))
			snapshot := exec.CommandContext(t.Context(), "jj", "status")
			snapshot.Dir = directory
			snapshotOutput, err := snapshot.CombinedOutput()
			require.NoError(t, err, string(snapshotOutput))
			read := exec.CommandContext(t.Context(), helper, "--local")
			payload, _ := json.Marshal(map[string]any{"operation": "read", "repositoryPath": directory})
			read.Stdin = bytes.NewReader(payload)
			readOutput, err := read.Output()
			require.NoError(t, err)
			var observed struct {
				Head struct {
					TreeID string `json:"treeId"`
				} `json:"head"`
			}
			require.NoError(t, json.Unmarshal(readOutput, &observed))
			require.Len(t, observed.Head.TreeID, 40)
			runtime.tree, runtime.candidateTree = observed.Head.TreeID, observed.Head.TreeID
			defer func() { runtime.tree, runtime.candidateTree = tree, tree }()
			for range 2 {
				capture := exec.CommandContext(t.Context(), "node", "--experimental-strip-types", filepath.Join(root, "flows/test/coding-reserved-install-rehearsal.mjs"))
				capture.Env = append(cmd.Env, "SMITHERS_STK12_OPERATION=candidate")
				var stderr bytes.Buffer
				capture.Stderr = &stderr
				output, err := capture.Output()
				require.NoError(t, err, stderr.String())
				require.JSONEq(t, fmt.Sprintf(`{"generation":7,"base":%q,"head":%q}`, base, head), string(output))
			}
			item, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
			require.NoError(t, err)
			require.EqualValues(t, 7, item.Generation)
			require.True(t, item.CandidateVerified)
			require.Empty(t, item.PendingOp)
		}
		retained, _ := json.Marshal(map[string]any{"retain_source": source})
		req := httptest.NewRequest("POST", fmt.Sprintf("http://example.com/api/repos/gate-owner/app/workspaces/%s/head", row.ID), strings.NewReader(string(retained)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+initial)
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, 200, out.Code, out.Body.String())

		// Issuer attachment never selects a later run for an already-bound token.
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='replacement' WHERE id=$1`, itemID)
		require.NoError(t, err)
		before = runtime.calls
		call(t, initial, "propose", proposal, 403)
		require.Equal(t, before, runtime.calls)
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='current-run' WHERE id=$1`, itemID)
		require.NoError(t, err)
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

	t.Run("equal bytes after invalidation request fresh verification", func(t *testing.T) {
		// The previous case observed a change and then a reversion. That
		// cannot revive verification merely by returning the old generation.
		beforeReplay, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
		require.NoError(t, err)
		call(t, token, "candidate", string(raw), 200)
		replayed, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
		require.NoError(t, err)
		require.Equal(t, beforeReplay.Version, replayed.Version)
		require.False(t, replayed.CandidateVerified, "sealed-source replay does not revive its old verification")
		fresh := source
		fresh.CommitID = strings.Repeat("e", 40)
		body, err := json.Marshal(services.ReservedStackInput{RequestID: "55555555-5555-4555-8555-555555555555", Source: &fresh})
		require.NoError(t, err)
		call(t, token, "candidate", string(body), 202)
		item, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
		require.NoError(t, err)
		require.False(t, item.CandidateVerified)
		require.EqualValues(t, 7, item.Generation, "the owning worker allocates the next generation")
		var checks struct {
			Capture *services.MachineCapturePending `json:"capture"`
		}
		require.NoError(t, json.Unmarshal(item.Checks, &checks))
		require.NotNil(t, checks.Capture)
		require.Equal(t, fresh.CommitID, checks.Capture.Head)
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET checks=checks-'capture',state='verifying',verify_outcome='' WHERE id=$1`, itemID)
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET capture_pending=NULL WHERE id=$1`, row.ID)
		require.NoError(t, err)
		// Running checks already own this equal candidate; replay does not
		// consume another generation or schedule a second capture.
		before, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
		require.NoError(t, err)
		call(t, token, "candidate", string(raw), 200)
		after, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, 1)
		require.NoError(t, err)
		require.Equal(t, before.Version, after.Version)
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET state='integrating' WHERE id=$1`, itemID)
		require.NoError(t, err)
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
