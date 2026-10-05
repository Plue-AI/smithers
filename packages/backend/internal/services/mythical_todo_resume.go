package services

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// resumeTodo is Resume on a paused TODO (spec §4.1 paused → queued,
// §10.7.1). Under the stack's row lock it clears paused_at (mythicalResumed)
// and wakes the stack. Stop cancelled the attempt's run, so a TODO stopped
// while working queues to run the same attempt again, on its own lane, with
// every steer held for it as its first input; one stopped during the review
// of its pull request keeps the pull request and is reviewed again. Resume
// lifts no bound. The same Idempotency-Key again answers the same receipt.
func (s *MythicalService) resumeTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	return s.pressTodo(ctx, number, input, "resume a TODO", "todo.resumed", func(_ context.Context, _ pgx.Tx, _ db.MythicalStack, item db.MythicalItem, press todoPress) (db.MythicalItem, error) {
		next := mythicalResumed(item)
		checks := mythicalChecksOf(next)
		checks.Resumes = append(checks.Resumes, press)
		next.Checks = checks.encode()
		return next, nil
	})
}

// mythicalResumed is a paused item resumed: in review, its review stopped
// with the pause runs again; otherwise the attempt Stop cancelled queues to
// run again with the same attempt number (start counts it once more).
func mythicalResumed(item db.MythicalItem) db.MythicalItem {
	next := item
	next.PausedAt, next.NextAttemptAt = pgtype.Timestamptz{}, pgtype.Timestamptz{}
	checks := mythicalChecksOf(item)
	if item.State == "blocked" {
		// A failed TODO stays failed: Retry, not Resume, starts it again.
		return next
	}
	if item.State == "proposed" {
		if review := checks.Review; review != nil && (review.Verdict == "" || review.Verdict == mythicalCancelled || strings.HasPrefix(review.Verdict, mythicalStopped)) {
			checks.Review = nil
		}
		next.Checks = checks.encode()
		return next
	}
	next.State, next.Reason = "queued", ""
	next.Attempt = item.Attempt - 1
	checks.RunLaunched, checks.RunAttached = false, false
	next.Checks = checks.encode()
	return next
}
