package services

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type repositoryCiReceiptFixture struct {
	pool           *pgxpool.Pool
	queries        *db.Queries
	service        *RepositoryJobService
	gateway        *repositoryJobTestGateway
	registrationID string
	revision       int64
	digest         string
	input          RepositoryCheckReceiptInput
}

const repositoryCiRequiredPolicy = `{"checks":[{"id":"unit","policy":"required"},{"id":"types","policy":"required"},{"id":"style","policy":"report"}],"scope":"future"}`
const repositoryCiAdvisoryOnlyPolicy = `{"checks":[{"id":"style","policy":"report"}],"scope":"future"}`

func repositoryCiReceiptEnv(t *testing.T) *repositoryCiReceiptFixture {
	return repositoryCiReceiptEnvFor(t, repositoryCiRequiredPolicy,
		[]RepositoryCheckOutcome{{ID: "unit", Outcome: "passed"}, {ID: "types", Outcome: "skipped_no_matching_paths"}})
}

func repositoryCiReceiptEnvFor(t *testing.T, policy string, checks []RepositoryCheckOutcome) *repositoryCiReceiptFixture {
	t.Helper()
	pool, queries, service, gateway, registration := repositoryJobFixture(t)
	ctx := context.Background()
	registration.FlowID = "repository-jobs/ci"
	registration.Input = json.RawMessage(policy)
	gateway.config = registration
	row, err := service.Register(ctx, "gateway", "token", "ci", registration)
	require.NoError(t, err)
	runID := "run-" + uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO repository_job_dispatches(registration_id,revision,digest,delivery_key,source,event_type,event_action,payload,status,run_id)
		VALUES($1,$2,$3,'manual:receipt','smithers-cloud','manual','manual:ci','{}'::jsonb,'submitted',$4)`,
		row.ID, row.Revision, row.Digest, runID)
	require.NoError(t, err)
	return &repositoryCiReceiptFixture{
		pool: pool, queries: queries, service: service, gateway: gateway,
		registrationID: row.ID, revision: row.Revision, digest: row.Digest,
		input: RepositoryCheckReceiptInput{
			Repo: registration.Repo, WorkspaceID: registration.WorkspaceID, RegistrationID: row.ID,
			Revision: row.Revision, Digest: row.Digest, ExecutionDigest: registration.ExecutionDigest,
			RunID: runID, ExecutionID: "check-step-1",
			CommitID: strings.Repeat("c", 40), ChangeID: "deliveredchange", BaseCommitID: strings.Repeat("9", 40),
			Checks: checks,
			Gate:   "passed",
		},
	}
}

func (f *repositoryCiReceiptFixture) put(t *testing.T, requestID string, edit func(*RepositoryCheckReceiptInput)) (RepositoryCheckReceiptResponse, bool, error) {
	t.Helper()
	input := f.input
	input.Checks = append(make([]RepositoryCheckOutcome, 0, len(f.input.Checks)), f.input.Checks...)
	if edit != nil {
		edit(&input)
	}
	return f.service.CreateCheckReceipt(context.Background(), "gateway", "token", requestID, input)
}

// repositoryCiExtraWorkspace adds a second active workspace to the fixture's
// repository. uq_workspaces_active allows one per (repository, user, kind), so
// it gets its own user.
func (f *repositoryCiReceiptFixture) extraWorkspace(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.NewString()
	name := "ciuser_" + strings.ReplaceAll(id, "-", "")[:16]
	var userID int64
	require.NoError(t, f.pool.QueryRow(ctx,
		`INSERT INTO users (username, lower_username, email, lower_email, display_name) VALUES ($1,$1,$2,$2,'CI') RETURNING id`,
		name, name+"@test.com").Scan(&userID))
	t.Cleanup(func() { _, _ = f.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID) })
	_, err := f.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) SELECT $1,repository_id,$2,'running' FROM repository_job_registrations WHERE id=$3`, id, userID, f.registrationID)
	require.NoError(t, err)
	return id
}

