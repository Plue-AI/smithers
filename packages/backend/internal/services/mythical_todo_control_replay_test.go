package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// Each case enters through the same public service as the HTTP controls and
// uses real PostgreSQL transactions, stack rows, and activity records.
func newControlReplay(t *testing.T, op string) (*mythicalOrchestration, context.Context, db.MythicalItem, db.MythicalItem, TodoControlInput, string) {
	t.Helper()
	o, session := newTodoAdmission(t)
	o.fileTodo(session, "first")
	other := o.fileTodo(session, "second")
	item := o.fileTodo(session, "third")
	input := TodoControlInput{Op: op, Repository: o.repoID, Actor: o.userID, Request: "control-key"}
	operation := "todo.dropped"
	switch op {
	case "retry":
		item.State, item.Attempt = "blocked", 1
		var err error
		item, err = o.service.queries().SaveMythicalItem(session, item)
		require.NoError(t, err)
		steer := "Preserve cancellation"
		input.Steer = &steer
		operation = "todo.retried"
	case "move":
		input.Direction = "up"
		operation = "todo.moved"
	}
	return o, session, item, other, input, operation
}

func requireControlMismatch(t *testing.T, err error) {
	t.Helper()
	var refusal *TodoControlError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, TodoControlError{http.StatusConflict, "idempotency_mismatch", "conflict", "Idempotency-Key was already used for a different request"}, *refusal)
}

func TestTodoControlCredentialReplay(t *testing.T) {
	for _, op := range []string{"retry", "drop", "move"} {
		t.Run(op, func(t *testing.T) {
			o, session, item, other, input, operation := newControlReplay(t, op)
			first, err := o.service.ControlTodo(session, item.Number.Int64, input)
			require.NoError(t, err)
			after := o.byID(uuidString(item.ID))
			otherAfter := o.byID(uuidString(other.ID))
			// Concurrent retransmissions return the original receipt even though
			// the item is no longer in the state which admitted the original action.
			type result struct {
				receipt TodoControlReceipt
				err     error
			}
			replies := make(chan result, 4)
			for range 4 {
				go func() { r, e := o.service.ControlTodo(session, item.Number.Int64, input); replies <- result{r, e} }()
			}
			for range 4 {
				r := <-replies
				require.NoError(t, r.err)
				require.Equal(t, first, r.receipt)
			}
			require.Equal(t, after, o.byID(uuidString(item.ID)))
			facts := o.facts(item, operation)
			require.Len(t, facts, 1)
			for _, field := range []string{"credential", "request", "request_body", "receipt"} {
				require.NotContains(t, facts[0], field)
			}
			var public []byte
			require.NoError(t, o.pool.QueryRow(session, `SELECT jsonb_build_array(payload,request_receipt,terminal_receipt) FROM product_job_requests WHERE operation=$1`, operation).Scan(&public))
			require.NotContains(t, string(public), "owner-session")
			require.NotContains(t, string(public), input.Request)
			require.NotContains(t, string(public), "Preserve cancellation")

			_, err = o.service.ControlTodo(session, other.Number.Int64, input)
			requireControlMismatch(t, err)
			changed := input
			if op == "move" {
				changed.Direction = "down"
			} else if op == "retry" {
				text := "Different instructions"
				changed.Steer = &text
			} else {
				changed.Op, changed.Direction = "move", "up"
			}
			_, err = o.service.ControlTodo(session, item.Number.Int64, changed)
			requireControlMismatch(t, err)
			for _, otherOp := range []string{"retry", "drop", "move"} {
				if otherOp == op {
					continue
				}
				changed = TodoControlInput{Op: otherOp, Repository: o.repoID, Actor: o.userID, Request: input.Request}
				if otherOp == "move" {
					changed.Direction = "up"
				}
				_, err = o.service.ControlTodo(session, item.Number.Int64, changed)
				requireControlMismatch(t, err)
			}
			_, err = o.service.FileTodo(session, o.repoID, o.userID, MythicalTodoInput{Title: "Collision", Prompt: "Do not create", Request: input.Request})
			requireControlMismatch(t, err)
			changed = input
			changed.Request = "second"
			_, err = o.service.ControlTodo(session, other.Number.Int64, changed)
			requireControlMismatch(t, err)
			for _, key := range []string{"", strings.Repeat("x", 257)} {
				changed = input
				changed.Request = key
				_, err = o.service.ControlTodo(session, item.Number.Int64, changed)
				requireTodoRefusal(t, err, 400, "invalid_idempotency_key", "")
			}
			for _, field := range []string{"actor", "repository"} {
				changed = input
				if field == "actor" {
					changed.Actor++
				} else {
					changed.Repository++
				}
				_, err = o.service.ControlTodo(session, item.Number.Int64, changed)
				requireTodoRefusal(t, err, 403, "permission", "Invalid TODO authority")
			}
			require.Equal(t, after, o.byID(uuidString(item.ID)))
			require.Equal(t, otherAfter, o.byID(uuidString(other.ID)))

			// Same member and key through a new authenticated session are independent.
			replacement := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: o.userID}, SessionHash: "replacement-session"})
			target := item
			if op == "drop" {
				target = other
			}
			if op == "retry" {
				again := o.byID(uuidString(item.ID))
				again.State, again.Attempt = "blocked", 2
				_, err = o.service.queries().SaveMythicalItem(session, again)
				require.NoError(t, err)
			}
			second, err := o.service.ControlTodo(replacement, target.Number.Int64, input)
			require.NoError(t, err)
			if op != "drop" {
				require.NotEqual(t, first, second)
			}
			replay, err := o.service.ControlTodo(session, item.Number.Int64, input)
			require.NoError(t, err)
			require.Equal(t, first, replay)
			var count int
			require.NoError(t, o.pool.QueryRow(session, `SELECT count(*) FROM product_job_requests WHERE operation=$1`, operation).Scan(&count))
			require.Equal(t, 2, count)
			_, err = o.pool.Exec(session, `UPDATE users SET is_active=false WHERE id=$1`, o.userID)
			require.NoError(t, err)
			replay, err = o.service.ControlTodo(session, item.Number.Int64, input)
			var denied *AccessError
			require.ErrorAs(t, err, &denied)
			require.Equal(t, "permission", denied.Code)
			require.Empty(t, replay)
		})
	}
}

