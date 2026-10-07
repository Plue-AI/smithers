package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

type noteHostContractFixture struct{}

func (noteHostContractFixture) CodingNoteParticipant(_ context.Context, _ string, run string, _ flowruntime.Pin) (string, string, error) {
	return "agent:own", run, nil
}

// The person-facing install socket observes the same real, verified burst
// that admits the pinned note. Host capability registration is the only fake;
// this is not C-J3-03's real-machine/run acceptance.
func TestOutsideNotesComposedLiveBoundary(t *testing.T) {
	testBranchChangesProductionLiveBoundary(t, func(f presenceInstallFixture, ingest *machined.BurstIngest) {
		var item string
		require.NoError(t, f.pool.QueryRow(t.Context(), `INSERT INTO mythical_items(repository_id,source,state,workspace_id,owner_id,request_run_id,flow_digest,checks) VALUES($1,'todo','running',$2,$3,'pinned-notes-run',$4,$5) RETURNING id`, f.row.RepositoryID, f.row.ID, f.user.ID, strings.Repeat("a", 64), `{"flowSource":"`+strings.Repeat("b", 40)+`"}`).Scan(&item))
		store, err := jobs.NewStore(f.pool)
		require.NoError(t, err)
		dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			t.Error("burst admission must not launch a host")
			return nil, machined.ErrNotReady
		})})
		require.NoError(t, err)
		notes := &machined.OutsideChangeNotes{Runs: &machined.PinnedCodingNoteRuns{Host: noteHostContractFixture{}}, Dispatcher: dispatcher}
		ingest.OutsideChanges = notes.Admit
		t.Cleanup(func() {
			rows, err := f.pool.Query(context.Background(), `SELECT payload FROM product_job_requests WHERE operation=$1 ORDER BY created_at`, flowdispatch.OperationSignal)
			require.NoError(t, err)
			defer rows.Close()
			count := 0
			for rows.Next() {
				var raw []byte
				require.NoError(t, rows.Scan(&raw))
				var saved struct {
					Target  flowruntime.Target `json:"target"`
					RunID   string             `json:"runId"`
					Payload struct {
						Kind  string         `json:"kind"`
						Actor map[string]any `json:"actor"`
						Files []string       `json:"files"`
					} `json:"payload"`
				}
				require.NoError(t, json.Unmarshal(raw, &saved))
				require.Equal(t, "pinned-notes-run", saved.RunID)
				require.Equal(t, item, saved.Target.BindingID)
				require.Equal(t, f.row.ID, saved.Target.WorkspaceID)
				require.Equal(t, "repository:"+fmt.Sprint(f.row.RepositoryID), saved.Target.TenantID)
				require.Equal(t, "outside_change", saved.Payload.Kind)
				require.Equal(t, "member:2", saved.Payload.Actor["id"])
				require.Equal(t, "ssh", saved.Payload.Actor["via"])
				require.NotEmpty(t, saved.Payload.Files)
				count++
			}
			require.NoError(t, rows.Err())
			require.Equal(t, 203, count, "each committed burst admits one note; duplicate and split parts add none")
		})
	})
}

// The install event binding and live socket are real. The pinned coding host's
// capability registration remains a contract fake, not real-machine acceptance.
func TestOutsideNotesMachineEventsProductionLiveBinding(t *testing.T) {
	testMachineEventsProductionLiveBinding(t, func(f presenceInstallFixture) *machined.OutsideChangeNotes {
		var item string
		require.NoError(t, f.pool.QueryRow(t.Context(), `INSERT INTO mythical_items(repository_id,source,state,workspace_id,owner_id,request_run_id,flow_digest,checks) VALUES($1,'todo','running',$2,$3,'pinned-notes-run',$4,$5) RETURNING id`, f.row.RepositoryID, f.row.ID, f.user.ID, strings.Repeat("a", 64), `{"flowSource":"`+strings.Repeat("b", 40)+`"}`).Scan(&item))
		store, err := jobs.NewStore(f.pool)
		require.NoError(t, err)
		dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			t.Error("event admission must not launch a host")
			return nil, machined.ErrNotReady
		})})
		require.NoError(t, err)
		t.Cleanup(func() {
			var count int
			require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT count(*) FROM product_job_requests WHERE operation=$1`, flowdispatch.OperationSignal).Scan(&count))
			require.Equal(t, 5, count, "five committed bursts, including a host actor reference; the transport replay admits none")
			var fact []byte
			require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT data->'actor' FROM product_job_events WHERE event_type='branch.burst' AND data->>'id'=$1`, "01000000-0000-0000-0000-000000000000").Scan(&fact))
			require.JSONEq(t, `{"kind":"person","id":"member:2","member_id":"2","via":"ssh"}`, string(fact), "the watcher keeps its stable actor identity")
			var raw []byte
			require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT payload FROM product_job_requests WHERE request_id=$1`, "outside-change:"+f.row.ID+":01000000-0000-0000-0000-000000000000").Scan(&raw))
			var saved struct {
				RunID   string `json:"runId"`
				Payload struct {
					Actor map[string]any `json:"actor"`
					Files []string       `json:"files"`
				} `json:"payload"`
			}
			require.NoError(t, json.Unmarshal(raw, &saved))
			require.Equal(t, "pinned-notes-run", saved.RunID)
			require.Equal(t, "person", saved.Payload.Actor["kind"])
			require.Equal(t, "ssh", saved.Payload.Actor["via"])
			require.Equal(t, "Alice", saved.Payload.Actor["name"])
			require.Equal(t, []string{"a.ts"}, saved.Payload.Files)
			require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT payload FROM product_job_requests WHERE request_id=$1`, "outside-change:"+f.row.ID+":07000000-0000-0000-0000-000000000000").Scan(&raw))
			require.NoError(t, json.Unmarshal(raw, &saved))
			require.Equal(t, "pinned-notes-run", saved.RunID)
			require.Equal(t, "agent", saved.Payload.Actor["kind"])
			require.Equal(t, "run:retained-attempt", saved.Payload.Actor["id"])
		})
		return &machined.OutsideChangeNotes{Runs: &machined.PinnedCodingNoteRuns{Host: noteHostContractFixture{}}, Dispatcher: dispatcher}
	}, func(f presenceInstallFixture) {
		// A display-name change after commit must not alter the watcher fact's
		// identity on transport replay or insert a second note.
		_, err := f.pool.Exec(t.Context(), `UPDATE users SET display_name='Bob' WHERE id=$1`, f.user.ID)
		require.NoError(t, err)
	})
}