func requireReceiptCode(t *testing.T, err error, code pkgerrors.Code) {
	t.Helper()
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, code, apiErr.Code, apiErr.Message)
}

func TestRepositoryCiReceiptRequiredContextNamesThePolicy(t *testing.T) {
	t.Parallel()
	require.Equal(t, "repository-ci/7f0c1d64@7.9f2c4a1b0e73",
		repositoryCiRequiredContext("7f0c1d64", 7, "9f2c4a1b0e73aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
}

func TestRepositoryCiReceiptValidation(t *testing.T) {
	t.Parallel()
	valid := RepositoryCheckReceiptInput{
		Repo: "owner/repo", WorkspaceID: uuid.NewString(), RegistrationID: uuid.NewString(), Revision: 1,
		Digest: strings.Repeat("a", 64), ExecutionDigest: strings.Repeat("b", 64), RunID: "run-1", ExecutionID: "exec-1",
		CommitID: strings.Repeat("c", 40), ChangeID: "change", BaseCommitID: strings.Repeat("d", 40),
		Checks: []RepositoryCheckOutcome{{ID: "unit", Outcome: "passed"}}, Gate: "passed",
	}
	require.NoError(t, validateRepositoryCheckReceipt(uuid.NewString(), valid))
	for name, edit := range map[string]func(*RepositoryCheckReceiptInput){
		"gate":      func(i *RepositoryCheckReceiptInput) { i.Gate = "failed" },
		"commit":    func(i *RepositoryCheckReceiptInput) { i.CommitID = "main" },
		"base":      func(i *RepositoryCheckReceiptInput) { i.BaseCommitID = "" },
		"digest":    func(i *RepositoryCheckReceiptInput) { i.Digest = "approved" },
		"execution": func(i *RepositoryCheckReceiptInput) { i.ExecutionID = "" },
		"run":       func(i *RepositoryCheckReceiptInput) { i.RunID = "" },
		"missing":   func(i *RepositoryCheckReceiptInput) { i.Checks = nil },
		"outcome": func(i *RepositoryCheckReceiptInput) {
			i.Checks = []RepositoryCheckOutcome{{ID: "unit", Outcome: "skipped"}}
		},
		"duplicate": func(i *RepositoryCheckReceiptInput) {
			i.Checks = []RepositoryCheckOutcome{{ID: "unit", Outcome: "passed"}, {ID: "unit", Outcome: "passed"}}
		},
	} {
		t.Run(name, func(t *testing.T) {
			input := valid
			edit(&input)
			err := validateRepositoryCheckReceipt(uuid.NewString(), input)
			requireReceiptCode(t, err, pkgerrors.CodeBadRequest)
		})
	}
	requireReceiptCode(t, validateRepositoryCheckReceipt("not-a-uuid", valid), pkgerrors.CodeBadRequest)
}

func TestRepositoryCiReceiptIntegrationWritesTheReservedStatus(t *testing.T) {
	f := repositoryCiReceiptEnv(t)
	ctx := context.Background()
	requestID := uuid.NewString()
	result, created, err := f.put(t, requestID, nil)
	require.NoError(t, err)
	require.True(t, created)
	wanted := "repository-ci/" + f.registrationID + "@1." + f.digest[:12]
	require.Equal(t, wanted, result.Context)
	require.Equal(t, f.input.CommitID, result.CommitID)
	require.Equal(t, "success", result.Status)
	require.Positive(t, result.StatusID)

	var statusContext, statusCommit, statusChange, statusState string
	var workflowRunID *int64
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT context,commit_sha,change_id,status,workflow_run_id FROM commit_statuses WHERE id=$1`, result.StatusID).
		Scan(&statusContext, &statusCommit, &statusChange, &statusState, &workflowRunID))
	require.Equal(t, wanted, statusContext)
	require.Equal(t, f.input.CommitID, statusCommit)
	require.Equal(t, f.input.ChangeID, statusChange)
	require.Equal(t, "success", statusState)
	require.Nil(t, workflowRunID, "a receipt status is unreachable from the legacy workflow updater")

	receipt, err := f.queries.GetRepositoryCiCheckReceipt(ctx, db.GetRepositoryCiCheckReceiptParams{RegistrationID: f.registrationID, RequestID: requestID})
	require.NoError(t, err)
	require.Equal(t, result.StatusID, receipt.CommitStatusID)
	require.JSONEq(t, `[{"id":"unit","outcome":"passed"},{"id":"types","outcome":"skipped_no_matching_paths"}]`, string(receipt.Checks))
}

func TestRepositoryCiReceiptIntegrationIdempotentReplay(t *testing.T) {
	f := repositoryCiReceiptEnv(t)
	ctx := context.Background()
	requestID := uuid.NewString()
	first, created, err := f.put(t, requestID, nil)
	require.NoError(t, err)
	require.True(t, created)
	replay, createdAgain, err := f.put(t, requestID, nil)
	require.NoError(t, err)
	require.False(t, createdAgain)
	require.Equal(t, first, replay)
	var statuses int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM commit_statuses WHERE context=$1`, first.Context).Scan(&statuses))
	require.Equal(t, 1, statuses)

	_, _, err = f.put(t, requestID, func(i *RepositoryCheckReceiptInput) { i.CommitID = strings.Repeat("7", 40) })
	requireReceiptCode(t, err, pkgerrors.CodeConflict)
}

