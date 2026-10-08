package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// machineCleanupCapture consumes the durable authenticated daemon receipt,
// never a database head alone. Every reachable object and the current ref are
// inspected as data under the existing host repository maintenance boundary.
func machineCleanupCapture(pool *pgxpool.Pool, host *repohost.Client) services.CleanupCaptureVerifier {
	return func(ctx context.Context, row db.Workspace, consume func(services.WorkspaceDiskReclaimCapture) error) error {
		if pool == nil || host == nil || row.HeadCommitID == "" {
			return machined.ErrNotReady
		}
		rows, err := pool.Query(ctx, `SELECT event_id::text,capture_payload,payload_digest FROM machine_event_receipts WHERE workspace_id=$1 AND outcome='applied' AND capture_payload IS NOT NULL AND ($2='' OR event_id::text=$2) ORDER BY at DESC`, row.ID, row.CleanupPendingCaptureID)
		if err != nil {
			return err
		}
		var capture wire.Captured
		var captureID string
		for rows.Next() {
			var id string
			var payload, digest []byte
			if err := rows.Scan(&id, &payload, &digest); err != nil {
				rows.Close()
				return err
			}
			sum := sha256.Sum256(payload)
			candidate, err := wire.DecodeCaptured(payload)
			if err == nil && bytes.Equal(sum[:], digest) && candidate.Head == row.HeadCommitID {
				capture, captureID = candidate, id
				break
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if captureID == "" {
			return errors.New("final capture receipt unavailable")
		}
		var final bool
		err = pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_events WHERE event_type='branch.final_capture' AND tenant_id=$1 AND principal_id=$2 AND data->>'head'=$3 AND data->>'tree'=$4 AND data->>'vm_id'=$5)`, fmt.Sprint(row.RepositoryID), "branch:"+row.ID, capture.Head, capture.Tree, row.VmID).Scan(&final)
		if err != nil {
			return err
		}
		if !final {
			return errors.New("writer-excluded final capture unavailable")
		}
		if row.CleanupPendingCaptureID != "" && (row.CleanupPendingCaptureID != captureID || row.CleanupPendingHead != capture.Head) {
			return errors.New("pending cleanup capture changed")
		}
		scope, err := db.New(pool).GetRepoOwnerSlugAndNameByID(ctx, row.RepositoryID)
		if err != nil {
			return err
		}
		validate := func(ctx context.Context) error {
			return host.WithMachineRepository(ctx, scope.OwnerSlug, scope.RepoName, func(path string) error {
				objects := machined.GitCaptureObjects{Resolve: func(context.Context, string) (string, error) { return path, nil }}
				missing, err := objects.VerifyCapture(ctx, row.ID, capture)
				if err != nil {
					return err
				}
				if len(missing) != 0 {
					return errors.New("final capture objects unavailable")
				}
				head, err := objects.BranchHead(ctx, row.ID)
				if err != nil {
					return err
				}
				if head != capture.Head {
					return errors.New("final capture ref changed")
				}
				return nil
			})
		}
		if err := validate(ctx); err != nil {
			return err
		}
		return consume(services.WorkspaceDiskReclaimCapture{WorkspaceID: row.ID, CandidateHead: capture.Head, RetainedHead: capture.Head, CapturedTree: capture.Tree, CaptureID: captureID, Settled: true, Quiet: true, BindingVerified: true, CaptureComplete: true, InventoryCurrent: true, Revalidate: validate})
	}
}
