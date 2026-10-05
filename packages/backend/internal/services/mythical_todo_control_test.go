package services

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestTodoControlGuardsReadFacts(t *testing.T) {
	// Literal permissions are independent of the projection and guard code.
	fixtures := []struct {
		name, state string
		facts       todoControlFacts
		allowed     []string
	}{
		{"queued", "queued", todoControlFacts{}, []string{"drop"}},
		{"starting", "running", todoControlFacts{}, []string{"drop"}},
		{"working", "running", todoControlFacts{Executing: true}, []string{"stop", "drop"}},
		{"in_review", "proposed", todoControlFacts{Executing: true}, []string{"stop", "drop"}},
		{"in_review_without_run", "proposed", todoControlFacts{}, []string{"drop"}},
		{"paused", "running", todoControlFacts{Paused: true}, []string{"resume", "drop"}},
		{"failed", "blocked", todoControlFacts{}, []string{"retry", "retry-current-flow", "drop"}},
		{"failed_paused", "blocked", todoControlFacts{Paused: true}, []string{"resume", "retry", "retry-current-flow", "drop"}},
		{"needs_you_conflict", "running", todoControlFacts{Executing: true, Waits: []string{"conflict"}}, []string{"stop", "drop"}},
		{"needs_you_moved_off", "running", todoControlFacts{Executing: true, Waits: []string{"moved_off"}}, []string{"stop", "drop"}},
		{"needs_you_foreign_push", "running", todoControlFacts{Executing: true, Waits: []string{"foreign_push"}}, []string{"stop", "drop"}},
		{"needs_you_question", "running", todoControlFacts{Executing: true, Waits: []string{"question"}}, []string{"drop"}},
		{"needs_you_approval", "running", todoControlFacts{Executing: true, Waits: []string{"approval"}}, []string{"drop"}},
		{"branch_and_question", "running", todoControlFacts{Executing: true, Waits: []string{"foreign_push", "question"}}, []string{"drop"}},
		{"branch_and_approval", "proposed", todoControlFacts{Executing: true, Waits: []string{"conflict", "approval"}}, []string{"drop"}},
		{"needs_you_paused", "running", todoControlFacts{Paused: true, Waits: []string{"conflict"}}, []string{"resume", "drop"}},
		{"needs_you_failed", "blocked", todoControlFacts{Waits: []string{"foreign_push"}}, []string{"retry", "retry-current-flow", "drop"}},
		{"merged", "landed", todoControlFacts{Executing: true, Paused: true, Waits: []string{"question"}}, nil},
		{"dropped", "cancelled", todoControlFacts{Executing: true, Paused: true, Waits: []string{"conflict"}}, nil},
		{"historic_rejected", "rejected", todoControlFacts{Executing: true, Paused: true}, nil},
		{"historic_declined", "declined", todoControlFacts{Executing: true, Paused: true}, nil},
	}
	for _, fixture := range fixtures {
		for _, op := range []string{"stop", "resume", "retry", "retry-current-flow", "drop"} {
			t.Run(fixture.name+"/"+op, func(t *testing.T) {
				err := todoControlGuard(db.MythicalItem{State: fixture.state}, TodoControlInput{Op: op}, fixture.facts)
				if slices.Contains(fixture.allowed, op) {
					require.NoError(t, err)
				} else {
					require.Error(t, err)
				}
			})
		}
	}
	// The merge fence the press persists refuses every control (§10.6.2b);
	// another pending GitHub write is not a merge.
	fenced := db.MythicalItem{State: "blocked", PendingOp: []byte(`{"kind":"merge","target":"3","desired":"` + strings.Repeat("a", 40) + `","state":"intended"}`)}
	pushing := db.MythicalItem{State: "blocked", PendingOp: []byte(`{"kind":"push","target":"smithers/x","state":"intended"}`)}
	for _, op := range []string{"stop", "resume", "retry", "retry-current-flow", "drop"} {
		err := todoControlGuard(fenced, TodoControlInput{Op: op}, todoControlFacts{Executing: true, Paused: true})
		require.Equal(t, &TodoControlError{http.StatusConflict, "merging", "conflict", "TODO is merging"}, err)
		if err := todoControlGuard(pushing, TodoControlInput{Op: op}, todoControlFacts{Executing: true, Paused: true}); err != nil {
			require.NotEqual(t, "merging", err.(*TodoControlError).Code)
		}
	}
}

