package compose

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Registration facts are controlled inputs, while admission and the mounted
// live boundary use the production host qualifier. Guest/tool qualification is
// proved separately by the real microVM and reference browser drivers.
func TestOutsideNotesComposedLiveBoundary(t *testing.T) {
	testBranchChangesProductionLiveBoundary(t, func(f presenceInstallFixture, ingest *machined.BurstIngest, boot [16]byte) {
		var item string
		require.NoError(t, f.pool.QueryRow(t.Context(), `INSERT INTO mythical_items(repository_id,source,state,workspace_id,owner_id,request_run_id,flow_digest,checks) VALUES($1,'todo','running',$2,$3,'pinned-notes-run',$4,$5) RETURNING id`, f.row.RepositoryID, f.row.ID, f.user.ID, strings.Repeat("a", 64), `{"flowSource":"`+strings.Repeat("b", 40)+`"}`).Scan(&item))
		store, err := jobs.NewStore(f.pool)
		require.NoError(t, err)
		dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			t.Error("burst admission must not launch a host")
			return nil, machined.ErrNotReady
		})})
		require.NoError(t, err)
		notes := &machined.OutsideChangeNotes{Runs: &machined.PinnedCodingNoteRuns{Host: qualifiedOutsideNoteHost(t, f, dispatcher, item, boot)}, Dispatcher: dispatcher}
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

// The installed event binding and live socket exercise the production qualifier
// over controlled registration facts, not real-machine acceptance.
func TestOutsideNotesMachineEventsProductionLiveBinding(t *testing.T) {
	testMachineEventsProductionLiveBinding(t, func(f presenceInstallFixture, boot [16]byte) *machined.OutsideChangeNotes {
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
		return &machined.OutsideChangeNotes{Runs: &machined.PinnedCodingNoteRuns{Host: qualifiedOutsideNoteHost(t, f, dispatcher, item, boot)}, Dispatcher: dispatcher}
	}, func(f presenceInstallFixture) {
		// A display-name change after commit must not alter the watcher fact's
		// identity on transport replay or insert a second note.
		_, err := f.pool.Exec(t.Context(), `UPDATE users SET display_name='Bob' WHERE id=$1`, f.user.ID)
		require.NoError(t, err)
	})
}