func TestRepositoryCiReceiptIntegrationConcurrentRetriesWriteOnePair(t *testing.T) {
	f := repositoryCiReceiptEnv(t)
	ctx := context.Background()
	requestID := uuid.NewString()
	const attempts = 8
	results := make(chan RepositoryCheckReceiptResponse, attempts)
	failures := make(chan error, attempts)
	var wg sync.WaitGroup
	for range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, _, err := f.put(t, requestID, nil)
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
	var first RepositoryCheckReceiptResponse
	for result := range results {
		if first.StatusID == 0 {
			first = result
		}
		require.Equal(t, first, result)
	}
	var receipts, statuses int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM repository_ci_check_receipts WHERE request_id=$1`, requestID).Scan(&receipts))
	require.Equal(t, 1, receipts)
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM commit_statuses WHERE context=$1`, first.Context).Scan(&statuses))
	require.Equal(t, 1, statuses)
}

func TestRepositoryCiReceiptIntegrationConcurrentConflictingBodiesPickOneWinner(t *testing.T) {
	f := repositoryCiReceiptEnv(t)
	ctx := context.Background()
	requestID := uuid.NewString()
	commits := []string{strings.Repeat("1", 40), strings.Repeat("2", 40), strings.Repeat("3", 40), strings.Repeat("4", 40)}
	failures := make(chan error, len(commits))
	var wg sync.WaitGroup
	for _, commit := range commits {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := f.put(t, requestID, func(i *RepositoryCheckReceiptInput) { i.CommitID = commit })
			failures <- err
		}()
	}
	wg.Wait()
	close(failures)
	accepted := 0
	for err := range failures {
		if err == nil {
			accepted++
			continue
		}
		requireReceiptCode(t, err, pkgerrors.CodeConflict)
	}
	require.Equal(t, 1, accepted)
	var receipts, statuses int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM repository_ci_check_receipts WHERE request_id=$1`, requestID).Scan(&receipts))
	require.Equal(t, 1, receipts)
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM commit_statuses WHERE context LIKE 'repository-ci/%'`).Scan(&statuses))
	require.Equal(t, 1, statuses, "a refused body leaves no orphan status behind")
}

