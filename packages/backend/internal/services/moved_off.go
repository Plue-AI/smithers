package services

import "errors"

// MovedOffFact is the branch fact, not a run wait: it survives Stop and Retry.
// No existing head poll can find the pre-move working copy across jj operations.
// This seam is deliberately unmounted until authenticated daemon events and the
// shared freeze/capture/broker contracts land. It performs no repository IO.
type MovedOffFact struct {
	By            string `json:"by"`
	Item          string `json:"item"`
	PreMoveCommit string `json:"pre_move_commit"`
}

// ItemPosition must come from the daemon's change-id lookup and descent query,
// never from branch names or tree equality. History is newest operation first.
type ItemPosition struct {
	ChangePresent     bool
	Descends          bool
	WorkingCopyCommit string
}

var ErrMovedOffHistoryUnavailable = errors.New("moved_off: pre-move history unavailable")
var ErrMovedOffProviderUnavailable = errors.New("moved_off: authenticated daemon providers unavailable")

// DetectMovedOff is shared by metadata events and overflow resync. Scratch
// branches have no item. A query error must be handled by the caller, never
// converted to an absent change. Redelivery retains the original return target.
func DetectMovedOff(item, by string, current ItemPosition, history []ItemPosition, prior *MovedOffFact) (*MovedOffFact, error) {
	if item == "" || (current.ChangePresent && current.Descends) {
		return nil, nil
	}
	if prior != nil && prior.Item == item && prior.PreMoveCommit != "" {
		copy := *prior
		return &copy, nil
	}
	for _, operation := range history {
		if operation.ChangePresent && operation.Descends && operation.WorkingCopyCommit != "" {
			return &MovedOffFact{By: by, Item: item, PreMoveCommit: operation.WorkingCopyCommit}, nil
		}
	}
	return nil, ErrMovedOffHistoryUnavailable
}

// MovedOffCaptureTarget never captures the off-item working copy as the item's
// head. LastCaptured is the item's verified head, not the Return target.
func MovedOffCaptureTarget(fact *MovedOffFact, lastCaptured, workingCopy string) (string, error) {
	if fact == nil {
		return workingCopy, nil
	}
	if lastCaptured == "" {
		return "", ErrMovedOffHistoryUnavailable
	}
	return lastCaptured, nil
}

// ActivateMovedOff refuses unconditionally while the real guest providers are
// absent. Caller-supplied booleans cannot attest broker security or authority.
// No host jj execution, legacy Undo, root file or alternate writer is used.
func ActivateMovedOff() error { return ErrMovedOffProviderUnavailable }
