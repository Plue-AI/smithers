package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ActivityLimit is how many of a branch's newest entries its activity card
// and topic snapshot hold (spec §7.2).
const ActivityLimit = 200

// The activity kinds (spec §3). S1 writes step, steer, answer and github.
const (
	ActivityStep     = "step"
	ActivitySteer    = "steer"
	ActivityQuestion = "question"
	ActivityAnswer   = "answer"
	ActivityEdit     = "edit"
	ActivityChange   = "change"
	ActivityGitHub   = "github"
	ActivityRebase   = "rebase"
)

// ActivityView is one branch activity entry, as GET
// /api/branches/{b}/activity and the branch:<id>:activity topic carry it.
type ActivityView struct {
	Seq     int64           `json:"seq"`
	At      time.Time       `json:"at"`
	Actor   json.RawMessage `json:"actor"`
	AskedBy json.RawMessage `json:"asked_by,omitempty"`
	Kind    string          `json:"kind"`
	Summary json.RawMessage `json:"summary"`
	GitHub  bool            `json:"github,omitempty"`
}

// ActivityDelta is one branch:<id>:activity topic delta: an appended entry.
type ActivityDelta struct {
	Type  string       `json:"type"`
	Entry ActivityView `json:"entry"`
}

func activityView(row db.Activity) ActivityView {
	return ActivityView{Seq: row.Seq, At: row.At, Actor: todoActorRef(row.Actor), AskedBy: todoActorRef(row.AskedBy), Kind: row.Kind, Summary: row.Summary, GitHub: row.Github}
}

// AppendActivity appends one entry to a branch's activity and its
// branch:<id>:activity projection in tx (spec §3.1): seq is the branch's next,
// in commit order. askedBy is the optional requester, separate from the actor.
// sourceKey, when set, names the entry's origin (an agent
// step is its run and journal sequence): an entry already appended under it
// is answered unchanged (appended false), so a re-observed page appends
// nothing twice.
func AppendActivity(ctx context.Context, tx pgx.Tx, branchID string, actor TodoActor, askedBy *TodoActor, kind string, summary any, sourceKey string) (ActivityView, bool, error) {
	switch kind {
	case ActivityStep, ActivitySteer, ActivityQuestion, ActivityAnswer, ActivityEdit, ActivityChange, ActivityGitHub, ActivityRebase:
	default:
		return ActivityView{}, false, fmt.Errorf("activity kind %q is not one of spec §3's", kind)
	}
	q := db.New(tx)
	if _, err := q.LockBranchForActivity(ctx, branchID); err != nil {
		return ActivityView{}, false, err
	}
	key := pgtype.Text{String: sourceKey, Valid: sourceKey != ""}
	if key.Valid {
		existing, err := q.GetActivityBySourceKey(ctx, db.GetActivityBySourceKeyParams{BranchID: branchID, SourceKey: key})
		if err == nil {
			return activityView(existing), false, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return ActivityView{}, false, err
		}
	}
	seq, err := q.NextActivitySeq(ctx, branchID)
	if err != nil {
		return ActivityView{}, false, err
	}
	body, err := json.Marshal(summary)
	if err != nil {
		return ActivityView{}, false, err
	}
	var requester json.RawMessage
	if askedBy != nil {
		requester = askedBy.encode()
	}
	row, err := q.InsertActivity(ctx, db.InsertActivityParams{BranchID: branchID, Seq: seq, Actor: actor.encode(), AskedBy: requester, Kind: kind,
		Summary: body, SourceKey: key})
	if err != nil {
		return ActivityView{}, false, err
	}
	view := activityView(row)
	branch, err := q.GetBranch(ctx, branchID)
	if err != nil {
		return ActivityView{}, false, err
	}
	if _, err := Publish(ctx, tx, Projection{RepositoryID: branch.RepositoryID, Topic: ProjectionTopicBranchActivity(branchID), Payload: ActivityDelta{Type: "entry", Entry: view}}); err != nil {
		return ActivityView{}, false, err
	}
	return view, true, nil
}

