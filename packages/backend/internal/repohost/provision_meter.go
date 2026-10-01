package repohost

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// ProvisionMeter meters the git storage a staged fork or import adds to its
// destination owner (smithersai/plue#768). A staged repository has no
// repository row until it is published, so its allowance is its owner's.
type ProvisionMeter interface {
	PushMeter
	// OwnerGitBytesAllowance returns the storage owner has left; limited is
	// false when the owner has no storage limit.
	OwnerGitBytesAllowance(ctx context.Context, owner string) (allowance int64, limited bool, err error)
	// RecordProvisionedGitBytes records the git object bytes of the
	// published repository owner/repo, measured at measuredAt.
	RecordProvisionedGitBytes(ctx context.Context, owner, repo string, gitBytes int64, measuredAt time.Time) error
}

// provisionMeter is the push meter as a ProvisionMeter, or nil without a
// push meter. A push meter that cannot meter provisioning fails, so a staged
// write is never left unmetered.
func (c *Client) provisionMeter() (ProvisionMeter, error) {
	if c.pushMeter == nil {
		return nil, nil
	}
	meter, ok := c.pushMeter.(ProvisionMeter)
	if !ok {
		return nil, fmt.Errorf("configured git storage meter cannot meter repository provisioning")
	}
	return meter, nil
}

// provisionGitHeaders carries owner's allowance in GitBytesAllowanceHeader
// when owner has a storage limit.
func (c *Client) provisionGitHeaders(ctx context.Context, owner string) (http.Header, error) {
	meter, err := c.provisionMeter()
	if err != nil || meter == nil {
		return nil, err
	}
	allowance, limited, err := meter.OwnerGitBytesAllowance(ctx, owner)
	if err != nil {
		return nil, fmt.Errorf("read remaining storage: %w", err)
	}
	headers := make(http.Header)
	if limited {
		headers.Set(GitBytesAllowanceHeader, strconv.FormatInt(max(allowance, 0), 10))
	}
	return headers, nil
}

// StagedProvisionGitHeaders returns the headers the import's mirror push to
// StagedProvisionGitEndpoint must carry: the destination owner's allowance,
// which repo-host caps the pack at. Read them again for each push.
func (c *Client) StagedProvisionGitHeaders(ctx context.Context, staged StagedProvision) (http.Header, error) {
	if staged.OperationType != provisionOperationImport {
		return nil, fmt.Errorf("staged git headers require an import provision")
	}
	return c.provisionGitHeaders(ctx, staged.Owner)
}

// addsGitObjects reports whether staged copies git objects into its
// destination: a fork copies its source, an import receives a mirror push.
func (s StagedProvision) addsGitObjects() bool {
	return s.OperationType == provisionOperationFork || s.OperationType == provisionOperationImport
}

// recordProvisionedGitSize records a published fork's or import's git bytes,
// so the owner's next admission counts them. The repository is published, so
// it is measured through its own route.
func (c *Client) recordProvisionedGitSize(ctx context.Context, staged StagedProvision) error {
	if !staged.addsGitObjects() {
		return nil
	}
	meter, err := c.provisionMeter()
	if err != nil || meter == nil {
		return err
	}
	size, err := c.GitSize(ctx, staged.Owner, staged.Repo)
	if err != nil {
		return fmt.Errorf("measure provisioned repository: %w", err)
	}
	return meter.RecordProvisionedGitBytes(ctx, staged.Owner, staged.Repo, size.GitBytes, time.Unix(0, size.MeasuredAt))
}
