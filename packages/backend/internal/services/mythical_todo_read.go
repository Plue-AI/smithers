package services

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Todo returns the shared TodoCard contract from the canonical item. The
// legacy mythical snapshot retains its engine-state decoder for old sessions.
func (s *MythicalService) Todo(ctx context.Context, repositoryID, number int64) (map[string]any, error) {
	item, err := s.queries().GetMythicalItemByNumber(ctx, repositoryID, number)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &TodoControlError{404, "todo_not_found", "user", "TODO not found"}
	}
	if err != nil {
		return nil, err
	}
	return s.todoCard(ctx, item, nil)
}
func (s *MythicalService) Todos(ctx context.Context, repositoryID int64) ([]map[string]any, error) {
	items, err := s.queries().ListMythicalItems(ctx, repositoryID, 500)
	if err != nil {
		return nil, err
	}
	views := []map[string]any{}
	for _, item := range items {
		view, err := s.todoCard(ctx, item, items)
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	return views, nil
}
func todoAvatar(user db.User) string {
	if strings.HasPrefix(user.AvatarUrl, "https://") || strings.HasPrefix(user.AvatarUrl, "http://") {
		return user.AvatarUrl
	}
	return "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHJ4PSIyNCIgZmlsbD0iI2RkZCIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iMTgiIHI9IjgiIGZpbGw9IiM4ODgiLz48cGF0aCBkPSJNOCA0NGExNiAxNiAwIDAgMSAzMiAwIiBmaWxsPSIjODg4Ii8+PC9zdmc+"
}

// todoQueuePosition is a queued item's 1-based place among the repository's
// queued TODOs, in stack order: the "#2" of mvp.md §4.1's "waiting for a
// machine #2". items is the repository's ListMythicalItems page, or nil to
// read it; an item past that page queues after every listed one.
func (s *MythicalService) todoQueuePosition(ctx context.Context, item db.MythicalItem, items []db.MythicalItem) (int64, error) {
	if items == nil {
		var err error
		if items, err = s.queries().ListMythicalItems(ctx, item.RepositoryID, 500); err != nil {
			return 0, err
		}
	}
	position := int64(0)
	for _, other := range items {
		if todoState(other) != "queued" {
			continue
		}
		position++
		if other.ID == item.ID {
			return position, nil
		}
	}
	return position + 1, nil
}

// todoCard is the TodoCard projection of item. items is the repository's
// ListMythicalItems page when the caller already holds it, else nil.
func (s *MythicalService) todoCard(ctx context.Context, item db.MythicalItem, items []db.MythicalItem) (map[string]any, error) {
	var owner db.User
	var err error
	if item.OwnerID.Valid {
		owner, err = s.queries().GetUserByID(ctx, item.OwnerID.Int64)
	} else {
		owner, err = s.queries().GetSelfHostOwner(ctx)
	}
	if err != nil {
		return nil, err
	}
	revisions := item.Revisions
	if len(revisions) == 0 {
		revisions = []byte(`[]`)
	}
	waits := []map[string]any{}
	for _, wait := range todoOpenWaits(item) {
		actions := []any{}
		if wait.Kind == "question" && wait.Signal != nil {
			// The seeded card's Answer: one text field, sent as todo.answer.
			actions = append(actions, map[string]any{"tag": "todo.answer", "label": "Answer",
				"input": []any{map[string]any{"name": "answer", "label": "Answer", "kind": "text", "required": true}}})
		}
		waits = append(waits, map[string]any{"id": wait.ID, "kind": wait.Kind, "prompt": wait.Prompt, "since": wait.Since, "actions": actions})
	}
	// There is no branch or machine before admission. Never invent an ID or
	// machine state for a queued item; TodoCard permits that absence.
	card := map[string]any{"n": item.Number.Int64, "title": item.Title.String, "state": todoState(item),
		"owner":            map[string]any{"login": owner.Username, "name": owner.DisplayName, "avatar_url": todoAvatar(owner)},
		"prompt_revisions": revisions, "steps": todoSteps(item), "waits": waits, "steers": todoSteers(item), "evidence": []any{},
		"present": []any{}}
	if answer := todoFirstAnswer(item); answer != nil {
		card["first_answer"] = answer
	}
	if failure := todoFailure(item); failure != nil {
		card["failure"] = failure
	}
	if card["merge"], err = s.todoMerge(ctx, item); err != nil {
		return nil, err
	}
	workspace, hasBranch, err := s.todoBranchWorkspace(ctx, item)
	if err != nil {
		return nil, err
	}
	if hasBranch {
		state := branchMachineState(workspace)
		if state == "provisioning" {
			state = "waking"
		}
		machine := map[string]any{"state": state}
		// A lane the full host queued waits in line: "Waiting for a
		// machine · #2" (spec §4.2), never a failure.
		// The card says why the TODO waits and where it is in line, whatever
		// step the lane is for (its run, its review).
		if place, waiting := s.machinePlace(workspace); waiting {
			machine = map[string]any{"state": "waiting", "position": place}
			card["queue"] = map[string]any{"reason": "machine", "position": int64(place)}
		}
		if state == "failed" {
			machine["error"] = map[string]any{"class": "infra", "message": workspace.FailureMessage.String}
		}
		// Once published, the branch is the pull request's head branch.
		name := workspace.Name
		if published := mythicalChecksOf(item).Branch; published != "" {
			name = published
		}
		card["branch"] = map[string]any{"id": workspace.ID, "name": name, "machine": machine}
	}
	if item.Attempt > 0 && item.RequestRunID != "" {
		card["run"] = map[string]any{"id": item.RequestRunID, "attempt": item.Attempt, "indicators": []any{}}
	}
	if learning := mythicalChecksOf(item).Learning; learning != nil {
		card["learning"] = learning
		if learning.RunID != "" {
			card["run"] = map[string]any{"id": learning.RunID, "attempt": int32(1), "indicators": []any{}}
		}
	}
	// A merged or dropped TODO has left the stack: it has no place, so its
	// card never reads "Next to merge".
	if state := card["state"]; item.StackPosition.Valid && state != "merged" && state != "dropped" {
		card["place"] = item.StackPosition.Int64
	}
	// "Rebase pending onto T2" until the candidate is rebased; a rebase that
	// voided the approval says so until someone presses Merge again.
	if checks := mythicalChecksOf(item); !mythicalSettledStates[item.State] {
		if rebase := checks.Rebase; rebase != nil && !rebase.Rebased {
			card["rebase_pending"] = map[string]any{"onto": rebase.Name}
		}
		if checks.ApprovalCleared != "" && checks.Land == nil {
			card["approval_cleared"] = true
		}
	}
	// A queued TODO waits for a lane machine; the card says so and where it is
	// in line (mvp.md §4.1), never the stack's internal outage text.
	if card["state"] == "queued" {
		position, err := s.todoQueuePosition(ctx, item, items)
		if err != nil {
			return nil, err
		}
		card["queue"] = map[string]any{"reason": "machine", "position": position}
	}
	if item.IssueNumber.Valid && item.IssueURL != "" {
		card["issue"] = map[string]any{"number": item.IssueNumber.Int64, "url": item.IssueURL, "fixes": item.FixesIssue}
	}
	if item.PRNumber.Valid && item.PRURL != "" {
		// draft is GitHub's flag as the stack last read the pull request;
		// included_items are the earlier items its body includes, then this TODO.
		checks := mythicalChecksOf(item)
		card["pr"] = map[string]any{"number": item.PRNumber.Int64, "url": item.PRURL, "head": item.PRHead, "draft": checks.PRDraft,
			"included_items": append(append([]int64{}, checks.PRIncludes...), item.Number.Int64)}
	}
	evidence := todoEvidence(item)
	// The run's model access is read from the lane it holds, else from the
	// lane the card names once that lane was released.
	accessLane := item.WorkspaceID
	if accessLane == "" && hasBranch {
		accessLane = workspace.ID
	}
	if item.Attempt > 0 && accessLane != "" {
		access, err := s.queries().MythicalWorkspaceModelAccess(ctx, item.RepositoryID, accessLane)
		if err != nil {
			return nil, err
		}
		if label := modelAccessLabel(access); label != "" {
			entry := map[string]any{"kind": "model_access", "label": label}
			if n := len(evidence); n > 0 && evidence[n-1].Attempt == item.Attempt {
				evidence[n-1].Items = append(append([]map[string]any{}, evidence[n-1].Items...), entry)
			} else {
				evidence = append(evidence, todoAttemptEvidence{Attempt: item.Attempt, Revision: item.CandidateHead, Items: []map[string]any{entry}})
			}
		}
	}
	card["evidence"] = evidence
	return card, nil
}

// todoBranchWorkspace is the lane machine a TODO's card names as its branch:
// the lane it holds, else, once that lane was released (in review after the
// verdict, merged), its latest coding lane, retired or not, so the card keeps
// naming its branch. A TODO that never had a lane has none.
func (s *MythicalService) todoBranchWorkspace(ctx context.Context, item db.MythicalItem) (db.Workspace, bool, error) {
	id := item.WorkspaceID
	if id == "" {
		err := s.store.QueryRow(ctx, `SELECT workspace_id FROM mythical_lanes
 WHERE item_id = $1 AND repository_id = $2 AND name NOT LIKE '% review g%'
 ORDER BY created_at DESC LIMIT 1`, item.ID, item.RepositoryID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return db.Workspace{}, false, nil
		}
		if err != nil {
			return db.Workspace{}, false, err
		}
	}
	workspace, err := s.queries().GetWorkspace(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.Workspace{}, false, nil
	}
	if err != nil {
		return db.Workspace{}, false, err
	}
	return workspace, workspace.RepositoryID == item.RepositoryID, nil
}

// modelAccessLabel names the model access a run used, one group per provider
// and payer: "AI Gateway · owner key: openai/gpt-5.1, anthropic/claude-sonnet-4.5".
func modelAccessLabel(access []db.ModelAccess) string {
	providers := map[string]string{"vercel": "AI Gateway", "openai": "OpenAI", "anthropic": "Anthropic",
		"openrouter": "OpenRouter", "cerebras": "Cerebras"}
	payers := map[string]string{"owner": "owner key", "credit": "Smithers credit"}
	var groups []string
	models := map[string][]string{}
	for _, row := range access {
		provider := providers[row.Provider]
		if provider == "" {
			provider = row.Provider
		}
		payer := payers[row.PaidBy]
		if payer == "" {
			payer = row.PaidBy
		}
		group := provider + " · " + payer
		if _, seen := models[group]; !seen {
			groups = append(groups, group)
		}
		models[group] = append(models[group], row.Model)
	}
	labels := make([]string, 0, len(groups))
	for _, group := range groups {
		labels = append(labels, group+": "+strings.Join(models[group], ", "))
	}
	return strings.Join(labels, "; ")
}

// Attempts retain the card evidence in the canonical checks column. Runtime
// ingestion owns these snapshots; older attempts are never recomputed from the
// current candidate. This replaces the previous current-attempt-only projection.
type todoAttemptEvidence struct {
	Attempt  int32            `json:"attempt"`
	Revision string           `json:"revision"`
	Items    []map[string]any `json:"items"`
}

func currentTodoEvidence(item db.MythicalItem) todoAttemptEvidence {
	evidence := todoAttemptEvidence{Attempt: item.Attempt, Revision: item.CandidateHead, Items: []map[string]any{}}
	for _, receipt := range mythicalReceiptsView(item) {
		if receipt.Commit != item.CandidateHead {
			continue
		}
		check := map[string]any{"kind": "check", "name": receipt.Check, "state": receipt.Status}
		if receipt.DurationMs != nil {
			check["took_s"] = float64(*receipt.DurationMs) / 1000
		}
		evidence.Items = append(evidence.Items, check)
	}
	checks := mythicalChecksOf(item)
	// The review is of the pull request head that published this candidate
	// (Candidate); a review recorded before Candidate existed names it as Head.
	if review := checks.Review; review != nil && item.CandidateHead != "" && review.Verdict != "" &&
		(review.Candidate == item.CandidateHead || review.Candidate == "" && review.Head == item.CandidateHead) {
		evidence.Items = append(evidence.Items, map[string]any{"kind": "review", "summary": checks.Review.Verdict})
	}
	if item.FlowDigest.Valid && item.FlowDigest.String != "" {
		evidence.Items = append(evidence.Items, map[string]any{"kind": "flow", "name": "todo", "version": item.FlowDigest.String})
	}
	return evidence
}

func retainTodoAttemptEvidence(item db.MythicalItem) db.MythicalItem {
	if !mythicalTodo(item) || item.Attempt <= 0 {
		return item
	}
	checks := mythicalChecksOf(item)
	current := currentTodoEvidence(item)
	for i, evidence := range checks.Attempts {
		if evidence.Attempt == item.Attempt {
			checks.Attempts[i] = current
			item.Checks = checks.encode()
			return item
		}
	}
	checks.Attempts = append(checks.Attempts, current)
	item.Checks = checks.encode()
	return item
}

func todoEvidence(item db.MythicalItem) []todoAttemptEvidence {
	evidence := []todoAttemptEvidence{}
	for _, stored := range mythicalChecksOf(item).Attempts {
		if stored.Attempt != item.Attempt && len(stored.Items) > 0 {
			evidence = append(evidence, stored)
		}
	}
	if current := currentTodoEvidence(item); current.Attempt > 0 && len(current.Items) > 0 {
		evidence = append(evidence, current)
	}
	return evidence
}

// Steps name only phases with a persisted run binding. A proposed candidate or
// a launch acknowledgement alone cannot make a step done.
func todoSteps(item db.MythicalItem) []map[string]any {
	steps := []map[string]any{}
	if item.Reason == "TODO admission unavailable" {
		steps = append(steps, map[string]any{"id": "start", "label": "Start", "state": "waiting"})
	}
	add := func(id, label, run, outcome, success string) {
		if run == "" {
			return
		}
		state := "current"
		if outcome == "" {
			switch todoState(item) {
			case "queued", "needs_you", "failed":
				state = "waiting"
			case "paused":
				state = "paused"
			case "merged", "dropped":
				return
			}
		}
		if item.Reason == "TODO admission unavailable" && outcome == "" {
			state = "waiting"
		}
		if outcome != "" {
			state = "failed"
			if outcome == success {
				state = "done"
			}
		}
		steps = append(steps, map[string]any{"id": id, "label": label, "state": state})
	}
	add("request", "Plan", item.RequestRunID, item.RequestOutcome, "validated")
	add("vibe", "Code", item.VibeRunID, item.VibeOutcome, "submitted")
	add("verify", "Verify", item.VerifyRunID, item.VerifyOutcome, "passed")
	if review := mythicalChecksOf(item).Review; review != nil {
		add("review", "Review", review.RunID, review.Verdict, "approve")
	}
	if learning := mythicalChecksOf(item).Learning; learning != nil {
		state := "waiting"
		switch learning.State {
		case "running", "committing":
			state = "current"
		case "completed":
			state = "done"
		case "failed", "cancelled":
			state = "failed"
		}
		steps = append(steps, map[string]any{"id": "learning", "label": "Learn", "state": state})
	}
	return steps
}
