package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Bind the same normalized name/action that the existing controller consumes.
func InstallWorkspaceServiceControlSubject(repository int64, workspace, name, action string) InstallSubject {
	name = strings.TrimSuffix(strings.TrimSpace(name), ".service")
	action = strings.ToLower(strings.TrimSpace(action))
	raw, _ := json.Marshal([]string{name, action})
	digest := sha256.Sum256(raw)
	return InstallSubject{RepositoryID: repository, WorkspaceID: strings.TrimSpace(workspace), Resource: "service-control", PayloadDigest: hex.EncodeToString(digest[:])}
}

func (s *WorkspaceService) manageInstallWorkspaceService(ctx context.Context, workspace string, repository, actor int64, name, action string) (WorkspaceManagedService, error) {
	if s.transactions == nil {
		return WorkspaceManagedService{}, confirmationPermission()
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return WorkspaceManagedService{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	scoped := *s
	scoped.q, scoped.installQueries, scoped.transactions = q, q, tx
	subject := InstallWorkspaceServiceControlSubject(repository, workspace, name, action)
	ctx, err = scoped.authorizeInstallWorkspaceMetadata(ctx, "box.services", repository, actor, subject)
	if err != nil {
		return WorkspaceManagedService{}, err
	}
	if err = scoped.guardWorkspaceServiceControl(ctx, repository, actor); err != nil {
		return WorkspaceManagedService{}, err
	}
	ctx = context.WithValue(ctx, workspaceRuntimeEffectFenceKey{}, func(current context.Context) error {
		return scoped.guardWorkspaceServiceControl(current, repository, actor)
	})
	result, effectErr := scoped.manageWorkspaceServiceRequest(ctx, workspace, repository, actor, name, action)
	// A runtime effect cannot be rolled back by SQL. Preserve any observed
	// lifecycle/recency writes even if the caller disconnects after dispatch.
	commitCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	commitErr := tx.Commit(commitCtx)
	if effectErr != nil {
		return WorkspaceManagedService{}, effectErr
	}
	if commitErr != nil {
		return WorkspaceManagedService{}, commitErr
	}
	return result, nil
}

// Recheck immediately before the service-control transport, after runtime
// inspection may have waited. The existing workspace mutation guard also holds
// any write-share grant for the complete operation.
func (s *WorkspaceService) guardWorkspaceServiceControl(ctx context.Context, repository, actor int64) error {
	if s.installQueries == nil {
		return nil
	}
	tx, ok := s.transactions.(pgx.Tx)
	if !ok {
		return confirmationPermission()
	}
	return guardInstallMemberCredential(ctx, tx, repository, actor, false)
}

// A scoped controller supplies its live credential fence to retained lifecycle
// and checkout steps without imposing person credentials on internal recovery.
type workspaceRuntimeEffectFenceKey struct{}

func guardWorkspaceRuntimeEffect(ctx context.Context) error {
	if fence, ok := ctx.Value(workspaceRuntimeEffectFenceKey{}).(func(context.Context) error); ok {
		return fence(ctx)
	}
	return nil
}
