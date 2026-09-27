package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

func repositoryJobTestInput() RegisterRepositoryJobInput {
	return RegisterRepositoryJobInput{Repo: "owner/repo", WorkspaceID: uuid.NewString(), FlowID: "repository-jobs/issues",
		Revision: 1, Digest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40), ExecutionDigest: strings.Repeat("c", 64),
		Envelope: json.RawMessage(`{"capabilities":["read","write"],"flows":["repository-jobs/issues"],"budget":{"tokens":12000,"milliseconds":600000}}`),
		Mode:     "enabled", Events: []RepositoryJobEventRule{{Type: "issues", Actions: []string{"opened", "edited"}}, {Type: "issue_comment", Actions: []string{"created"}}},
		Input: json.RawMessage(`{"steps":[{"id":"triage","mode":"automatic"}],"scope":"future"}`)}
}

func TestRepositoryJobValidation(t *testing.T) {
	t.Parallel()
	for name, edit := range map[string]func(*RegisterRepositoryJobInput){
		"workspace":  func(i *RegisterRepositoryJobInput) { i.WorkspaceID = "other" },
		"source":     func(i *RegisterRepositoryJobInput) { i.SourceRevision = "main" },
		"candidate":  func(i *RegisterRepositoryJobInput) { i.Digest = "approved" },
		"executable": func(i *RegisterRepositoryJobInput) { i.ExecutionDigest = "current" },
		"unlimited": func(i *RegisterRepositoryJobInput) {
			i.Envelope = json.RawMessage(`{"capabilities":[],"flows":[],"budget":{}}`)
		},
		"trial source":   func(i *RegisterRepositoryJobInput) { i.Mode = "trial"; i.TrialIssueNumber = 1 },
		"trial wildcard": func(i *RegisterRepositoryJobInput) { i.Mode = "trial"; i.TrialSource = "github" },
		"trial cron": func(i *RegisterRepositoryJobInput) {
			i.Mode = "trial"
			i.TrialSource = "github"
			i.TrialIssueNumber = 1
			i.Schedule = "0 0 * * *"
		},
		"enabled trial scope": func(i *RegisterRepositoryJobInput) { i.TrialIssueNumber = 1 },
		"unsupported event":   func(i *RegisterRepositoryJobInput) { i.Events = []RepositoryJobEventRule{{Type: "installation"}} },
		"cron timezone":       func(i *RegisterRepositoryJobInput) { i.Schedule = "CRON_TZ=America/Los_Angeles 0 0 * * *" },
	} {
		t.Run(name, func(t *testing.T) {
			input := repositoryJobTestInput()
			edit(&input)
			_, err := validateRepositoryJob("issues", input, time.Now())
			require.Error(t, err)
		})
	}
	input := repositoryJobTestInput()
	_, err := validateRepositoryJob("issues", input, time.Now())
	require.NoError(t, err)
	input.Schedule = "0 9 * * *"
	next, err := validateRepositoryJob("chores", input, time.Date(2026, 9, 16, 10, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.Equal(t, time.Date(2026, 9, 17, 9, 0, 0, 0, time.UTC), next.Time)
	input.Schedule = "CRON_TZ=America/Los_Angeles 0 9 * * *"
	_, err = validateRepositoryJob("chores", input, time.Now())
	require.ErrorContains(t, err, "UTC")
	input.Mode = "trial"
	input.Schedule = ""
	input.TrialIssueNumber = 7
	input.TrialSource = "smithers-cloud"
	_, err = validateRepositoryJob("issues", input, time.Now())
	require.NoError(t, err)
}

func TestRepositoryJobEventMatching(t *testing.T) {
	t.Parallel()
	input := repositoryJobTestInput()
	event := db.RepositoryJobEvent{EventType: "issue", EventAction: "opened", Payload: json.RawMessage(`{"issue":{"author_association":"OWNER","labels":[{"name":"auto"}]}}`)}
	require.False(t, repositoryJobMatches(input, event), "no one said a maintainer wrote the text")
	event.Payload = json.RawMessage(`{"issue":{"author_association":"OWNER","smithers_text_by_maintainer":true,"labels":[{"name":"auto"}]}}`)
	require.True(t, repositoryJobMatches(input, event))
	input.Events = nil
	require.False(t, repositoryJobMatches(input, event))
	input = repositoryJobTestInput()
	input.Label = "auto"
	require.True(t, repositoryJobMatches(input, event))
	input.Label = "other"
	require.False(t, repositoryJobMatches(input, event))
	input.Mode = "trial"
	require.True(t, repositoryJobMatches(input, event))
	event.EventAction = "closed"
	require.False(t, repositoryJobMatches(input, event))
}

// A stranger's issue matches a job only through the job's trigger label (its
// configured label, else smithers) applied by a maintainer person
// (smithers_applied_by_maintainer), on the labeled text.
func TestRepositoryJobStrangerIssueNeedsTheTriggerLabel(t *testing.T) {
	t.Parallel()
	stranger := func(action, applied string, byMaintainer bool, labels ...string) db.RepositoryJobEvent {
		names := make([]map[string]string, 0, len(labels))
		for _, label := range labels {
			names = append(names, map[string]string{"name": label})
		}
		payload, err := json.Marshal(map[string]interface{}{
			"action": action, "label": map[string]interface{}{"name": applied, "smithers_applied_by_maintainer": byMaintainer},
			"sender": map[string]interface{}{"id": 7, "login": "maintainer", "type": "User"},
			"issue": map[string]interface{}{"number": 4, "author_association": "NONE", "labels": names, "body": "text",
				"user": map[string]interface{}{"id": 9, "login": "stranger"}},
		})
		require.NoError(t, err)
		return db.RepositoryJobEvent{Source: "github", EventType: "issues", EventAction: action, IssueNumber: 4, Payload: payload}
	}
	future := repositoryJobTestInput()
	future.Events = []RepositoryJobEventRule{{Type: "issues", Actions: []string{"opened", "edited", "reopened", "labeled", "assigned"}}}
	require.False(t, repositoryJobMatches(future, stranger("opened", "", true)))
	require.False(t, repositoryJobMatches(future, stranger("labeled", "invalid", true, "invalid")), "any label is not approval")
	require.False(t, repositoryJobMatches(future, stranger("labeled", "invalid", true, "invalid", "smithers")), "a later label is not approval")
	require.False(t, repositoryJobMatches(future, stranger("assigned", "", true, "smithers")))
	require.False(t, repositoryJobMatches(future, stranger("labeled", "smithers", false, "smithers")), "an app, a triage user or the stranger")
	require.True(t, repositoryJobMatches(future, stranger("labeled", "smithers", true, "smithers")))

	labeled := future
	labeled.Label = "auto"
	require.True(t, repositoryJobMatches(labeled, stranger("labeled", "auto", true, "auto")))
	require.False(t, repositoryJobMatches(labeled, stranger("labeled", "invalid", true, "auto", "invalid")))
	require.False(t, repositoryJobMatches(labeled, stranger("labeled", "smithers", true, "smithers")), "the job's own label is its trigger")

	trial := future
	trial.Mode, trial.TrialIssueNumber, trial.TrialSource = "trial", 4, "github"
	require.True(t, repositoryJobMatches(trial, stranger("opened", "", true)), "the registration scopes its own trial issue")
	other := stranger("labeled", "invalid", true, "invalid")
	other.IssueNumber = 5
	require.False(t, repositoryJobMatches(trial, other))
}

func TestRepositoryJobTrialAuthorityComesFromRegistration(t *testing.T) {
	t.Parallel()
	claim := db.RepositoryJobDispatch{Source: "smithers-cloud", IssueNumber: 12, Payload: json.RawMessage(`{"trial":true}`)}
	registration := db.RepositoryJobRegistration{Mode: "enabled", TrialSource: "smithers-cloud", TrialIssueNumber: 12}
	require.NotContains(t, repositoryJobDispatchEvent(registration, claim), "trial")
	registration.Mode = "trial"
	require.Equal(t, true, repositoryJobDispatchEvent(registration, claim)["trial"])
	claim.Source = "github"
	require.NotContains(t, repositoryJobDispatchEvent(registration, claim), "trial")
	claim.Source = "smithers-cloud"
	claim.IssueNumber = 13
	require.NotContains(t, repositoryJobDispatchEvent(registration, claim), "trial")
}

type repositoryJobTestGateway struct {
	t                  *testing.T
	target             BoxHostTarget
	config             RegisterRepositoryJobInput
	service            *RepositoryJobService
	calls              []string
	inputs             []json.RawMessage
	runs               map[string]string
	launches           map[string]flowdispatch.LaunchRequest
	pendingLaunches    []flowdispatch.LaunchRequest
	pendingSignals     []flowdispatch.SignalRequest
	dropRunOnce        bool
	dropSignalOnce     bool
	lostSignalOnce     bool
	terminalSignalOnce bool
	signalKeys         []string
	executionDigest    string
	cancelled          map[string]bool
}

func (g *repositoryJobTestGateway) AuthorizeHostCallback(_ context.Context, id, bearer string) (BoxHostTarget, error) {
	if id != "gateway" || bearer != "token" {
		return BoxHostTarget{}, fmt.Errorf("unauthorized fixture")
	}
	return g.target, nil
}
func (g *repositoryJobTestGateway) Admit(_ context.Context, request flowdispatch.LaunchRequest) (jobs.RequestReceipt, error) {
	g.calls = append(g.calls, "Admit")
	if g.launches == nil {
		g.launches = map[string]flowdispatch.LaunchRequest{}
	}
	if g.runs == nil {
		g.runs = map[string]string{}
	}
	if _, exists := g.launches[request.RequestID]; !exists {
		g.launches[request.RequestID] = request
		g.inputs = append(g.inputs, request.Payload)
	}
	g.pendingLaunches = append(g.pendingLaunches, request)
	return jobs.RequestReceipt{OperationID: "operation-" + request.RequestID, RequestID: request.RequestID, Kind: flowdispatch.OperationLaunch, State: jobs.StateAccepted}, nil
}

func (g *repositoryJobTestGateway) Approve(_ context.Context, _ jobs.Scope, launchOperationID, requestID string, _ json.RawMessage) (jobs.RequestReceipt, error) {
	g.calls = append(g.calls, "Approve")
	return jobs.RequestReceipt{OperationID: "approval-" + launchOperationID, RequestID: requestID, Kind: flowdispatch.OperationApprove, State: jobs.StateAccepted}, nil
}

func (g *repositoryJobTestGateway) Signal(_ context.Context, request flowdispatch.SignalRequest) (jobs.RequestReceipt, error) {
	g.calls = append(g.calls, "Signal")
	g.signalKeys = append(g.signalKeys, request.RequestID)
	g.pendingSignals = append(g.pendingSignals, request)
	return jobs.RequestReceipt{OperationID: "operation-" + request.RequestID, RequestID: request.RequestID, Kind: flowdispatch.OperationSignal, State: jobs.StateAccepted}, nil
}

func (g *repositoryJobTestGateway) CancelRequest(_ context.Context, _ jobs.Scope, requestID string) (jobs.Operation, error) {
	g.calls = append(g.calls, "Cancel")
	if _, exists := g.launches[requestID]; !exists {
		return jobs.Operation{}, jobs.ErrNotFound
	}
	if g.cancelled == nil {
		g.cancelled = map[string]bool{}
	}
	g.cancelled[requestID] = true
	return jobs.Operation{RequestID: requestID, State: jobs.StateWaiting, CancellationRequested: true}, nil
}

func (g *repositoryJobTestGateway) projectPending(ctx context.Context) error {
	launches, signals := g.pendingLaunches, g.pendingSignals
	g.pendingLaunches, g.pendingSignals = nil, nil
	for _, request := range launches {
		if g.dropRunOnce {
			g.dropRunOnce = false
			g.runs[request.RequestID] = "run-" + uuid.NewString()
			continue
		}
		target := request.Target
		target.TenantID, target.PrincipalID = request.Scope.TenantID, request.Scope.PrincipalID
		planDigest := strings.Repeat("e", 64)
		if !strings.HasPrefix(g.config.FlowID, "repository-jobs/") && g.config.ApprovedPlanDigest != "" {
			planDigest = g.config.ApprovedPlanDigest
		}
		executionDigest := g.config.ExecutionDigest
		if g.executionDigest != "" {
			executionDigest = g.executionDigest
		}
		planID := "plan-" + request.RequestID
		approval, _ := json.Marshal(map[string]any{"target": map[string]any{
			"_tag": "Plan", "planId": planID, "digest": planDigest, "envelope": g.config.Envelope,
		}, "scope": "once", "idempotencyKey": request.RequestID + ":approve"})
		checkpoint := flowdispatch.RuntimeCheckpoint{Version: 1, Target: target, FlowID: request.FlowID,
			Projection: request.Projection, PlanID: planID, PlanDigest: planDigest,
			ExecutionDigest: executionDigest, Envelope: g.config.Envelope, Approval: approval}
		update := flowdispatch.ProjectionUpdate{OperationID: "operation-" + request.RequestID, Scope: request.Scope, State: jobs.StateWaiting, Checkpoint: checkpoint}
		if err := g.service.ProjectFlowRuntime(ctx, update); err != nil {
			return err
		}
		if g.cancelled[request.RequestID] {
			continue
		}
		if g.runs[request.RequestID] == "" {
			g.runs[request.RequestID] = "run-" + uuid.NewString()
		}
		checkpoint.RunID = g.runs[request.RequestID]
		checkpoint.Receipt = &flowruntime.FlowRuntimeReceipt{Tag: "Accepted", RunID: checkpoint.RunID}
		update.Checkpoint = checkpoint
		if err := g.service.ProjectFlowRuntime(ctx, update); err != nil {
			return err
		}
	}
	for _, request := range signals {
		if g.lostSignalOnce {
			g.lostSignalOnce = false
			continue
		}
		target := request.Target
		target.TenantID, target.PrincipalID = request.Scope.TenantID, request.Scope.PrincipalID
		checkpoint := flowdispatch.RuntimeCheckpoint{Version: 1, Target: target, FlowID: request.FlowID,
			RunID: request.RunID, Projection: request.Projection}
		state := jobs.StateCompleted
		if g.terminalSignalOnce {
			g.terminalSignalOnce = false
			state, checkpoint.FailureCode = jobs.StateFailed, "runtime_run_terminal"
		} else if g.dropSignalOnce {
			g.dropSignalOnce = false
			state, checkpoint.FailureCode = jobs.StateFailed, "no_matching_wait"
		} else {
			checkpoint.MutationReceipt = &flowruntime.FlowRuntimeReceipt{Tag: "Accepted", RunID: request.RunID}
		}
		if err := g.service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{
			OperationID: "operation-" + request.RequestID, Scope: request.Scope, State: state, Checkpoint: checkpoint,
		}); err != nil {
			return err
		}
	}
	return nil
}

func repositoryJobFixture(t *testing.T) (*pgxpool.Pool, *db.Queries, *RepositoryJobService, *repositoryJobTestGateway, RegisterRepositoryJobInput) {
	t.Helper()
	pool := getAgentTestPool(t)
	q := db.New(pool)
	uid, rid := setupTestUserAndRepo(t, pool)
	ctx := context.Background()
	t.Cleanup(func() {
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer func() { _ = tx.Rollback(ctx) }()
		token := strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")
		_, err = tx.Exec(ctx, `
			INSERT INTO repository_storage_operations (
				repository_id, operation_type, token, storage_route_key,
				source_owner, source_repo, source_user_id
			)
			SELECT r.id, 'delete', $2, 'static', u.username, r.name, r.user_id
			FROM repositories r JOIN users u ON u.id = r.user_id WHERE r.id = $1
		`, rid, token)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, token)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `DELETE FROM repositories WHERE id=$1`, rid)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `DELETE FROM repository_storage_operations WHERE repository_id=$1`, rid)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `DELETE FROM users WHERE id=$1`, uid)
		require.NoError(t, err)
		require.NoError(t, tx.Commit(ctx))
	})
	input := repositoryJobTestInput()
	var owner, name string
	require.NoError(t, pool.QueryRow(ctx, `SELECT u.username,r.name FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, rid).Scan(&owner, &name))
	input.Repo = owner + "/" + name
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, input.WorkspaceID, rid, uid)
	require.NoError(t, err)
	gateway := &repositoryJobTestGateway{t: t, config: input, target: BoxHostTarget{RepositoryID: rid, UserID: uid, WorkspaceID: input.WorkspaceID}}
	service := NewRepositoryJobService(q, gateway, pool)
	gateway.service = service
	service.SetFlowDispatcher(gateway)
	service.SetOutsiderEgress(&recordingOutsiderEgress{})
	return pool, q, service, gateway, input
}

func repositoryJobPoll(t *testing.T, service *RepositoryJobService, dispatcher *repositoryJobTestGateway) {
	t.Helper()
	ctx := context.Background()
	require.NoError(t, service.PollOnce(ctx))
	require.NoError(t, dispatcher.projectPending(ctx))
}

func repositoryJobAdmit(t *testing.T, s *RepositoryJobService, repo int64, delivery string, number int64, kind, action string) {
	t.Helper()
	comment := ""
	if kind == "issue_comment" {
		comment = `,"comment":{"id":91,"body":"more information","user":{"login":"author"},"author_association":"OWNER","smithers_text_by_maintainer":true}`
	}
	body := json.RawMessage(fmt.Sprintf(`{"action":%q,"issue":{"id":100,"number":%d,"user":{"login":"author"},"author_association":"OWNER","smithers_text_by_maintainer":true}%s}`, action, number, comment))
	require.NoError(t, s.AdmitGitHubEvent(context.Background(), repo, db.GithubWebhookJob{DeliveryID: delivery, Payload: body}, TriggerEvent{Type: kind, Action: action}))
}

func TestRepositoryJobSignalProjectionIgnoresReplayedAttempt(t *testing.T) {
	pool, _, service, gateway, input := repositoryJobFixture(t)
	ctx := context.Background()
	registration, err := service.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)

	repositoryJobAdmit(t, service, gateway.target.RepositoryID, "projection-run", 41, "issues", "opened")
	repositoryJobPoll(t, service, gateway)
	gateway.dropSignalOnce = true
	repositoryJobAdmit(t, service, gateway.target.RepositoryID, "projection-reply", 41, "issue_comment", "created")
	repositoryJobPoll(t, service, gateway)
	require.Len(t, gateway.signalKeys, 1)
	firstOperation := "operation-" + gateway.signalKeys[0]

	var dispatchID string
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM repository_job_dispatches WHERE registration_id=$1 AND delivery_key='github:projection-reply'`, registration.ID).Scan(&dispatchID))
	_, err = pool.Exec(ctx, `UPDATE repository_job_dispatches SET next_attempt_at=now() WHERE id=$1`, dispatchID)
	require.NoError(t, err)
	require.NoError(t, service.PollOnce(ctx))
	require.Len(t, gateway.signalKeys, 2)
	waiting, err := service.q.GetRepositoryJobDispatch(ctx, dispatchID)
	require.NoError(t, err)
	require.Equal(t, "waiting", waiting.Status)
	require.EqualValues(t, 1, waiting.SignalAttempt)
	var oldProjection repositoryJobFlowProjection
	oldProjection.Kind = repositoryJobFlowProjectionKind
	oldProjection.Mode = repositoryJobFlowModeSignal
	oldProjection.DispatchID = dispatchID
	oldProjection.RegistrationID = registration.ID
	oldProjection.Revision = registration.Revision
	oldProjection.SignalAttempt = 0
	oldProjection.PreviousRunID = waiting.RunID
	checkpoint := flowdispatch.RuntimeCheckpoint{
		Version: 1, FlowID: registration.FlowID,
		Target: repositoryJobFlowTarget(db.RepositoryJobRegistration{WorkspaceID: input.WorkspaceID}, waiting),
	}
	checkpoint.Projection, err = json.Marshal(oldProjection)
	require.NoError(t, err)
	checkpoint.FailureCode = "no_matching_wait"
	update := flowdispatch.ProjectionUpdate{
		OperationID: firstOperation, Scope: repositoryJobFlowScope(gateway.target.RepositoryID, gateway.target.UserID),
		State: jobs.StateFailed, Checkpoint: checkpoint,
	}
	require.NoError(t, service.ProjectFlowRuntime(ctx, update))
	after, err := service.q.GetRepositoryJobDispatch(ctx, dispatchID)
	require.NoError(t, err)
	require.Equal(t, waiting.SignalAttempt, after.SignalAttempt)
	require.Equal(t, waiting.Status, after.Status)
	require.JSONEq(t, string(waiting.Receipt), string(after.Receipt))

	// The SQL predicate must reject stale attempts even if a caller read the
	// dispatch before another worker projected the newer operation.
	rows, err := service.q.RetryProjectedRepositoryJobSignal(ctx, db.RetryProjectedRepositoryJobSignalParams{
		ID: dispatchID, Receipt: repositoryJobRuntimeReceipt(update), NextAttemptAt: time.Now(),
		ExpectedSignalAttempt: 0, ExpectedOperationID: firstOperation,
	})
	require.NoError(t, err)
	require.Zero(t, rows)

	// The operation guard also rejects a different operation on the current attempt.
	rows, err = service.q.ProjectRepositoryJobSignal(ctx, db.ProjectRepositoryJobSignalParams{
		ID: dispatchID, Status: "failed", RunID: waiting.RunID, Receipt: repositoryJobRuntimeReceipt(update),
		ExpectedSignalAttempt: waiting.SignalAttempt, ExpectedOperationID: "different-operation",
	})
	require.NoError(t, err)
	require.Zero(t, rows)

	require.NoError(t, gateway.projectPending(ctx))
	before, err := service.q.GetRepositoryJobDispatch(ctx, dispatchID)
	require.NoError(t, err)
	require.Equal(t, "submitted", before.Status)
	require.NoError(t, service.ProjectFlowRuntime(ctx, update))
	after, err = service.q.GetRepositoryJobDispatch(ctx, dispatchID)
	require.NoError(t, err)
	require.Equal(t, before.SignalAttempt, after.SignalAttempt)
	require.Equal(t, before.Status, after.Status)
	require.JSONEq(t, string(before.Receipt), string(after.Receipt))
}

