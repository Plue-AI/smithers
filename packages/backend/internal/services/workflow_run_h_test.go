package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type workflowRunHQuerierOnly struct {
	WorkflowRunQuerier
}

// workflowRunHNoUpdaterQuerier hides the optional workflowRunCheckRunUpdater
// interface so the post-without-persist branch can be exercised.
type workflowRunHNoUpdaterQuerier struct {
	WorkflowRunQuerier
}

func TestWorkflowRun_H_DispatchForEventErrorBranches(t *testing.T) {
	ctx := context.Background()
	_, err := newCurrentPushTestService(&mockWorkflowRunQuerier{}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: 0,
		Event:        TriggerEvent{Type: "push"},
	})
	assert.Equal(t, 400, workflowRunAPIStatus(t, err))

	_, err = newCurrentPushTestService(&mockWorkflowRunQuerier{}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: 1,
		Event:        TriggerEvent{},
	})
	assert.Equal(t, 400, workflowRunAPIStatus(t, err))

	_, err = newCurrentPushTestService(nil).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: 1,
		Event:        TriggerEvent{Type: "push"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))

	defID := int64(9)
	_, err = newCurrentPushTestService(&mockWorkflowRunQuerier{
		getDefFn: func(context.Context, db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{}, errors.New("definition lookup failed")
		},
	}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID:         1,
		WorkflowDefinitionID: &defID,
		Event:                TriggerEvent{Type: "push"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))

	_, err = newCurrentPushTestService(&mockWorkflowRunQuerier{
		getDefFn: func(context.Context, db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{}, pgx.ErrNoRows
		},
	}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID:         1,
		WorkflowDefinitionID: &defID,
		Event:                TriggerEvent{Type: "push"},
	})
	assert.Equal(t, 404, workflowRunAPIStatus(t, err))

	_, err = newCurrentPushTestService(&mockWorkflowRunQuerier{
		ensureDefRefFn: func(context.Context, db.EnsureWorkflowDefinitionReferenceParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{}, errors.New("ensure failed")
		},
	}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID:         1,
		UseLoadedDefinitions: true,
		LoadedDefinitions: []LoadedWorkflowDefinition{{
			Name:   "ci",
			Path:   ".smithers/workflows/ci.tsx",
			Config: []byte(`{"on":{"push":{}}}`),
		}},
		Event: TriggerEvent{Type: "workflow_dispatch"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))

	_, err = newCurrentPushTestService(&mockWorkflowRunQuerier{
		listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return nil, errors.New("list failed")
		},
	}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: 1,
		Event:        TriggerEvent{Type: "push"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))

	_, err = newCurrentPushTestService(&mockWorkflowRunQuerier{
		getDefFn: func(context.Context, db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return makeWorkflowDef(1, 1, "bad", true, `{"on":`), nil
		},
	}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID:         1,
		WorkflowDefinitionID: &defID,
		Event:                TriggerEvent{Type: "push"},
	})
	assert.Equal(t, 422, workflowRunAPIStatus(t, err))

	_, err = newCurrentPushTestService(&mockWorkflowRunQuerier{
		getDefFn: func(context.Context, db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return makeWorkflowDef(1, 1, "manual", true, `{"on":{"push":{}}}`), nil
		},
	}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID:         1,
		WorkflowDefinitionID: &defID,
		Event:                TriggerEvent{Type: "workflow_dispatch"},
	})
	assert.Equal(t, 422, workflowRunAPIStatus(t, err))
}

