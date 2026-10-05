package services

import (
	"context"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// TodoControlInput is the POST /api/todos/{n} control: its op and optional
// steer, and, set only by the route from the request it authorized, the
// install's repository, the person and the request's Idempotency-Key.
type TodoControlInput struct {
	Op    string  `json:"op"`
	Steer *string `json:"steer,omitempty"`
	// Repository, Actor and Request are never read from the body.
	Repository int64  `json:"-"`
	Actor      int64  `json:"-"`
	Request    string `json:"-"`
}

// TodoControlReceipt is a recorded control: "requested", and for a retry the
// attempt it starts, so the app settles its toast from that attempt.
type TodoControlReceipt struct {
	State   string `json:"state"`
	Attempt int32  `json:"attempt,omitempty"`
}

// todoControls dispatches each TODO control to its service, one file per op
// (mythical_todo_<op>.go). An op without an entry is unavailable.
var todoControls = map[string]func(*MythicalService, context.Context, int64, TodoControlInput) (TodoControlReceipt, error){}

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
	switch input.Op {
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

// TodoAmendInput is the revised prompt and acceptance of the same TODO.
// It carries no actor/via: only the bound install authorization supplies them.
type TodoAmendInput struct {
	Prompt     string `json:"prompt"`
	Acceptance string `json:"acceptance"`
}

// AmendTodo stays disabled before subject reads, revision allocation, events or
// signals. Confirmation creation belongs to the shared dispatcher, never this
// direct service boundary; no caller-provided attribution can enable it.
func (s *MythicalService) AmendTodo(_ context.Context, number int64, input TodoAmendInput) error {
	if number <= 0 {
		return &TodoControlError{http.StatusBadRequest, "invalid_todo", "user", "Invalid TODO number"}
	}
	if strings.TrimSpace(input.Prompt) == "" || !utf8.ValidString(input.Prompt) || !utf8.ValidString(input.Acceptance) || len(input.Prompt)+len(input.Acceptance) > mythicalPromptBytes {
		return &TodoControlError{http.StatusBadRequest, "invalid_amendment", "user", "Invalid amendment"}
	}
	return &TodoControlError{http.StatusServiceUnavailable, "todo_control_unavailable", "infra", "TODO controls are unavailable"}
}