func TestTodoControlsRefuseBeforeDependencies(t *testing.T) {
	// A completely absent store/launcher is intentional: touching either would
	// panic. No optional orchestration field can accidentally enable execution.
	service := NewMythicalService(nil, nil)
	for _, op := range []string{"stop", "resume", "retry", "retry-current-flow", "drop"} {
		_, err := service.ControlTodo(context.Background(), 12, TodoControlInput{Op: op})
		refusal := err.(*TodoControlError)
		require.Equal(t, http.StatusServiceUnavailable, refusal.Status)
		require.Equal(t, "infra", refusal.Class)
		require.Equal(t, "todo_control_unavailable", refusal.Code)
	}
}

func TestTodoControlInputBoundaries(t *testing.T) {
	text := func(s string) *string { return &s }
	for _, input := range []TodoControlInput{
		{}, {Op: "cancel"}, {Op: "stop", Steer: text("x")}, {Op: "resume", Steer: text("x")},
		{Op: "drop", Steer: text("x")}, {Op: "retry", Steer: text(" ")},
		{Op: "retry", Steer: text(string([]byte{0xff}))}, {Op: "retry-current-flow", Steer: text(strings.Repeat("x", mythicalPromptBytes+1))},
	} {
		require.Error(t, input.validate())
	}
	for _, op := range []string{"retry", "retry-current-flow"} {
		require.NoError(t, (TodoControlInput{Op: op, Steer: text(strings.Repeat("x", mythicalPromptBytes))}).validate())
		require.NoError(t, (TodoControlInput{Op: op, Steer: text(" Keep\nverbatim ")}).validate())
	}
	var service *MythicalService
	_, err := service.ControlTodo(context.Background(), 0, TodoControlInput{Op: "drop"})
	require.Equal(t, "invalid_todo", err.(*TodoControlError).Code)
	_, err = service.ControlTodo(context.Background(), 12, TodoControlInput{Op: "cancel"})
	require.Equal(t, "invalid_control", err.(*TodoControlError).Code)
}

func TestTodoSteerAndAmendDarkInputs(t *testing.T) {
	var service *MythicalService
	text := func(s string) *string { return &s }
	for _, value := range []string{" Keep\nverbatim ", strings.Repeat("x", mythicalPromptBytes)} {
		_, err := service.ControlTodo(context.Background(), 12, TodoControlInput{Steer: text(value)})
		require.Equal(t, "todo_control_unavailable", err.(*TodoControlError).Code)
	}
	for _, value := range []string{"", " ", string([]byte{0xff}), strings.Repeat("x", mythicalPromptBytes+1)} {
		_, err := service.ControlTodo(context.Background(), 12, TodoControlInput{Steer: text(value)})
		require.Equal(t, "invalid_steer", err.(*TodoControlError).Code)
	}
	for _, input := range []TodoAmendInput{
		{Prompt: "Keep\nverbatim", Acceptance: ""},
		{Prompt: strings.Repeat("x", mythicalPromptBytes)},
		{Prompt: "x", Acceptance: strings.Repeat("y", mythicalPromptBytes-1)},
	} {
		err := service.AmendTodo(context.Background(), 12, input)
		require.Equal(t, "todo_control_unavailable", err.(*TodoControlError).Code)
	}
	for _, input := range []TodoAmendInput{
		{}, {Prompt: " "}, {Prompt: string([]byte{0xff})},
		{Prompt: "x", Acceptance: string([]byte{0xff})},
		{Prompt: "x", Acceptance: strings.Repeat("y", mythicalPromptBytes)},
	} {
		err := service.AmendTodo(context.Background(), 12, input)
		require.Equal(t, "invalid_amendment", err.(*TodoControlError).Code)
	}
	require.Equal(t, "invalid_todo", service.AmendTodo(context.Background(), 0, TodoAmendInput{Prompt: "x"}).(*TodoControlError).Code)
}
