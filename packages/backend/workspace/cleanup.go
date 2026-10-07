package workspace

import (
	"context"
	"time"
)

// CleanupWorkspace is a server-owned binding, never a branch-supplied path,
// command or process selector. Retention comes from the committed settlement.
type CleanupWorkspace struct {
	ID, VMID, Branch, Head        string
	PendingHead, PendingCaptureID string
	RepositoryID, OwnerID         int64
	SettledAt, Now                time.Time
}

// DiskReclaimCapture is an authenticated complete-capture and current broker
// inventory receipt under the writer/admission fence. Quiet alone, a database
// head alone or retained Git objects alone do not authorize removal.
type DiskReclaimCapture struct {
	WorkspaceID, CandidateHead, RetainedHead, CaptureID                string
	Settled, Quiet, BindingVerified, CaptureComplete, InventoryCurrent bool
}

// CleanupFence belongs to the capture lifecycle and broker. It excludes all
// writers/session admission through fn, verifies objects and the live head ref,
// and refuses stale inventories. After the supplied 24-hour retention expires,
// remaining services must be terminated through the trusted broker, termination
// confirmed and a new final capture obtained before fn. Open terminals/SSH
// sessions are never forced closed. A running machine must finish the ordinary
// capture/sleep lifecycle and publish its stopped row before fn can remove its
// disk. On restart a pending capture may be reused only after verifying the
// retained graph, current ref/binding and current quiet inventory under the
// same admission/writer fence; a missing machine alone is not a receipt.
// Providers must refuse missing contracts.
type CleanupFence interface {
	WithFinalCapture(context.Context, CleanupWorkspace, func(DiskReclaimCapture) error) error
}