func TestRepositoryJobFlowDispatchProductPostgres(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	owner, repoName := "owner"+suffix, "repo"+suffix
	var userID, repositoryID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
		owner, suffix+"@example.invalid").Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO repositories(user_id,name,lower_name) VALUES($1,$2,$2) RETURNING id`,
		userID, repoName).Scan(&repositoryID))
	input := repositoryJobTestInput()
	input.Repo = owner + "/" + repoName
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, input.WorkspaceID, repositoryID, userID)
	require.NoError(t, err)
	dispatcher := &repositoryJobTestGateway{
		t: t, config: input,
		target: BoxHostTarget{RepositoryID: repositoryID, UserID: userID, WorkspaceID: input.WorkspaceID},
	}
	service := NewRepositoryJobService(q, dispatcher, pool)
	dispatcher.service = service
	service.SetFlowDispatcher(dispatcher)
	registration, err := service.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)

	// Admission returns before the runtime projection and retains enough scope
	// for the common resolver to reconstruct only the authorized host binding.
	repositoryJobAdmit(t, service, repositoryID, "initial", 41, "issues", "opened")
	require.NoError(t, service.PollOnce(ctx))
	rows, err := q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: repositoryID, Job: "issues"})
	require.NoError(t, err)
	require.Equal(t, "waiting", rows[0].Status)
	require.Empty(t, rows[0].RunID)
	require.Len(t, dispatcher.pendingLaunches, 1)
	request := dispatcher.pendingLaunches[0]
	require.Equal(t, flowdispatch.ApprovalManual, request.ApprovalPolicy)
	require.NotContains(t, dispatcher.calls, "Approve")
	resolver, err := NewRepositoryJobFlowHostTargetResolver(service)
	require.NoError(t, err)
	target := request.Target
	target.TenantID, target.PrincipalID = request.Scope.TenantID, request.Scope.PrincipalID
	authority, err := resolver.ResolveFlowHostTarget(ctx, target)
	require.NoError(t, err)
	require.Equal(t, input.SourceRevision, authority.SourceRevision)
	foreign := target
	foreign.PrincipalID = "user:999999"
	_, err = resolver.ResolveFlowHostTarget(ctx, foreign)
	require.Error(t, err)
	require.NoError(t, dispatcher.projectPending(ctx))
	rows, err = q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: repositoryID, Job: "issues"})
	require.NoError(t, err)
	require.Equal(t, "submitted", rows[0].Status)
	require.NotEmpty(t, rows[0].RunID)
	require.Contains(t, dispatcher.calls, "Approve")

	// A definitive missing wait advances the durable attempt. A lost response
	// retries the same key, while a terminal generation starts a fresh Flow run.
	dispatcher.dropSignalOnce = true
	repositoryJobAdmit(t, service, repositoryID, "no-wait", 41, "issue_comment", "created")
	repositoryJobPoll(t, service, dispatcher)
	_, err = pool.Exec(ctx, `UPDATE repository_job_dispatches SET next_attempt_at=now() WHERE registration_id=$1 AND delivery_key='github:no-wait'`, registration.ID)
	require.NoError(t, err)
	repositoryJobPoll(t, service, dispatcher)
	require.NotEqual(t, dispatcher.signalKeys[0], dispatcher.signalKeys[1])
	dispatcher.lostSignalOnce = true
	repositoryJobAdmit(t, service, repositoryID, "lost-ack", 41, "issue_comment", "created")
	repositoryJobPoll(t, service, dispatcher)
	_, err = pool.Exec(ctx, `UPDATE repository_job_dispatches SET next_attempt_at=now() WHERE registration_id=$1 AND delivery_key='github:lost-ack'`, registration.ID)
	require.NoError(t, err)
	repositoryJobPoll(t, service, dispatcher)
	require.Equal(t, dispatcher.signalKeys[2], dispatcher.signalKeys[3])
	dispatcher.terminalSignalOnce = true
	repositoryJobAdmit(t, service, repositoryID, "terminal", 41, "issue_comment", "created")
	repositoryJobPoll(t, service, dispatcher)
	require.Len(t, dispatcher.pendingLaunches, 1)
	require.NoError(t, dispatcher.projectPending(ctx))

	// A changed runtime descriptor is rejected before approval. Pausing then
	// persists cancellation for every reconnectable launch request.
	dispatcher.executionDigest = strings.Repeat("d", 64)
	repositoryJobAdmit(t, service, repositoryID, "changed-runtime", 42, "issues", "opened")
	repositoryJobPoll(t, service, dispatcher)
	changed, err := q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: repositoryID, Job: "issues"})
	require.NoError(t, err)
	require.Equal(t, "failed", changed[0].Status)
	require.True(t, dispatcher.cancelled[repositoryJobFlowRequestID(changed[0].ID)])
	cancelCalls := len(dispatcher.calls)
	_, err = service.Pause(ctx, repositoryID, userID, "issues")
	require.NoError(t, err)
	require.Contains(t, dispatcher.calls[cancelCalls:], "Cancel")
	_, err = resolver.ResolveFlowHostTarget(ctx, target)
	require.NoError(t, err, "paused launches must still resolve to deliver durable cancellation")
}

func TestRepositoryJobsIntegrationTrialIsolationAndPause(t *testing.T) {
	_, q, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	repositoryJobAdmit(t, s, g.target.RepositoryID, "early-trial", 12, "issues", "opened")
	repositoryJobAdmit(t, s, g.target.RepositoryID, "unrelated", 13, "issues", "opened")
	rows, err := q.ListRepositoryJobAdmissions(ctx, 100)
	require.NoError(t, err)
	require.Empty(t, rows, "no opt-in means no admission")
	input.Mode = "trial"
	input.TrialSource = "github"
	input.TrialIssueNumber = 12
	reg, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	retry, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	require.Equal(t, reg.ID, retry.ID)
	repositoryJobPoll(t, s, g)
	dispatches, err := s.Dispatches(ctx, g.target.RepositoryID, g.target.UserID, "issues")
	require.NoError(t, err)
	require.Len(t, dispatches, 1)
	require.Equal(t, int64(12), dispatches[0].IssueNumber)
	require.Equal(t, "submitted", dispatches[0].Status)
	var trialInput struct {
		Event struct{ Trial bool } `json:"event"`
	}
	require.Len(t, g.inputs, 1)
	require.NoError(t, json.Unmarshal(g.inputs[0], &trialInput))
	require.True(t, trialInput.Event.Trial)
	input.Mode = "enabled"
	input.TrialSource = ""
	input.TrialIssueNumber = 0
	enabled, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	trial, err := q.GetRepositoryJobRegistration(ctx, reg.ID)
	require.NoError(t, err)
	require.False(t, trial.Enabled)
	repositoryJobPoll(t, s, g)
	require.Len(t, g.runs, 1, "old unrelated issue must not backfill")
	_, err = s.Pause(ctx, g.target.RepositoryID, g.target.UserID, "issues")
	require.NoError(t, err)
	_, err = s.Register(ctx, "gateway", "token", "issues", input)
	require.ErrorContains(t, err, "paused")
	repositoryJobAdmit(t, s, g.target.RepositoryID, "after-pause", 14, "issues", "opened")
	repositoryJobPoll(t, s, g)
	require.Len(t, g.runs, 1)
	input.Revision = 2
	_, err = s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	stale := input
	stale.Revision = 1
	_, err = s.Register(ctx, "gateway", "token", "issues", stale)
	require.Error(t, err)
	current, err := q.GetRepositoryJobRegistration(ctx, enabled.ID)
	require.NoError(t, err)
	require.Equal(t, int64(2), current.Revision)
}

func TestRepositoryJobsIntegrationLostRunReplyRetryAndAuthority(t *testing.T) {
	pool, q, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	g.dropRunOnce = true
	reg, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	repositoryJobAdmit(t, s, g.target.RepositoryID, "signed-event", 7, "issues", "opened")
	repositoryJobAdmit(t, s, g.target.RepositoryID, "signed-event", 7, "issues", "opened")
	repositoryJobPoll(t, s, g)
	require.Len(t, g.runs, 1)
	_, err = pool.Exec(ctx, `UPDATE repository_job_dispatches SET next_attempt_at=now() WHERE registration_id=$1`, reg.ID)
	require.NoError(t, err)
	repositoryJobPoll(t, s, g)
	require.Len(t, g.inputs, 1, "persisted plan reused after transport failure")
	require.Len(t, g.runs, 1)
	dispatches, err := q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: g.target.RepositoryID, Job: "issues"})
	require.NoError(t, err)
	require.Len(t, dispatches, 1)
	require.Equal(t, "submitted", dispatches[0].Status)
	var runInput struct {
		Job, SourceRevision, Digest string
		Event                       struct {
			Source, DeliveryKey string
			IssueNumber         int64
			Payload             json.RawMessage
		}
	}
	require.NoError(t, json.Unmarshal(g.inputs[0], &runInput))
	require.Equal(t, "issues", runInput.Job)
	require.Equal(t, "github", runInput.Event.Source)
	require.Equal(t, "github:signed-event", runInput.Event.DeliveryKey)
	require.Equal(t, input.SourceRevision, runInput.SourceRevision)
	g.dropSignalOnce = true
	repositoryJobAdmit(t, s, g.target.RepositoryID, "signed-reply", 7, "issue_comment", "created")
	repositoryJobPoll(t, s, g)
	_, err = pool.Exec(ctx, `UPDATE repository_job_dispatches SET next_attempt_at=now() WHERE registration_id=$1`, reg.ID)
	require.NoError(t, err)
	repositoryJobPoll(t, s, g)
	require.Len(t, g.signalKeys, 2)
	require.NotEqual(t, g.signalKeys[0], g.signalKeys[1], "definitive rejection requires a new persisted attempt key")
	require.Len(t, g.runs, 1)
	g.lostSignalOnce = true
	repositoryJobAdmit(t, s, g.target.RepositoryID, "reply-lost-ack", 7, "issue_comment", "created")
	repositoryJobPoll(t, s, g)
	_, err = pool.Exec(ctx, `UPDATE repository_job_dispatches SET next_attempt_at=now() WHERE registration_id=$1`, reg.ID)
	require.NoError(t, err)
	repositoryJobPoll(t, s, g)
	require.Len(t, g.signalKeys, 4)
	require.Equal(t, g.signalKeys[2], g.signalKeys[3], "ambiguous Signal failure must retain its key")
	g.executionDigest = strings.Repeat("d", 64)
	repositoryJobAdmit(t, s, g.target.RepositoryID, "modified-source", 8, "issues", "opened")
	repositoryJobPoll(t, s, g)
	require.Len(t, g.runs, 1, "unreviewed descriptor cannot autoapprove")
	dispatches, err = q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: g.target.RepositoryID, Job: "issues"})
	require.NoError(t, err)
	require.Equal(t, "failed", dispatches[0].Status)
	_, err = pool.Exec(ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, g.target.UserID)
	require.NoError(t, err)
	_, err = s.Register(ctx, "gateway", "token", "issues", input)
	require.Error(t, err)
	priorCalls := len(g.calls)
	repositoryJobAdmit(t, s, g.target.RepositoryID, "revoked-actor", 9, "issues", "opened")
	repositoryJobPoll(t, s, g)
	require.Len(t, g.calls, priorCalls, "revoked activator cannot launch")
}

func TestRepositoryJobsIntegrationNativeOutboxAndLeaseFence(t *testing.T) {
	pool, q, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO issues(repository_id,number,title,author_id) VALUES($1,1,'rolled back',$2)`, g.target.RepositoryID, g.target.UserID)
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_job_events WHERE repository_id=$1`, g.target.RepositoryID).Scan(&count))
	require.Zero(t, count)
	var issueID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO issues(repository_id,number,title,author_id) VALUES($1,1,'real native trial',$2) RETURNING id`, g.target.RepositoryID, g.target.UserID).Scan(&issueID))
	input.Mode = "trial"
	input.TrialSource = "smithers-cloud"
	input.TrialIssueNumber = 1
	reg, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	var commentID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO issue_comments(issue_id,user_id,body) VALUES($1,$2,'reply') RETURNING id`, issueID, g.target.UserID).Scan(&commentID))
	_, err = pool.Exec(ctx, `UPDATE issue_comments SET body=body WHERE id=$1`, commentID)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_job_events WHERE repository_id=$1`, g.target.RepositoryID).Scan(&count))
	require.Equal(t, 2, count, "comment count update and unchanged edit emit no extra issue event")
	admissions, err := q.ListRepositoryJobAdmissions(ctx, 100)
	require.NoError(t, err)
	require.Len(t, admissions, 2)
	for _, row := range admissions {
		e := row.RepositoryJobEvent
		require.NoError(t, q.EnqueueRepositoryJobDispatch(ctx, db.EnqueueRepositoryJobDispatchParams{ID: reg.ID, Revision: 1, DeliveryKey: e.DeliveryKey, Source: e.Source, EventType: e.EventType, EventAction: e.EventAction, IssueNumber: e.IssueNumber, Payload: e.Payload, Status: "queued"}))
	}
	claims, err := q.ClaimRepositoryJobDispatches(ctx, 5)
	require.NoError(t, err)
	require.Len(t, claims, 1, "same issue reply is ordered behind its opening event")
	other, err := q.ClaimRepositoryJobDispatches(ctx, 5)
	require.NoError(t, err)
	require.Empty(t, other)
	_, err = pool.Exec(ctx, `UPDATE repository_job_dispatches SET lease_until=now()-interval '1 second' WHERE id=$1`, claims[0].ID)
	require.NoError(t, err)
	reclaimed, err := q.ClaimRepositoryJobDispatches(ctx, 5)
	require.NoError(t, err)
	require.Len(t, reclaimed, 1)
	n, err := q.SaveRepositoryJobPlan(ctx, db.SaveRepositoryJobPlanParams{ID: claims[0].ID, ClaimToken: claims[0].ClaimToken, Plan: []byte(`{}`)})
	require.NoError(t, err)
	require.Zero(t, n, "stale worker cannot persist a plan")
	require.NoError(t, s.dispatch(ctx, reclaimed[0]))
	repositoryJobPoll(t, s, g)
	repositoryJobPoll(t, s, g)
	require.Len(t, g.runs, 1)
	rows, err := q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: g.target.RepositoryID, Job: "issues"})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	for _, row := range rows {
		require.Equal(t, "submitted", row.Status)
		require.Equal(t, "smithers-cloud", row.Source)
	}
	_, err = q.GetRepositoryJobRegistration(ctx, uuid.NewString())
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestRepositoryJobsIntegrationScheduleCrashDedup(t *testing.T) {
	pool, q, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	input.Schedule = "0 9 * * *"
	input.FlowID = "repository-jobs/chores"
	g.config = input
	reg, err := s.Register(ctx, "gateway", "token", "chores", input)
	require.NoError(t, err)
	due := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)
	_, err = pool.Exec(ctx, `UPDATE repository_job_registrations SET next_fire_at=$2 WHERE id=$1`, reg.ID, due)
	require.NoError(t, err)
	key := "schedule:" + due.Format(time.RFC3339Nano)
	require.NoError(t, q.EnqueueRepositoryJobDispatch(ctx, db.EnqueueRepositoryJobDispatchParams{ID: reg.ID, Revision: 1, DeliveryKey: key, Source: "schedule", EventType: "schedule", Payload: json.RawMessage(`{}`), Status: "queued"}))
	require.NoError(t, s.enqueueSchedules(ctx))
	repositoryJobPoll(t, s, g)
	require.Len(t, g.runs, 1)
	rows, err := q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: g.target.RepositoryID, Job: "chores"})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	current, err := q.GetRepositoryJobRegistration(ctx, reg.ID)
	require.NoError(t, err)
	require.True(t, current.NextFireAt.Time.After(time.Now()))
}

