package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// TodoControlInput is the POST /api/todos/{n} control: its op, an optional
// steer, a move's direction (up or down), and, set only by the route from the
// request it authorized, the install's repository, the person and the
// request's Idempotency-Key.
type TodoControlInput struct {
	Op        string  `json:"op"`
	Steer     *string `json:"steer,omitempty"`
	Direction string  `json:"direction,omitempty"`
	// Repository, Actor and Request are never read from the body.
	Repository int64  `json:"-"`
	Actor      int64  `json:"-"`
	Request    string `json:"-"`
}

// TodoControlReceipt is a recorded control: "accepted" once it is durable,
// for a retry the attempt it starts and for a move the place it took, so the
// app settles its toast once the TODO card shows that attempt or place.
type TodoControlReceipt struct {
	State    string `json:"state"`
	Attempt  int32  `json:"attempt,omitempty"`
	Place    int64  `json:"place,omitempty"`
	Number   int64  `json:"n,omitempty"`
	Revision int    `json:"rev,omitempty"`
}

// todoControls dispatches each TODO control to its service, one file per op
// (mythical_todo_<op>.go). An op without an entry is unavailable.
var todoControls = map[string]func(*MythicalService, context.Context, int64, TodoControlInput) (TodoControlReceipt, error){
	"":      (*MythicalService).steerTodo,
	"retry": (*MythicalService).retryTodo,
	"drop":  (*MythicalService).dropTodo,
	"move":  (*MythicalService).moveTodo,
}

// TodoControlError uses the install command error envelope (§6.2.3).
// Legacy repository API errors retain their existing wire format.
type TodoControlError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Class   string `json:"class"`
	Message string `json:"message"`
}

func (e *TodoControlError) Error() string { return e.Message }

func todoControlConflict(message string) error {
	return &TodoControlError{http.StatusConflict, "conflict", "conflict", message}
}

func (input TodoControlInput) validate() error {
	if input.Direction != "" && input.Op != "move" {
		return &TodoControlError{http.StatusBadRequest, "invalid_control", "user", "Only a move takes a direction"}
	}
	switch input.Op {
	case "move":
		if input.Steer != nil {
			return &TodoControlError{http.StatusBadRequest, "invalid_control", "user", "This control does not accept a steer"}
		}
		if input.Direction != "up" && input.Direction != "down" {
			return &TodoControlError{http.StatusBadRequest, "invalid_control", "user", "Move up or down"}
		}
	case "stop", "resume", "drop":
		if input.Steer != nil {
			return &TodoControlError{http.StatusBadRequest, "invalid_control", "user", "This control does not accept a steer"}
		}
	case "":
		if input.Steer == nil {
			return &TodoControlError{http.StatusBadRequest, "invalid_steer", "user", "A steer is required"}
		}
		fallthrough
	case "retry", "retry-current-flow":
		if input.Steer != nil && (!utf8.ValidString(*input.Steer) || len(*input.Steer) > mythicalPromptBytes || strings.TrimSpace(*input.Steer) == "") {
			return &TodoControlError{http.StatusBadRequest, "invalid_steer", "user", "Invalid steer"}
		}
	default:
		return &TodoControlError{http.StatusBadRequest, "invalid_control", "user", "Unknown TODO control"}
	}
	return nil
}

// todoControlFacts are read-only runtime facts supplied with the locked item,
// never inferred from its product state. They introduce no persisted state or
// alternate projection. T-STK-01/T-FLW-11 own their committed sources. The
// merge fence is the item's own (mythicalMergeFenced).
type todoControlFacts struct {
	Executing bool
	Paused    bool
	Waits     []string
}

func todoControlGuard(item db.MythicalItem, input TodoControlInput, facts todoControlFacts) error {
	if err := input.validate(); err != nil {
		return err
	}
	if mythicalMergeFenced(item) {
		return &TodoControlError{http.StatusConflict, "merging", "conflict", "TODO is merging"}
	}
	if item.State == "landed" || item.State == "cancelled" || item.State == "rejected" || item.State == "declined" {
		return todoControlConflict("TODO is settled")
	}
	switch input.Op {
	case "stop":
		if !facts.Executing {
			return todoControlConflict("TODO has no executing run")
		}
		for _, wait := range facts.Waits {
			if wait == "question" || wait == "approval" {
				return todoControlConflict("Answer the open wait first")
			}
		}
	case "resume":
		if !facts.Paused {
			return todoControlConflict("TODO is not paused")
		}
	case "retry", "retry-current-flow":
		if item.State != "blocked" {
			return todoControlConflict("TODO has not failed")
		}
	}
	return nil
}

// ControlTodo runs TODO n's control through todoControls once the route has
// authorized it. An op with no service is refused before any read, signal,
// attempt, GitHub write or removal.
func (s *MythicalService) ControlTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	if number <= 0 {
		return TodoControlReceipt{}, &TodoControlError{http.StatusBadRequest, "invalid_todo", "user", "Invalid TODO number"}
	}
	if err := input.validate(); err != nil {
		return TodoControlReceipt{}, err
	}
	control := todoControls[input.Op]
	if control == nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	return control(s, ctx, number, input)
}

