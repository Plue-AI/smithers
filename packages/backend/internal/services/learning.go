package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// LearningOutput is data returned by the machine, never repository code loaded
// by the host. No proposed diff is executed or applied here.
type LearningOutput struct {
	Repository string             `json:"repository"`
	Todo       int64              `json:"todo"`
	Run        string             `json:"run"`
	Pages      []LearningPage     `json:"pages"`
	Proposals  []LearningProposal `json:"proposals"`
}
type LearningPage struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}
type LearningProposal struct {
	Signature string   `json:"signature"`
	Title     string   `json:"title"`
	Evidence  []string `json:"evidence"`
	Todos     []int64  `json:"todos"`
	Prompt    string   `json:"prompt"`
}

// LearningBinding comes from the stored run, not the success payload.
type LearningBinding struct {
	Repository string
	Todo       int64
	Run        string
	State      string
}

var ErrLearningUnavailable = errors.New("learning dependencies unavailable")
var ErrLearningBinding = errors.New("learning output does not match merged TODO run")

// LearningTransaction must bind the existing wiki, memory-note and TODO writers
// to ONE database transaction. Receipt locks the stored run/TODO and returns
// true on committed replay. RecordReceipt stores lessons and durable topic
// deltas in that transaction; it never writes a TODO state event.
// There is deliberately no implementation until the shared transaction-aware
// memory adapter lands. A nil adapter refuses before any effect.
type LearningTransaction interface {
	Receipt(context.Context, LearningBinding) (bool, error)
	Page(context.Context, LearningBinding, LearningPage) error
	Proposal(context.Context, LearningBinding, LearningProposal, time.Time) (bool, error)
	RecordReceipt(context.Context, LearningBinding, int) error
}
type LearningStore interface {
	Transaction(context.Context, func(LearningTransaction) error) error
}

// LearningSuppressed uses dismissal time (not creation time). Exactly 90 days
// remains suppressed; a future dismissal timestamp also fails closed.
func LearningSuppressed(status string, dismissedAt *time.Time, now time.Time) bool {
	if status == "pending" {
		return true
	}
	return status == "rejected" && (dismissedAt == nil || !now.After(dismissedAt.Add(90*24*time.Hour)))
}

// CommitLearning is the missing handoff from typed machine output to the host's
// transaction. It remains unmounted; no run credential receives a write route.
func CommitLearning(ctx context.Context, store LearningStore, binding LearningBinding, output LearningOutput, now time.Time) error {
	if binding.State != "merged" || binding.Repository == "" || binding.Run == "" || binding.Todo <= 0 ||
		output.Repository != binding.Repository || output.Run != binding.Run || output.Todo != binding.Todo {
		return ErrLearningBinding
	}
	if len(output.Pages) > 64 || len(output.Proposals) > 64 {
		return fmt.Errorf("learning output exceeds limits")
	}
	signatures := map[string]bool{}
	for _, page := range output.Pages {
		if strings.TrimSpace(page.Title) == "" || strings.TrimSpace(page.Body) == "" || len(page.Body) > maxWikiBodyBytes {
			return fmt.Errorf("invalid learning page")
		}
	}
	for _, proposal := range output.Proposals {
		if strings.TrimSpace(proposal.Signature) == "" || signatures[proposal.Signature] || strings.TrimSpace(proposal.Title) == "" ||
			strings.TrimSpace(proposal.Prompt) == "" || len(proposal.Evidence) == 0 || len(proposal.Todos) == 0 || len(proposal.Todos) > 20 {
			return fmt.Errorf("invalid learning proposal")
		}
		for _, evidence := range proposal.Evidence {
			if strings.TrimSpace(evidence) == "" {
				return fmt.Errorf("empty learning evidence")
			}
		}
		refs := map[int64]bool{}
		for _, todo := range proposal.Todos {
			if todo <= 0 || refs[todo] {
				return fmt.Errorf("invalid learning TODO ref")
			}
			refs[todo] = true
		}
		signatures[proposal.Signature] = true
	}
	if store == nil {
		return ErrLearningUnavailable
	}
	return store.Transaction(ctx, func(tx LearningTransaction) error {
		done, err := tx.Receipt(ctx, binding)
		if err != nil || done {
			return err
		}
		lessons := 0
		for _, page := range output.Pages {
			if err := tx.Page(ctx, binding, page); err != nil {
				return err
			}
			lessons++
		}
		for _, proposal := range output.Proposals {
			created, err := tx.Proposal(ctx, binding, proposal, now)
			if err != nil {
				return err
			}
			if created {
				lessons++
			}
		}
		return tx.RecordReceipt(ctx, binding, lessons)
	})
}
