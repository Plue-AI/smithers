// Package runtimeports owns values exchanged with optional execution and retained-storage adapters.
// It contains no deployment SQL or provider implementation.
package runtimeports

import (
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

type BindAlertRemediationJobWorkflowRunAtAttemptParams struct {
	WorkflowRunID    pgtype.Int8 `json:"workflow_run_id"`
	JobID            int64       `json:"job_id"`
	IncidentRowID    int64       `json:"incident_row_id"`
	DispatchToken    string      `json:"dispatch_token"`
	ExpectedAttempts int32       `json:"expected_attempts"`
}

type ClaimQueuedWorkflowRunsRow struct {
	ID                   int64              `json:"id"`
	RepositoryID         int64              `json:"repository_id"`
	WorkflowDefinitionID int64              `json:"workflow_definition_id"`
	TriggerRef           string             `json:"trigger_ref"`
	TriggerCommitSha     string             `json:"trigger_commit_sha"`
	ClaimToken           pgtype.UUID        `json:"claim_token"`
	ClaimGeneration      int64              `json:"claim_generation"`
	ClaimLeaseExpiresAt  pgtype.Timestamptz `json:"claim_lease_expires_at"`
}

type ClearPurgedStorageDeletionByExactKeyParams struct {
	RepositoryID  int64  `json:"repository_id"`
	AllocationKey string `json:"allocation_key"`
	ObjectKey     string `json:"object_key"`
}

type GetLatestReadySandboxEnvironmentImageParams struct {
	RepositoryID pgtype.Int8 `json:"repository_id"`
	Kind         string      `json:"kind"`
}

type HasStorageDeletionAllocationParams struct {
	RepositoryID  int64  `json:"repository_id"`
	AllocationKey string `json:"allocation_key"`
}

type ListOrphanedSandboxInstancesParams struct {
	MinAgeSeconds int64 `json:"min_age_seconds"`
	MaxRows       int32 `json:"max_rows"`
}

type ListOrphanedSandboxInstancesRow struct {
	ID            string      `json:"id"`
	ResourceKind  pgtype.Text `json:"resource_kind"`
	ResourceID    pgtype.Text `json:"resource_id"`
	ObservedState string      `json:"observed_state"`
	CreatedAt     time.Time   `json:"created_at"`
}

type ListSandboxEgressAuditByResourceParams struct {
	ResourceKind     string      `json:"resource_kind"`
	ResourceID       string      `json:"resource_id"`
	RepositoryID     pgtype.Int8 `json:"repository_id"`
	HasCursor        bool        `json:"has_cursor"`
	CursorOccurredAt time.Time   `json:"cursor_occurred_at"`
	CursorID         int64       `json:"cursor_id"`
	PageSize         int32       `json:"page_size"`
}

type MarkWorkflowRunFailureParams struct {
	ID              int64  `json:"id"`
	ClaimToken      string `json:"claim_token"`
	ClaimGeneration int64  `json:"claim_generation"`
}

type MarkWorkflowRunSuccessParams struct {
	ID              int64  `json:"id"`
	ClaimToken      string `json:"claim_token"`
	ClaimGeneration int64  `json:"claim_generation"`
}

type RenewWorkflowSandboxClaimParams struct {
	ID              int64  `json:"id"`
	ClaimToken      string `json:"claim_token"`
	ClaimGeneration int64  `json:"claim_generation"`
}

// RepoGateway is a retired box gateway's row (#2198), read only by the
// one-release convergence that discards it.
type RepoGateway struct {
	ID                  string             `json:"id"`
	RepositoryID        int64              `json:"repository_id"`
	UserID              int64              `json:"user_id"`
	WorkspaceID         pgtype.UUID        `json:"workspace_id"`
	VmID                string             `json:"vm_id"`
	BaseUrl             string             `json:"base_url"`
	AuthTokenHash       string             `json:"auth_token_hash"`
	AuthTokenCiphertext string             `json:"auth_token_ciphertext"`
	LandingTokenID      pgtype.Int8        `json:"landing_token_id"`
	Status              string             `json:"status"`
	LastActivityAt      time.Time          `json:"last_activity_at"`
	DeletedAt           pgtype.Timestamptz `json:"deleted_at"`
	CreatedAt           time.Time          `json:"created_at"`
	UpdatedAt           time.Time          `json:"updated_at"`
}

type RetireSandboxEnvironmentImageParams struct {
	ID           string      `json:"id"`
	RepositoryID pgtype.Int8 `json:"repository_id"`
}

type SandboxEgressAudit struct {
	ID                 int64           `json:"id"`
	SandboxID          string          `json:"sandbox_id"`
	ResourceKind       string          `json:"resource_kind"`
	ResourceID         string          `json:"resource_id"`
	RepositoryID       pgtype.Int8     `json:"repository_id"`
	OccurredAt         time.Time       `json:"occurred_at"`
	Host               string          `json:"host"`
	Method             string          `json:"method"`
	Path               string          `json:"path"`
	Status             int32           `json:"status"`
	Allowed            bool            `json:"allowed"`
	SwappedSecretNames []string        `json:"swapped_secret_names"`
	TransformSummary   json.RawMessage `json:"transform_summary"`
	CreatedAt          time.Time       `json:"created_at"`
}

type SandboxEnvironmentImage struct {
	ID             string      `json:"id"`
	RepositoryID   pgtype.Int8 `json:"repository_id"`
	Kind           string      `json:"kind"`
	Source         string      `json:"source"`
	SourceRevision string      `json:"source_revision"`
	ClosureHash    string      `json:"closure_hash"`
	Image          string      `json:"image"`
	Status         string      `json:"status"`
	CreatedBy      pgtype.Int8 `json:"created_by"`
	CreatedAt      time.Time   `json:"created_at"`
	UpdatedAt      time.Time   `json:"updated_at"`
}

type UpsertSandboxEnvironmentImageParams struct {
	RepositoryID   pgtype.Int8 `json:"repository_id"`
	Kind           string      `json:"kind"`
	Source         string      `json:"source"`
	SourceRevision string      `json:"source_revision"`
	ClosureHash    string      `json:"closure_hash"`
	Image          string      `json:"image"`
	CreatedBy      pgtype.Int8 `json:"created_by"`
}
