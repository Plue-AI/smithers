package services

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// ProviderPoolAuthority retains one catalog decision and its existing issuer
// grant. Consumers fence each outbound attempt, releasing locks before streaming
// the answer. The original role decision is not evaluated again.
type ProviderPoolAuthority struct {
	user, repository int64
	fence            func(context.Context, func(context.Context) error) error
}

func (a *ProviderPoolAuthority) Scope() (int64, int64) { return a.user, a.repository }

func (a *ProviderPoolAuthority) WithLiveAuthority(ctx context.Context, effect func(context.Context) error) error {
	if a == nil || a.fence == nil || effect == nil {
		return confirmationPermission()
	}
	return a.fence(ctx, effect)
}

func (p *ProviderPoolScopes) ScopeAuthorization(ctx context.Context, bearer string) (*ProviderPoolAuthority, error) {
	var subject InstallSubject
	var host *flowhost.CredentialBinding
	user, repository, err := p.scopeDecision(ctx, bearer, func(s InstallSubject, h *flowhost.CredentialBinding) { subject, host = s, h })
	if err != nil {
		return nil, err
	}
	authority := &ProviderPoolAuthority{user: user, repository: repository}
	info := middleware.AuthInfoFromContext(ctx)
	authority.fence = func(current context.Context, effect func(context.Context) error) error {
		if !p.install {
			return effect(current)
		}
		if p.pool == nil || subject.RepositoryID != repository || middleware.AuthInfoFromContext(current) != info {
			return confirmationPermission()
		}
		tx, err := p.pool.Begin(current)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback(context.WithoutCancel(current)) }()
		checked := current
		if host != nil {
			// The verified host's user supplies lock keys only. This synthetic
			// value is never used as a session or passed to Authorize.
			locks := &middleware.AuthInfo{User: &db.User{ID: user}}
			if err := lockInstallCredentialRows(current, tx, repository, locks, false); err != nil {
				return err
			}
			live, err := flowhost.LockModelCredential(current, tx, p.codec, bearer)
			if errors.Is(err, flowhost.ErrModelCredentialInvalid) {
				return &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Invalid model credential"}
			}
			if err != nil {
				return err
			}
			if live != *host {
				return confirmationPermission()
			}
			checked = context.WithValue(current, verifiedInstallPoolHostKey{}, live)
		} else if err := guardInstallMemberCredential(current, tx, repository, user, false); err != nil {
			return err
		}
		var one int
		err = tx.QueryRow(current, `SELECT 1 FROM workspaces WHERE id=$1::uuid AND repository_id=$2 FOR SHARE`, subject.WorkspaceID, repository).Scan(&one)
		if errors.Is(err, pgx.ErrNoRows) {
			return confirmationPermission()
		}
		if err != nil {
			return err
		}
		// Reuse the existing stored publisher/host and workspace predicates;
		// they grant no new command and do not run catalog policy again.
		if _, err := authorizeWorkspaceProviderPool(checked, db.New(tx), subject); err != nil {
			return err
		}
		effectErr := effect(context.WithValue(current, providerPoolTransactionKey{}, tx))
		// Selection and refresh records retain their original durable behavior,
		// including failure/backoff records. Only invalid admission rolls back.
		commitCtx, cancel := context.WithTimeout(context.WithoutCancel(current), 5*time.Second)
		defer cancel()
		commitErr := tx.Commit(commitCtx)
		if effectErr != nil {
			return effectErr
		}
		return commitErr
	}
	return authority, nil
}

// Provider callbacks share the authority transaction rather than acquiring a
// second pool connection while holding credential rows. This also keeps a
// one-connection install usable and prevents pool exhaustion under concurrency.
type providerPoolTransactionKey struct{}

func ProviderPoolQueries(ctx context.Context, fallback *db.Queries) *db.Queries {
	if tx, ok := ctx.Value(providerPoolTransactionKey{}).(pgx.Tx); ok {
		return db.New(tx)
	}
	return fallback
}

func (s *ProviderConnectionService) withPoolAuthorityStore(ctx context.Context) *ProviderConnectionService {
	tx, ok := ctx.Value(providerPoolTransactionKey{}).(pgx.Tx)
	if s == nil || !ok {
		return s
	}
	scoped := *s
	q := db.New(tx)
	scoped.q = q
	if s.audit != nil {
		scoped.audit = NewAuditService(q)
	}
	return &scoped
}
