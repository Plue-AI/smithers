package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/services"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const devtoolsSnapshotPayloadMaxBytes = 1 << 20

// DevtoolsSnapshotRouteQuerier is the db surface required by the repo-scoped
// devtools snapshot HTTP handlers.
type DevtoolsSnapshotRouteQuerier interface {
	UpsertDevtoolsSnapshot(ctx context.Context, arg db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error)
	GetDevtoolsSnapshot(ctx context.Context, arg db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error)
	ListDevtoolsSnapshotsBySession(ctx context.Context, arg db.ListDevtoolsSnapshotsBySessionParams) ([]db.DevtoolsSnapshot, error)
	GetAgentSession(ctx context.Context, id string) (db.AgentSession, error)
}

// DevtoolsSnapshotsHandler handles repo-scoped devtools snapshot routes.
type DevtoolsSnapshotsHandler struct {
	Queries DevtoolsSnapshotRouteQuerier
	Reader  *services.DevtoolsSnapshotAPI
	// Enabled gates the devtools snapshot surface. It is resolved once from
	// the canonical config (feature_flags.devtools_snapshot_enabled, which
	// defaults to false) and wired in by the caller — never read from the
	// environment directly, so an unset flag is disabled, not enabled.
	Enabled bool
}

type DevtoolsSnapshotWriteRequest struct {
	RepositoryID *int64          `json:"repository_id,omitempty"`
	Kind         string          `json:"kind"`
	SessionID    string          `json:"session_id"`
	WorkspaceID  *string         `json:"workspace_id,omitempty"`
	Payload      json.RawMessage `json:"payload"`
}

type devtoolsSnapshotCreatedResponse struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
}

type devtoolsSnapshotResponse struct {
	ID           string          `json:"id"`
	SessionID    string          `json:"session_id"`
	RepositoryID int64           `json:"repository_id"`
	Kind         string          `json:"kind"`
	WorkspaceID  *string         `json:"workspace_id,omitempty"`
	Payload      json.RawMessage `json:"payload"`
	CreatedAt    time.Time       `json:"created_at"`
}

type devtoolsSnapshotListResponse struct {
	Snapshots []devtoolsSnapshotResponse `json:"snapshots"`
}

// RegisterDevtoolsSnapshotRoutes mounts the repo-scoped devtools snapshot
// routes under /api/repos/{owner}/{repo}. enabled reflects the resolved
// feature_flags.devtools_snapshot_enabled config value (defaults false).
func RegisterDevtoolsSnapshotRoutes(r chi.Router, queries *db.Queries, readRepo, writeRepo []func(http.Handler) http.Handler, enabled bool, installPools ...*pgxpool.Pool) {
	if r == nil || queries == nil {
		return
	}

	handler := &DevtoolsSnapshotsHandler{Queries: queries, Enabled: enabled, Reader: services.NewDevtoolsSnapshotAPI(queries, installPools...)}
	r.With(writeRepo...).Post("/devtools/snapshots", handler.PostSnapshot)
	r.With(readRepo...).Get("/devtools/snapshots", handler.GetSnapshots)
	r.With(readRepo...).Get("/devtools/snapshots/latest", handler.GetSnapshots)
}

// PostSnapshot handles POST /api/repos/{owner}/{repo}/devtools/snapshots.
func (h *DevtoolsSnapshotsHandler) PostSnapshot(w http.ResponseWriter, r *http.Request) {
	if !h.Enabled {
		pkgerrors.WriteError(w, pkgerrors.NotFound("devtools snapshots are disabled"))
		return
	}

	if _, err := requireRouteUser(r); err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repo := middleware.RepoFromContext(r.Context())
	if repo == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	var req DevtoolsSnapshotWriteRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	input, err := DevtoolsSnapshotWriteInput(repo.ID, req)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	api := h.Reader
	if api == nil {
		api = services.NewDevtoolsSnapshotAPI(h.Queries)
	}
	snapshot, err := api.Write(r.Context(), repo.ID, middleware.UserFromContext(r.Context()).ID, input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusCreated, devtoolsSnapshotCreatedResponse{
		ID:        devtoolsSnapshotID(snapshot),
		CreatedAt: snapshot.Timestamp,
	})
}

// DevtoolsSnapshotWriteInput normalizes the same typed payload at admission and execution.
func DevtoolsSnapshotWriteInput(repository int64, req DevtoolsSnapshotWriteRequest) (services.DevtoolsSnapshotWriteInput, error) {
	var in services.DevtoolsSnapshotWriteInput
	if req.RepositoryID != nil && *req.RepositoryID != repository {
		return in, pkgerrors.BadRequest("repository_id does not match repository route")
	}
	kind, err := normalizeDevtoolsSnapshotKind(req.Kind)
	if err != nil {
		return in, err
	}
	in.Kind = kind
	session, err := validateRequiredUUID(req.SessionID, "session_id")
	if err != nil {
		return in, err
	}
	in.SessionID = session
	workspace, err := validateOptionalUUID(req.WorkspaceID, "workspace_id")
	if err != nil {
		return in, err
	}
	if workspace != nil {
		in.WorkspaceID = *workspace
	}
	payload, err := normalizeDevtoolsSnapshotPayload(req.Payload, workspace)
	if err != nil {
		return in, err
	}
	in.Payload = payload
	return in, nil
}

