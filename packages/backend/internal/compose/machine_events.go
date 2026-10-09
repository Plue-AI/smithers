package compose

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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

// bindMachineEvents is the install's event pump without transcript import: a
// transcript record on it is refused for good before any read of it or write.
func bindMachineEvents(ctx context.Context, registry *machined.Registry, pool *pgxpool.Pool, host *repohost.Client, observeCommitted func(), notes *machined.OutsideChangeNotes, moved ...*services.MythicalService) (func(), error) {
	return machineEvents{}.bind(ctx, registry, pool, host, observeCommitted, notes, moved...)
}

// machineEvents is what the install's one durable-event consumer writes with.
type machineEvents struct {
	// Transcripts imports a member's external agent session (ADR 0004 variant
	// 5). Nil leaves that import unavailable; every other event is unaffected.
	Transcripts *TranscriptIngest
}

// settledTranscript makes every transcript record end in an acknowledgement.
//
// A machine has one durable queue: its change events wait behind whatever is
// at the front. A transcript record the host cannot import must therefore not
// stay there. Whatever the reason replaying the record would not change (no
// import in this install, an adapter host that is down, a session the host
// never opened), the record is refused for good: nothing of it is written, the
// receipt says rejected, and the machine stops reading that source. Only a
// database fault or a cancelled request leaves the record unanswered, as for
// every other event, because then nothing at all can be recorded.
func settledTranscript(write machined.EventWriter) machined.EventWriter {
	return func(ctx context.Context, tx pgx.Tx, branch string, event machined.Event) (machined.Acknowledgement, error) {
		rejected := machined.Acknowledgement{Seq: event.Seq, Outcome: machined.AckRejected}
		if write == nil {
			return rejected, nil
		}
		// A refusal part-way through leaves none of the writer's rows behind.
		attempt, err := tx.Begin(ctx)
		if err != nil {
			return machined.Acknowledgement{Seq: event.Seq}, err
		}
		ack, err := write(ctx, attempt, branch, event)
		if err == nil {
			return ack, attempt.Commit(ctx)
		}
		var database *pgconn.PgError
		if errors.As(err, &database) || ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return machined.Acknowledgement{Seq: event.Seq}, err
		}
		if undo := attempt.Rollback(ctx); undo != nil {
			return machined.Acknowledgement{Seq: event.Seq}, undo
		}
		slog.Warn("transcript record refused", "workspace_id", branch, "sequence", event.Seq, "error", err)
		return rejected, nil
	}
}

func (m machineEvents) bind(ctx context.Context, registry *machined.Registry, pool *pgxpool.Pool, host *repohost.Client, observeCommitted func(), notes *machined.OutsideChangeNotes, moved ...*services.MythicalService) (func(), error) {
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
		burst.OutsideChanges = func(ctx context.Context, tx pgx.Tx, branch, burst string, actor json.RawMessage, files []string) error {
			err := notes.Admit(ctx, tx, branch, burst, actor, files)
			// An unqualified coding host leaves notification delivery dark,
			// not the ordinary committed watcher projections.
			if errors.Is(err, machined.ErrNotReady) {
				return nil
			}
			return err
		}
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

		ingest := &machined.Ingestor{Pool: pool, Bursts: burst, Prepare: func(ctx context.Context, tx pgx.Tx, branch string, event machined.Event, commit machined.EventCommit) (machined.Acknowledgement, error) {
			ack := machined.Acknowledgement{Seq: event.Seq}
			if len(event.Payload) > 0 && event.Payload[0] == 4 && len(moved) > 0 && moved[0] != nil {
				return moved[0].PrepareStoredMovedOffEvent(link.Machine(), func(ctx context.Context, tx pgx.Tx, raw json.RawMessage) (json.RawMessage, error) {
					return machineMovedActor(ctx, tx, raw, colors)
				})(ctx, tx, branch, event, commit)
			}
			if len(event.Payload) > 0 && event.Payload[0] == 5 {
				if m.Transcripts == nil || !registry.TranscriptImportReady() {
					return commit(settledTranscript(nil))
				}
				// Each record's owner comes from this link's own boot: the
				// session receipts of another boot never answer for it.
				transcripts := *m.Transcripts
				transcripts.Resolve = installTranscriptSource(link)
				// A record can reach the host a moment before its session's
				// receipt. It waits for the receipt here, before any row lock
				// and before Ingestor takes the registry fence, so whoever
				// needs either is not held while this record waits.
				if err := awaitTranscriptSession(ctx, tx, branch, link, event); err != nil {
					return ack, err
				}
				// A workspace owner may consult the registry while holding
				// this row. Acquire it before Ingestor takes the registry fence.
				var workspace string
				if err := tx.QueryRow(ctx, `SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, branch).Scan(&workspace); err != nil {
					return ack, err
				}
				return commit(settledTranscript(func(ctx context.Context, tx pgx.Tx, branch string, event machined.Event) (machined.Acknowledgement, error) {
					if !registry.TranscriptImportEnabled() {
						return machined.Acknowledgement{Seq: event.Seq, Outcome: machined.AckRejected}, nil
					}
					return transcripts.Write(ctx, tx, branch, event)
				}))
			}
			if len(event.Payload) == 0 || (event.Payload[0] != 2 && event.Payload[0] != 3) {
				return ack, machined.ErrNotReady
			}
			return prepareMachineCaptureWriter(host)(ctx, tx, branch, event, commit)
		}}
		ack, err := ingest.Commit(ctx, link.Connection, branch, event)
		if err != nil {
			slog.Warn("machine event refused", "workspace_id", branch, "sequence", event.Seq, "error", err)
		}
		return ack, err
	}, func(ctx context.Context, link *machined.Link, branch string, event machined.Event) error {
		err := burst.Hint(ctx, link.Connection, branch, event)
		if err != nil {
			slog.Warn("machine hint refused", "workspace_id", branch, "error", err)
		}
		return err
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
			// Preserve admission's KEY SHARE workspace lock. Upgrading to SHARE
			// makes the later running-state UPDATE wait on its own admission.
			visit = func(ctx context.Context, tx pgx.Tx, branch string, host *repohost.Client, read func(string) error) error {
				return withMachineRepositoryAuthorityTx(ctx, tx, branch, host, read, "FOR KEY SHARE")
			}
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
