package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

// The parent-scoped child launch is T-FLW-01's missing consumer contract.
// This qualifies its authorizer input, not a working install flow launch.
func TestInstallOwnRunFlowPolicyPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	ws, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "flow-parent", Kind: "container", Status: "running", TargetBookmark: "smithers/parent"})
	require.NoError(t, err)
	var number int64
	var generation int64
	require.NoError(t, f.pool.QueryRow(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,stack_position,title,workspace_id,request_run_id,owner_id,created_by,attempt) VALUES($1,'todo','running',1,'Parent flow',$2,'parent-run',$3,$3,1) RETURNING number,generation`, f.repoID, ws.ID, f.owner.ID).Scan(&number, &generation))
	scopes := "write:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.LandingWorkspaceScope(ws.ID) + "," + middleware.AgentSessionRestrictionScope("parent-run")
	token := f.token(f.owner, "child-flow-parent", scopes, true)
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
	require.NoError(t, err)
	info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hash, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
	subject := services.InstallSubject{RepositoryID: f.repoID, WorkspaceID: ws.ID, TodoNumber: number, RunID: "parent-run", Attempt: 1, Generation: generation, Resource: "flows/check/flow.ts", PayloadDigest: strings.Repeat("a", 64)}
	for _, name := range []string{"own", "unbound", "other workspace", "other run", "other attempt", "other generation", "no payload", "no flow", "system flow", "malformed flow", "malformed digest"} {
		t.Run(name, func(t *testing.T) {
			requested := subject
			switch name {
			case "unbound":
				requested = services.InstallSubject{}
			case "other workspace":
				requested.WorkspaceID = "00000000-0000-4000-8000-000000000001"
			case "other run":
				requested.RunID = "other-run"
			case "other attempt":
				requested.Attempt++
			case "other generation":
				requested.Generation++
			case "no payload":
				requested.PayloadDigest = ""
			case "no flow":
				requested.Resource = ""
			case "system flow":
				requested.Resource = "flows/merge/flow.ts"
			case "malformed flow":
				requested.Resource = "../../merge"
			case "malformed digest":
				requested.PayloadDigest = "not-a-digest"
			}
			count := 0
			ctx := services.WithAuthorizationObserver(middleware.ContextWithAuthInfo(f.ctx, info), func(string) { count++ })
			decision, err := services.Authorize(ctx, f.q, "flow.run", requested)
			if name == "own" {
				require.NoError(t, err)
				bound := services.WithInstallAuthorization(ctx, "flow.run", decision, requested)
				_, err = services.Authorize(bound, f.q, "flow.run", requested)
				require.NoError(t, err)
				changed := requested
				changed.PayloadDigest = strings.Repeat("b", 64)
				_, err = services.Authorize(bound, f.q, "flow.run", changed)
				require.Error(t, err)
			} else {
				var refused *services.AccessError
				require.ErrorAs(t, err, &refused)
				require.Equal(t, 403, refused.Status)
			}
			require.Equal(t, 1, count)
		})
	}
	for _, mutation := range []string{"paused", "stale attempt", "suspended workspace", "removed sponsor", "expired credential"} {
		t.Run(mutation, func(t *testing.T) {
			ctx := middleware.ContextWithAuthInfo(f.ctx, info)
			switch mutation {
			case "paused":
				_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET paused_at=now() WHERE repository_id=$1 AND number=$2`, f.repoID, number)
				defer f.pool.Exec(f.ctx, `UPDATE mythical_items SET paused_at=NULL WHERE repository_id=$1 AND number=$2`, f.repoID, number)
			case "stale attempt":
				_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='replacement',attempt=2 WHERE repository_id=$1 AND number=$2`, f.repoID, number)
				defer f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='parent-run',attempt=1 WHERE repository_id=$1 AND number=$2`, f.repoID, number)
			case "suspended workspace":
				_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET status='suspended' WHERE id=$1`, ws.ID)
				defer f.pool.Exec(f.ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, ws.ID)
			case "removed sponsor":
				_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$3 WHERE repository_id=$1 AND number=$2`, f.repoID, number, f.other.ID)
				defer f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$3 WHERE repository_id=$1 AND number=$2`, f.repoID, number, f.owner.ID)
			case "expired credential":
				_, err = f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, stored.TokenID)
			}
			require.NoError(t, err)
			_, err = services.Authorize(ctx, f.q, "flow.run", subject)
			var refused *services.AccessError
			require.ErrorAs(t, err, &refused)
			status := 403
			if mutation == "expired credential" {
				status = 401
			}
			require.Equal(t, status, refused.Status)
		})
	}
}
