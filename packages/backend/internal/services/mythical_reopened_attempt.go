package services

import (
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A reopen restores an accepted generation, not the run Drop closed. Keep
// this attempt identity until a new launch advances it, including while queued.
func todoReopenedAttempt(item db.MythicalItem) bool {
	return item.Attempt > 0 && mythicalChecksOf(item).GitHubReopenedAttempt == item.Attempt
}

// A reopened attempt or a historical composition that ended after publication
// needs a fresh run. Live review compositions receive input on the same run.
func todoReviewAwaitsAttempt(item db.MythicalItem) bool {
	if item.State != "proposed" {
		return false
	}
	_, pinned := mythicalPinOf(item)
	return todoReopenedAttempt(item) || pinned && item.RequestOutcome != ""
}

// The caller admits work under the TODO/stack transaction. The existing
// startPinned path owns placement, the next attempt and its durable launch.
func queueReopenedTodo(item db.MythicalItem) db.MythicalItem {
	next := retainTodoAttemptEvidence(item)
	checks := mythicalChecksOf(next)
	checks.RunLaunched, checks.RunAttached = false, false
	checks.Replans, checks.AttemptBase = 0, item.Attempt
	checks.Land = nil
	next.State, next.Reason, next.NextAttemptAt = "queued", "", pgtype.Timestamptz{}
	next.CandidateVerified = false
	next.Checks = checks.encode()
	return next
}