func TestRepositoryJobsIntegrationTrialCreationIsAtomicAndIdempotent(t *testing.T) {
	pool, _, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	_, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	request := RepositoryJobTrialInput{Repo: input.Repo, WorkspaceID: input.WorkspaceID, Revision: input.Revision, Digest: input.Digest, Title: "Real setup trial", Body: "Reproduce an empty configuration"}
	const attempts = 8
	results := make(chan RepositoryJobTrialResult, attempts)
	failures := make(chan error, attempts)
	var wg sync.WaitGroup
	for range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := s.CreateTrial(ctx, "gateway", "token", "issues", "setup-request", request)
			results <- result
			failures <- err
		}()
	}
	wg.Wait()
	close(results)
	close(failures)
	for err := range failures {
		require.NoError(t, err)
	}
	var first RepositoryJobTrialResult
	for result := range results {
		if first.IssueID == 0 {
			first = result
		}
		require.Equal(t, first, result)
	}
	require.Equal(t, "smithers-cloud", first.Source)
	require.Positive(t, first.Number)
	var issues, events int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issues WHERE repository_id=$1`, g.target.RepositoryID).Scan(&issues))
	require.Equal(t, 1, issues)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_job_events WHERE repository_id=$1`, g.target.RepositoryID).Scan(&events))
	require.Equal(t, 1, events)
	repositoryJobPoll(t, s, g)
	require.Empty(t, g.calls, "trial issue must not leak into an existing broad active configuration before trial registration")
	changed := request
	changed.Body = "unreviewed different request"
	_, err = s.CreateTrial(ctx, "gateway", "token", "issues", "setup-request", changed)
	require.ErrorContains(t, err, "different candidate")
	input.Mode = "trial"
	input.TrialSource = "smithers-cloud"
	input.TrialIssueNumber = first.Number
	_, err = s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	repositoryJobPoll(t, s, g)
	require.Len(t, g.runs, 1)
	bad := request
	bad.WorkspaceID = uuid.NewString()
	_, err = s.CreateTrial(ctx, "gateway", "token", "issues", "new-request", bad)
	require.ErrorContains(t, err, "its own box's coding host")
}