func TestWorkflowRun_H_CreateRunForDefinitionBranches(t *testing.T) {
	ctx := context.Background()
	matchingDef := makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`)

	_, err := newCurrentPushTestService(&mockWorkflowRunQuerier{
		listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{matchingDef}, nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, errors.New("repo failed")
		},
	}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))

	_, err = newCurrentPushTestService(&mockWorkflowRunQuerier{
		listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{matchingDef}, nil
		},
		createRunFn: func(context.Context, db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, errors.New("create failed")
		},
	}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))

	cacheDef := makeWorkflowDef(5, 42, "cache", true, `{"on":{"push":{}},"jobs":{"build":{"cache":[{"action":"restore","key":"deps","paths":["vendor"]}]}}}`)
	q := &mockWorkflowRunQuerier{
		listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{cacheDef}, nil
		},
		createTaskFn: func(_ context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			var payload map[string]any
			require.NoError(t, json.Unmarshal(arg.Payload, &payload))
			assert.Contains(t, payload, "cache")
			return db.WorkflowTask{ID: 50, WorkflowStepID: arg.WorkflowStepID}, nil
		},
	}
	_, err = newCurrentPushTestService(q).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)

	// Malformed job configs are rejected up front instead of dispatching a
	// best-effort run with no steps.
	invalidJobsDef := makeWorkflowDef(2, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{"steps":"bad"}}}`)
	_, err = newCurrentPushTestService(&mockWorkflowRunQuerier{
		listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{invalidJobsDef}, nil
		},
	}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 400, workflowRunAPIStatus(t, err))

	_, err = newCurrentPushTestService(&mockWorkflowRunQuerier{
		listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(3, 42, "bad-if", true, `{"on":{"push":{}},"jobs":{"build":{"if":"bad syntax"}}}`),
			}, nil
		},
	}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 400, workflowRunAPIStatus(t, err))

	_, err = newCurrentPushTestService(&mockWorkflowRunQuerier{
		listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(4, 42, "cycle", true, `{"on":{"push":{}},"jobs":{"build":{"needs":["test"]},"test":{"needs":["build"]}}}`),
			}, nil
		},
	}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 400, workflowRunAPIStatus(t, err))

	_, err = newCurrentPushTestService(&mockWorkflowRunQuerier{
		listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{matchingDef}, nil
		},
		createStepFn: func(context.Context, db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
			return db.WorkflowStep{}, errors.New("step failed")
		},
	}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))

	_, err = newCurrentPushTestService(&mockWorkflowRunQuerier{
		listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{matchingDef}, nil
		},
		createTaskFn: func(context.Context, db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			return db.WorkflowTask{}, errors.New("task failed")
		},
	}).DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))
}

