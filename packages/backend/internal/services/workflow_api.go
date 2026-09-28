package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// WorkflowAPIQuerier is the database interface required by WorkflowAPIService.
type WorkflowAPIQuerier interface {
	ListWorkflowDefinitionsByRepo(ctx context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error)
	GetWorkflowDefinition(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error)
	ListWorkflowRunsByRepo(ctx context.Context, arg db.ListWorkflowRunsByRepoParams) ([]db.WorkflowRun, error)
	ListWorkflowRunsByDefinition(ctx context.Context, arg db.ListWorkflowRunsByDefinitionParams) ([]db.WorkflowRun, error)
	GetWorkflowRun(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error)
	// SSE log streaming reads.
	ListWorkflowStepsByRunID(ctx context.Context, runID int64) ([]db.WorkflowStep, error)
	ListWorkflowLogsSince(ctx context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error)
}

// WorkflowAPIService provides read operations for workflow definitions and runs.
type WorkflowAPIService interface {
	GetWorkflowLogStreamHead(context.Context, int64) (int64, error)
	ListWorkflowDefinitions(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error)
	GetWorkflowDefinition(ctx context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error)
	ListWorkflowRunsByRepo(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowRun, error)
	ListWorkflowRunsByDefinition(ctx context.Context, repositoryID, definitionID int64, page, perPage int) ([]db.WorkflowRun, error)
	GetWorkflowRun(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error)
	DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error)
	InvokeWorkflow(ctx context.Context, input InvokeWorkflowInput) (*InvokeWorkflowResult, error)
	CancelWorkflowRun(ctx context.Context, repositoryID, runID int64) error
	RerunRun(ctx context.Context, input RerunInput) (*WorkflowRunResult, error)
	ResumeRun(ctx context.Context, repositoryID, runID int64) error
	// SSE log streaming reads -- required for WorkflowRunRouteService compliance.
	ListWorkflowSteps(ctx context.Context, runID int64) ([]db.WorkflowStep, error)
	ListWorkflowLogsSince(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error)
}

type workflowAPIService struct {
	queries WorkflowAPIQuerier
	runner  WorkflowRunService
	billing BillingPolicy
	invoker InvokedFlowInvoker
}

type WorkflowAPIServiceOption func(*workflowAPIService)

func WithWorkflowAPIBillingPolicy(policy BillingPolicy) WorkflowAPIServiceOption {
	return func(s *workflowAPIService) { s.billing = policy }
}

// WithWorkflowAPIFlowInvoker runs InvokeWorkflow on the canonical Flow runtime.
func WithWorkflowAPIFlowInvoker(invoker InvokedFlowInvoker) WorkflowAPIServiceOption {
	return func(s *workflowAPIService) { s.invoker = invoker }
}

// NewWorkflowAPIService creates a new WorkflowAPIService.
func NewWorkflowAPIService(queries WorkflowAPIQuerier, runner WorkflowRunService, opts ...WorkflowAPIServiceOption) WorkflowAPIService {
	s := &workflowAPIService{queries: queries, runner: runner}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// listWorkflowDefinitionsBatchSize is the DB page size used when scanning
// definitions for API listing. Repos hold at most a handful of workflow files
// (sync itself caps at 1000), so the scan is one query in practice.
const listWorkflowDefinitionsBatchSize = 200

func (s *workflowAPIService) ListWorkflowDefinitions(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error) {
	if s.queries == nil {
		return nil, pkgerrors.Internal("workflow store unavailable")
	}
	if perPage <= 0 {
		perPage = 30
	}
	skip := (page - 1) * perPage
	if skip < 0 {
		skip = 0
	}

	// Workflow sync soft-deletes removed workflow files by setting
	// is_active = FALSE; the listing must only surface live definitions,
	// mirroring the is_active check the dispatch path enforces. The underlying
	// query paginates over all rows, so filter and re-paginate over active
	// rows here to keep page boundaries correct.
	definitions := make([]db.WorkflowDefinition, 0, perPage)
	for offset := 0; ; offset += listWorkflowDefinitionsBatchSize {
		rows, err := s.queries.ListWorkflowDefinitionsByRepo(ctx, db.ListWorkflowDefinitionsByRepoParams{
			RepositoryID: repositoryID,
			PageOffset:   ClampInt32(offset),
			PageSize:     int32(listWorkflowDefinitionsBatchSize),
		})
		if err != nil {
			return nil, err
		}
		for _, def := range rows {
			if !def.IsActive {
				continue
			}
			if skip > 0 {
				skip--
				continue
			}
			definitions = append(definitions, def)
			if len(definitions) == perPage {
				return definitions, nil
			}
		}
		if len(rows) < listWorkflowDefinitionsBatchSize {
			return definitions, nil
		}
	}
}

func (s *workflowAPIService) GetWorkflowDefinition(ctx context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
	if s.queries == nil {
		return db.WorkflowDefinition{}, pkgerrors.Internal("workflow store unavailable")
	}
	def, err := s.queries.GetWorkflowDefinition(ctx, db.GetWorkflowDefinitionParams{
		ID:           definitionID,
		RepositoryID: repositoryID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.WorkflowDefinition{}, pkgerrors.NotFound("workflow definition not found")
		}
		return db.WorkflowDefinition{}, pkgerrors.Internal("failed to fetch workflow definition").WithCause(err)
	}
	return def, nil
}

func (s *workflowAPIService) ListWorkflowRunsByRepo(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowRun, error) {
	if s.queries == nil {
		return nil, pkgerrors.Internal("workflow store unavailable")
	}
	if perPage <= 0 {
		perPage = 30
	}
	offset := (page - 1) * perPage
	if offset < 0 {
		offset = 0
	}
	return s.queries.ListWorkflowRunsByRepo(ctx, db.ListWorkflowRunsByRepoParams{
		RepositoryID: repositoryID,
		PageOffset:   ClampInt32(offset),
		PageSize:     int32(perPage),
	})
}

func (s *workflowAPIService) ListWorkflowRunsByDefinition(ctx context.Context, repositoryID, definitionID int64, page, perPage int) ([]db.WorkflowRun, error) {
	if s.queries == nil {
		return nil, pkgerrors.Internal("workflow store unavailable")
	}
	if perPage <= 0 {
		perPage = 30
	}
	offset := (page - 1) * perPage
	if offset < 0 {
		offset = 0
	}
	return s.queries.ListWorkflowRunsByDefinition(ctx, db.ListWorkflowRunsByDefinitionParams{
		WorkflowDefinitionID: definitionID,
		RepositoryID:         repositoryID,
		PageOffset:           ClampInt32(offset),
		PageSize:             int32(perPage),
	})
}

func (s *workflowAPIService) GetWorkflowRun(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
	if s.queries == nil {
		return db.WorkflowRun{}, pkgerrors.Internal("workflow store unavailable")
	}
	run, err := s.queries.GetWorkflowRun(ctx, db.GetWorkflowRunParams{
		ID:           runID,
		RepositoryID: repositoryID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.WorkflowRun{}, pkgerrors.NotFound("workflow run not found")
		}
		return db.WorkflowRun{}, pkgerrors.Internal("failed to fetch workflow run").WithCause(err)
	}
	return run, nil
}

func (s *workflowAPIService) DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
	if s.runner == nil {
		return nil, pkgerrors.Internal("workflow run service unavailable")
	}
	return s.runner.DispatchForEvent(ctx, input)
}