func TestRepositoryJobsIntegrationGitHubWorkerAdmitsWithoutLegacyDefinition(t *testing.T) {
	_, _, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	_, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	job := gitHubIssueEventJob("issues", "opened")
	queries := pushJobQuerier(job)
	queries.listRepositoryIDsForGitHubWebhookJobFn = func(context.Context, db.ListRepositoryIDsForGitHubWebhookJobParams) ([]int64, error) {
		return []int64{g.target.RepositoryID}, nil
	}
	queries.listWorkflowTriggersByRepositoryFn = func(context.Context, int64) ([]db.WorkflowTrigger, error) { return nil, nil }
	legacy := &mockGitHubWebhookEventRunDispatcher{}
	worker := NewGitHubWebhookEventWorker(queries, legacy)
	worker.SetTextStamper(authorWroteIssueText(t))
	worker.SetRepositoryJobs(s)
	require.NoError(t, worker.PollOnce(ctx))
	require.NoError(t, worker.PollOnce(ctx))
	repositoryJobPoll(t, s, g)
	require.Empty(t, legacy.calls)
	require.Len(t, g.runs, 1)
	rows, err := s.Dispatches(ctx, g.target.RepositoryID, g.target.UserID, "issues")
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, "github:"+job.DeliveryID, rows[0].DeliveryKey)
	require.Equal(t, "github", rows[0].Source)
	require.Equal(t, "submitted", rows[0].Status)
}

