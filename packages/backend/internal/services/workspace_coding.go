package services

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// WorkspaceCodingRevision is native JJ identity. Kind=conflicted has TreeTerms
// instead of TreeID and cannot be used as an expected accepted revision.
type WorkspaceCodingRevision struct {
	Kind            string                    `json:"kind,omitempty"`
	ChangeID        string                    `json:"changeId"`
	CommitID        string                    `json:"commitId"`
	TreeID          string                    `json:"treeId,omitempty"`
	OperationID     string                    `json:"operationId"`
	ParentCommitIDs []string                  `json:"parentCommitIds"`
	Description     string                    `json:"description,omitempty"`
	Empty           bool                      `json:"empty,omitempty"`
	TreeTerms       []WorkspaceCodingTreeTerm `json:"treeTerms,omitempty"`
}

type WorkspaceCodingTreeTerm struct {
	TreeID   string `json:"treeId"`
	Positive bool   `json:"positive"`
}

// WorkspaceCodingInput is one opinionated native command. RequestID identifies
// an invocation for replay; it never substitutes for a native change ID.
type WorkspaceCodingInput struct {
	Operation           string                   `json:"operation"`
	RequestID           string                   `json:"requestId"`
	ExpectedOperationID string                   `json:"expectedOperationId"`
	Target              WorkspaceCodingRevision  `json:"target"`
	Source              *WorkspaceCodingRevision `json:"source,omitempty"`
	After               *WorkspaceCodingRevision `json:"after,omitempty"`
	Description         *string                  `json:"description,omitempty"`
	Files               []WorkspaceCodingFile    `json:"files,omitempty"`
}

type WorkspaceCodingFile struct {
	Path         string  `json:"path"`
	BeforeDigest *string `json:"beforeDigest"`
	Content      *string `json:"content"`
}

type WorkspaceCodingRecovery struct {
	RequestID string                        `json:"requestId"`
	Path      string                        `json:"path"`
	Files     []WorkspaceCodingRecoveryFile `json:"files"`
}

type WorkspaceCodingRecoveryFile struct {
	Path     string  `json:"path"`
	Preimage *string `json:"preimage"`
	Proposed *string `json:"proposed"`
}

type WorkspaceCodingResult struct {
	Status            string                    `json:"status"`
	Capabilities      []string                  `json:"capabilities,omitempty"`
	Replayed          bool                      `json:"replayed,omitempty"`
	OperationID       string                    `json:"operationId"`
	ParentOperationID string                    `json:"parentOperationId,omitempty"`
	Timestamp         time.Time                 `json:"timestamp,omitempty"`
	Head              *WorkspaceCodingRevision  `json:"head,omitempty"`
	Revision          *WorkspaceCodingRevision  `json:"revision,omitempty"`
	Revisions         []WorkspaceCodingRevision `json:"revisions,omitempty"`
	Recovery          *WorkspaceCodingRecovery  `json:"recovery,omitempty"`
}

// WorkspaceCodingProjection is a bounded replay of immutable native operation
// metadata carried by the existing head reporter. It has no independent ID.
type WorkspaceCodingProjection struct {
	Operation         string    `json:"operation"`
	OperationID       string    `json:"operationId"`
	ParentOperationID string    `json:"parentOperationId"`
	Timestamp         time.Time `json:"timestamp"`
	ChangeIDs         []string  `json:"changeIds"`
}

func validateCodingProjections(projections []WorkspaceCodingProjection) error {
	if len(projections) > 20 {
		return pkgerrors.BadRequest("at most 20 native coding operations may be projected per head report")
	}
	for _, p := range projections {
		switch p.Operation {
		case "create", "snapshot", "describe", "amend", "reorder", "edit", "apply_files":
		default:
			return pkgerrors.BadRequest("unsupported native coding projection")
		}
		if !codingOpID.MatchString(p.OperationID) || !codingOpID.MatchString(p.ParentOperationID) || p.Timestamp.IsZero() || len(p.ChangeIDs) == 0 || len(p.ChangeIDs) > 1000 {
			return pkgerrors.BadRequest("coding projection requires exact native IDs, time, and affected changes")
		}
		for _, id := range p.ChangeIDs {
			if !codingChangeID.MatchString(id) {
				return pkgerrors.BadRequest("coding projection requires full native change IDs")
			}
		}
	}
	return nil
}

