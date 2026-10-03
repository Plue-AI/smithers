package services

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Every write of a mythical_items row and of a TODO goes through the seam
// that projects the item onto its TODO in the same transaction (spec
// §4.1.0, §10.1). A new caller anywhere else in the backend fails here, so
// todos.state cannot drift from the engine's work record (T-STK-01 risk).
func TestMythicalItemWritesGoThroughTheTodoProjection(t *testing.T) {
	allowed := map[string][]string{
		".SaveMythicalItem(":       {"internal/services/mythical_item_write.go"},
		".InsertMythicalItem(":     {"internal/services/mythical_item_write.go"},
		".InsertMythicalChatItem(": {"internal/services/mythical_item_write.go"},
		".InsertMythicalTodoItem(": {"internal/services/todo_service.go"},
		".LinkMythicalItemTodo(":   {"internal/services/todo_service.go"},
		".UpdateTodo(":             {"internal/services/todo_service.go"},
		".InsertTodo(":             {"internal/services/todo_service.go"},
		".InsertTodoEvent(":        {"internal/services/todo_service.go"},
		".InsertProjectionEvent(":  {"internal/services/projection.go"},
		".InsertActivity(":         {"internal/services/activity.go"},
	}
	rawSQL := []string{"UPDATE mythical_items", "INSERT INTO mythical_items", "UPDATE todos", "INSERT INTO todos",
		"INSERT INTO todo_events", "INSERT INTO projection_events", "INSERT INTO activity"}
	root := filepath.Join("..", "..")
	checked := 0
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == "node_modules" || entry.Name() == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		// The query layer defines the writes; it calls none of them.
		if strings.HasPrefix(rel, "internal/db/") {
			return nil
		}
		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		checked++
		text := string(source)
		for call, files := range allowed {
			if strings.Contains(text, call) && !containsString(files, rel) {
				t.Errorf("%s calls %s; only %v may (it would bypass the TODO projection)", rel, strings.Trim(call, ".("), files)
			}
		}
		for _, statement := range rawSQL {
			if strings.Contains(text, statement) {
				t.Errorf("%s writes %q directly; TODO and item rows change only through the TODO service", rel, statement)
			}
		}
		return nil
	})
	require.NoError(t, err)
	require.Greater(t, checked, 100, "the walk reached the backend's sources")
}

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

// requireTodosProjected is the T-STK-01 drift assertion: after a worker
// pass, every TODO stands at the state its item projects to (§4.1.0), and
// every admitted item has a TODO.
func requireTodosProjected(t testing.TB, conn db.DBTX, repositoryID int64) {
	t.Helper()
	ctx := context.Background()
	q := db.New(conn)
	items, err := q.ListMythicalItems(ctx, repositoryID, 1000)
	require.NoError(t, err)
	for _, item := range items {
		if !item.TodoID.Valid {
			require.False(t, mythicalItemIsTodo(item), "item %s (%s, #%d) passed admission and has no TODO", uuidString(item.ID), item.State, item.IssueNumber.Int64)
			continue
		}
		todo, err := q.GetTodo(ctx, uuidString(item.TodoID))
		require.NoError(t, err)
		projected := ProjectItemState(item, todo)
		// Retry lifecycle is queued until real admission; an existing open PR
		// independently remains visible as in_review (lead ruling 2026-10-03).
		if item.State == "queued" && todo.State == "queued" && item.PRState == "open" && item.PRNumber.Valid {
			projected = TodoQueued
		}
		require.Equal(t, string(projected), todo.State,
			"T%d drifted from its item %s (%s: %s)", todo.Number, uuidString(item.ID), item.State, item.Reason)
		events, err := q.ListTodoEvents(ctx, todo.ID)
		require.NoError(t, err)
		require.NotEmpty(t, events, "T%d has a state with no event", todo.Number)
		require.Equal(t, todo.State, events[len(events)-1].ToState, "T%d's last event is not its state", todo.Number)
	}
}