func TestTodoControlReplayMetadataRollsBackWithEffects(t *testing.T) {
	for _, op := range []string{"retry", "drop", "move"} {
		t.Run(op, func(t *testing.T) {
			o, session, item, other, input, operation := newControlReplay(t, op)
			order := o.stackOrder()
			_, err := o.pool.Exec(session, `CREATE FUNCTION reject_control_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.authorization_context ? 'credential' THEN RAISE EXCEPTION 'test metadata write refused'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_control_metadata BEFORE UPDATE ON product_job_requests FOR EACH ROW EXECUTE FUNCTION reject_control_metadata()`)
			require.NoError(t, err)
			_, err = o.service.ControlTodo(session, item.Number.Int64, input)
			require.ErrorContains(t, err, "test metadata write refused")
			require.Equal(t, item, o.byID(uuidString(item.ID)))
			require.Equal(t, other, o.byID(uuidString(other.ID)))
			require.Equal(t, order, o.stackOrder())
			require.Empty(t, o.facts(item, operation))
			_, err = o.service.queries().GetMythicalRequest(session, o.repoID, "owner-session", input.Request)
			require.ErrorIs(t, err, pgx.ErrNoRows)
			_, err = o.pool.Exec(session, `DROP TRIGGER reject_control_metadata ON product_job_requests`)
			require.NoError(t, err)
			receipt, err := o.service.ControlTodo(session, item.Number.Int64, input)
			require.NoError(t, err)
			require.Equal(t, "accepted", receipt.State)
			require.Len(t, o.facts(item, operation), 1)
		})
	}
}

