package services

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// BranchActivityEvent is a branch's conversation entry: a steer, an answer,
// the agent's question or an agent step (spec §3 product_job_events, §14.3
// Branch activity[]). Each is appended to the item's branch stream in the
// transaction that changes the item, as moved-off is, so branch:<id>:activity
// reads one log under one cursor and an entry stays on the branch it
// happened on.
const BranchActivityEvent = "branch.activity"

// recordBranchActivity appends one entry for item's branch and wakes the
// topic's readers. actor is a rendered TodoCard actor (todoActor) or a stored
// participant the branch actor renderer resolves. An item with no branch
// records none.
func recordBranchActivity(ctx context.Context, tx pgx.Tx, item db.MythicalItem, id, kind string, actor json.RawMessage, text string) error {
	if item.WorkspaceID == "" || len(actor) == 0 {
		return nil
	}
	data, err := json.Marshal(map[string]any{"id": id, "kind": kind, "actor": actor, "text": text, "n": item.Number.Int64})
	if err != nil {
		return err
	}
	scope := jobs.Scope{TenantID: strconv.FormatInt(item.RepositoryID, 10), PrincipalID: "branch:" + item.WorkspaceID}
	if _, err := jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), BranchActivityEvent, "completed", data); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `SELECT pg_notify($1,'')`, "branch_"+strings.ReplaceAll(item.WorkspaceID, "-", "")+"_activity")
	return err
}

// todoPhase is one step of a TODO as its card names it, with the run bound to
// it. The card's steps (todoSteps) and the branch's agent steps read this list.
type todoPhase struct{ id, label, run, outcome, success string }

func todoPhases(item db.MythicalItem) []todoPhase {
	phases := []todoPhase{
		{"request", "Plan", item.RequestRunID, item.RequestOutcome, "validated"},
		{"vibe", "Code", item.VibeRunID, item.VibeOutcome, "submitted"},
		{"verify", "Verify", item.VerifyRunID, item.VerifyOutcome, "passed"},
	}
	if review := mythicalChecksOf(item).Review; review != nil {
		phases = append(phases, todoPhase{"review", "Review", review.RunID, review.Verdict, "approve"})
	}
	return phases
}

// runAgentActor is the agent working run for the item's owner, in the stored
// participant form machined.ResolveStoredEventActor writes for agent changes.
func runAgentActor(item db.MythicalItem, run, agent string) json.RawMessage {
	actor := map[string]any{"kind": "agent", "id": "run:" + run, "run_id": run, "agent_kind": agent}
	switch {
	case item.OwnerID.Valid:
		actor["for_member"] = strconv.FormatInt(item.OwnerID.Int64, 10)
	case item.CreatedBy.Valid:
		actor["for_member"] = strconv.FormatInt(item.CreatedBy.Int64, 10)
	}
	raw, _ := json.Marshal(actor)
	return raw
}

// recordRunActivity appends the agent's side of one run projection: each
// question the run opened, then each step whose run began, named as the TODO
// card names it.
func recordRunActivity(ctx context.Context, tx pgx.Tx, before, after db.MythicalItem) error {
	open := map[string]bool{}
	for _, wait := range mythicalChecksOf(before).Waits {
		open[wait.ID] = true
	}
	for _, wait := range mythicalChecksOf(after).Waits {
		if open[wait.ID] || wait.Kind != "question" || wait.SettledAt != nil || wait.Signal == nil || wait.Prompt == "" {
			continue
		}
		if err := recordBranchActivity(ctx, tx, after, "question:"+wait.ID, "question", runAgentActor(after, wait.Signal.Run, "coding"), wait.Prompt); err != nil {
			return err
		}
	}
	began := map[string]string{}
	for _, phase := range todoPhases(before) {
		began[phase.id] = phase.run
	}
	for _, phase := range todoPhases(after) {
		if phase.run == "" || began[phase.id] == phase.run {
			continue
		}
		agent := "coding"
		if phase.id == "review" {
			agent = "reviewer"
		}
		if err := recordBranchActivity(ctx, tx, after, "step:"+phase.id+":"+phase.run, "step", runAgentActor(after, phase.run, agent), phase.label); err != nil {
			return err
		}
	}
	return nil
}
