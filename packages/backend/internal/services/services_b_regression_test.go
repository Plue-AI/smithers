package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
)

func TestRegressionResumeOutagePreservesDisk(t *testing.T) {
	pool := newProductTestPool(t)
	for _, code := range []int{500, 502, 504, 0} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			ws := sampleDBWorkspace("ws-1")
			ws.Status = "suspended"
			deletes, creates, starts, resets := 0, 0, 0, 0
			q := &mockWorkspaceQuerier{updateWorkspaceExecutionInfoFn: func(context.Context, db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
				resets++
				return ws, nil
			}}
			// The wake passes machine admission and the activation providers
			// (c240bd3cf7, #3568) before the controller is asked to start.
			svc := composeHostedSandboxWake(newWorkspaceServiceForTests(ownerlessWorkspaceQuerier{q, noBranchMachineOwner{}}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
				getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
					return sandbox.Sandbox{State: sandbox.StateStopped}, nil
				},
				startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
					starts++
					if code == 0 {
						return sandbox.StartResult{}, context.DeadlineExceeded
					}
					return sandbox.StartResult{}, &sandbox.StatusError{StatusCode: code}
				},
				deleteVMFn: func(context.Context, string) error { deletes++; return nil },
				createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
					creates++
					return sandbox.CreateResult{}, errors.New("unexpected replacement")
				},
			})), pool)
			got, err := svc.ensureWorkspaceRunning(context.Background(), ws, CreateWorkspaceSessionInput{RepositoryID: 101, UserID: 1, RepoOwner: "alice", RepoName: "repo"})
			require.Zero(t, deletes)
			require.Zero(t, creates)
			require.Zero(t, resets)
			require.Equal(t, ws.VmID, got.VmID)
			var api *pkgerrors.APIError
			require.ErrorAs(t, err, &api)
			require.Equal(t, 503, api.Status)
			require.Positive(t, api.RetryAfter)
			if code != 0 {
				require.Equal(t, 2, starts)
			}
		})
	}
}

func TestRegressionProvisionFailureSettlesSession(t *testing.T) {
	for _, mode := range []string{"timeout", "panic", "mark-running"} {
		t.Run(mode, func(t *testing.T) {
			settled := false
			q := &mockWorkspaceQuerier{failActiveWorkspaceSessionFn: func(ctx context.Context, id string) (db.WorkspaceSession, error) {
				if err := ctx.Err(); err != nil {
					return db.WorkspaceSession{}, err
				}
				settled = true
				return workspaceExecHSession(id, "ws-1", 1, "failed"), nil
			}, markWorkspaceSessionRunningFn: func(context.Context, string) (db.WorkspaceSession, error) {
				return db.WorkspaceSession{}, errors.New("write failed")
			}}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{getVMFn: func(ctx context.Context, id string) (sandbox.Sandbox, error) {
				if mode == "panic" {
					panic("provisioning panic")
				}
				if mode == "timeout" {
					return sandbox.Sandbox{}, ctx.Err()
				}
				return sandbox.Sandbox{ID: id, State: sandbox.StateRunning}, nil
			}}))
			input := CreateWorkspaceSessionInput{WorkspaceID: "ws-1", RepositoryID: 101, UserID: 1}
			if mode == "panic" {
				_, err := svc.CreateSession(context.Background(), input)
				require.Error(t, err)
			} else {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				if mode == "timeout" {
					cancel()
				}
				_, err := svc.finishWorkspaceSessionProvisioning(ctx, workspaceExecHSession("session", "ws-1", 1, "pending"), sampleDBWorkspace("ws-1"), input, 80, 24)
				require.Error(t, err)
			}
			require.True(t, settled, "durable session must terminate")
		})
	}
}

func TestRegressionSearchRenameAndCopy(t *testing.T) {
	for _, kind := range []string{"renamed", "copied"} {
		t.Run(kind, func(t *testing.T) {
			q := newFakeSearchIndexQueries(true)
			host := &fakeSearchIndexRepoHost{diff: repohost.ChangeDiff{FileDiffs: []repohost.FileDiff{{Path: "new.go", OldPath: "old.go", ChangeType: kind}}}}
			require.NoError(t, NewSearchIndexer(q, host).IndexPush(context.Background(), defaultSearchIndexInput()))
			upserts, deletes := q.snapshot()
			require.Len(t, upserts, 1)
			require.Equal(t, "new.go", upserts[0].FilePath)
			require.Equal(t, "content for new.go", upserts[0].Content)
			if kind == "renamed" {
				require.Equal(t, []db.DeleteCodeSearchDocumentByPathParams{{RepositoryID: 41, FilePath: "old.go"}}, deletes)
			} else {
				require.Empty(t, deletes)
			}
			documents := map[string]string{"old.go": "original content"}
			for _, deleted := range deletes {
				delete(documents, deleted.FilePath)
			}
			for _, updated := range upserts {
				documents[updated.FilePath] = updated.Content
			}
			require.Equal(t, "content for new.go", documents["new.go"])
			if kind == "copied" {
				require.Equal(t, "original content", documents["old.go"])
			} else {
				require.NotContains(t, documents, "old.go")
			}
			require.Equal(t, "abc123", q.indexedCommit)
		})
	}
}

