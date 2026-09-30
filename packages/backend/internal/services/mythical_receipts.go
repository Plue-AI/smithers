package services

import (
	"encoding/json"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
)

// mythicalReceiptBound caps the receipts one item keeps: coding/verify runs
// at most 64 checks, and a request's plan a handful of Changes.
const mythicalReceiptBound = 200

// mythicalReceipts are the check receipts of the run that last measured the
// item's candidate: the lane's request, its delivery (coding/vibe, whose
// cleanup rewrites and rechecks the commits), or coding/verify on a rebased
// candidate. Run names that run.
type mythicalReceipts struct {
	Run    string            `json:"run"`
	Checks []mythicalReceipt `json:"checks"`
}

// mythicalReceipt is one check's receipt, as the coding flows recorded it
// (flows/coding/schema.ts Receipt), without its evidence. DurationMs is how
// long the check's process ran, when the receipt recorded its start and finish.
type mythicalReceipt struct {
	Check      string `json:"check"`
	Tier       string `json:"tier"`
	Status     string `json:"status"`
	Fault      string `json:"fault,omitempty"`
	Commit     string `json:"commit"`
	DurationMs *int64 `json:"durationMs,omitempty"`
}

type mythicalFlowReceipt struct {
	CheckID    string `json:"checkId"`
	Tier       string `json:"tier"`
	Status     string `json:"status"`
	Fault      string `json:"fault"`
	CommitID   string `json:"commitId"`
	StartedAt  *int64 `json:"startedAt"`
	FinishedAt *int64 `json:"finishedAt"`
}

// duration is how long the receipt's check ran; nil unless it recorded both
// its start and a finish no earlier than it.
func (r mythicalFlowReceipt) duration() *int64 {
	if r.StartedAt == nil || r.FinishedAt == nil || *r.FinishedAt < *r.StartedAt {
		return nil
	}
	duration := *r.FinishedAt - *r.StartedAt
	return &duration
}

// mythicalReceiptTiers and mythicalReceiptStatuses are the values a kept
// receipt may carry (@smthrs/rpc/Mythical MythicalReceiptSchema).
var (
	mythicalReceiptTiers    = map[string]bool{"fast": true, "slow": true, "delivery": true}
	mythicalReceiptStatuses = map[string]bool{"passed": true, "failed": true}
	mythicalReceiptFaults   = map[string]bool{"": true, "infra": true, "factory": true}
)

// mythicalRunReceipts reads the check receipts a terminal request, delivery
// or verify run returned; nil when it returned none. A superseded receipt measured a
// commit the run later replaced, so it is not kept, nor is one that is not a
// receipt the coding flows write.
func mythicalRunReceipts(phase, runID string, update flowdispatch.ProjectionUpdate) *mythicalReceipts {
	if runID == "" || update.Checkpoint.Run == nil || update.Checkpoint.Run.FinalOutput == nil {
		return nil
	}
	output := []byte(*update.Checkpoint.Run.FinalOutput)
	var receipts []mythicalFlowReceipt
	type changes struct {
		Changes []struct {
			Receipts []mythicalFlowReceipt `json:"receipts"`
		} `json:"changes"`
	}
	var result struct {
		// A request's validated result, a delivery's cleanup rechecks, and
		// coding/verify's own receipts.
		Outcome struct {
			Result *changes `json:"result"`
		} `json:"outcome"`
		Cleanup *struct {
			Result *changes `json:"result"`
		} `json:"cleanup"`
		Receipts []mythicalFlowReceipt `json:"receipts"`
	}
	if json.Unmarshal(output, &result) != nil {
		return nil
	}
	var measured *changes
	switch phase {
	case "request":
		measured = result.Outcome.Result
	case "vibe":
		if result.Cleanup != nil {
			measured = result.Cleanup.Result
		}
	case "verify":
		receipts = result.Receipts
	default:
		return nil
	}
	if measured != nil {
		for _, change := range measured.Changes {
			receipts = append(receipts, change.Receipts...)
		}
	}
	kept := make([]mythicalReceipt, 0, len(receipts))
	for _, receipt := range receipts {
		if receipt.CheckID == "" || receipt.CommitID == "" || !mythicalReceiptTiers[receipt.Tier] ||
			!mythicalReceiptStatuses[receipt.Status] || !mythicalReceiptFaults[receipt.Fault] {
			continue
		}
		kept = append(kept, mythicalReceipt{Check: receipt.CheckID, Tier: receipt.Tier, Status: receipt.Status,
			Fault: receipt.Fault, Commit: receipt.CommitID, DurationMs: receipt.duration()})
	}
	if len(kept) == 0 {
		return nil
	}
	// The candidate's head is the last Change, so its receipts come last:
	// past the bound, the earliest Changes' receipts are the ones dropped.
	if len(kept) > mythicalReceiptBound {
		kept = kept[len(kept)-mythicalReceiptBound:]
	}
	return &mythicalReceipts{Run: runID, Checks: kept}
}

// measures reports whether the receipts checked commit, the head of the
// item's candidate.
func (r *mythicalReceipts) measures(commit string) bool {
	if r == nil || commit == "" {
		return false
	}
	for _, receipt := range r.Checks {
		if receipt.Commit == commit {
			return true
		}
	}
	return false
}

// mythicalKeepReceipts answers the receipts an item keeps once a run of it
// returned run: the run's, unless it returned none, or the kept ones measure
// the current candidate and the run's do not (a delivery that finishes after
// its candidate was already rebased and verified).
func mythicalKeepReceipts(candidate string, kept, run *mythicalReceipts) *mythicalReceipts {
	if run == nil || kept.measures(candidate) && !run.measures(candidate) {
		return kept
	}
	return run
}
