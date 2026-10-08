package process

import (
	"context"
	"fmt"
)

// WriteRepositoryReceipt is the fixed preparation write used before admission.
func (r *Runtime) WriteRepositoryReceipt(ctx context.Context, id string, content []byte) error {
	if len(content) > 65536 {
		return fmt.Errorf("repository receipt exceeds limit")
	}
	return r.WriteFile(ctx, id, ".git/smithers-workspace-initialization.json", content, 0600)
}