func TestRegressionMentionUsesExactSource(t *testing.T) {
	for _, kind := range []string{"issue", "landing"} {
		t.Run(kind, func(t *testing.T) {
			var created db.Notification
			nq := &mockNotificationQuerier{
				createFn: func(_ context.Context, a db.CreateNotificationParams) (db.Notification, error) {
					created = db.Notification{ID: 1, UserID: a.UserID, SourceID: a.SourceID, SourceType: a.SourceType}
					return created, nil
				},
				getIssueByIDFn: func(context.Context, int64) (db.Issue, error) { return db.Issue{ID: 7, RepositoryID: 1}, nil },
				getLandingByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
					return db.LandingRequest{ID: 7, RepositoryID: 2}, nil
				},
				getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
					return db.Repository{ID: id, IsPublic: (kind == "issue" && id == 1) || (kind == "landing" && id == 2)}, nil
				},
			}
			ns := NewNotificationService(nq)
			mq := &mockMentionQuerier{getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) { return db.User{ID: 55}, nil }}
			mc := MentionContext{RepositoryID: 1}
			if kind == "issue" {
				mc.IssueID = pgtype.Int8{Int64: 7, Valid: true}
			} else {
				mc.LandingRequestID = pgtype.Int8{Int64: 7, Valid: true}
			}
			require.NoError(t, NewMentionService(mq, ns).ProcessMentions(context.Background(), "@alice", mc, "mentioned"))
			visible, err := ns.filterReadableNotifications(context.Background(), 55, []db.Notification{created})
			require.NoError(t, err)
			require.Len(t, visible, 1)
			require.Equal(t, "mention_"+kind, created.SourceType)
		})
	}
}

func TestRegressionRerunUsesOriginalCommitDefinition(t *testing.T) {
	for _, removed := range []bool{false, true} {
		t.Run(fmt.Sprint(removed), func(t *testing.T) {
			def := makeWorkflowDef(10, 42, "ci", !removed, `{"on":{"push":{}},"jobs":{"new-command":{}}}`)
			q := &mockWorkflowRunQuerier{getRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
				return db.WorkflowRun{ID: 1, RepositoryID: 42, WorkflowDefinitionID: 10, TriggerEvent: "push", TriggerCommitSha: strings.Repeat("a", 40)}, nil
			}, getDefFn: func(context.Context, db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) { return def, nil }}
			loader := &recordingWorkflowDefinitionCommitLoader{result: workflowLoadResultForPath(def.Path, `{"on":{"push":{}},"jobs":{"old-command":{}}}`)}
			_, err := NewWorkflowRunService(q, WithWorkflowRunDefinitionCommitLoader(loader)).RerunRun(context.Background(), RerunInput{RunID: 1, RepositoryID: 42})
			require.NoError(t, err)
			require.Len(t, loader.calls, 1)
			require.Equal(t, strings.Repeat("a", 40), loader.calls[0].commitSHA)
			require.Len(t, q.createTaskCalls, 1)
			require.Contains(t, string(q.createTaskCalls[0].Payload), "old-command")
			require.NotContains(t, string(q.createTaskCalls[0].Payload), "new-command")
			require.Equal(t, strings.Repeat("a", 40), q.createRunCalls[0].TriggerCommitSha)
		})
	}
}

type refreshFunc func(context.Context, string, string) (RefreshedTokens, error)

func (f refreshFunc) Refresh(c context.Context, p, r string) (RefreshedTokens, error) {
	return f(c, p, r)
}