func TestRepositoryCiReceiptIntegrationAuthorityMatrix(t *testing.T) {
	f := repositoryCiReceiptEnv(t)
	ctx := context.Background()
	_, _, err := f.service.CreateCheckReceipt(ctx, "other-gateway", "token", uuid.NewString(), f.input)
	require.Error(t, err)
	_, _, err = f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) { i.WorkspaceID = uuid.NewString() })
	requireReceiptCode(t, err, pkgerrors.CodeForbidden)
	_, _, err = f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) { i.Repo = "someone/else" })
	requireReceiptCode(t, err, pkgerrors.CodeForbidden)

	// The registration's own workspace must still be the calling gateway's.
	other := f.extraWorkspace(t)
	_, err = f.pool.Exec(ctx, `UPDATE repository_job_registrations SET workspace_id=$2 WHERE id=$1`, f.registrationID, other)
	require.NoError(t, err)
	_, _, err = f.put(t, uuid.NewString(), nil)
	requireReceiptCode(t, err, pkgerrors.CodeForbidden)

	_, err = f.pool.Exec(ctx, `DELETE FROM repository_job_registrations WHERE id=$1`, f.registrationID)
	require.NoError(t, err)
	_, _, err = f.put(t, uuid.NewString(), nil)
	requireReceiptCode(t, err, pkgerrors.CodeNotFound)
}

func TestRepositoryCiReceiptIntegrationPolicyMatrix(t *testing.T) {
	f := repositoryCiReceiptEnv(t)
	ctx := context.Background()
	_, _, err := f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) { i.Revision = 2 })
	requireReceiptCode(t, err, pkgerrors.CodeConflict)
	_, _, err = f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) { i.ExecutionDigest = strings.Repeat("f", 64) })
	requireReceiptCode(t, err, pkgerrors.CodeConflict)
	_, _, err = f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) {
		i.Checks = []RepositoryCheckOutcome{{ID: "unit", Outcome: "passed"}}
	})
	requireReceiptCode(t, err, pkgerrors.CodeUnprocessableEntity)
	_, _, err = f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) {
		i.Checks = append(i.Checks, RepositoryCheckOutcome{ID: "invented", Outcome: "passed"})
	})
	requireReceiptCode(t, err, pkgerrors.CodeUnprocessableEntity)
	// A report-only check may be reported and is never required.
	_, created, err := f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) {
		i.Checks = append(i.Checks, RepositoryCheckOutcome{ID: "style", Outcome: "passed"})
	})
	require.NoError(t, err)
	require.True(t, created)

	// A replaced policy renames its required context, so the old receipt cannot
	// satisfy the new one.
	_, err = f.pool.Exec(ctx, `UPDATE repository_job_registrations SET revision=2 WHERE id=$1`, f.registrationID)
	require.NoError(t, err)
	_, _, err = f.put(t, uuid.NewString(), nil)
	requireReceiptCode(t, err, pkgerrors.CodeConflict)
}

