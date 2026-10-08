package compose

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// A session's idempotency key belongs to one operation, across creation and
// amendment. Both actual HTTP doors must serialize rather than deadlock.
func TestTodoCreationFeedbackRaceComposedInstall(t *testing.T) {
	h := newTodoLiteralInstall(t, func(s *services.MythicalService, pool *pgxpool.Pool) {
		s.EnableTodoSteering()
		s.SetTodoFlow(func(context.Context, int64, string) (string, error) {
			t.Fatal("queued feedback must not resolve Active")
			return "", nil
		})
		store, err := jobs.NewStore(pool)
		require.NoError(t, err)
		dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: s, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			t.Fatal("HTTP must not await runtime delivery")
			return nil, nil
		})})
		require.NoError(t, err)
		s.SetLauncher(dispatcher)
	})
	_, err := h.pool.Exec(t.Context(), `UPDATE mythical_items SET revisions='[{"rev":1,"text":"Literal projection","acceptance":[],"by":{"person":"maya"},"at":"2026-10-02T12:00:00Z"}]' WHERE id=$1`, h.item.ID)
	require.NoError(t, err)
	for round := 0; round < 20; round++ {
		t.Run(fmt.Sprintf("race-%02d", round), func(t *testing.T) {
			key := fmt.Sprintf("creation-feedback-%d", round)
			var beforeItems, beforeFacts int
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items`).Scan(&beforeItems))
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'todo.%'`).Scan(&beforeFacts))
			type response struct {
				code   int
				body   map[string]any
				create bool
			}
			start := make(chan struct{})
			results := make(chan response, 2)
			go func() {
				<-start
				code, body := h.call(t, "POST", `{"title":"Race","prompt":"Only one operation"}`, key, "/api/todos")
				results <- response{code, body, true}
			}()
			go func() {
				<-start
				code, body := h.call(t, "PATCH", `{"prompt":"Keep cancellation","acceptance":[]}`, key)
				results <- response{code, body, false}
			}()
			close(start)
			accepted, refused, created := 0, 0, 0
			for range 2 {
				select {
				case res := <-results:
					if res.code == 202 {
						accepted++
						if res.create {
							created++
						}
					} else {
						require.Equal(t, 409, res.code, res.body)
						require.Equal(t, "idempotency_mismatch", res.body["code"])
						refused++
					}
				case <-time.After(10 * time.Second):
					t.Fatal("creation and feedback did not settle")
				}
			}
			require.Equal(t, 1, accepted)
			require.Equal(t, 1, refused)
			var afterItems, afterFacts int
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items`).Scan(&afterItems))
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'todo.%'`).Scan(&afterFacts))
			require.Equal(t, beforeItems+created, afterItems)
			if created == 1 {
				require.Equal(t, beforeFacts+1, afterFacts)
			} else {
				require.Equal(t, beforeFacts+2, afterFacts, "amendment and its shared steer each record one fact")
			}
		})
	}
}