func TestRegressionRefreshLeaseProtectsInteractiveRefresh(t *testing.T) {
	for _, mode := range []string{"worker-manual", "dispatch-dispatch"} {
		t.Run(mode, func(t *testing.T) {
			q := newFakePCQ()
			calls := 0
			svc := newPCService(q, nil)
			actor := &db.User{ID: 7}
			connection, err := svc.ConnectForUser(context.Background(), actor, ConnectProviderInput{Provider: "codex", AccessToken: "old", RefreshToken: "refresh", AccountID: "account"})
			require.NoError(t, err)
			row := q.rows[connection.ID]
			row.AccessExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-time.Minute), Valid: true}
			row.NextRefreshAt = pgtype.Timestamptz{}
			q.rows[row.ID] = row
			svc.refresher = refreshFunc(func(ctx context.Context, _, _ string) (RefreshedTokens, error) {
				calls++
				if calls > 1 {
					return RefreshedTokens{}, ErrProviderRefreshInvalidGrant
				}
				if mode == "worker-manual" {
					_, err = svc.RefreshNow(ctx, actor, row.ID)
				} else {
					_, err = svc.materialize(ctx, q.rows[row.ID])
				}
				require.Error(t, err, "a claimed connection must not start another exchange")
				return RefreshedTokens{AccessToken: "new", RefreshToken: "rotated", ExpiresAt: time.Now().Add(time.Hour)}, nil
			})
			if mode == "worker-manual" {
				_, err = svc.RefreshDue(context.Background())
			} else {
				_, err = svc.materialize(context.Background(), row)
			}
			require.NoError(t, err)
			require.Equal(t, 1, calls)
			require.Equal(t, "active", q.rows[row.ID].State)
			require.Equal(t, "enc:new", string(q.rows[row.ID].AccessTokenEncrypted))
		})
	}
}

func TestRegressionStaleRefreshResultCannotOverwriteNewGeneration(t *testing.T) {
	for _, failure := range []bool{false, true} {
		t.Run(fmt.Sprint(failure), func(t *testing.T) {
			q := newFakePCQ()
			svc := newPCService(q, nil)
			connection, err := svc.ConnectForUser(context.Background(), &db.User{ID: 7}, ConnectProviderInput{Provider: "codex", AccessToken: "old", RefreshToken: "refresh", AccountID: "account"})
			require.NoError(t, err)
			row := q.rows[connection.ID]
			row.AccessExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-time.Minute), Valid: true}
			row.NextRefreshAt = pgtype.Timestamptz{}
			q.rows[row.ID] = row
			calls := 0
			svc.refresher = refreshFunc(func(ctx context.Context, _, _ string) (RefreshedTokens, error) {
				calls++
				if calls == 1 {
					current := q.rows[row.ID]
					current.RefreshLeaseUntil = pgtype.Timestamptz{}
					q.rows[row.ID] = current
					refreshed, err := svc.RefreshDue(ctx)
					require.NoError(t, err)
					require.True(t, refreshed)
					if failure {
						return RefreshedTokens{}, ErrProviderRefreshInvalidGrant
					}
					return RefreshedTokens{AccessToken: "stale", RefreshToken: "stale"}, nil
				}
				return RefreshedTokens{AccessToken: "new", RefreshToken: "rotated", ExpiresAt: time.Now().Add(time.Hour)}, nil
			})
			_, err = svc.RefreshDue(context.Background())
			require.NoError(t, err)
			require.Equal(t, "active", q.rows[row.ID].State)
			require.Equal(t, "enc:new", string(q.rows[row.ID].AccessTokenEncrypted))
		})
	}
}

type deleteFailingSearchQueries struct{ *fakeSearchIndexQueries }

func (q deleteFailingSearchQueries) DeleteCodeSearchDocumentByPath(context.Context, db.DeleteCodeSearchDocumentByPathParams) error {
	return errors.New("delete failed")
}
func TestRegressionRenameFailurePreservesWatermark(t *testing.T) {
	q := newFakeSearchIndexQueries(true)
	q.indexedCommit = "old-commit"
	host := &fakeSearchIndexRepoHost{diff: repohost.ChangeDiff{FileDiffs: []repohost.FileDiff{{Path: "new.go", OldPath: "old.go", ChangeType: "renamed"}}}}
	require.Error(t, NewSearchIndexer(deleteFailingSearchQueries{q}, host).IndexPush(context.Background(), defaultSearchIndexInput()))
	require.Equal(t, "old-commit", q.indexedCommit)
}

func TestRegressionSessionFailureNotificationRequiresDurableWrite(t *testing.T) {
	notified := false
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		failActiveWorkspaceSessionFn: func(context.Context, string) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, errors.New("database unavailable")
		},
		notifyWorkspaceStatusFn: func(context.Context, db.NotifyWorkspaceStatusParams) error { notified = true; return nil },
	})
	svc.failWorkspaceSession(context.Background(), "session")
	require.False(t, notified)
}
