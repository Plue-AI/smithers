package services

import (
	"sort"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// TodoWait is an independent reason the item needs a member. Settled waits stay
// in checks as evidence; projection considers only the open ones.
type TodoWait struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"`
	Prompt     string     `json:"prompt"`
	Since      time.Time  `json:"since"`
	AnsweredBy string     `json:"answered_by,omitempty"`
	SettledAt  *time.Time `json:"settled_at,omitempty"`
}

// todoState is the single product-state projection of the stored engine facts.
func todoState(item db.MythicalItem) string {
	switch item.State {
	case "landed":
		return "merged"
	case "cancelled", "rejected", "declined":
		return "dropped"
	}
	checks := mythicalChecksOf(item)
	if len(todoOpenWaits(item)) > 0 {
		return "needs_you"
	}
	if item.PausedAt.Valid {
		return "paused"
	}
	switch item.State {
	case "blocked":
		return "failed"
	case "proposed":
		return "in_review"
	case "queued":
		if checks.RunLaunched && !checks.RunAttached {
			return "starting"
		}
		if item.PRState == "open" {
			return "in_review"
		}
		return "queued"
	case "skipped":
		return "queued"
	default:
		if checks.RunLaunched && !checks.RunAttached {
			return "starting"
		}
		return "working"
	}
}

func todoOpenWaits(item db.MythicalItem) []TodoWait {
	waits := []TodoWait{}
	switch item.State {
	case "landed", "cancelled", "rejected", "declined":
		return waits
	}
	for _, wait := range mythicalChecksOf(item).Waits {
		if wait.SettledAt == nil {
			waits = append(waits, wait)
		}
	}
	rank := map[string]int{"moved_off": 0, "conflict": 1, "foreign_push": 2, "approval": 3, "question": 4}
	sort.SliceStable(waits, func(i, j int) bool {
		if rank[waits[i].Kind] != rank[waits[j].Kind] {
			return rank[waits[i].Kind] < rank[waits[j].Kind]
		}
		return waits[i].Since.Before(waits[j].Since)
	})
	return waits
}
