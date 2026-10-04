package services

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestTodoStateLiteralProjection(t *testing.T) {
	// Independent literal base states, not a production/spec-derived oracle.
	cases := []struct{ engine, product string }{
		{"queued", "queued"}, {"skipped", "queued"}, {"running", "working"}, {"delivering", "working"},
		{"integrating", "working"}, {"verifying", "working"}, {"proposing", "working"}, {"waiting", "working"},
		{"retrying", "working"}, {"proposed", "in_review"}, {"landed", "merged"}, {"blocked", "failed"},
		{"cancelled", "dropped"}, {"rejected", "dropped"}, {"declined", "dropped"},
	}
	count := 0
	for _, c := range cases {
		for _, launched := range []bool{false, true} {
			for _, paused := range []bool{false, true} {
				for _, waits := range [][]TodoWait{nil, {{ID: "q", Kind: "question"}}, {{ID: "f", Kind: "foreign_push"}}, {{ID: "q", Kind: "question"}, {ID: "f", Kind: "foreign_push"}}} {
					item := db.MythicalItem{State: c.engine, PausedAt: pgtype.Timestamptz{Time: time.Unix(1, 0), Valid: paused}, Checks: mythicalChecks{Waits: waits, RunLaunched: launched}.encode()}
					expected := c.product
					if launched {
						switch c.engine {
						case "queued", "running", "delivering", "integrating", "verifying", "proposing", "waiting", "retrying":
							expected = "starting"
						}
					}
					terminal := c.engine == "landed" || c.engine == "cancelled" || c.engine == "rejected" || c.engine == "declined"
					if !terminal {
						if len(waits) > 0 {
							expected = "needs_you"
						} else if paused {
							expected = "paused"
						}
					}
					require.Equal(t, expected, todoState(item), "%s paused=%v waits=%v", c.engine, paused, waits)
					count++
				}
			}
		}
	}
	require.Equal(t, 240, count)
	t.Logf("literal projection inputs: %d", count)
	for _, attached := range []bool{false, true} {
		item := db.MythicalItem{State: "running", Checks: mythicalChecks{RunLaunched: true, RunAttached: attached}.encode()}
		expected := "starting"
		if attached {
			expected = "working"
		}
		require.Equal(t, expected, todoState(item))
	}
	require.Equal(t, "in_review", todoState(db.MythicalItem{State: "queued", PRState: "open"}))
}
func TestTodoWaitPriorityAndSettlement(t *testing.T) {
	now := time.Unix(1, 0)
	item := db.MythicalItem{State: "blocked", Checks: mythicalChecks{Waits: []TodoWait{
		{ID: "q", Kind: "question", Since: now}, {ID: "f-new", Kind: "foreign_push", Since: now.Add(time.Second)},
		{ID: "f-old", Kind: "foreign_push", Since: now}, {ID: "done", Kind: "moved_off", SettledAt: &now},
	}}.encode()}
	waits := todoOpenWaits(item)
	require.Equal(t, []string{"f-old", "f-new", "q"}, []string{waits[0].ID, waits[1].ID, waits[2].ID})
	require.Equal(t, "needs_you", todoState(item))
	checks := mythicalChecksOf(item)
	checks.Waits[0].SettledAt = &now
	item.Checks = checks.encode()
	require.Len(t, todoOpenWaits(item), 2)
	require.Equal(t, "needs_you", todoState(item))
}

func TestTodoPrimaryWaitLiteralOrder(t *testing.T) {
	item := db.MythicalItem{State: "running", Checks: mythicalChecks{Waits: []TodoWait{
		{ID: "q", Kind: "question"}, {ID: "a", Kind: "approval"}, {ID: "f", Kind: "foreign_push"}, {ID: "c", Kind: "conflict"}, {ID: "m", Kind: "moved_off"},
	}}.encode()}
	waits := todoOpenWaits(item)
	var kinds []string
	for _, wait := range waits {
		kinds = append(kinds, wait.Kind)
	}
	require.Equal(t, []string{"moved_off", "conflict", "foreign_push", "approval", "question"}, kinds)
}