func TestRepositoryCiReceiptIntegrationRunMustBeRetainedByProductDatabase(t *testing.T) {
	f := repositoryCiReceiptEnv(t)
	ctx := context.Background()
	_, _, err := f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) { i.RunID = "run-" + uuid.NewString() })
	requireReceiptCode(t, err, pkgerrors.CodeRepositoryCIRunUnverified)

	// Another repository's dispatch for the same run id is not this repository's.
	otherPool, _, otherService, otherGateway, otherRegistration := repositoryJobFixture(t)
	otherRegistration.FlowID = "repository-jobs/ci"
	otherRegistration.Input = json.RawMessage(`{"checks":[{"id":"unit","policy":"required"}],"scope":"future"}`)
	otherGateway.config = otherRegistration
	otherRow, err := otherService.Register(ctx, "gateway", "token", "ci", otherRegistration)
	require.NoError(t, err)
	foreignRun := "run-" + uuid.NewString()
	_, err = otherPool.Exec(ctx, `INSERT INTO repository_job_dispatches(registration_id,revision,digest,delivery_key,source,event_type,event_action,payload,status,run_id)
		VALUES($1,$2,$3,'manual:foreign','smithers-cloud','manual','manual:ci','{}'::jsonb,'submitted',$4)`,
		otherRow.ID, otherRow.Revision, otherRow.Digest, foreignRun)
	require.NoError(t, err)
	_, _, err = f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) { i.RunID = foreignRun })
	requireReceiptCode(t, err, pkgerrors.CodeRepositoryCIRunUnverified)

	// Another workspace in this repository is not this gateway's workspace.
	strayWorkspace := f.extraWorkspace(t)
	strayRun := "run-" + uuid.NewString()
	_, err = f.pool.Exec(ctx, `INSERT INTO repository_job_registrations(repository_id,workspace_id,user_id,job,mode,revision,digest,source_revision,flow_id,configuration,enabled)
		SELECT repository_id,$2,user_id,'review','enabled',1,digest,source_revision,'repository-jobs/review',configuration,true FROM repository_job_registrations WHERE id=$1`, f.registrationID, strayWorkspace)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO repository_job_dispatches(registration_id,revision,digest,delivery_key,source,event_type,event_action,payload,status,run_id)
		SELECT id,revision,digest,'manual:stray','smithers-cloud','manual','manual:review','{}'::jsonb,'submitted',$2 FROM repository_job_registrations WHERE workspace_id=$1 AND job='review'`, strayWorkspace, strayRun)
	require.NoError(t, err)
	_, _, err = f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) { i.RunID = strayRun })
	requireReceiptCode(t, err, pkgerrors.CodeRepositoryCIRunUnverified)

	for _, retired := range []string{"failed", "skipped"} {
		_, err = f.pool.Exec(ctx, `UPDATE repository_job_dispatches SET status=$2 WHERE run_id=$1`, f.input.RunID, retired)
		require.NoError(t, err)
		_, _, err = f.put(t, uuid.NewString(), nil)
		requireReceiptCode(t, err, pkgerrors.CodeRepositoryCIRunUnverified)
	}

	// The producing run normally belongs to another job's registration, not to
	// the ci registration the receipt names.
	_, err = f.pool.Exec(ctx, `UPDATE repository_job_dispatches SET status='submitted' WHERE run_id=$1`, f.input.RunID)
	require.NoError(t, err)
	producing := "run-" + uuid.NewString()
	_, err = f.pool.Exec(ctx, `INSERT INTO repository_job_registrations(repository_id,workspace_id,user_id,job,mode,revision,digest,source_revision,flow_id,configuration,enabled)
		SELECT repository_id,workspace_id,user_id,'feature','enabled',1,digest,source_revision,'repository-jobs/feature',configuration,true FROM repository_job_registrations WHERE id=$1`, f.registrationID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO repository_job_dispatches(registration_id,revision,digest,delivery_key,source,event_type,event_action,payload,status,run_id)
		SELECT id,revision,digest,'manual:feature','smithers-cloud','manual','manual:feature','{}'::jsonb,'submitted',$2 FROM repository_job_registrations WHERE repository_id=(SELECT repository_id FROM repository_job_registrations WHERE id=$1) AND job='feature'`, f.registrationID, producing)
	require.NoError(t, err)
	_, created, err := f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) { i.RunID = producing })
	require.NoError(t, err)
	require.True(t, created)
}

