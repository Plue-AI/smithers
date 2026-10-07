package compose

import (
	"context"
	"fmt"
)

// A self-hosted install has one configured repository host. The resolver still
// looks up canonical repository identity before calling this placement port;
// hosted deployments continue to supply their private placement adapter.
type installRepositoryPlacement string

func (p installRepositoryPlacement) StorageSetForRepository(_ context.Context, repositoryID int64) (string, error) {
	if repositoryID <= 0 || p == "" {
		return "", fmt.Errorf("invalid install repository placement")
	}
	return string(p), nil
}