func (s *workflowAPIService) CancelWorkflowRun(ctx context.Context, repositoryID, runID int64) error {
	if s.runner == nil {
		return pkgerrors.Internal("workflow run service unavailable")
	}
	// An invoked run's Flow launch is cancelled in the same transaction
	// (WorkflowRunCancelParticipant).
	return s.runner.CancelRun(ctx, repositoryID, runID)
}

func (s *workflowAPIService) RerunRun(ctx context.Context, input RerunInput) (*WorkflowRunResult, error) {
	if s.runner == nil {
		return nil, pkgerrors.Internal("workflow run service unavailable")
	}
	return s.runner.RerunRun(ctx, input)
}

func (s *workflowAPIService) ResumeRun(ctx context.Context, repositoryID, runID int64) error {
	if s.runner == nil {
		return pkgerrors.Internal("workflow run service unavailable")
	}
	return s.runner.ResumeRun(ctx, repositoryID, runID)
}

func (s *workflowAPIService) ListWorkflowSteps(ctx context.Context, runID int64) ([]db.WorkflowStep, error) {
	if s.queries == nil {
		return nil, pkgerrors.Internal("workflow store unavailable")
	}
	return s.queries.ListWorkflowStepsByRunID(ctx, runID)
}

func (s *workflowAPIService) ListWorkflowLogsSince(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error) {
	if s.queries == nil {
		return nil, pkgerrors.Internal("workflow store unavailable")
	}
	return s.queries.ListWorkflowLogsSince(ctx, db.ListWorkflowLogsSinceParams{
		RunID:    runID,
		AfterID:  afterID,
		PageSize: limit,
	})
}

// ValidateDispatchInputs validates user-provided inputs against the workflow
// definition's workflow_dispatch trigger input schema. It checks for:
//   - Required inputs that are missing
//   - Inputs that are not defined in the schema (unknown keys)
//   - Applies default values for inputs that have them
//
// Returns the merged inputs map (user inputs + defaults) and an error if validation fails.
func ValidateDispatchInputs(configJSON json.RawMessage, userInputs map[string]interface{}) (map[string]interface{}, error) {
	if len(configJSON) == 0 {
		if len(userInputs) > 0 {
			return nil, pkgerrors.BadRequest("workflow does not accept dispatch inputs")
		}
		return nil, nil
	}

	var cfg WorkflowTriggerConfig
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return nil, pkgerrors.Internal("failed to parse workflow config").WithCause(err)
	}

	if cfg.On.WorkflowDispatch == nil {
		if len(userInputs) > 0 {
			return nil, pkgerrors.BadRequest("workflow does not accept dispatch inputs")
		}
		return nil, nil
	}

	definedInputs := cfg.On.WorkflowDispatch.Inputs
	if definedInputs == nil {
		// Workflow dispatch is defined but has no inputs schema — accept any user inputs.
		return userInputs, nil
	}

	// Build result with defaults, then override with user inputs.
	result := make(map[string]interface{})

	// Validate that all user inputs are defined in the schema.
	for key := range userInputs {
		if _, ok := definedInputs[key]; !ok {
			return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "WorkflowDispatch",
				Field:    key,
				Code:     "invalid",
			})
		}
	}

	// Process each defined input: apply defaults, check required.
	for key, inputSpec := range definedInputs {
		specMap, ok := inputSpec.(map[string]interface{})
		if !ok {
			continue
		}

		userVal, hasUserVal := userInputs[key]

		if hasUserVal {
			result[key] = userVal
			continue
		}

		// Check for default value.
		if defaultVal, hasDefault := specMap["default"]; hasDefault {
			result[key] = defaultVal
			continue
		}

		// Check if required.
		if required, ok := specMap["required"]; ok {
			if reqBool, ok := required.(bool); ok && reqBool {
				return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
					Resource: "WorkflowDispatch",
					Field:    key,
					Code:     "missing_field",
				})
			}
		}
	}

	return result, nil
}