// BranchActivity answers a branch's repository and its newest
// ActivityLimit entries, oldest first (GET /api/branches/{b}/activity, the
// branch:<id>:activity snapshot).
func (s *TodoService) BranchActivity(ctx context.Context, branchID string) (int64, []ActivityView, error) {
	q := db.New(s.store)
	branch, err := s.branch(ctx, q, branchID)
	if err != nil {
		return 0, nil, err
	}
	rows, err := q.ListBranchActivity(ctx, db.ListBranchActivityParams{BranchID: branch.ID, RowLimit: ActivityLimit})
	if err != nil {
		return 0, nil, err
	}
	out := make([]ActivityView, 0, len(rows))
	for _, row := range rows {
		out = append(out, activityView(row))
	}
	return branch.RepositoryID, out, nil
}

// BranchRepository answers the repository a branch belongs to.
func (s *TodoService) BranchRepository(ctx context.Context, branchID string) (int64, error) {
	branch, err := s.branch(ctx, db.New(s.store), branchID)
	return branch.RepositoryID, err
}

func (s *TodoService) branch(ctx context.Context, q *db.Queries, branchID string) (db.GetBranchRow, error) {
	if !pgUUIDFromString(branchID).Valid {
		return db.GetBranchRow{}, pkgerrors.NotFound("no such branch")
	}
	branch, err := q.GetBranch(ctx, branchID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.GetBranchRow{}, pkgerrors.NotFound("no such branch")
	}
	return branch, err
}

// The runtime journal's step start: a control.engine.event whose engine
// record is a scheduled node, counted as a step when it is an action call
// (RunProgress in the CLI counts the same).
const (
	runtimeEngineEventKind = "control.engine.event"
	runtimeNodeScheduled   = "flows.engine.node-scheduled"
	runtimeActionCall      = "ActionCall"
)

// runtimeStep is the step a runtime event starts, if it starts one.
type runtimeStep struct {
	Node    string `json:"node"`
	Action  string `json:"action,omitempty"`
	Attempt int64  `json:"attempt,omitempty"`
}

func runtimeStepOf(kind string, payload json.RawMessage) (runtimeStep, bool) {
	if kind != runtimeEngineEventKind {
		return runtimeStep{}, false
	}
	var record struct {
		EventType string `json:"eventType"`
		Payload   struct {
			NodeID  string `json:"nodeId"`
			Kind    string `json:"kind"`
			Action  string `json:"action"`
			Attempt int64  `json:"attempt"`
		} `json:"payload"`
	}
	if json.Unmarshal(payload, &record) != nil || record.EventType != runtimeNodeScheduled || record.Payload.Kind != runtimeActionCall ||
		record.Payload.NodeID == "" {
		return runtimeStep{}, false
	}
	return runtimeStep{Node: record.Payload.NodeID, Action: record.Payload.Action, Attempt: record.Payload.Attempt}, true
}

// projectRunSteps appends one step entry to the item's TODO branch for each
// step a run's observed journal page starts (spec §7.2, the runtime
// projection), in the same transaction as the item and its TODO. An item with no TODO has no branch and records none.
func (s *TodoService) projectRunSteps(ctx context.Context, tx pgx.Tx, item db.MythicalItem, phase string, update flowdispatch.ProjectionUpdate) error {
	if !item.TodoID.Valid || len(update.Events) == 0 {
		return nil
	}
	q := db.New(tx)
	todo, err := q.GetTodo(ctx, uuidString(item.TodoID))
	if err != nil {
		return err
	}
	if !todo.BranchID.Valid {
		return nil
	}
	for _, event := range update.Events {
		step, ok := runtimeStepOf(event.Kind, event.Payload)
		if !ok {
			continue
		}
		run := event.RunID
		if run == "" {
			run = update.Checkpoint.RunID
		}
		actor := TodoActor{Agent: "coding", Run: run, Todo: todo.Number}
		summary := map[string]any{"step": step.Node, "phase": phase, "run": run}
		if step.Action != "" {
			summary["action"] = step.Action
		}
		if step.Attempt > 1 {
			summary["attempt"] = step.Attempt
		}
		key := "run:" + run + ":" + strconv.FormatInt(event.Sequence, 10)
		if _, _, err := AppendActivity(ctx, tx, uuidString(todo.BranchID), actor, nil, ActivityStep, summary, key); err != nil {
			return err
		}
	}
	return nil
}
