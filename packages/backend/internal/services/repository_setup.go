package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const repositorySetupBinding = "repository-setup"

type RepositorySetupDispatcher interface {
	AdmitInTx(context.Context, pgx.Tx, flowdispatch.LaunchRequest) (jobs.RequestReceipt, error)
}
type RepositorySetupWorkspace interface {
	CreateWorkspace(context.Context, CreateWorkspaceInput) (WorkspaceResponse, error)
}
type RepositorySetupService struct {
	pool           *pgxpool.Pool
	repositoryJobs *RepositoryJobService
	workspaces     RepositorySetupWorkspace
	dispatcher     RepositorySetupDispatcher
}

func NewRepositorySetupService(pool *pgxpool.Pool, repositoryJobs *RepositoryJobService, workspaces RepositorySetupWorkspace) *RepositorySetupService {
	return &RepositorySetupService{pool: pool, repositoryJobs: repositoryJobs, workspaces: workspaces}
}
func (s *RepositorySetupService) SetFlowDispatcher(dispatcher RepositorySetupDispatcher) {
	s.dispatcher = dispatcher
}

type SetupRecord struct {
	ID                       string
	UserID, RepositoryID     int64
	Input                    SetupInput
	OperationID, WorkspaceID string
	Response                 SetupResponse
	Terminal                 bool
	ObservationError         string
}

const setupColumns = "id::text,user_id,repository_id,input,operation_id::text,COALESCE(workspace_id::text,''),response,terminal,observation_error"

func scanSetup(row pgx.Row) (SetupRecord, error) {
	var value SetupRecord
	var input, response []byte
	err := row.Scan(&value.ID, &value.UserID, &value.RepositoryID, &input, &value.OperationID, &value.WorkspaceID, &response, &value.Terminal, &value.ObservationError)
	if err != nil {
		return value, err
	}
	if json.Unmarshal(input, &value.Input) != nil || json.Unmarshal(response, &value.Response) != nil {
		return value, fmt.Errorf("invalid persisted setup request")
	}
	return value, nil
}
func (s *RepositorySetupService) authorize(ctx context.Context, repoID, userID int64, write bool) error {
	if s == nil || s.pool == nil || s.repositoryJobs == nil {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Repository setup unavailable")
	}
	_, err := s.repositoryJobs.authorizedRepo(ctx, repoID, userID, write)
	return err
}
func setupInitial(input SetupInput) SetupResponse {
	return SetupResponse{RequestID: input.RequestID, Revision: input.Revision, Digest: input.Digest, WorkspaceID: input.WorkspaceID, Receipt: &SetupReceipt{RequestID: input.RequestID, Revision: input.Revision, Digest: input.Digest, Operation: input.Operation, Phase: "queued", UpdatedAt: time.Now().UnixMilli(), Results: []SetupEvalResult{}, Evidence: []string{}}}
}
func setupSameInput(stored, input SetupInput, workspace string) bool {
	// A poll may return the worker-selected workspace. That pin may be sent on a
	// reconnect without changing the already admitted request.
	if input.WorkspaceID == workspace && workspace != "" {
		input.WorkspaceID = stored.WorkspaceID
	}
	left, _ := setupJSON(stored)
	right, _ := setupJSON(input)
	return string(left) == string(right)
}