// The production qualifier is mounted even before an authenticated coding
// registration exists. Live watcher cards keep advancing; no signal is queued.
func TestOutsideNotesUnqualifiedHostKeepsLiveBoundary(t *testing.T) {
	testMachineEventsProductionLiveBinding(t, func(f presenceInstallFixture, boot [16]byte) *machined.OutsideChangeNotes {
		_, err := f.pool.Exec(t.Context(), `INSERT INTO mythical_items(repository_id,source,state,workspace_id,owner_id,request_run_id,flow_digest,checks) VALUES($1,'todo','running',$2,$3,'unqualified-run',$4,$5)`, f.row.RepositoryID, f.row.ID, f.user.ID, strings.Repeat("a", 64), `{"flowSource":"`+strings.Repeat("b", 40)+`"}`)
		require.NoError(t, err)
		store, err := jobs.NewStore(f.pool)
		require.NoError(t, err)
		dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			t.Error("watcher must not launch coding")
			return nil, machined.ErrNotReady
		})})
		require.NoError(t, err)
		t.Cleanup(func() {
			var n int
			require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT count(*) FROM product_job_requests WHERE operation=$1`, flowdispatch.OperationSignal).Scan(&n))
			require.Zero(t, n)
		})
		return &machined.OutsideChangeNotes{Runs: &machined.PinnedCodingNoteRuns{Host: &machined.RegisteredCodingNoteHost{ArtifactDigest: strings.Repeat("a", 64)}}, Dispatcher: dispatcher}
	})
}

func qualifiedOutsideNoteHost(t *testing.T, f presenceInstallFixture, dispatcher *flowdispatch.Service, item string, boot [16]byte) *machined.RegisteredCodingNoteHost {
	t.Helper()
	ctx := t.Context()
	artifact := strings.Repeat("c", 64)
	host := uuid.NewString()
	pin := flowruntime.Pin{Flow: "todo", SourceCommit: strings.Repeat("b", 40), ExecutionDigest: strings.Repeat("a", 64)}
	target := flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", f.row.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", f.user.ID), WorkspaceID: f.row.ID, BindingKind: "mythical-item", BindingID: item}
	_, err := f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write','maya',20001) ON CONFLICT(repository_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET permission='write',unix_login='maya',unix_uid=20001`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	err = f.pool.QueryRow(ctx, `UPDATE flow_runtime_host_bindings SET tenant_id=$2,principal_id=$3,binding_kind='mythical-item',binding_id=$4,repository_id=$5,user_id=$6,runtime_artifact_digest=$7,source_revision=$8,state='running',owner_generation=1 WHERE workspace_id=$1 AND catalog_key='coding' RETURNING id::text`, f.row.ID, target.TenantID, target.PrincipalID, item, f.row.RepositoryID, f.user.ID, artifact, pin.SourceCommit).Scan(&host)
	require.NoError(t, err)
	receipt, err := dispatcher.Admit(ctx, flowdispatch.LaunchRequest{Scope: jobs.Scope{TenantID: target.TenantID, PrincipalID: target.PrincipalID}, RequestID: "outside-note-launch", Target: target, FlowID: "todo", Pin: &pin, Payload: json.RawMessage(`{}`), Projection: json.RawMessage(`{}`), ApprovalPolicy: flowdispatch.ApprovalAuto})
	require.NoError(t, err)
	checkpoint := flowdispatch.RuntimeCheckpoint{Version: 1, Target: target, FlowID: "todo", RunID: "pinned-notes-run", ExecutionDigest: pin.ExecutionDigest, Identity: flowruntime.Identity{Protocol: flowruntime.Protocol, RuntimeArtifactDigest: artifact, SourceRevision: pin.SourceCommit, OwnerGeneration: 1}}
	raw, err := json.Marshal(checkpoint)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, receipt.OperationID, raw)
	require.NoError(t, err)
	require.NoError(t, pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		scope := jobs.Scope{TenantID: fmt.Sprint(f.row.RepositoryID), PrincipalID: "branch:" + f.row.ID}
		for kind, data := range map[string]map[string]any{
			"branch.session_opened": {"boot": hex.EncodeToString(boot[:]), "session": 77, "login": "agent", "uid": 19999, "via": "agent:" + host, "owner_generation": 1, "member_id": f.user.ID},
			"branch.run_registered": {"boot": hex.EncodeToString(boot[:]), "session": 77, "run": host},
		} {
			raw, err := json.Marshal(data)
			if err != nil {
				return err
			}
			if _, err = jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), kind, "completed", raw); err != nil {
				return err
			}
		}
		return nil
	}))
	return &machined.RegisteredCodingNoteHost{ArtifactDigest: artifact}
}

// The production dark policy retains authenticated daemon watcher facts and
// the mounted live projection without enqueueing signals to the TODO host.
func TestOutsideNotesDarkConsumerKeepsWatcherFacts(t *testing.T) {
	testMachineEventsProductionLiveBinding(t, func(f presenceInstallFixture, boot [16]byte) *machined.OutsideChangeNotes {
		var item string
		require.NoError(t, f.pool.QueryRow(t.Context(), `INSERT INTO mythical_items(repository_id,source,state,workspace_id,owner_id,request_run_id,flow_digest,checks) VALUES($1,'todo','running',$2,$3,'pinned-notes-run',$4,$5) RETURNING id`, f.row.RepositoryID, f.row.ID, f.user.ID, strings.Repeat("a", 64), `{"flowSource":"`+strings.Repeat("b", 40)+`"}`).Scan(&item))
		store, err := jobs.NewStore(f.pool)
		require.NoError(t, err)
		dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			t.Error("dark watcher must not contact a coding host")
			return nil, machined.ErrNotReady
		})})
		require.NoError(t, err)
		t.Cleanup(func() {
			var facts, signals int
			require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT count(*) FROM product_job_events WHERE event_type='branch.burst'`).Scan(&facts))
			require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT count(*) FROM product_job_requests WHERE operation=$1`, flowdispatch.OperationSignal).Scan(&signals))
			require.Equal(t, 5, facts)
			require.Zero(t, signals)
		})
		return machined.NewOutsideChangeNotes(&machined.PinnedCodingNoteRuns{Host: qualifiedOutsideNoteHost(t, f, dispatcher, item, boot)}, dispatcher)
	})
}