// repositoryCiReceiptLandingWorker queues one agent-authored append for the
// exact commit a receipt attested, so the receipt and the landing gate are
// exercised end to end inside one repository.
func (f *repositoryCiReceiptFixture) landingWorkerFor(t *testing.T, commitID, changeID string) (*LandingWorker, *repositoryCiWorkerRepoHost, int64) {
	t.Helper()
	ctx := context.Background()
	var repositoryID, userID int64
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT repository_id,user_id FROM repository_job_registrations WHERE id=$1`, f.registrationID).Scan(&repositoryID, &userID))
	landingRequest, err := f.queries.CreateLandingRequest(ctx, db.CreateLandingRequestParams{
		RepositoryID: repositoryID, Title: "append", AuthorID: userID,
		TargetBookmark: "main", SourceBookmark: "work", StackSize: 1, AgentAuthored: true,
	})
	require.NoError(t, err)
	_, err = f.queries.AddLandingRequestChange(ctx, db.AddLandingRequestChangeParams{LandingRequestID: landingRequest.ID, ChangeID: changeID, PositionInStack: 0})
	require.NoError(t, err)
	// The agent's landing onto main carries its person's approval of this
	// exact revision (D-23), so only the CI receipt decides here.
	revisions, err := json.Marshal(map[string]approvalRevision{changeID: {CommitID: commitID, Seq: 1}})
	require.NoError(t, err)
	_, err = f.queries.CreateLandingRequestReview(ctx, db.CreateLandingRequestReviewParams{
		LandingRequestID: landingRequest.ID, ReviewerID: pgtype.Int8{Int64: userID, Valid: true},
		ReviewerKind: "human", Type: "approve", ChangeRevisions: revisions,
	})
	require.NoError(t, err)
	expectedCommitID := strings.Repeat("8", 40)
	appendRequest, err := json.Marshal(repohost.LandRequest{
		ChangeIDs: []string{commitID}, TargetBookmark: "main", ExpectedCommitID: &expectedCommitID, OperationKey: "landing/ci/advisory",
		Append: &repohost.LandAppend{SourceCommitID: commitID, SourceBaseCommitID: strings.Repeat("9", 40), Description: "append one reviewed change"},
	})
	require.NoError(t, err)
	_, err = f.queries.CreateLandingTask(ctx, db.CreateLandingTaskParams{LandingRequestID: landingRequest.ID, RepositoryID: repositoryID, Priority: 0, AppendRequest: appendRequest})
	require.NoError(t, err)
	host := &repositoryCiWorkerRepoHost{change: repohost.Change{ChangeID: changeID, CommitID: commitID, ParentChangeIDs: []string{}}}
	return NewLandingWorker(f.queries, host), host, landingRequest.ID
}

// repositoryCiWorkerRepoHost supplies the ownership checks the append path
// requires while retaining each request for end-to-end receipt assertions.
type repositoryCiWorkerRepoHost struct {
	change   repohost.Change
	landed   int
	requests []repohost.LandRequest
	lookups  []repohost.LandRequest
}

func (h *repositoryCiWorkerRepoHost) LandChanges(_ context.Context, _, _ string, req repohost.LandRequest) (repohost.LandResult, error) {
	if req.LookupOnly {
		h.lookups = append(h.lookups, req)
		return repohost.LandResult{}, &repohost.StatusError{StatusCode: 404, Code: "landing_receipt_missing"}
	}
	h.requests = append(h.requests, req)
	h.landed++
	return repohost.LandResult{LandedCount: len(req.ChangeIDs), TargetBookmark: req.TargetBookmark, TargetCommitID: strings.Repeat("d", 40)}, nil
}

func (h *repositoryCiWorkerRepoHost) GetChange(_ context.Context, _, _, _ string) (repohost.Change, error) {
	return h.change, nil
}

func (h *repositoryCiWorkerRepoHost) GetChangeFiles(_ context.Context, _, _, _ string) ([]repohost.ChangeFile, error) {
	return nil, nil
}

func (h *repositoryCiWorkerRepoHost) GetFileAtChange(_ context.Context, _, _, _, _ string) (repohost.FileContent, error) {
	return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404, Code: "not_found"}
}

func (h *repositoryCiWorkerRepoHost) ListBookmarks(_ context.Context, _, _ string, _ string, _ int) ([]repohost.Bookmark, string, error) {
	return []repohost.Bookmark{{Name: "main", TargetChangeID: "targetchange", TargetCommitID: strings.Repeat("e", 40)}}, "", nil
}

func TestRepositoryCiReceiptRawIdCharacterBoundary(t *testing.T) {
	t.Parallel()
	valid := RepositoryCheckReceiptInput{
		Repo: "owner/repo", WorkspaceID: uuid.NewString(), RegistrationID: uuid.NewString(), Revision: 1,
		Digest: strings.Repeat("a", 64), ExecutionDigest: strings.Repeat("b", 64), RunID: "run-1", ExecutionID: "exec-1",
		CommitID: strings.Repeat("c", 40), ChangeID: "change", BaseCommitID: strings.Repeat("d", 40), Gate: "passed",
	}
	// SetupCheckSchema bounds the raw id by JavaScript string length, i.e.
	// UTF-16 code units. One astral character costs two of them.
	const astral = "\U0001D11E"
	for name, id := range map[string]string{
		"ascii at the bound":  strings.Repeat("a", 100),
		"latin1 at the bound": strings.Repeat("é", 100),
		"astral at the bound": strings.Repeat(astral, 50),
	} {
		t.Run(name, func(t *testing.T) {
			require.Equal(t, 100, len(utf16.Encode([]rune(id))))
			input := valid
			input.Checks = []RepositoryCheckOutcome{{ID: id, Outcome: "passed"}}
			require.NoError(t, validateRepositoryCheckReceipt(uuid.NewString(), input),
				"a raw id accepted by the shared JS policy schema must remain reportable")
		})
	}
	for name, id := range map[string]string{
		"ascii over the bound":  strings.Repeat("a", 101),
		"latin1 over the bound": strings.Repeat("é", 101),
		"astral over the bound": strings.Repeat(astral, 51),
		"nul":                   "unit\x00check",
		"invalid utf-8":         "unit\xff\xfecheck",
	} {
		t.Run(name, func(t *testing.T) {
			input := valid
			input.Checks = []RepositoryCheckOutcome{{ID: id, Outcome: "passed"}}
			requireReceiptCode(t, validateRepositoryCheckReceipt(uuid.NewString(), input), pkgerrors.CodeBadRequest)
		})
	}
}

func TestRepositoryCiReceiptMissingChecksKeyIsMalformed(t *testing.T) {
	t.Parallel()
	valid := RepositoryCheckReceiptInput{
		Repo: "owner/repo", WorkspaceID: uuid.NewString(), RegistrationID: uuid.NewString(), Revision: 1,
		Digest: strings.Repeat("a", 64), ExecutionDigest: strings.Repeat("b", 64), RunID: "run-1", ExecutionID: "exec-1",
		CommitID: strings.Repeat("c", 40), ChangeID: "change", BaseCommitID: strings.Repeat("d", 40), Gate: "passed",
	}
	requireReceiptCode(t, validateRepositoryCheckReceipt(uuid.NewString(), valid), pkgerrors.CodeBadRequest)
	valid.Checks = []RepositoryCheckOutcome{}
	require.NoError(t, validateRepositoryCheckReceipt(uuid.NewString(), valid), "the empty array is the explicit form")
}

func TestRepositoryCiReceiptIntegrationAdvisoryOnlyPolicyAcceptsEmptyCoverage(t *testing.T) {
	f := repositoryCiReceiptEnvFor(t, repositoryCiAdvisoryOnlyPolicy, []RepositoryCheckOutcome{})
	ctx := context.Background()
	result, created, err := f.put(t, uuid.NewString(), nil)
	require.NoError(t, err, "a policy with no required rule is covered by an empty verified set")
	require.True(t, created)
	require.Equal(t, "repository-ci/"+f.registrationID+"@1."+f.digest[:12], result.Context)
	var stored json.RawMessage
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT checks FROM repository_ci_check_receipts WHERE context=$1`, result.Context).Scan(&stored))
	require.JSONEq(t, `[]`, string(stored))

	worker, host, _ := f.landingWorkerFor(t, f.input.CommitID, f.input.ChangeID)
	require.NoError(t, worker.PollOnce(ctx))
	require.Equal(t, 1, host.landed, "the reserved status the empty-coverage receipt wrote still satisfies the gate")
}