var (
	codingChangeID = regexp.MustCompile(`^[k-z]{32}$`)
	codingCommitID = regexp.MustCompile(`^[0-9a-f]{40}$`)
	codingOpID     = regexp.MustCompile(`^[0-9a-f]{128}$`)
	codingFileHash = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func validateCodingRevision(revision WorkspaceCodingRevision, operationID string) error {
	if !codingChangeID.MatchString(revision.ChangeID) || !codingCommitID.MatchString(revision.CommitID) ||
		!codingCommitID.MatchString(revision.TreeID) || revision.OperationID != operationID ||
		len(revision.ParentCommitIDs) != 1 || !codingCommitID.MatchString(revision.ParentCommitIDs[0]) ||
		(revision.Kind != "" && revision.Kind != "resolved") || len(revision.TreeTerms) != 0 {
		return pkgerrors.BadRequest("expected revision must contain exact resolved native JJ IDs and one parent")
	}
	return nil
}

func validateCodingInput(input WorkspaceCodingInput) error {
	id, err := uuid.Parse(input.RequestID)
	if err != nil || id == uuid.Nil || id.String() != input.RequestID || !codingOpID.MatchString(input.ExpectedOperationID) {
		return pkgerrors.BadRequest("requestId must be a canonical nonzero UUID and expectedOperationId a full native ID")
	}
	if err := validateCodingRevision(input.Target, input.ExpectedOperationID); err != nil {
		return err
	}
	if input.Operation != "apply_files" && input.Files != nil {
		return pkgerrors.BadRequest("file edits are only valid for apply_files")
	}
	switch input.Operation {
	case "apply_files":
		if input.Source != nil || input.After != nil || input.Description != nil {
			return pkgerrors.BadRequest("apply_files requires only its target and file edits")
		}
		return validateCodingFiles(input.Files)
	case "create", "describe":
		if input.Description == nil || len(*input.Description) > 16<<10 || strings.IndexByte(*input.Description, 0) >= 0 || input.Source != nil || input.After != nil {
			return pkgerrors.BadRequest("create/describe require only a bounded description and target")
		}
	case "snapshot", "edit":
		if input.Source != nil || input.After != nil || input.Description != nil {
			return pkgerrors.BadRequest("snapshot/edit require only a target")
		}
	case "amend", "reorder":
		other := input.Source
		if input.Operation == "reorder" {
			other = input.After
		}
		if other == nil || input.Description != nil || (input.Operation == "amend" && input.After != nil) || (input.Operation == "reorder" && input.Source != nil) {
			return pkgerrors.BadRequest("amend requires source; reorder requires after")
		}
		return validateCodingRevision(*other, input.ExpectedOperationID)
	default:
		return pkgerrors.BadRequest("unsupported coding operation")
	}
	return nil
}

func validateCodingFiles(files []WorkspaceCodingFile) error {
	if len(files) == 0 || len(files) > 30 {
		return pkgerrors.BadRequest("apply_files requires 1 to 30 file edits")
	}
	paths, size := map[string]bool{}, 0
	for _, file := range files {
		if file.Path == "" || len(file.Path) > 4096 || strings.Contains(file.Path, "\\") || paths[file.Path] {
			return pkgerrors.BadRequest("file paths must be distinct canonical relative paths")
		}
		for _, character := range file.Path {
			if character < 32 || character == 127 {
				return pkgerrors.BadRequest("file path contains control characters")
			}
		}
		for _, component := range strings.Split(file.Path, "/") {
			if component == "" || component == "." || component == ".." || component == ".jj" || component == ".git" {
				return pkgerrors.BadRequest("file paths cannot enter native metadata or leave the repository")
			}
		}
		if file.BeforeDigest != nil && !codingFileHash.MatchString(*file.BeforeDigest) {
			return pkgerrors.BadRequest("file preimages require SHA256 or null")
		}
		if file.Content == nil && file.BeforeDigest == nil {
			return pkgerrors.BadRequest("each file edit must change its preimage")
		}
		if file.Content != nil {
			size += len(*file.Content)
			if file.BeforeDigest != nil && fmt.Sprintf("%x", sha256.Sum256([]byte(*file.Content))) == *file.BeforeDigest {
				return pkgerrors.BadRequest("each file edit must change its preimage")
			}
		}
		paths[file.Path] = true
	}
	if size > 256<<10 {
		return pkgerrors.BadRequest("file edit contents exceed 256 KiB")
	}
	for name := range paths {
		parts := strings.Split(name, "/")
		for i := 1; i < len(parts); i++ {
			if paths[strings.Join(parts[:i], "/")] {
				return pkgerrors.BadRequest("file edits overlap ancestor paths")
			}
		}
	}
	return nil
}

// ReadCodingRevisions inspects immutable native revisions without snapshotting
// working files. The normal head reporter or explicit snapshot action records
// files before the caller binds a plan to a revision.
func (s *WorkspaceService) ReadCodingRevisions(ctx context.Context, workspaceID string, repositoryID, userID int64, changeIDs []string) (WorkspaceCodingResult, error) {
	if len(changeIDs) > 100 {
		return WorkspaceCodingResult{}, pkgerrors.BadRequest("at most 100 change IDs may be read")
	}
	for _, id := range changeIDs {
		if !codingChangeID.MatchString(id) {
			return WorkspaceCodingResult{}, pkgerrors.BadRequest("full native change IDs are required")
		}
	}
	if changeIDs == nil {
		changeIDs = []string{}
	}
	return s.executeCoding(ctx, workspaceID, repositoryID, userID, WorkspaceAccessRead,
		map[string]any{"operation": "read", "changeIds": changeIDs})
}

// ApplyCodingOperation runs through the existing authorized/resumed sandbox
// execution facet. Each transport invocation gets a fresh controller exec key:
// exec output is sensitive and not replayable there. JJ's native operation log
// owns logical replay, including retries after controller/guest interruption.
func (s *WorkspaceService) ApplyCodingOperation(ctx context.Context, workspaceID string, repositoryID, userID int64, input WorkspaceCodingInput) (WorkspaceCodingResult, error) {
	if err := validateCodingInput(input); err != nil {
		return WorkspaceCodingResult{}, err
	}
	raw, _ := json.Marshal(input)
	var request map[string]any
	_ = json.Unmarshal(raw, &request)
	var result WorkspaceCodingResult
	err := s.withWorkspaceMutation(ctx, workspaceID, repositoryID, userID, func(ctx context.Context, _ db.Workspace) error {
		var err error
		result, err = s.executeCoding(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite, request)
		if err == nil && result.Status == "accepted" {
			err = s.recordCodingOperation(ctx, workspaceID, repositoryID, userID, input.Operation, result)
		}
		return err
	})
	if err == nil {
		s.touchWorkspaceEntryRecency(ctx, workspaceID, "coding")
	}
	return result, err
}

type workspaceCodingProvenance interface {
	RecordWorkspaceCodingOperation(context.Context, db.RecordWorkspaceCodingOperationParams) (db.JjOperation, error)
}

func (s *WorkspaceService) recordCodingOperation(ctx context.Context, workspaceID string, repositoryID, userID int64, operation string, result WorkspaceCodingResult) error {
	store, ok := s.q.(workspaceCodingProvenance)
	if !ok {
		return pkgerrors.Internal("workspace coding provenance unavailable")
	}
	changeIDs := make([]string, 0, len(result.Revisions))
	for _, revision := range result.Revisions {
		changeIDs = append(changeIDs, revision.ChangeID)
	}
	_, err := store.RecordWorkspaceCodingOperation(ctx, db.RecordWorkspaceCodingOperationParams{
		RepositoryID: repositoryID, OperationID: result.OperationID,
		OperationType: "coding/" + operation, Description: "native coding " + operation,
		UserID: userID, ParentOperationID: result.ParentOperationID,
		WorkspaceID: workspaceID, ChangeIds: changeIDs, CreatedAt: result.Timestamp,
	})
	if err != nil {
		return &pkgerrors.APIError{Status: http.StatusServiceUnavailable, Code: pkgerrors.CodeCodingProvenancePending, Message: "native mutation is saved; retry the identical request to finish provenance projection", RetryAfter: 1}
	}
	return nil
}

func (s *WorkspaceService) executeCoding(ctx context.Context, workspaceID string, repositoryID, userID int64, access WorkspaceAccessLevel, request map[string]any) (WorkspaceCodingResult, error) {
	workspace, client, err := s.workspaceFacetTarget(ctx, workspaceID, repositoryID, userID, access)
	if err != nil {
		return WorkspaceCodingResult{}, err
	}
	// Resume may take time. Recheck workspace access immediately before exec.
	current, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, access)
	if err != nil {
		return WorkspaceCodingResult{}, err
	}
	if current.VmID != workspace.VmID {
		return WorkspaceCodingResult{}, pkgerrors.Conflict("workspace execution changed before coding; read its current revision")
	}
	user := strings.TrimSpace(s.workspaceUsername)
	if user == "" {
		user = defaultWorkspaceUser
	}
	command, err := buildWorkspaceCodingCommand(defaultWorkspaceClonePath, user, request)
	if err != nil {
		return WorkspaceCodingResult{}, pkgerrors.Internal("encode workspace coding request").WithCause(err)
	}
	ctx = sandbox.WithIdempotencyKey(ctx, "coding-exec-"+uuid.NewString())
	response, err := client.Execute(ctx, workspace.VmID, sandbox.ExecRequest{Command: command, TimeoutMS: workspaceOperationTimeoutPtr()})
	if err != nil {
		return WorkspaceCodingResult{}, &pkgerrors.APIError{Status: http.StatusServiceUnavailable, Code: pkgerrors.CodeCodingOutcomeUnknown, Message: "workspace transport interrupted; retry the identical request to recover its native receipt", RetryAfter: 1}
	}
	var envelope struct {
		WorkspaceCodingResult
		Error *struct {
			Code     string                   `json:"code"`
			Message  string                   `json:"message"`
			Recovery *WorkspaceCodingRecovery `json:"recovery,omitempty"`
		} `json:"error"`
	}
	if len(response.Stdout) > 16<<20 || json.Unmarshal([]byte(response.Stdout), &envelope) != nil {
		return WorkspaceCodingResult{}, pkgerrors.Internal("invalid native coding response; retry identical request to recover its receipt")
	}
	if envelope.Error != nil {
		status := http.StatusConflict
		switch envelope.Error.Code {
		case "unsupported_jj", "guest_failure", "workspace_busy", "reporter_upgrade_required":
			status = http.StatusServiceUnavailable
		case "invalid_request":
			status = http.StatusBadRequest
		}
		// The guest names its own failure, so this is a string from another
		// process: ParseCode is the reviewed ingress that keeps it from
		// inventing a code no client has ever been told about. An
		// unrecognized one is a defect in the guest or a version skew, which
		// is coding_guest_failure and its registered 503.
		code, known := pkgerrors.ParseCode("coding_" + envelope.Error.Code)
		if !known {
			code, status = pkgerrors.CodeCodingGuestFailure, http.StatusServiceUnavailable
		}
		apiError := &pkgerrors.APIError{Status: status, Code: code, Message: envelope.Error.Message}
		if envelope.Error.Recovery != nil {
			apiError.Details = map[string]any{"recovery": envelope.Error.Recovery}
		}
		return WorkspaceCodingResult{}, apiError
	}
	if !workspaceExecSucceeded(response) || !codingOpID.MatchString(envelope.OperationID) ||
		(envelope.Status != "read" && envelope.Status != "accepted" && envelope.Status != "unchanged") {
		return WorkspaceCodingResult{}, pkgerrors.Internal("invalid native coding receipt")
	}
	return envelope.WorkspaceCodingResult, nil
}

func buildWorkspaceCodingCommand(repo, user string, request any) (string, error) {
	raw, err := json.Marshal(request)
	if err != nil {
		return "", err
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", err
	}
	delete(payload, "actorId")
	delete(payload, "workspaceId")
	delete(payload, "reportProvenance")
	delete(payload, "requireReporterLock")
	payload["repositoryPath"] = repo
	raw, err = json.Marshal(payload)
	if err != nil {
		return "", err
	}
	// Match repository provisioning's developer identity. The sandbox control
	// channel executes as root; running JJ there would create root-owned native
	// metadata and bypass the workspace user's JJ author/configuration.
	asDev := "runuser -u " + shellQuote(user) + " -- env -u JJ_CONFIG HOME=" + shellQuote(defaultWorkspaceHome) +
		" XDG_CONFIG_HOME=" + shellQuote(defaultWorkspaceHome+"/.config") + " USER=" + shellQuote(user) + " LOGNAME=" + shellQuote(user) +
		" PATH=/usr/local/bin:/run/current-system/sw/bin:/usr/bin:/bin "
	return asDev + shellQuote(workspaceJJExportPath) + " --local <<'SMITHERS_CODING_JSON'\n" + string(raw) + "\nSMITHERS_CODING_JSON", nil
}
