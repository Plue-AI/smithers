package services

import (
	"context"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// TodoControlInput is the POST /api/todos/{n} control payload. The install
// catalog owns authorization, confirmation and durable request deduplication.
type TodoControlInput struct {
	Op    string  `json:"op"`
	Steer *string `json:"steer,omitempty"`
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
	switch input.Op {
	case "stop", "resume", "drop":
		if input.Steer != nil {
			return &TodoControlError{http.StatusBadRequest, "invalid_control", "user", "Only Retry accepts a steer"}
		}
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
// alternate projection. T-STK-01/T-FLW-11 own their committed sources.
type todoControlFacts struct {
	Executing bool
	Paused    bool
	Waits     []string
	Merging   bool
}

func todoControlGuard(item db.MythicalItem, input TodoControlInput, facts todoControlFacts) error {
	if err := input.validate(); err != nil {
		return err
	}
	if facts.Merging {
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

// ControlTodo replaces the served legacy retryItem door. It remains dark:
// this checkout has no shared install Authorize/Dispatch, durable attempt/pause
// source or validated retained-machine execution composition. Refuse BEFORE
// reading a subject or sending signals, allocating attempts, closing a PR or
// removing a branch. Wiring a launcher alone must never enable this method.
func (s *MythicalService) ControlTodo(_ context.Context, number int64, input TodoControlInput) error {
	if number <= 0 {
		return &TodoControlError{http.StatusBadRequest, "invalid_todo", "user", "Invalid TODO number"}
	}
	if err := input.validate(); err != nil {
		return err
	}
	return &TodoControlError{http.StatusServiceUnavailable, "todo_control_unavailable", "infra", "TODO controls are unavailable"}
}