func TestRepositoryJobSixHourGuard(t *testing.T) {
	for _, milliseconds := range []int64{1, 21600000, 21600001, 0, -1} {
		input := repositoryJobTestInput()
		input.Envelope = json.RawMessage(fmt.Sprintf(`{"capabilities":[],"flows":[],"budget":{"tokens":2400000,"milliseconds":%d}}`, milliseconds))
		_, err := validateRepositoryJob("issues", input, time.Now())
		if milliseconds > 0 && milliseconds <= 21600000 {
			require.NoError(t, err)
		} else {
			require.Error(t, err)
		}
	}
}

func TestProtectedPathMatching(t *testing.T) {
	t.Parallel()
	entries := append([]string(nil), protectedPathRoots...)
	entries = append(entries, "deploy/keys")
	require.Equal(t, []string{".github/workflows/extra.yml", ".smithers/factory.json", "apps/app/AGENTS.md", "deploy/keys/prod.pem", "flows/PACKAGE.ts"},
		protectedPathsTouched([]string{"src/fix.ts", "flows/PACKAGE.ts", ".smithers/factory.json", "apps/app/AGENTS.md",
			".github/workflows/extra.yml", "deploy/keys/prod.pem", "src/deploy/keys/x", "docs/github.md", "AGENTS.md.bak"}, entries))
}