// Request commits the product intent and shared dispatcher admission in one
// transaction. It never contacts a runtime, provisions a workspace, or waits
// for the Flow. Duplicate requests join this durable record.
func (s *RepositorySetupService) Request(ctx context.Context, repoID, userID int64, input SetupInput) (SetupRecord, error) {
	if err := ValidateSetupInput(&input); err != nil {
		return SetupRecord{}, pkgerrors.BadRequest(err.Error())
	}
	if err := s.authorize(ctx, repoID, userID, true); err != nil {
		return SetupRecord{}, err
	}
	repositoryName, err := s.repositoryJobs.repositoryName(ctx, db.RepositoryJobRegistration{RepositoryID: repoID, UserID: userID})
	if err != nil {
		return SetupRecord{}, err
	}
	if input.Repo != repositoryName {
		return SetupRecord{}, pkgerrors.BadRequest("Setup repository identity differs")
	}
	if s.dispatcher == nil {
		return SetupRecord{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Repository setup dispatcher unavailable")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SetupRecord{}, err
	}
	defer tx.Rollback(ctx)
	// Serialize request identity before generating a binding ID. The persisted
	// unique key remains authoritative even if advisory hashes collide.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, fmt.Sprintf("repository-setup:%d:%s", userID, input.RequestID)); err != nil {
		return SetupRecord{}, err
	}
	old, err := scanSetup(tx.QueryRow(ctx, "SELECT "+setupColumns+" FROM repository_setup_requests WHERE user_id=$1 AND request_id=$2", userID, input.RequestID))
	if err == nil {
		if old.RepositoryID != repoID || !setupSameInput(old.Input, input, old.WorkspaceID) {
			return SetupRecord{}, pkgerrors.New(pkgerrors.CodeSetupRequestReused, "Setup request was already used for another operation")
		}
		return old, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return SetupRecord{}, err
	}
	if input.WorkspaceID != "" {
		_, err = db.New(tx).GetWorkspaceForUserRepo(ctx, db.GetWorkspaceForUserRepoParams{ID: input.WorkspaceID, RepositoryID: repoID, UserID: userID})
		if err != nil {
			return SetupRecord{}, pkgerrors.NotFound("Workspace unavailable")
		}
	}
	id := uuid.NewString()
	payload, _ := setupJSON(input)
	projection, _ := json.Marshal(map[string]string{"kind": repositorySetupBinding, "id": id})
	auth, _ := json.Marshal(map[string]any{"repositoryId": repoID, "userId": userID, "setupRequestId": id})
	receipt, err := s.dispatcher.AdmitInTx(ctx, tx, flowdispatch.LaunchRequest{Scope: repositoryJobFlowScope(repoID, userID), RequestID: "repository-setup:" + input.RequestID, Target: flowruntime.Target{BindingKind: repositorySetupBinding, BindingID: id, WorkspaceID: input.WorkspaceID}, FlowID: "repository/setup", Payload: payload, Projection: projection, AuthorizationContext: auth, ApprovalPolicy: flowdispatch.ApprovalAuto})
	if err != nil {
		return SetupRecord{}, err
	}
	response := setupInitial(input)
	encoded, _ := json.Marshal(response)
	value, err := scanSetup(tx.QueryRow(ctx, `INSERT INTO repository_setup_requests(id,user_id,repository_id,request_id,job,input,operation_id,workspace_id,response) VALUES($1,$2,$3,$4,$5,$6,$7,NULLIF($8,'')::uuid,$9) RETURNING `+setupColumns, id, userID, repoID, input.RequestID, input.Job, payload, receipt.OperationID, input.WorkspaceID, encoded))
	if err != nil {
		return SetupRecord{}, err
	}
	return value, tx.Commit(ctx)
}

// Read and Recover are database projections; neither can start or revive a VM.
func (s *RepositorySetupService) Read(ctx context.Context, repoID, userID int64, repo, job, requestID string) (SetupRecord, error) {
	if err := s.authorize(ctx, repoID, userID, false); err != nil {
		return SetupRecord{}, err
	}
	record, err := scanSetup(s.pool.QueryRow(ctx, "SELECT "+setupColumns+" FROM repository_setup_requests WHERE user_id=$1 AND repository_id=$2 AND request_id=$3 AND job=$4", userID, repoID, requestID, job))
	if errors.Is(err, pgx.ErrNoRows) || err == nil && record.Input.Repo != repo {
		return SetupRecord{}, pkgerrors.NotFound("Setup request not found")
	}
	return record, err
}
func (s *RepositorySetupService) latest(ctx context.Context, repoID, userID int64, job string) (SetupRecord, error) {
	return scanSetup(s.pool.QueryRow(ctx, "SELECT "+setupColumns+" FROM repository_setup_requests WHERE user_id=$1 AND repository_id=$2 AND job=$3 ORDER BY created_at DESC,id DESC LIMIT 1", userID, repoID, job))
}