func TestTodoControlReplayRechecksAuthorityAfterLockWait(t *testing.T) {
	for _, op := range []string{"retry", "drop", "move"} {
		t.Run(op, func(t *testing.T) {
			o, session, item, _, input, _ := newControlReplay(t, op)
			_, err := o.service.ControlTodo(session, item.Number.Int64, input)
			require.NoError(t, err)
			locked, err := o.pool.Begin(session)
			require.NoError(t, err)
			defer locked.Rollback(context.Background())
			_, err = locked.Exec(session, `SELECT pg_advisory_xact_lock($1)`, o.repoID)
			require.NoError(t, err)
			done := make(chan error, 1)
			go func() {
				receipt, err := o.service.ControlTodo(session, item.Number.Int64, input)
				if receipt.State != "" {
					err = fmt.Errorf("disclosed receipt: %+v (%v)", receipt, err)
				}
				done <- err
			}()
			require.Eventually(t, func() bool {
				var waiting bool
				err := o.pool.QueryRow(session, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND objid=$1)`, o.repoID).Scan(&waiting)
				return err == nil && waiting
			}, 5*time.Second, 10*time.Millisecond)
			_, err = o.pool.Exec(session, `UPDATE users SET is_active=false WHERE id=$1`, o.userID)
			require.NoError(t, err)
			require.NoError(t, locked.Commit(session))
			select {
			case err = <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("control did not finish after lock release")
			}
			var denied *AccessError
			require.ErrorAs(t, err, &denied)
			require.Equal(t, "permission", denied.Code)
		})
	}
}

func TestTodoControlLegacyReceiptsCannotAuthorizeReplay(t *testing.T) {
	for _, op := range []string{"retry", "drop", "move"} {
		t.Run(op, func(t *testing.T) {
			o, session, item, _, input, operation := newControlReplay(t, op)
			checks := mythicalChecksOf(item)
			switch op {
			case "retry":
				checks.Retries = append(checks.Retries, todoRetry{Request: input.Request, Attempt: 2})
			case "drop":
				checks.Dropped = &todoDrop{Request: input.Request}
				item.State = "cancelled"
			case "move":
				err := pgx.BeginFunc(session, o.pool, func(tx pgx.Tx) error {
					raw, _ := json.Marshal(map[string]any{"item": uuidString(item.ID), "to": 2, "direction": "up"})
					_, e := jobs.RecordFactInTx(session, tx, todoOperationScope(item), uuid.NewSHA1(todoMoveNamespace, []byte(uuidString(item.ID)+"\x00"+input.Request)).String(), operation, todoState(item), raw)
					return e
				})
				require.NoError(t, err)
			}
			item.Checks = checks.encode()
			var err error
			item, err = o.service.queries().SaveMythicalItem(session, item)
			require.NoError(t, err)
			_, err = o.service.ControlTodo(session, item.Number.Int64, input)
			requireTodoRefusal(t, err, 503, "todo_control_unavailable", "")
			require.Equal(t, item, o.byID(uuidString(item.ID)))
		})
	}
}

func TestTodoControlAndCreationRaceForOneRequest(t *testing.T) {
	for _, op := range []string{"retry", "drop", "move"} {
		t.Run(op, func(t *testing.T) {
			o, session, item, _, input, operation := newControlReplay(t, op)
			start := make(chan struct{})
			outcomes := make(chan error, 2)
			go func() { <-start; _, err := o.service.ControlTodo(session, item.Number.Int64, input); outcomes <- err }()
			go func() {
				<-start
				_, err := o.service.FileTodo(session, o.repoID, o.userID, MythicalTodoInput{Title: "Racing creation", Prompt: "Only one request owns the key", Request: input.Request})
				outcomes <- err
			}()
			close(start)
			accepted := 0
			for range 2 {
				if err := <-outcomes; err == nil {
					accepted++
				} else {
					requireControlMismatch(t, err)
				}
			}
			require.Equal(t, 1, accepted)
			var created, controlled int
			require.NoError(t, o.pool.QueryRow(session, `SELECT count(*) FROM mythical_items WHERE checks->>'filedRequest'=$1`, input.Request).Scan(&created))
			require.NoError(t, o.pool.QueryRow(session, `SELECT count(*) FROM product_job_requests WHERE operation=$1`, operation).Scan(&controlled))
			require.Equal(t, 1, created+controlled, "the losing operation made no durable change")
			if created == 1 {
				require.Equal(t, item, o.byID(uuidString(item.ID)))
			}
		})
	}
}

func TestTodoControlUnreadableReceiptDoesNotRepeatEffect(t *testing.T) {
	for _, op := range []string{"retry", "drop", "move"} {
		t.Run(op, func(t *testing.T) {
			o, session, item, _, input, operation := newControlReplay(t, op)
			_, err := o.service.ControlTodo(session, item.Number.Int64, input)
			require.NoError(t, err)
			after := o.byID(uuidString(item.ID))
			for _, invalid := range []string{`{}`, `{"state":"running"}`, `{"state":1}`} {
				_, err = o.pool.Exec(session, `UPDATE product_job_requests SET authorization_context=jsonb_set(authorization_context,'{receipt}',$2::jsonb) WHERE operation=$1`, operation, invalid)
				require.NoError(t, err)
				_, err = o.service.ControlTodo(session, item.Number.Int64, input)
				requireTodoRefusal(t, err, 503, "todo_control_unavailable", "")
				require.Equal(t, after, o.byID(uuidString(item.ID)))
				require.Len(t, o.facts(item, operation), 1)
			}
		})
	}
}