// A run started from an outsider's labeled issue marks its workspace before
// it starts; a maintainer's run does not.
func TestRepositoryJobOutsiderRunMarksItsWorkspace(t *testing.T) {
	_, q, service, gateway, input := repositoryJobFixture(t)
	ctx := context.Background()
	input.Events = []RepositoryJobEventRule{{Type: "issues", Actions: []string{"opened", "labeled"}}}
	_, err := service.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	admit := func(delivery string, byMaintainer bool, action string) {
		body := json.RawMessage(fmt.Sprintf(`{"action":%q,"label":{"name":"smithers","smithers_applied_by_maintainer":true},"sender":{"id":7,"login":"maintainer","type":"User"},
			"issue":{"id":100,"number":41,"user":{"id":9,"login":"author"},"smithers_text_by_maintainer":%t,"labels":[{"name":"smithers"}]}}`, action, byMaintainer))
		require.NoError(t, service.AdmitGitHubEvent(ctx, gateway.target.RepositoryID, db.GithubWebhookJob{DeliveryID: delivery, Payload: body},
			TriggerEvent{Type: "issues", Action: action}))
		repositoryJobPoll(t, service, gateway)
	}
	admit("maintainer", true, "opened")
	marked, err := q.IsOutsiderWorkspace(ctx, input.WorkspaceID)
	require.NoError(t, err)
	require.False(t, marked)
	admit("outsider", false, "labeled")
	marked, err = q.IsOutsiderWorkspace(ctx, input.WorkspaceID)
	require.NoError(t, err)
	require.True(t, marked)
}

// A native issue, comment or label carries the maintainer stamps GitHub
// events get from the webhook worker, so native and GitHub events share one
// trust rule. A maintainer is a person who may write the repository.
func TestRepositoryJobNativeEventsCarryTheMaintainerStamps(t *testing.T) {
	pool, _, _, g, _ := repositoryJobFixture(t)
	ctx := context.Background()
	repo := g.target.RepositoryID
	var stranger, writer, reader int64
	for name, id := range map[string]*int64{"stranger": &stranger, "writer": &writer, "reader": &reader} {
		login := name + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
			login, login+"@example.invalid").Scan(id))
	}
	_, err := pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write'),($1,$3,'read')`, repo, writer, reader)
	require.NoError(t, err)
	// write runs one statement in a transaction that names its writer, as
	// IssueService does.
	write := func(editor int64, statement string, args ...any) {
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer func() { _ = tx.Rollback(ctx) }()
		_, err = tx.Exec(ctx, `SELECT set_config('smithers.issue_text_editor', $1, true)`, strconv.FormatInt(editor, 10))
		require.NoError(t, err)
		_, err = tx.Exec(ctx, statement, args...)
		require.NoError(t, err)
		require.NoError(t, tx.Commit(ctx))
	}
	stamps := func(number int64, author int64) (bool, bool) {
		write(author, `INSERT INTO issues(repository_id,number,title,author_id) VALUES($1,$2,'native',$3)`, repo, number, author)
		var issueID int64
		require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM issues WHERE repository_id=$1 AND number=$2`, repo, number).Scan(&issueID))
		write(author, `INSERT INTO issue_comments(issue_id,user_id,body,type) VALUES($1,$2,'more','comment')`, issueID, author)
		var issue, comment bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT (payload->'issue'->>'smithers_text_by_maintainer')::boolean FROM repository_job_events
			WHERE repository_id=$1 AND issue_number=$2 AND event_type='issues'`, repo, number).Scan(&issue))
		require.NoError(t, pool.QueryRow(ctx, `SELECT (payload->'comment'->>'smithers_text_by_maintainer')::boolean FROM repository_job_events
			WHERE repository_id=$1 AND issue_number=$2 AND event_type='issue_comment'`, repo, number).Scan(&comment))
		return issue, comment
	}
	for number, want := range map[int64]struct {
		author     int64
		maintainer bool
	}{71: {g.target.UserID, true}, 72: {writer, true}, 73: {stranger, false}, 74: {reader, false}} {
		issue, comment := stamps(number, want.author)
		require.Equal(t, want.maintainer, issue, "issue %d", number)
		require.Equal(t, want.maintainer, comment, "comment on %d", number)
	}
	var association int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_job_events WHERE repository_id=$1
		AND (payload->'issue' ? 'author_association' OR payload->'comment' ? 'author_association')`, repo).Scan(&association))
	require.Zero(t, association, "native events name no GitHub-style association to trust")

	// A native label names whether a maintainer applied it: a maintainer's
	// smithers label approves a stranger's issue, the stranger's own label
	// and a read collaborator's do not.
	q := db.New(pool)
	var labelID, issueID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO labels(repository_id,name,color) VALUES($1,'smithers','ffffff') RETURNING id`, repo).Scan(&labelID))
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM issues WHERE repository_id=$1 AND number=73`, repo).Scan(&issueID))
	labeled := func(by int64) bool {
		require.NoError(t, q.AddIssueLabels(ctx, db.AddIssueLabelsParams{IssueID: issueID, LabelIds: []int64{labelID}, AddedBy: pgtype.Int8{Int64: by, Valid: true}}))
		var payload []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM repository_job_events WHERE repository_id=$1 AND issue_number=73
			AND event_action='labeled'`, repo).Scan(&payload))
		_, err := pool.Exec(ctx, `DELETE FROM repository_job_events WHERE repository_id=$1 AND issue_number=73 AND event_action='labeled'`, repo)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `DELETE FROM issue_labels WHERE issue_id=$1`, issueID)
		require.NoError(t, err)
		return gitHubIssueEventApproves("issues", "labeled", payload, issueApprovalLabel)
	}
	require.False(t, labeled(stranger))
	require.False(t, labeled(reader))
	require.True(t, labeled(writer))
	require.True(t, labeled(g.target.UserID))
}