func TestRepositoryCiReceiptIntegrationAdvisoryOnlyPolicyRecordsAReportCheck(t *testing.T) {
	f := repositoryCiReceiptEnvFor(t, repositoryCiAdvisoryOnlyPolicy, []RepositoryCheckOutcome{{ID: "style", Outcome: "passed"}})
	result, created, err := f.put(t, uuid.NewString(), nil)
	require.NoError(t, err)
	require.True(t, created)
	var stored json.RawMessage
	require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT checks FROM repository_ci_check_receipts WHERE context=$1`, result.Context).Scan(&stored))
	require.JSONEq(t, `[{"id":"style","outcome":"passed"}]`, string(stored))
}

func TestRepositoryCiReceiptIntegrationEmptyCoverageUnderARequiredRuleIsRefused(t *testing.T) {
	f := repositoryCiReceiptEnvFor(t, repositoryCiRequiredPolicy, []RepositoryCheckOutcome{})
	_, _, err := f.put(t, uuid.NewString(), nil)
	requireReceiptCode(t, err, pkgerrors.CodeUnprocessableEntity)
	// Every other gate is still evaluated on the same request.
	_, _, err = f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) { i.RunID = "run-" + uuid.NewString() })
	requireReceiptCode(t, err, pkgerrors.CodeRepositoryCIRunUnverified)
	_, _, err = f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) { i.WorkspaceID = uuid.NewString() })
	requireReceiptCode(t, err, pkgerrors.CodeForbidden)
	_, _, err = f.put(t, uuid.NewString(), func(i *RepositoryCheckReceiptInput) { i.Revision = 9 })
	requireReceiptCode(t, err, pkgerrors.CodeConflict)
}

func TestRepositoryCiReceiptIntegrationAdvisoryPolicyGainingARequiredRuleRefusesTheOldStatus(t *testing.T) {
	f := repositoryCiReceiptEnvFor(t, repositoryCiAdvisoryOnlyPolicy, []RepositoryCheckOutcome{})
	ctx := context.Background()
	accepted, _, err := f.put(t, uuid.NewString(), nil)
	require.NoError(t, err)

	// The policy is replaced with one that has a required rule. A replacement
	// always renames the required context, so the earlier status stops counting.
	_, err = f.pool.Exec(ctx, `UPDATE repository_job_registrations SET revision=2, digest=$2, configuration=jsonb_set(configuration,'{input}',$3::jsonb) WHERE id=$1`,
		f.registrationID, strings.Repeat("e", 64), repositoryCiRequiredPolicy)
	require.NoError(t, err)

	worker, host, landingRequestID := f.landingWorkerFor(t, f.input.CommitID, f.input.ChangeID)
	require.NoError(t, worker.PollOnce(ctx))
	require.Zero(t, host.landed)
	task, err := f.queries.GetLandingTaskByLandingRequestID(ctx, landingRequestID)
	require.NoError(t, err)
	require.Contains(t, task.LastError.String, "repository-ci/"+f.registrationID+"@2."+strings.Repeat("e", 12))
	require.NotContains(t, task.LastError.String, accepted.Context)
}

func TestRepositoryCiReceiptIntegrationReplayAfterATransientRunUnverified(t *testing.T) {
	f := repositoryCiReceiptEnv(t)
	ctx := context.Background()
	requestID := uuid.NewString()
	// The Run acknowledgement was lost, so the dispatch does not yet carry the
	// run id the executing run reports.
	_, err := f.pool.Exec(ctx, `UPDATE repository_job_dispatches SET run_id='', status='dispatching' WHERE run_id=$1`, f.input.RunID)
	require.NoError(t, err)
	_, _, err = f.put(t, requestID, nil)
	requireReceiptCode(t, err, pkgerrors.CodeRepositoryCIRunUnverified)

	_, err = f.pool.Exec(ctx, `UPDATE repository_job_dispatches SET run_id=$1, status='submitted' WHERE run_id=''`, f.input.RunID)
	require.NoError(t, err)
	retried, created, err := f.put(t, requestID, nil)
	require.NoError(t, err)
	require.True(t, created)
	replay, createdAgain, err := f.put(t, requestID, nil)
	require.NoError(t, err)
	require.False(t, createdAgain)
	require.Equal(t, retried, replay)

	var receipts, statuses int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM repository_ci_check_receipts WHERE request_id=$1`, requestID).Scan(&receipts))
	require.Equal(t, 1, receipts)
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM commit_statuses WHERE context=$1`, retried.Context).Scan(&statuses))
	require.Equal(t, 1, statuses)
}
