package services

// Historical engine fixtures predate install admission. They populate existing
// rows for orchestration/recovery tests; they are not admission or trust evidence.
// The retired observation implementation is reused here rather than introducing
// a second fixture model for persisted legacy rows.

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"strings"
)

func seedMythicalIssue(s *MythicalService, ctx context.Context, repositoryID int64, issue mythicalIssue, applied gitHubLabelApplication) error {
	q := s.queries()
	stack, err := q.GetMythicalStack(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	digest := mythicalIssueDigest(issue)
	body := issue.Body
	if len(body) > mythicalPromptBytes {
		body = body[:mythicalPromptBytes]
	}
	for range 3 {
		existing, err := q.GetMythicalItemByIssue(ctx, repositoryID, issue.Number)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		// A label a maintainer person applied counts while it stays on the
		// issue: a TODO needs no new label for its maintainer's own edit.
		checks := mythicalChecksOf(existing)
		// The owner's policy makes an issue a TODO once, without the label;
		// the label then keeps it one like any other.
		if applied.Removed && applied.ByMaintainer && strings.EqualFold(applied.Label, todoLabel) {
			// A maintainer took todo off: the factory never puts it back, and
			// the issue is a TODO again only when a maintainer re-applies it.
			checks.AutoTodo, checks.Todo, checks.OptedOut = "", false, true
		}
		// Each maintainer's application of todo acts once: a replay of the one
		// already seen neither re-queues the item nor lifts its bounds.
		freshTodo := appliedByMaintainer(applied, todoLabel) && (applied.EventID == 0 || applied.EventID != checks.TodoEvent)
		if appliedByMaintainer(applied, todoLabel) && applied.EventID != 0 {
			checks.TodoEvent = applied.EventID
		}
		auto := applied.AutoTodo != "" && checks.AutoTodo == "" && !checks.OptedOut
		if auto {
			checks.AutoTodo = applied.AutoTodo
		}
		if applied.FiledBy != "" {
			checks.Filed, checks.FiledRequest = digest, applied.FiledRequest
		}
		// Text a maintainer person filed through Smithers (FileTodo) is
		// theirs while it stands exactly as filed; GitHub names the App.
		if checks.Filed != "" && checks.Filed == digest {
			issue.TextByMaintainer = true
		}
		outsider := !issue.TextByMaintainer
		// A TODO the policy made stays one: the label is its projection.
		checks.Todo = checks.AutoTodo != "" || issueCarriesLabel(issue.Labels, todoLabel) && (appliedByMaintainer(applied, todoLabel) || checks.Todo)
		checks.Automerge = issueCarriesLabel(issue.Labels, automergeLabel) && (appliedByMaintainer(applied, automergeLabel) || checks.Automerge)
		approved := ""
		switch {
		case !checks.Todo:
		case checks.AutoTodo != "" && issue.TextByMaintainer:
			// The policy approves the text of the maintainer it names.
			approved = digest
		case approvesIssueText(issueText{ByMaintainer: issue.TextByMaintainer}, nil, issue.Labels, applied, todoLabel):
			approved = digest
		case existing.ApprovedDigest == digest:
			approved = digest
		}
		state, reason := mythicalAdmission(issue, approved == digest)
		reason = mythicalProposalReason(reason, checks)
		if errors.Is(err, pgx.ErrNoRows) {
			item, inserted, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repositoryID,
				IssueNumber: pgtype.Int8{Int64: issue.Number, Valid: true}, IssueTitle: issue.Title, IssueURL: issue.URL,
				IssueDigest: digest, IssueBody: body, ApprovedDigest: approved, State: state, Reason: reason, Outsider: outsider,
				Checks: checks.encode()})
			if err != nil {
				return err
			}
			if inserted {
				s.itemChanged(ctx, q, stack, item.ID)
				return nil
			}
			continue
		}
		next := existing
		next.Checks = checks.encode()
		notStarted := existing.State == "queued" || existing.State == "skipped" || existing.State == "cancelled" ||
			(existing.State == "declined" && existing.IssueDigest != digest && approved == digest) ||
			// A maintainer re-applying todo resumes a TODO stopped at its bound.
			(existing.State == "blocked" && mythicalChecksOf(existing).bounded() && freshTodo)
		switch {
		case existing.State == "declined" && !notStarted:
		case state == "cancelled" && (existing.State == "queued" || existing.State == "retrying" || existing.State == "skipped"):
			next.State, next.Reason = "cancelled", reason
		case notStarted:
			if existing.State == "blocked" {
				// A person resumed it: its bounds count from here.
				resumed := mythicalChecksOf(next)
				resumed.resume()
				next.Checks = resumed.encode()
			}
			next.State, next.Reason = state, reason
			next.IssueTitle, next.IssueURL, next.IssueDigest, next.IssueBody, next.ApprovedDigest = issue.Title, issue.URL, digest, body, approved
			next.Outsider = outsider
		}
		if next.State == existing.State && next.Reason == existing.Reason && next.IssueDigest == existing.IssueDigest &&
			next.IssueTitle == existing.IssueTitle && next.ApprovedDigest == existing.ApprovedDigest && next.Outsider == existing.Outsider &&
			sameMythicalChecks(next, existing) {
			return nil
		}
		saved, err := q.SaveMythicalItem(ctx, next)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		s.itemChanged(ctx, q, stack, saved.ID)
		return nil
	}
	return errors.New("the item changed concurrently; the next sweep observes the issue again")
}