// ResolveFlowHostTarget is called only by the shared jobs dispatcher. It selects
// the coding catalog from the fixed repository/setup operation, never from a
// caller-supplied catalog or host address.
func (s *RepositorySetupService) ResolveFlowHostTarget(ctx context.Context, target flowruntime.Target) (flowhost.Authority, error) {
	refuse := func(code string, retry bool) (flowhost.Authority, error) {
		return flowhost.Authority{}, repositoryJobFlowFailure{code: code, retryable: retry}
	}
	if target.BindingKind != repositorySetupBinding || target.BindingID == "" {
		return refuse("runtime_target_unsupported", false)
	}
	repoID, ok := scopedFlowRuntimeID(target.TenantID, "repository:")
	userID, userOK := scopedFlowRuntimeID(target.PrincipalID, "user:")
	if !ok || !userOK {
		return refuse("runtime_target_invalid", false)
	}
	record, err := scanSetup(s.pool.QueryRow(ctx, "SELECT "+setupColumns+" FROM repository_setup_requests WHERE id=$1", target.BindingID))
	if err != nil {
		return refuse("runtime_target_not_found", !errors.Is(err, pgx.ErrNoRows))
	}
	if record.UserID != userID || record.RepositoryID != repoID || target.WorkspaceID != record.Input.WorkspaceID {
		return refuse("runtime_target_forbidden", false)
	}
	if err = s.authorize(ctx, repoID, userID, true); err != nil {
		return refuse("runtime_target_forbidden", false)
	}
	repositoryName, err := s.repositoryJobs.repositoryName(ctx, db.RepositoryJobRegistration{RepositoryID: repoID, UserID: userID})
	if err != nil || record.Input.Repo != repositoryName {
		return refuse("runtime_repository_changed", false)
	}
	workspaceID := record.WorkspaceID
	if workspaceID == "" {
		if s.workspaces == nil {
			return refuse("runtime_workspace_unavailable", true)
		}
		owner, name, _ := strings.Cut(record.Input.Repo, "/")
		workspace, createErr := s.workspaces.CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: repoID, UserID: userID, RepoOwner: owner, RepoName: name, Kind: "vm"})
		if createErr != nil {
			return flowhost.Authority{}, createErr
		}
		if workspace.Status != "running" {
			return refuse("runtime_workspace_not_ready", true)
		}
		// Setup runs on the repository's own box: every box runs the catalog's
		// pinned coding host, so any box serves it. The primary box's
		// find-or-create deduplicates provisioning; keep the first selected
		// identity immutable if two recovered deliveries race.
		err = s.pool.QueryRow(ctx, `UPDATE repository_setup_requests SET workspace_id=COALESCE(workspace_id,$2::uuid),updated_at=clock_timestamp() WHERE id=$1 RETURNING workspace_id::text`, record.ID, workspace.ID).Scan(&workspaceID)
		if err != nil {
			return refuse("runtime_binding_unavailable", true)
		}
	}
	workspace, err := db.New(s.pool).GetWorkspaceForUserRepo(ctx, db.GetWorkspaceForUserRepoParams{ID: workspaceID, RepositoryID: repoID, UserID: userID})
	if err != nil || workspace.DeletedAt.Valid {
		return refuse("runtime_workspace_unavailable", false)
	}
	return flowhost.Authority{Target: target, RepositoryID: repoID, UserID: userID, WorkspaceID: workspaceID, CatalogKey: flowhost.CatalogCoding}, nil
}
func (s *RepositorySetupService) ProjectFlowRuntime(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	var correlation struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	}
	if json.Unmarshal(update.Checkpoint.Projection, &correlation) != nil || correlation.Kind != repositorySetupBinding {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	record, err := scanSetup(tx.QueryRow(ctx, "SELECT "+setupColumns+" FROM repository_setup_requests WHERE id=$1 FOR UPDATE", correlation.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		// Repository deletion removes its setup correlation. A late runtime
		// observation has no product row left to update; retrying it cannot
		// recreate the deleted repository or its receipt.
		return nil
	}
	if err != nil {
		return err
	}
	checkpoint := update.Checkpoint
	scope := repositoryJobFlowScope(record.RepositoryID, record.UserID)
	if update.OperationID != record.OperationID || update.Scope != scope || checkpoint.Target.TenantID != scope.TenantID || checkpoint.Target.PrincipalID != scope.PrincipalID || checkpoint.Target.BindingKind != repositorySetupBinding || checkpoint.Target.BindingID != record.ID || checkpoint.Target.WorkspaceID != record.Input.WorkspaceID || checkpoint.FlowID != "repository/setup" {
		return fmt.Errorf("setup runtime correlation differs")
	}
	if record.Terminal {
		return tx.Commit(ctx)
	}
	response := setupInitial(record.Input)
	response.WorkspaceID = record.WorkspaceID
	receipt := response.Receipt
	receipt.RunID = checkpoint.RunID
	observationError := ""
	terminal := false
	if checkpoint.Run != nil {
		if checkpoint.Run.RunID != checkpoint.RunID || checkpoint.Run.FlowID != "repository/setup" {
			return fmt.Errorf("setup run identity differs")
		}
		switch checkpoint.Run.Status {
		case "completed":
			if checkpoint.Run.FinalOutput == nil {
				observationError = "Setup completed without a verified result"
			} else {
				output, outputErr := validateSetupOutput(record.Input, record.WorkspaceID, checkpoint.RunID, *checkpoint.Run.FinalOutput)
				if outputErr != nil {
					observationError = "Setup result could not be verified"
				} else {
					response = output
					terminal = true
				}
			}
		case "failed":
			receipt.Phase = "failed"
			receipt.Error = "Repository setup failed"
			terminal = true
		case "cancelled":
			receipt.Phase = "stopped"
			terminal = true
		case "waiting", "waiting-approval", "parked":
			receipt.Phase = "waiting"
		default:
			receipt.Phase = "running"
		}
	} else if checkpoint.RunID != "" {
		receipt.Phase = "running"
	}
	if !terminal && update.State.Terminal() {
		terminal = true
		if update.State == jobs.StateCancelled {
			receipt.Phase = "stopped"
		} else {
			receipt.Phase = "failed"
			receipt.Error = "Repository setup failed"
		}
		if observationError != "" {
			receipt.Error = observationError
		}
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE repository_setup_requests SET response=$2,terminal=$3,observation_error=$4,updated_at=clock_timestamp() WHERE id=$1`, record.ID, encoded, terminal, observationError)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type SetupRegistration struct {
	RegistrationID string         `json:"registrationId"`
	WorkspaceID    string         `json:"workspaceId"`
	Revision       int64          `json:"revision"`
	Digest         string         `json:"digest"`
	SourceRevision string         `json:"sourceRevision"`
	Enabled        bool           `json:"enabled"`
	Owned          bool           `json:"owned"`
	Draft          SetupDraft     `json:"draft"`
	Schedule       *SetupSchedule `json:"schedule,omitempty"`
}
type SetupSchedule struct {
	Expression string `json:"expression"`
	NextFireAt string `json:"nextFireAt"`
}
type SetupRegistrationState struct {
	State  string             `json:"state"`
	Active *SetupRegistration `json:"active,omitempty"`
	Trial  *SetupRegistration `json:"trial,omitempty"`
	Error  string             `json:"error,omitempty"`
}
type SetupRecoveryState struct {
	State            string         `json:"state"`
	Input            *SetupInput    `json:"input,omitempty"`
	Result           *SetupResponse `json:"result,omitempty"`
	ObservationError string         `json:"observationError,omitempty"`
	Error            string         `json:"error,omitempty"`
}
type SetupRecovery struct {
	Owner        string                 `json:"owner"`
	Repo         string                 `json:"repo"`
	Job          string                 `json:"job"`
	Registration SetupRegistrationState `json:"registration"`
	Setup        SetupRecoveryState     `json:"setup"`
}

func (s *RepositorySetupService) registration(ctx context.Context, repoID, userID int64, repo, job string) SetupRegistrationState {
	unavailable := SetupRegistrationState{State: "unavailable", Error: "Repository registration state is unavailable"}
	rows, err := s.repositoryJobs.List(ctx, repoID, userID)
	if err != nil {
		return unavailable
	}
	state := SetupRegistrationState{State: "known"}
	count := 0
	for _, row := range rows {
		if row.Job != job {
			continue
		}
		count++
		if count > 50 {
			return unavailable
		}
		var config RegisterRepositoryJobInput
		if json.Unmarshal(row.Configuration, &config) != nil {
			return unavailable
		}
		var draft SetupDraft
		redacted := false
		var fields map[string]json.RawMessage
		if json.Unmarshal(config.Input, &fields) != nil {
			return unavailable
		}
		var cases []map[string]json.RawMessage
		if json.Unmarshal(fields["cases"], &cases) != nil {
			return unavailable
		}
		if len(cases) > 0 {
			redacted = true
			for _, c := range cases {
				for key := range c {
					if !setupOne(key, "id", "name", "required") {
						redacted = false
					}
				}
			}
			if redacted {
				fields["cases"] = json.RawMessage(`[]`)
				config.Input, _ = json.Marshal(fields)
			}
		}
		if json.Unmarshal(config.Input, &draft) != nil || draft.validate() != nil {
			return unavailable
		}
		identity := SetupInput{Repo: repo, Job: job, Revision: row.Revision, Draft: draft}
		if !setupOne(row.Mode, "enabled", "trial") || row.FlowID != "repository-jobs/"+job || config.Repo != repo || config.WorkspaceID != row.WorkspaceID || config.SourceRevision != row.SourceRevision || config.FlowID != row.FlowID || config.Mode != row.Mode || config.Revision != row.Revision || config.Digest != row.Digest || row.Schedule != config.Schedule || row.Mode == "enabled" && job == "chores" && row.Schedule != draft.Schedule || !redacted && row.Digest != setupCandidateDigest(identity, false) && row.Digest != setupCandidateDigest(identity, true) {
			return unavailable
		}
		value := &SetupRegistration{RegistrationID: row.ID, WorkspaceID: row.WorkspaceID, Revision: row.Revision, Digest: row.Digest, SourceRevision: row.SourceRevision, Enabled: row.Enabled, Owned: !redacted && row.UserID == userID, Draft: draft}
		if job == "chores" && row.Mode == "enabled" && row.Enabled && row.Schedule != "" && row.NextFireAt.Valid {
			value.Schedule = &SetupSchedule{Expression: row.Schedule, NextFireAt: row.NextFireAt.Time.UTC().Format(time.RFC3339Nano)}
		}
		if row.Mode == "enabled" {
			if state.Active != nil {
				return unavailable
			}
			state.Active = value
		} else {
			if state.Trial != nil {
				return unavailable
			}
			state.Trial = value
		}
	}
	return state
}
func (s *RepositorySetupService) Recover(ctx context.Context, repoID, userID int64, owner, repo, job string) (SetupRecovery, error) {
	result := SetupRecovery{Owner: owner, Repo: repo, Job: job}
	if err := s.authorize(ctx, repoID, userID, false); err != nil {
		return result, err
	}
	result.Registration = s.registration(ctx, repoID, userID, repo, job)
	record, err := s.latest(ctx, repoID, userID, job)
	if errors.Is(err, pgx.ErrNoRows) {
		result.Setup = SetupRecoveryState{State: "none"}
	} else if err != nil || record.Input.Repo != repo {
		result.Setup = SetupRecoveryState{State: "unavailable", Error: "Setup recovery storage is unavailable"}
	} else {
		result.Setup = SetupRecoveryState{State: "found", Input: &record.Input, Result: &record.Response, ObservationError: record.ObservationError}
	}
	return result, nil
}