// GetSnapshots handles GET /api/repos/{owner}/{repo}/devtools/snapshots and
// GET /api/repos/{owner}/{repo}/devtools/snapshots/latest.
func (h *DevtoolsSnapshotsHandler) GetSnapshots(w http.ResponseWriter, r *http.Request) {
	if !h.Enabled {
		pkgerrors.WriteError(w, pkgerrors.NotFound("devtools snapshots are disabled"))
		return
	}

	if _, err := requireRouteUser(r); err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repo := middleware.RepoFromContext(r.Context())
	if repo == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	input, err := DevtoolsSnapshotReadInput(r, repo.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	reader := h.Reader
	if reader == nil {
		reader = services.NewDevtoolsSnapshotAPI(h.Queries)
	}
	rows, err := reader.Read(r.Context(), repo.ID, middleware.UserFromContext(r.Context()).ID, input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	resp := make([]devtoolsSnapshotResponse, 0, len(rows))
	for _, row := range rows {
		resp = append(resp, mapDevtoolsSnapshotResponse(row))
	}
	pkgerrors.WriteJSON(w, http.StatusOK, devtoolsSnapshotListResponse{Snapshots: resp})
}

// DevtoolsSnapshotReadInput is shared by admission and the retained handler.
func DevtoolsSnapshotReadInput(r *http.Request, repository int64) (services.DevtoolsSnapshotReadInput, error) {
	var input services.DevtoolsSnapshotReadInput
	query := r.URL.Query()
	session, err := validateRequiredUUID(query.Get("session_id"), "session_id")
	if err != nil {
		return input, err
	}
	input.SessionID = session
	if raw := strings.TrimSpace(query.Get("repository_id")); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			return input, pkgerrors.BadRequest("repository_id must be a positive integer")
		}
		if id != repository {
			return input, pkgerrors.NotFound("devtools snapshot not found")
		}
	}
	workspace, err := validateOptionalUUID(queryStringPtr(query.Get("workspace_id")), "workspace_id")
	if err != nil {
		return input, err
	}
	if workspace != nil {
		input.WorkspaceID = *workspace
	}
	if raw := strings.TrimSpace(query.Get("kind")); raw != "" {
		kind, err := normalizeDevtoolsSnapshotKind(raw)
		if err != nil {
			return input, err
		}
		input.Kind = kind
	}
	return input, nil
}

func normalizeDevtoolsSnapshotKind(raw string) (string, *pkgerrors.APIError) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    "kind",
			Code:     "missing_field",
		})
	case "console", "command-output", "command_output":
		return "command_output", nil
	case "network", "tool-state", "tool_state":
		return "tool_state", nil
	case "file-tree", "file_tree":
		return "file_tree", nil
	case "screenshot":
		return "screenshot", nil
	default:
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    "kind",
			Code:     "invalid",
		})
	}
}

func validateRequiredUUID(raw, field string) (string, *pkgerrors.APIError) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    field,
			Code:     "missing_field",
		})
	}
	if _, err := uuid.Parse(trimmed); err != nil {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    field,
			Code:     "invalid",
		})
	}
	return trimmed, nil
}

func validateOptionalUUID(raw *string, field string) (*string, *pkgerrors.APIError) {
	if raw == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		return nil, nil
	}
	if _, err := uuid.Parse(trimmed); err != nil {
		return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    field,
			Code:     "invalid",
		})
	}
	return &trimmed, nil
}

func normalizeDevtoolsSnapshotPayload(raw json.RawMessage, workspaceID *string) (json.RawMessage, *pkgerrors.APIError) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    "payload",
			Code:     "missing_field",
		})
	}
	if len(trimmed) > devtoolsSnapshotPayloadMaxBytes {
		return nil, pkgerrors.RequestEntityTooLarge("payload too large")
	}

	var payload map[string]any
	if err := json.Unmarshal(trimmed, &payload); err != nil {
		return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    "payload",
			Code:     "invalid",
		})
	}

	// The schema landed without a dedicated workspace_id column; preserve the
	// request field in the JSON payload until ticket 0157 gives it a home.
	if workspaceID != nil {
		if _, exists := payload["workspace_id"]; !exists {
			payload["workspace_id"] = *workspaceID
		}
	}

	encoded := mustMarshalDevtoolsSnapshotPayload(payload)
	if len(encoded) > devtoolsSnapshotPayloadMaxBytes {
		return nil, pkgerrors.RequestEntityTooLarge("payload too large")
	}
	return json.RawMessage(encoded), nil
}

func mustMarshalDevtoolsSnapshotPayload(payload map[string]any) []byte {
	encoded, err := json.Marshal(payload)
	if err != nil {
		panic(fmt.Sprintf("devtools snapshot payload should be JSON-marshalable after JSON decode: %v", err))
	}
	return encoded
}

func mapDevtoolsSnapshotResponse(snapshot db.DevtoolsSnapshot) devtoolsSnapshotResponse {
	return devtoolsSnapshotResponse{
		ID:           devtoolsSnapshotID(snapshot),
		SessionID:    snapshot.SessionID,
		RepositoryID: snapshot.RepositoryID,
		Kind:         snapshot.Kind,
		WorkspaceID:  services.DevtoolsSnapshotWorkspaceID(snapshot.Payload),
		Payload:      snapshot.Payload,
		CreatedAt:    snapshot.Timestamp,
	}
}

func devtoolsSnapshotID(snapshot db.DevtoolsSnapshot) string {
	return fmt.Sprintf("%s:%s", snapshot.SessionID, snapshot.Kind)
}

func queryStringPtr(raw string) *string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