// The native maintainer rule is canWriteRepo, for every way a person holds
// access to a user's or an organization's repository.
func TestRepositoryNativeMaintainerIsCanWriteRepo(t *testing.T) {
	pool, q, _, g, _ := repositoryJobFixture(t)
	ctx := context.Background()
	person := func(name string) int64 {
		login := strings.ToLower(name) + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
			login, login+"@example.invalid").Scan(&id))
		return id
	}
	orgName := "org" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	var orgID, orgRepo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO organizations(name,lower_name,description) VALUES($1,$1,'') RETURNING id`, orgName).Scan(&orgID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(org_id,name,lower_name,description,is_public,default_bookmark,next_issue_number)
		VALUES($1,'r','r','',TRUE,'main',1) RETURNING id`, orgID).Scan(&orgRepo))
	people := map[string]int64{"owner": g.target.UserID}
	for _, name := range []string{"orgOwner", "member", "teamRead", "teamWrite", "teamAdmin", "exMember", "collabRead", "collabWrite", "collabAdmin", "stranger"} {
		people[name] = person(name)
	}
	exec := func(statement string, args ...any) {
		_, err := pool.Exec(ctx, statement, args...)
		require.NoError(t, err)
	}
	exec(`INSERT INTO org_members(organization_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member'),($1,$5,'member'),($1,$6,'member')`,
		orgID, people["orgOwner"], people["member"], people["teamRead"], people["teamWrite"], people["teamAdmin"])
	for _, permission := range []string{"read", "write", "admin"} {
		var team int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO teams(organization_id,name,lower_name,permission) VALUES($1,$2,$2,$2) RETURNING id`,
			orgID, permission).Scan(&team))
		exec(`INSERT INTO team_repos(team_id,repository_id) VALUES($1,$2)`, team, orgRepo)
		member := people["team"+strings.ToUpper(permission[:1])+permission[1:]]
		exec(`INSERT INTO team_members(team_id,user_id) VALUES($1,$2)`, team, member)
		if permission == "write" {
			// A team member who left the organization keeps no grant.
			exec(`INSERT INTO team_members(team_id,user_id) VALUES($1,$2)`, team, people["exMember"])
		}
	}
	for _, repo := range []int64{g.target.RepositoryID, orgRepo} {
		exec(`INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'read'),($1,$3,'write'),($1,$4,'admin')`,
			repo, people["collabRead"], people["collabWrite"], people["collabAdmin"])
		repository, err := q.GetRepoByID(ctx, repo)
		require.NoError(t, err)
		for name, id := range people {
			want, err := canWriteRepo(ctx, q, repository, id)
			require.NoError(t, err)
			var got bool
			require.NoError(t, pool.QueryRow(ctx, `SELECT repository_native_maintainer($1,$2)`, repo, id).Scan(&got))
			require.Equal(t, want, got, "%s on repository %d", name, repo)
		}
		var none bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT repository_native_maintainer($1,NULL)`, repo).Scan(&none))
		require.False(t, none, "text no person wrote")
	}
}