func TestWorkflowRun_H_CheckRunAndCommitStatusBranches(t *testing.T) {
	ctx := context.Background()
	def := makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}}}`)
	repo := db.Repository{ID: 42, Name: "Demo", UserID: pgtype.Int8{Int64: 7, Valid: true}}

	assert.Equal(t, "smithers / workflow", workflowCheckRunName(db.WorkflowDefinition{}))
	assert.Equal(t, "smithers/workflow", workflowCommitStatusContext("", ".tsx"))
	jobs, err := parseJobsFromConfig(nil)
	require.NoError(t, err)
	assert.Empty(t, jobs)

	params := pendingWorkflowCommitStatusParams(DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{CommitSHA: " abc123 ", ChangeID: " change-1 "},
	}, def, 99)
	assert.Equal(t, "abc123", params.CommitSha.String)
	assert.Equal(t, "change-1", params.ChangeID.String)
	assert.Equal(t, int64(99), params.WorkflowRunID.Int64)

	checks := &mockWorkflowRunCheckRunService{}
	svc := &workflowRunService{
		queries:         workflowRunHQuerierOnly{WorkflowRunQuerier: &mockWorkflowRunQuerier{}},
		checkRunService: checks,
	}
	svc.createInProgressCheckRun(ctx, db.WorkflowRun{ID: 1, Status: "queued", TriggerCommitSha: "abc"}, def, repo, "alice")
	assert.Empty(t, checks.postCalls)

	hResolver := func(id int64, err error) *mockRunnerInstallationResolver {
		return &mockRunnerInstallationResolver{resolveFn: func(context.Context, int64, int64, string, string) (int64, error) {
			return id, err
		}}
	}

	checks = &mockWorkflowRunCheckRunService{}
	svc = &workflowRunService{
		queries: workflowRunHNoUpdaterQuerier{
			WorkflowRunQuerier: &mockWorkflowRunQuerier{},
		},
		installationResolver: hResolver(44, nil),
		checkRunService:      checks,
	}
	svc.createInProgressCheckRun(ctx, db.WorkflowRun{ID: 2, Status: "running", TriggerCommitSha: "abc"}, def, repo, "alice")
	assert.Len(t, checks.postCalls, 1)

	checks = &mockWorkflowRunCheckRunService{}
	svc = NewWorkflowRunService(&mockWorkflowRunQuerier{},
		WithWorkflowRunGitHubCheckRunService(checks),
		WithWorkflowRunGitHubInstallationResolver(hResolver(0, errors.New("lookup failed"))),
	).(*workflowRunService)
	svc.createInProgressCheckRun(ctx, db.WorkflowRun{ID: 4, Status: "queued", TriggerCommitSha: "abc"}, def, repo, "alice")
	assert.Empty(t, checks.postCalls)

	q := &mockWorkflowRunQuerier{
		updateCheckRunFn: func(context.Context, db.UpdateWorkflowRunCheckRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, errors.New("persist check failed")
		},
	}
	checks = &mockWorkflowRunCheckRunService{
		postFn: func(context.Context, int64, string, string, GitHubCheckRunInput) (GitHubCheckRunResult, error) {
			return GitHubCheckRunResult{URL: "https://api.github/check-runs/1"}, nil
		},
	}
	svc = NewWorkflowRunService(q,
		WithWorkflowRunGitHubCheckRunService(checks),
		WithWorkflowRunGitHubInstallationResolver(hResolver(55, nil)),
	).(*workflowRunService)
	svc.createInProgressCheckRun(ctx, db.WorkflowRun{ID: 3, Status: "queued", TriggerCommitSha: "abc"}, def, repo, "alice")
	assert.Len(t, q.updateCheckRunCalls, 1)
	assert.True(t, q.updateCheckRunCalls[0].CheckRunUrl.Valid)
}

func TestWorkflowRun_H_CancelResumeAndRerunBranches(t *testing.T) {
	ctx := context.Background()

	assert.Equal(t, 500, workflowRunAPIStatus(t, NewWorkflowRunService(nil).CancelRun(ctx, 42, 7)))
	assert.Equal(t, 500, workflowRunAPIStatus(t, NewWorkflowRunService(nil).ResumeRun(ctx, 42, 7)))
	_, err := NewWorkflowRunService(nil).RerunRun(ctx, RerunInput{RepositoryID: 42, RunID: 7})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))

	assert.Equal(t, 404, workflowRunAPIStatus(t, NewWorkflowRunService(&mockWorkflowRunQuerier{
		getRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pgx.ErrNoRows
		},
	}).CancelRun(ctx, 42, 7)))

	assert.Equal(t, 500, workflowRunAPIStatus(t, NewWorkflowRunService(&mockWorkflowRunQuerier{
		getRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, errors.New("fetch failed")
		},
	}).CancelRun(ctx, 42, 7)))

	assert.Equal(t, 500, workflowRunAPIStatus(t, NewWorkflowRunService(&mockWorkflowRunQuerier{
		getRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 7, RepositoryID: 42, Status: "running"}, nil
		},
		cancelRunFn: func(context.Context, int64) error {
			return errors.New("cancel failed")
		},
	}).CancelRun(ctx, 42, 7)))

	writer := &mockWorkflowRunCommitStatusWriter{
		updateFn: func(context.Context, int64, string, string, string) (db.CommitStatus, error) {
			return db.CommitStatus{}, errors.New("status update failed")
		},
	}
	checks := &mockWorkflowRunCheckRunService{
		updateFn: func(context.Context, int64, string, string, int64, GitHubCheckRunUpdate) (GitHubCheckRunResult, error) {
			return GitHubCheckRunResult{}, errors.New("check update failed")
		},
	}
	q := &mockWorkflowRunQuerier{
		getRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID:           7,
				RepositoryID: 42,
				Status:       "running",
				CheckRunID:   pgtype.Int8{Int64: 123, Valid: true},
			}, nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 42, Name: "demo", UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{ID: 1, Username: "alice"}, nil
		},
	}
	err = NewWorkflowRunService(q, WithWorkflowRunCommitStatusWriter(writer), WithWorkflowRunGitHubCheckRunService(checks), WithWorkflowRunGitHubInstallationResolver(&mockRunnerInstallationResolver{
		resolveFn: func(context.Context, int64, int64, string, string) (int64, error) {
			return 99, nil
		},
	})).CancelRun(ctx, 42, 7)
	require.NoError(t, err)
	assert.Len(t, writer.updateCalls, 1)
	assert.Len(t, checks.updateCalls, 1)

	assert.Equal(t, 409, workflowRunAPIStatus(t, NewWorkflowRunService(&mockWorkflowRunQuerier{
		getRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 7, Status: "running"}, nil
		},
	}).ResumeRun(ctx, 42, 7)))

	assert.Equal(t, 500, workflowRunAPIStatus(t, NewWorkflowRunService(&mockWorkflowRunQuerier{
		getRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, errors.New("fetch failed")
		},
	}).ResumeRun(ctx, 42, 7)))

	for name, configure := range map[string]func(*mockWorkflowRunQuerier){
		"tasks": func(q *mockWorkflowRunQuerier) {
			q.resumeTasksFn = func(context.Context, int64) error { return errors.New("tasks failed") }
		},
		"steps": func(q *mockWorkflowRunQuerier) {
			q.resumeStepsFn = func(context.Context, int64) error { return errors.New("steps failed") }
		},
		"run": func(q *mockWorkflowRunQuerier) {
			q.resumeRunFn = func(context.Context, int64) error { return errors.New("run failed") }
		},
	} {
		t.Run("resume_"+name, func(t *testing.T) {
			q := &mockWorkflowRunQuerier{
				getRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
					return db.WorkflowRun{ID: 7, Status: "cancelled"}, nil
				},
			}
			configure(q)
			assert.Equal(t, 500, workflowRunAPIStatus(t, NewWorkflowRunService(q).ResumeRun(ctx, 42, 7)))
		})
	}

	_, err = NewWorkflowRunService(&mockWorkflowRunQuerier{
		getRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, errors.New("fetch failed")
		},
	}).RerunRun(ctx, RerunInput{RepositoryID: 42, RunID: 7})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))

	_, err = NewWorkflowRunService(&mockWorkflowRunQuerier{
		getRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 7, RepositoryID: 42, WorkflowDefinitionID: 5, Status: "failure"}, nil
		},
		getDefFn: func(context.Context, db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{}, errors.New("definition failed")
		},
	}).RerunRun(ctx, RerunInput{RepositoryID: 42, RunID: 7})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))

	_, err = NewWorkflowRunService(&mockWorkflowRunQuerier{
		getRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 7, RepositoryID: 42, WorkflowDefinitionID: 5, Status: "failure", TriggerEvent: "push", TriggerRef: "main", TriggerCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, nil
		},
		getDefFn: func(context.Context, db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return makeWorkflowDef(5, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`), nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, errors.New("repo failed")
		},
	}, WithWorkflowRunDefinitionCommitLoader(&recordingWorkflowDefinitionCommitLoader{result: workflowLoadResultForPath(".smithers/workflows/ci.tsx", `{"on":{"push":{}},"jobs":{"build":{}}}`)})).RerunRun(ctx, RerunInput{RepositoryID: 42, RunID: 7})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))
}

