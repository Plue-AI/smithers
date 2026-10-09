package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The production issuer and installed router are real. Guest publication is
// substituted; this ledger does not qualify a microVM or guest ancestry.
func TestAccessMachineHeadGrantsComposedPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("composed install PostgreSQL campaign")
	}
	t.Setenv("SMITHERS_ACCESS_MACHINE_HEAD", "1")
	r := newRehearsal(t, "SMITHERS_ACCESS_MACHINE_HEAD", "C-ACC-01", "machine-head-")
	require.True(t, r.install("Machine head grants"))
	_, err := r.member("ben", 208, "admin")
	require.NoError(t, err)
	_, err = r.member("alice", 209, "write")
	require.NoError(t, err)
	q, ctx := db.New(r.pool), r.ctx
	repo, err := q.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: "rehearsal-owner", LowerName: "app"})
	require.NoError(t, err)
	for _, login := range []string{"rehearsal-owner", "ben", "alice"} {
		t.Run(login, func(t *testing.T) {
			user, err := q.GetUserByLowerUsername(ctx, login)
			require.NoError(t, err)
			create := func(name string) db.Workspace {
				w, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: user.ID, Name: name, TargetBookmark: "main", Kind: "container", Status: "running"})
				require.NoError(t, err)
				return w
			}
			own, foreign := create("head-own-"+login), create("head-foreign-"+login)
			runtime := &candidatePublisherRuntime{}
			issuer := services.NewWorkspaceService(q, services.WithWorkspaceInstallAuthorization(q), services.WithWorkspaceTransactions(r.pool), services.WithWorkspaceRuntime(runtime), services.WithWorkspaceGitBaseURL(r.origin))
			host := "head-host-" + login
			_, err = issuer.PrepareBoxHost(ctx, host, own.ID, repo.ID, user.ID)
			require.NoError(t, err)
			t.Cleanup(func() { issuer.RetireBoxHostCredential(ctx, host, user.ID) })
			token := runtime.token
			require.NotEmpty(t, token)
			digest := sha256.Sum256([]byte(token))
			hash := hex.EncodeToString(digest[:])
			stored, err := q.GetAuthInfoByTokenHash(ctx, hash)
			require.NoError(t, err)
			sample := 0
			initialBody := fmt.Sprintf(`{"change_id":%q,"commit_id":%q,"ahead":2,"behind":1}`, strings.Repeat("k", 32), strings.Repeat("a", 40))
			type response struct {
				out       *httptest.ResponseRecorder
				decisions []string
			}
			send := func(callCtx context.Context, workspace string) response {
				sample++
				body := initialBody
				if sample > 1 {
					body = fmt.Sprintf(`{"change_id":%q,"commit_id":%q,"ahead":2,"behind":1}`, strings.Repeat("k", 32), fmt.Sprintf("%040x", sample))
				}
				req := httptest.NewRequest("POST", r.origin+"/api/repos/rehearsal-owner/app/workspaces/"+workspace+"/head", strings.NewReader(body)).WithContext(callCtx)
				req.RemoteAddr = "127.0.0.1:50999"
				req.Header.Set("Authorization", "Bearer "+token)
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Smithers-Actor", "person")
				req.Header.Set("Smithers-Profile", "full")
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(c string) { decisions = append(decisions, c) }))
				out := httptest.NewRecorder()
				r.server.Config.Handler.ServeHTTP(out, req)
				return response{out, decisions}
			}
			call := func(t *testing.T, workspace string, status int) {
				t.Helper()
				result := send(ctx, workspace)
				out, decisions := result.out, result.decisions
				require.Equal(t, status, out.Code, out.Body.String())
				if status == 401 {
					require.Empty(t, decisions)
				} else {
					require.Equal(t, []string{"workspace.head"}, decisions)
				}
				if status == 403 {
					require.Contains(t, out.Body.String(), `"code":"permission"`)
				}
			}
			call(t, own.ID, 200)
			updated, err := q.GetWorkspace(ctx, own.ID)
			require.NoError(t, err)
			require.Equal(t, strings.Repeat("k", 32), updated.HeadChangeID)
			require.Equal(t, strings.Repeat("a", 40), updated.HeadCommitID)
			require.Equal(t, int32(2), updated.Ahead)
			require.Equal(t, int32(1), updated.Behind)
			for _, cell := range []struct {
				name, sql, restore string
				status             int
			}{
				{"missing-workspace", `UPDATE access_tokens SET scopes='write:repository,repo:'||($2::bigint)::text WHERE id=$1`, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, 403},
				{"missing-write", `UPDATE access_tokens SET scopes=replace(scopes,'write:repository','read:repository') WHERE id=$1`, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, 403},
				{"unrecorded-publisher", `UPDATE workspaces SET head_push_token_id=NULL WHERE id=$1`, `UPDATE workspaces SET head_push_token_id=$2 WHERE id=$1`, 403},
				{"expired", `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, `UPDATE access_tokens SET expires_at=now()+interval '1 hour' WHERE id=$1`, 401},
			} {
				t.Run(cell.name, func(t *testing.T) {
					if cell.name == "unrecorded-publisher" {
						_, err = r.pool.Exec(ctx, cell.sql, own.ID)
					} else if cell.name == "missing-workspace" {
						_, err = r.pool.Exec(ctx, cell.sql, stored.TokenID, repo.ID)
					} else {
						_, err = r.pool.Exec(ctx, cell.sql, stored.TokenID)
					}
					require.NoError(t, err)
					before, err := q.GetWorkspace(ctx, own.ID)
					require.NoError(t, err)
					call(t, own.ID, cell.status)
					after, err := q.GetWorkspace(ctx, own.ID)
					require.NoError(t, err)
					require.Equal(t, before, after)
					if cell.name == "unrecorded-publisher" {
						_, err = r.pool.Exec(ctx, cell.restore, own.ID, stored.TokenID)
					} else if cell.name == "expired" {
						_, err = r.pool.Exec(ctx, cell.restore, stored.TokenID)
					} else {
						_, err = r.pool.Exec(ctx, cell.restore, stored.TokenID, stored.TokenScopes)
					}
					require.NoError(t, err)
				})
			}
			before, err := q.GetWorkspace(ctx, foreign.ID)
			require.NoError(t, err)
			call(t, foreign.ID, 403)
			after, err := q.GetWorkspace(ctx, foreign.ID)
			require.NoError(t, err)
			require.Equal(t, before, after)
			// Admission is already bound when the report waits for the real write
			// fence. Committed death or publisher replacement must win that wait.
			transitions := []struct {
				name, change, restore string
				status                int
			}{
				{"expiry", `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, `UPDATE access_tokens SET expires_at=now()+interval '1 hour' WHERE id=$1`, 401},
				{"publisher-replacement", `UPDATE workspaces SET head_push_token_id=NULL WHERE id=$1`, `UPDATE workspaces SET head_push_token_id=$2 WHERE id=$1`, 403},
				{"workspace-deletion", `UPDATE workspaces SET deleted_at=now() WHERE id=$1`, `UPDATE workspaces SET deleted_at=NULL WHERE id=$1`, 403},
			}
			if user.ID != repo.UserID.Int64 {
				permission := "write"
				if login == "ben" {
					permission = "admin"
				}
				transitions = append(transitions,
					struct {
						name, change, restore string
						status                int
					}{"member-suspension", fmt.Sprintf(`UPDATE collaborators SET suspended_at=now() WHERE repository_id=%d AND user_id=$1`, repo.ID), fmt.Sprintf(`UPDATE collaborators SET suspended_at=NULL WHERE repository_id=%d AND user_id=$1`, repo.ID), 401},
					struct {
						name, change, restore string
						status                int
					}{"member-removal", fmt.Sprintf(`DELETE FROM collaborators WHERE repository_id=%d AND user_id=$1`, repo.ID), fmt.Sprintf(`INSERT INTO collaborators(repository_id,user_id,permission) VALUES(%d,$1,'%s')`, repo.ID, permission), 401})
			}
			nextSponsor, err := q.GetUserByLowerUsername(ctx, "alice")
			require.NoError(t, err)
			if nextSponsor.ID == user.ID {
				nextSponsor, err = q.GetUserByLowerUsername(ctx, "ben")
				require.NoError(t, err)
			}
			t.Run("stored-binding/other-sponsor", func(t *testing.T) {
				_, err := r.pool.Exec(ctx, `UPDATE workspaces SET user_id=$2 WHERE id=$1`, own.ID, nextSponsor.ID)
				require.NoError(t, err)
				defer func() {
					_, err := r.pool.Exec(ctx, `UPDATE workspaces SET user_id=$2 WHERE id=$1`, own.ID, user.ID)
					require.NoError(t, err)
				}()
				before, err := q.GetWorkspace(ctx, own.ID)
				require.NoError(t, err)
				call(t, own.ID, 403)
				after, err := q.GetWorkspace(ctx, own.ID)
				require.NoError(t, err)
				require.Equal(t, before, after)
			})
			t.Run("stored-binding/service-machine-sole-writer", func(t *testing.T) {
				machines, err := q.GetBranchMachineOwner(ctx)
				require.NoError(t, err)
				_, err = r.pool.Exec(ctx, `UPDATE workspaces SET user_id=$2 WHERE id=$1`, own.ID, machines)
				require.NoError(t, err)
				defer func() {
					_, err := r.pool.Exec(ctx, `DELETE FROM workspace_shares WHERE workspace_id=$1`, own.ID)
					require.NoError(t, err)
					_, err = r.pool.Exec(ctx, `UPDATE workspaces SET user_id=$2 WHERE id=$1`, own.ID, user.ID)
					require.NoError(t, err)
				}()
				_, err = r.pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id,owner_user_id,grantee_user_id,level) VALUES($1,$2,$3,'write')`, own.ID, machines, user.ID)
				require.NoError(t, err)
				call(t, own.ID, 200)
				_, err = r.pool.Exec(ctx, `UPDATE workspace_shares SET level='read' WHERE workspace_id=$1 AND grantee_user_id=$2`, own.ID, user.ID)
				require.NoError(t, err)
				before, err := q.GetWorkspace(ctx, own.ID)
				require.NoError(t, err)
				call(t, own.ID, 403)
				after, err := q.GetWorkspace(ctx, own.ID)
				require.NoError(t, err)
				require.Equal(t, before, after)
				_, err = r.pool.Exec(ctx, `UPDATE workspace_shares SET level='write' WHERE workspace_id=$1 AND grantee_user_id=$2`, own.ID, user.ID)
				require.NoError(t, err)
				_, err = r.pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id,owner_user_id,grantee_user_id,level) VALUES($1,$2,$3,'write')`, own.ID, machines, nextSponsor.ID)
				require.NoError(t, err)
				call(t, own.ID, 403)
				after, err = q.GetWorkspace(ctx, own.ID)
				require.NoError(t, err)
				require.Equal(t, before, after)
				_, err = r.pool.Exec(ctx, `DELETE FROM workspace_shares WHERE workspace_id=$1 AND grantee_user_id=$2`, own.ID, nextSponsor.ID)
				require.NoError(t, err)
				call(t, own.ID, 200)
			})
			transitions = append(transitions, struct {
				name, change, restore string
				status                int
			}{"workspace-transfer", fmt.Sprintf(`UPDATE workspaces SET user_id=%d WHERE id=$1`, nextSponsor.ID), fmt.Sprintf(`UPDATE workspaces SET user_id=%d WHERE id=$1`, user.ID), 403})
			for _, transition := range transitions {
				t.Run("write-fence/"+transition.name, func(t *testing.T) {
					key := any(stored.TokenID)
					if strings.HasPrefix(transition.name, "member-") {
						key = user.ID
					}
					if transition.name == "publisher-replacement" || transition.name == "workspace-deletion" || transition.name == "workspace-transfer" {
						key = own.ID
					}
					defer func() {
						var err error
						if transition.name == "publisher-replacement" {
							_, err = r.pool.Exec(ctx, transition.restore, key, stored.TokenID)
						} else {
							_, err = r.pool.Exec(ctx, transition.restore, key)
						}
						require.NoError(t, err)
					}()
					lock, err := r.pool.Begin(ctx)
					require.NoError(t, err)
					defer lock.Rollback(context.Background())
					_, err = lock.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, repo.ID)
					require.NoError(t, err)
					requestCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
					defer cancel()
					done := make(chan response, 1)
					go func() { done <- send(requestCtx, own.ID) }()
					require.Eventually(t, func() bool {
						var n int
						err := r.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT pg_advisory_xact_lock($1)'`).Scan(&n)
						return err == nil && n > 0
					}, 5*time.Second, 10*time.Millisecond)
					_, err = r.pool.Exec(ctx, transition.change, key)
					require.NoError(t, err)
					snapshot := func() string {
						var raw string
						require.NoError(t, r.pool.QueryRow(ctx, `SELECT to_jsonb(w)::text FROM workspaces w WHERE id=$1`, own.ID).Scan(&raw))
						return raw
					}
					before := snapshot()
					require.NoError(t, lock.Commit(ctx))
					result := <-done
					require.Equal(t, transition.status, result.out.Code, result.out.Body.String())
					require.Equal(t, []string{"workspace.head"}, result.decisions, "the captured admission is evaluated once")
					require.Contains(t, result.out.Body.String(), `"code":"`+map[bool]string{true: "unauthenticated", false: "permission"}[transition.status == 401]+`"`)
					require.Equal(t, before, snapshot(), "queued report cannot replace the head after a committed authority transition")
				})
			}
			call(t, own.ID, 200)
		})
	}
}