// A native label reaches the one trust rule through the label service, which
// records who applied it. The owner's own session approves a stranger's issue
// with the trigger label and nothing else; a run credential acting as the
// owner is the repository's agent, not the owner, so its label approves
// nothing (a GitHub App's label is refused the same way).
func TestRepositoryJobNativeLabelsApproveOnlyAPersonsTriggerLabel(t *testing.T) {
	pool, q, _, g, _ := repositoryJobFixture(t)
	ctx := context.Background()
	repo := g.target.RepositoryID
	owner, err := q.GetUserByID(ctx, g.target.UserID)
	require.NoError(t, err)
	var ownerLogin, repoName string
	require.NoError(t, pool.QueryRow(ctx, `SELECT u.username, r.name FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, repo).Scan(&ownerLogin, &repoName))
	var stranger int64
	login := "stranger" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
		login, login+"@example.invalid").Scan(&stranger))
	_, err = pool.Exec(ctx, `INSERT INTO issues(repository_id,number,title,body,author_id) VALUES($1,81,'native','do it',$2)`, repo, stranger)
	require.NoError(t, err)
	for _, name := range []string{issueApprovalLabel, "invalid"} {
		_, err := pool.Exec(ctx, `INSERT INTO labels(repository_id,name,color) VALUES($1,$2,'ffffff')`, repo, name)
		require.NoError(t, err)
	}
	labels := NewLabelService(q)
	session := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, Scopes: middleware.ScopeSet{}})
	run := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, IsTokenAuth: true, TokenSystemIssued: true,
		RawScopes: "write:repository,repo:" + strconv.FormatInt(repo, 10), Scopes: middleware.ParseTokenScopes("write:repository")})
	approves := func(actx context.Context, label string) bool {
		_, err := labels.AddLabelsToIssue(actx, &owner, ownerLogin, repoName, 81, []string{label})
		require.NoError(t, err)
		var payload []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM repository_job_events WHERE repository_id=$1 AND issue_number=81
			AND event_action='labeled'`, repo).Scan(&payload))
		_, err = pool.Exec(ctx, `DELETE FROM issue_labels WHERE issue_id=(SELECT id FROM issues WHERE repository_id=$1 AND number=81)`, repo)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `DELETE FROM repository_job_events WHERE repository_id=$1 AND issue_number=81 AND event_action='labeled'`, repo)
		require.NoError(t, err)
		return gitHubIssueEventApproves("issues", "labeled", payload, issueApprovalLabel)
	}
	require.False(t, approves(session, "invalid"), "a maintainer's other label approves nothing")
	require.False(t, approves(run, issueApprovalLabel), "the owner's run applies the trigger label as an agent")
	require.True(t, approves(session, issueApprovalLabel), "the owner applying the trigger label approves the text")
	var unlabeled []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM repository_job_events WHERE repository_id=$1 AND issue_number=81
		AND event_action='unlabeled' AND payload->'label'->>'name'=$2 LIMIT 1`, repo, issueApprovalLabel).Scan(&unlabeled))
	require.False(t, gitHubIssueEventApproves("issues", "unlabeled", unlabeled, issueApprovalLabel), "removing a label approves nothing")
}

// A native issue's text is its maintainer author's own only while a
// maintainer person last wrote its title and its body. The owner's run
// credential acts as the owner but is the repository's agent: its edit
// approves nothing until a maintainer writes the text again or re-applies
// the trigger label; another maintainer's edit is approved.
func TestRepositoryJobNativeIssueTextNamesItsLastWriter(t *testing.T) {
	pool, q, _, g, _ := repositoryJobFixture(t)
	ctx := context.Background()
	repo := g.target.RepositoryID
	owner, err := q.GetUserByID(ctx, g.target.UserID)
	require.NoError(t, err)
	var repoName string
	require.NoError(t, pool.QueryRow(ctx, `SELECT name FROM repositories WHERE id=$1`, repo).Scan(&repoName))
	login := "writer" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	var writerID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
		login, login+"@example.invalid").Scan(&writerID))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo, writerID)
	require.NoError(t, err)
	writer, err := q.GetUserByID(ctx, writerID)
	require.NoError(t, err)

	issues := NewIssueService(q)
	session := func(user *db.User) context.Context {
		return middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: user, Scopes: middleware.ScopeSet{}})
	}
	run := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, IsTokenAuth: true, TokenSystemIssued: true,
		RawScopes: "write:repository,repo:" + strconv.FormatInt(repo, 10), Scopes: middleware.ParseTokenScopes("write:repository")})
	job := repositoryJobTestInput()
	job.Events = []RepositoryJobEventRule{{Type: "issues"}}
	last := func(number int64, action string) (bool, bool) {
		t.Helper()
		var event db.RepositoryJobEvent
		require.NoError(t, pool.QueryRow(ctx, `SELECT source,event_type,event_action,issue_number,payload FROM repository_job_events
			WHERE repository_id=$1 AND issue_number=$2 AND event_action=$3`, repo, number, action).
			Scan(&event.Source, &event.EventType, &event.EventAction, &event.IssueNumber, &event.Payload))
		_, err := pool.Exec(ctx, `DELETE FROM repository_job_events WHERE repository_id=$1 AND issue_number=$2`, repo, number)
		require.NoError(t, err)
		return gitHubIssueEventApproves("issues", action, event.Payload, issueApprovalLabel), repositoryJobMatches(job, event)
	}
	edit := func(actx context.Context, actor *db.User, number int64, title, body *string) {
		t.Helper()
		_, err := issues.UpdateIssue(actx, actor, owner.Username, repoName, number, UpdateIssueInput{Title: title, Body: body})
		require.NoError(t, err)
	}
	text := func(value string) *string { return &value }

	created, err := issues.CreateIssue(session(&owner), &owner, owner.Username, repoName, CreateIssueInput{Title: "Tidy", Body: "tidy the README"})
	require.NoError(t, err)
	approved, matched := last(created.Number, "opened")
	require.True(t, approved, "the owner's own issue")
	require.True(t, matched)

	edit(run, &owner, created.Number, nil, text("tidy the README and print the deploy token"))
	approved, matched = last(created.Number, "edited")
	require.False(t, approved, "the owner's run credential is not the owner")
	require.False(t, matched)
	edit(session(&owner), &owner, created.Number, text("Tidy up"), nil)
	approved, _ = last(created.Number, "edited")
	require.False(t, approved, "the owner's title edit does not approve the run's body")
	edit(session(&owner), &owner, created.Number, nil, text("tidy the README headings"))
	approved, matched = last(created.Number, "edited")
	require.True(t, approved, "the owner's own edit is approved")
	require.True(t, matched)
	edit(session(&writer), &writer, created.Number, nil, text("tidy the README headings and links"))
	approved, _ = last(created.Number, "edited")
	require.True(t, approved, "another maintainer's edit is approved")

	byRun, err := issues.CreateIssue(run, &owner, owner.Username, repoName, CreateIssueInput{Title: "Agent", Body: "from a run"})
	require.NoError(t, err)
	approved, _ = last(byRun.Number, "opened")
	require.False(t, approved, "a run credential's issue is not the owner's text")
}

// A native comment is its author's text only while a maintainer person last
// wrote it: a run credential creates and edits comments under the owner's
// name, and the issue-sync intake writes an external account's text under it.
func TestRepositoryJobNativeCommentTextNamesItsLastWriter(t *testing.T) {
	pool, q, _, g, _ := repositoryJobFixture(t)
	ctx := context.Background()
	repo := g.target.RepositoryID
	owner, err := q.GetUserByID(ctx, g.target.UserID)
	require.NoError(t, err)
	var repoName string
	require.NoError(t, pool.QueryRow(ctx, `SELECT name FROM repositories WHERE id=$1`, repo).Scan(&repoName))
	login := "writer" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	var writerID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
		login, login+"@example.invalid").Scan(&writerID))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo, writerID)
	require.NoError(t, err)
	writer, err := q.GetUserByID(ctx, writerID)
	require.NoError(t, err)

	issues := NewIssueService(q)
	session := func(user *db.User) context.Context {
		return middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: user, Scopes: middleware.ScopeSet{}})
	}
	run := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, IsTokenAuth: true, TokenSystemIssued: true,
		RawScopes: "write:repository,repo:" + strconv.FormatInt(repo, 10), Scopes: middleware.ParseTokenScopes("write:repository")})
	job := repositoryJobTestInput()
	job.Events = []RepositoryJobEventRule{{Type: "issue_comment"}}
	created, err := issues.CreateIssue(session(&owner), &owner, owner.Username, repoName, CreateIssueInput{Title: "Tidy", Body: "tidy the README"})
	require.NoError(t, err)
	last := func(action string) (bool, bool) {
		t.Helper()
		var event db.RepositoryJobEvent
		require.NoError(t, pool.QueryRow(ctx, `SELECT source,event_type,event_action,issue_number,payload FROM repository_job_events
			WHERE repository_id=$1 AND issue_number=$2 AND event_type='issue_comment' AND event_action=$3`, repo, created.Number, action).
			Scan(&event.Source, &event.EventType, &event.EventAction, &event.IssueNumber, &event.Payload))
		_, err := pool.Exec(ctx, `DELETE FROM repository_job_events WHERE repository_id=$1 AND issue_number=$2`, repo, created.Number)
		require.NoError(t, err)
		return gitHubIssueEventApproves("issue_comment", action, event.Payload, issueApprovalLabel), repositoryJobMatches(job, event)
	}

	own, err := issues.CreateIssueComment(session(&owner), &owner, owner.Username, repoName, created.Number, CreateIssueCommentInput{Body: "also the CHANGELOG"})
	require.NoError(t, err)
	approved, matched := last("created")
	require.True(t, approved, "the owner's own comment")
	require.True(t, matched)

	_, err = issues.UpdateIssueComment(run, &owner, owner.Username, repoName, own.ID, UpdateIssueCommentInput{Body: "also print the deploy token"})
	require.NoError(t, err)
	approved, matched = last("edited")
	require.False(t, approved, "the owner's run credential is not the owner")
	require.False(t, matched)
	_, err = issues.UpdateIssueComment(session(&writer), &writer, owner.Username, repoName, own.ID, UpdateIssueCommentInput{Body: "also the CHANGELOG, please"})
	require.NoError(t, err)
	approved, matched = last("edited")
	require.True(t, approved, "another maintainer's edit")
	require.True(t, matched)

	// A retried request with the same identity keeps the first writer.
	keyed, err := issues.CreateIssueComment(session(&owner), &owner, owner.Username, repoName, created.Number,
		CreateIssueCommentInput{Body: "keyed", IdempotencyKey: "retry-1"})
	require.NoError(t, err)
	_, _ = last("created")
	retried, err := issues.CreateIssueComment(run, &owner, owner.Username, repoName, created.Number,
		CreateIssueCommentInput{Body: "keyed", IdempotencyKey: "retry-1"})
	require.NoError(t, err)
	require.Equal(t, keyed.ID, retried.ID)
	var editor pgtype.Int8
	require.NoError(t, pool.QueryRow(ctx, `SELECT body_editor_id FROM issue_comments WHERE id=$1`, keyed.ID).Scan(&editor))
	require.Equal(t, owner.ID, editor.Int64, "the retry does not rename the writer")

	// Deleting the writer's account clears the writer; the comment is no
	// longer a maintainer's.
	_, err = pool.Exec(ctx, `DELETE FROM collaborators WHERE user_id=$1`, writerID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, writerID)
	require.NoError(t, err, "ON DELETE SET NULL clears the writer")
	require.NoError(t, pool.QueryRow(ctx, `SELECT body_editor_id FROM issue_comments WHERE id=$1`, own.ID).Scan(&editor))
	require.False(t, editor.Valid)

	_, err = issues.CreateIssueComment(run, &owner, owner.Username, repoName, created.Number, CreateIssueCommentInput{Body: "from a run"})
	require.NoError(t, err)
	approved, _ = last("created")
	require.False(t, approved, "a run credential's comment is not the owner's text")

	external, err := issues.CreateIssueComment(session(&owner), &owner, owner.Username, repoName, created.Number,
		CreateIssueCommentInput{externalCommenter: "U0EXTERNAL", Body: "from a chat channel"})
	require.NoError(t, err)
	approved, _ = last("created")
	require.False(t, approved, "the issue-sync intake writes an external account's text")
	_, err = issues.UpdateIssueComment(session(&owner), &owner, owner.Username, repoName, external.ID,
		UpdateIssueCommentInput{externalCommenter: true, Body: "edited in a chat channel"})
	require.NoError(t, err)
	approved, _ = last("edited")
	require.False(t, approved, "an external account's edit")
}

// A run reads the text that was approved, not the live issue: the dispatch
// event carries the approved title, body and revision of its subject.
func TestRepositoryJobDispatchEventCarriesTheApprovedText(t *testing.T) {
	t.Parallel()
	event := func(payload string) map[string]interface{} {
		return repositoryJobDispatchEvent(db.RepositoryJobRegistration{}, db.RepositoryJobDispatch{Source: "github", EventType: "issues",
			EventAction: "opened", IssueNumber: 4, Payload: json.RawMessage(payload)})
	}
	sum := sha256.Sum256([]byte("Tidy\x00tidy the README"))
	want := repositoryJobApprovedText{Title: "Tidy", Body: "tidy the README", Revision: "sha256:" + hex.EncodeToString(sum[:])}
	require.Equal(t, want, event(`{"issue":{"number":4,"title":"Tidy","body":"tidy the README"},"comment":{"body":"and more"}}`)["approvedText"])
	require.Equal(t, want, event(`{"pull_request":{"number":4,"title":"Tidy","body":"tidy the README","smithers_text_by_maintainer":true},"review":{"body":"ok"}}`)["approvedText"])
	require.NotContains(t, event(`{"pull_request":{"number":4,"title":"Tidy","body":"tidy the README"}}`), "approvedText", "an outsider's pull request approves nothing")
	empty := sha256.Sum256([]byte("Tidy\x00"))
	require.Equal(t, repositoryJobApprovedText{Title: "Tidy", Revision: "sha256:" + hex.EncodeToString(empty[:])},
		event(`{"issue":{"number":4,"title":"Tidy","body":null}}`)["approvedText"])
	require.NotContains(t, event(`{"ref":"refs/heads/main"}`), "approvedText")
}
