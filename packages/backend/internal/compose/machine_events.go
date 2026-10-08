package compose

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type machineBurstStore struct{ host *repohost.Client }

func (s machineBurstStore) WithBurstObjects(ctx context.Context, tx pgx.Tx, branch string, visit func(machined.BurstObjects) error) error {
	return withMachineRepositoryTx(ctx, tx, branch, s.host, func(path string) error {
		return visit(machined.GitBurstObjects{Resolve: func(context.Context, string) (string, error) { return path, nil }})
	})
}

// A cumulative counter supplies burst rate to the existing metrics collector.
// An install without a daemon producer does not fabricate zero observations.
func machineBurstObservations(metrics *routes.SmithersMetrics, registry *machined.Registry) func() {
	if registry == nil {
		return nil
	}
	bursts := prometheus.NewCounter(prometheus.CounterOpts{
		Name: "smithers_machine_bursts_total",
		Help: "Logical machine bursts committed by this process; staging, replay and failed ingestion are excluded.",
	})
	metrics.MustRegister(bursts)
	return bursts.Inc
}

func bindMachineEvents(ctx context.Context, registry *machined.Registry, pool *pgxpool.Pool, host *repohost.Client, observeCommitted func(), notes *machined.OutsideChangeNotes, moved ...*services.MythicalService) (func(), error) {
	if registry == nil {
		return func() {}, nil
	}
	if pool == nil || host == nil {
		return nil, machined.ErrNotReady
	}
	// No live-presence fallback: only immutable references or retained receipts
	// can establish an earlier actor after close, revocation or counter reuse.
	burst := &machined.BurstIngest{Pool: pool, Objects: machineBurstStore{host}, ObserveCommitted: observeCommitted}
	if notes != nil {
		burst.OutsideChanges = notes.Admit
	}
	return registry.ConsumeEvents(ctx, func(ctx context.Context, link *machined.Link, branch string, event machined.Event) (machined.Acknowledgement, error) {
		colors := map[string]int{}
		if len(event.Payload) > 0 && event.Payload[0] == 4 && len(moved) > 0 && moved[0] != nil {
			roster, err := (&services.Members{Pool: pool}).SharedRoster(ctx)
			if err != nil {
				return machined.Acknowledgement{}, err
			}
			for _, member := range roster.Members {
				colors[member.Login] = member.ColorIndex
			}
		}

		ingest := &machined.Ingestor{Pool: pool, Bursts: burst, Prepare: func(ctx context.Context, tx pgx.Tx, branch string, event machined.Event) (machined.EventWriter, error) {
			if len(event.Payload) > 0 && event.Payload[0] == 4 && len(moved) > 0 && moved[0] != nil {
				return moved[0].PrepareStoredMovedOffEvent(link.Machine(), func(ctx context.Context, tx pgx.Tx, raw json.RawMessage) (json.RawMessage, error) {
					return machineMovedActor(ctx, tx, raw, colors)
				})(ctx, tx, branch, event)
			}
			if len(event.Payload) == 0 || (event.Payload[0] != 2 && event.Payload[0] != 3) {
				return nil, machined.ErrNotReady
			}
			return prepareMachineCaptureWriter(host)(ctx, tx, branch, event)
		}}
		ack, err := ingest.Commit(ctx, link.Connection, branch, event)
		if err != nil {
			slog.Warn("machine event refused", "workspace_id", branch, "sequence", event.Seq, "error", err)
		}
		return ack, err
	}, func(ctx context.Context, link *machined.Link, branch string, event machined.Event) error {
		return burst.Hint(ctx, link.Connection, branch, event)
	})
}

func machineBranchHead(pool *pgxpool.Pool, host *repohost.Client) func(context.Context, string) (string, error) {
	return func(ctx context.Context, branch string) (string, error) {
		tx := machined.SessionAdmissionTransaction(ctx, branch)
		admitted := tx != nil
		if !admitted {
			var err error
			tx, err = pool.Begin(ctx)
			if err != nil {
				return "", err
			}
			defer tx.Rollback(ctx)
		}
		var head string
		visit := withMachineRepositoryTx
		if admitted {
			visit = withMachineRepositoryReadTx
		}
		err := visit(ctx, tx, branch, host, func(path string) error {
			row, err := db.New(tx).GetWorkspace(ctx, branch)
			if err != nil {
				return err
			}
			if row.HeadPushTokenID.Valid {
				return machined.ErrNotReady
			}
			seed := row.HeadCommitID
			if seed == "" {
				seed = row.SourceCommit
			}
			objects := machined.HostObjects{Visit: func(ctx context.Context, _ string, visit func(string) error) error { return visit(path) }}
			var readErr error
			head, readErr = objects.Head(ctx, branch, seed)
			return readErr
		})
		return head, err
	}
}

// Reuse the same public actor renderers as branch activity, without acquiring a
// second pool connection while the event transaction holds the registry fence.
func machineMovedActor(ctx context.Context, tx pgx.Tx, raw json.RawMessage, colors map[string]int) (json.RawMessage, error) {
	var actor struct {
		Kind    string `json:"kind"`
		ID      string `json:"id"`
		Member  string `json:"member_id"`
		Via     string `json:"via"`
		Agent   string `json:"agent_kind"`
		Run     string `json:"run_id"`
		Sponsor string `json:"for_member"`
	}
	if err := json.Unmarshal(raw, &actor); err != nil {
		return nil, err
	}
	if actor.Kind == "outside" {
		return raw, nil
	}
	member := actor.Member
	if actor.Kind == "agent" {
		member = actor.Sponsor
	}
	id, err := strconv.ParseInt(member, 10, 64)
	if err != nil {
		return nil, err
	}
	person, err := db.New(tx).GetUserByID(ctx, id)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if actor.Kind == "person" {
		result = branchPersonActor(person, colors[person.Username])
		if actor.Via == "ssh" || actor.Via == "terminal" || actor.Via == "cli" {
			result["via"] = actor.Via
		}
	} else if actor.Kind == "agent" {
		result = branchAgentActor(actor.ID, leaseParticipant{AgentKind: actor.Agent, RunID: actor.Run, DisplayName: actor.Agent}, &person, colors[person.Username])
	} else {
		return nil, machined.ErrUnauthorized
	}
	return json.Marshal(result)
}