func todoControlUnavailable() error {
	return &TodoControlError{http.StatusServiceUnavailable, "todo_control_unavailable", "infra", "TODO controls are unavailable"}
}

// todoRequestCredential uses only authenticated, server-bound identity.
// The repository scopes the database lookup. A session already binds one
// member, and shares its identity with creation and merge request records.
// A delegated token additionally binds its member and terminal scope; via
// attribution and caller-provided request fields never select this identity.
func todoRequestCredential(ctx context.Context, actor int64) (string, error) {
	info := middleware.AuthInfoFromContext(ctx)
	if info != nil && info.User != nil && info.User.ID == actor && actor > 0 && !middleware.IsAgentAccount(info.User.UserType) {
		if !info.IsTokenAuth && info.SessionHash != "" {
			return info.SessionHash, nil
		}
		if binding, ok := info.TerminalDelegation(); ok && info.CredentialKind() == middleware.CredentialDelegated && info.TokenID > 0 && binding.Branch != "" {
			identity, _ := json.Marshal([]any{"delegated", info.TokenID, actor, binding.Branch, binding.Profile, binding.Session})
			return string(identity), nil
		}
	}
	return "", &TodoControlError{http.StatusForbidden, "permission", "permission", "Invalid TODO authority"}
}

func todoRequestMismatch() error {
	return &TodoControlError{http.StatusConflict, "idempotency_mismatch", "conflict", "Idempotency-Key was already used for a different request"}
}

// lockTodoRequest shares the existing creation/merge request lock and the
// stack lock. Current authority is checked before waiting and again before
// any subject or replay is read. The caller supplies a fixed command id.
func lockTodoRequest(ctx context.Context, tx pgx.Tx, q *db.Queries, command string, input TodoControlInput) (db.User, string, error) {
	auth, err := Authorize(ctx, q, command)
	if err != nil {
		return db.User{}, "", err
	}
	repository, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return db.User{}, "", err
	}
	if auth.UserID != input.Actor || repository != input.Repository {
		return db.User{}, "", &TodoControlError{http.StatusForbidden, "permission", "permission", "Invalid TODO authority"}
	}
	credential, err := todoRequestCredential(ctx, auth.UserID)
	if err != nil {
		return db.User{}, "", err
	}
	if input.Request == "" || len(input.Request) > 256 {
		return db.User{}, "", &TodoControlError{http.StatusBadRequest, "invalid_idempotency_key", "user", "Idempotency-Key must contain 1 to 256 bytes"}
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, repository); err != nil {
		return db.User{}, "", err
	}
	if _, err = tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repository); err != nil {
		return db.User{}, "", err
	}
	if _, err = Authorize(ctx, q, command); err != nil {
		return db.User{}, "", err
	}
	person, err := q.GetUserByID(ctx, auth.UserID)
	return person, credential, err
}

// todoControlReplay reads the operation's existing fact, never the TODO's
// current state, after its caller has authorized and locked the request.
func todoControlReplay(ctx context.Context, tx pgx.Tx, q *db.Queries, item db.MythicalItem, input TodoControlInput, credential, operation string) (TodoControlReceipt, bool, error) {
	prior, err := q.GetMythicalRequest(ctx, input.Repository, credential, input.Request)
	if errors.Is(err, pgx.ErrNoRows) {
		return TodoControlReceipt{}, false, nil
	}
	if err != nil {
		return TodoControlReceipt{}, false, err
	}
	if prior.ID != item.ID {
		return TodoControlReceipt{}, false, todoRequestMismatch()
	}
	canonical, _ := json.Marshal(input)
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT authorization_context->'receipt' FROM product_job_requests
	 WHERE operation=$1 AND authorization_context->>'credential'=$2 AND authorization_context->>'request'=$3
	 AND payload->>'item'=$4 AND authorization_context->'request_body'=$5::jsonb`, operation, credential, input.Request, uuidString(item.ID), canonical).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return TodoControlReceipt{}, false, todoRequestMismatch()
	}
	if err != nil {
		return TodoControlReceipt{}, false, err
	}
	var receipt TodoControlReceipt
	if json.Unmarshal(raw, &receipt) != nil || receipt.State != "accepted" {
		return TodoControlReceipt{}, false, todoControlUnavailable()
	}
	return receipt, true, nil
}

// recordTodoControl keeps private replay metadata in the existing request
// record. Only the activity fact reaches the event stream.
func recordTodoControl(ctx context.Context, tx pgx.Tx, item db.MythicalItem, input TodoControlInput, credential, operation string, receipt TodoControlReceipt, fact map[string]any) error {
	raw, err := json.Marshal(fact)
	if err != nil {
		return err
	}
	operationID := uuid.NewString()
	if _, err = jobs.RecordFactInTx(ctx, tx, todoOperationScope(item), operationID, operation, todoState(item), raw); err != nil {
		return err
	}
	private, err := json.Marshal(map[string]any{
		"credential": credential, "request": input.Request, "request_body": input, "receipt": receipt,
	})
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE product_job_requests SET authorization_context=$2::jsonb WHERE id=$1`, operationID, private)
	return err
}