func TestWorkflowRun_H_CompleteGitHubCheckRunForCancellationBranches(t *testing.T) {
	ctx := context.Background()
	checks := &mockWorkflowRunCheckRunService{}
	run := db.WorkflowRun{ID: 7, RepositoryID: 42, CheckRunID: pgtype.Int8{Int64: 123, Valid: true}}

	svc := &workflowRunService{queries: &mockWorkflowRunQuerier{}}
	require.NoError(t, svc.completeGitHubCheckRunForCancellation(ctx, run))

	svc = &workflowRunService{
		queries:         workflowRunHQuerierOnly{WorkflowRunQuerier: &mockWorkflowRunQuerier{}},
		checkRunService: checks,
	}
	require.NoError(t, svc.completeGitHubCheckRunForCancellation(ctx, run))
	assert.Empty(t, checks.updateCalls)

	cancelResolver := func(id int64, resolveErr error) WorkflowRunServiceOption {
		return WithWorkflowRunGitHubInstallationResolver(&mockRunnerInstallationResolver{
			resolveFn: func(context.Context, int64, int64, string, string) (int64, error) {
				return id, resolveErr
			},
		})
	}

	svc = NewWorkflowRunService(&mockWorkflowRunQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, errors.New("repo failed")
		},
	}, WithWorkflowRunGitHubCheckRunService(checks), cancelResolver(99, nil)).(*workflowRunService)
	require.NoError(t, svc.completeGitHubCheckRunForCancellation(ctx, run))

	svc = NewWorkflowRunService(&mockWorkflowRunQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 42, Name: "   "}, nil
		},
	}, WithWorkflowRunGitHubCheckRunService(checks), cancelResolver(99, nil)).(*workflowRunService)
	require.NoError(t, svc.completeGitHubCheckRunForCancellation(ctx, run))

	svc = NewWorkflowRunService(&mockWorkflowRunQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 42, Name: "demo", UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{}, errors.New("user failed")
		},
	}, WithWorkflowRunGitHubCheckRunService(checks), cancelResolver(99, nil)).(*workflowRunService)
	require.NoError(t, svc.completeGitHubCheckRunForCancellation(ctx, run))

	svc = NewWorkflowRunService(&mockWorkflowRunQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 42, Name: "demo", UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{ID: 1, Username: "alice"}, nil
		},
	}, WithWorkflowRunGitHubCheckRunService(checks), cancelResolver(0, errors.New("not installed"))).(*workflowRunService)
	require.NoError(t, svc.completeGitHubCheckRunForCancellation(ctx, run))
}
