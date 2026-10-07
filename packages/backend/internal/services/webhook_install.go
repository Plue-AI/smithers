package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type installWebhookStore struct{ pool *pgxpool.Pool }

func WithWebhookInstallAuthorization(pool *pgxpool.Pool) WebhookServiceOption {
	return func(s *WebhookService) { s.install = &installWebhookStore{pool} }
}

func InstallWebhookSubject(repository int64, command string, id, delivery int64, input any) (InstallSubject, error) {
	subject := InstallSubject{RepositoryID: repository, Resource: fmt.Sprintf("webhook:%d:%d", id, delivery)}
	valid := false
	switch command {
	case "webhooks.list":
		_, valid = input.(struct{})
		valid = valid && id == 0 && delivery == 0
	case "webhooks.get", "webhooks.deliveries", "webhooks.delete":
		_, valid = input.(struct{})
		valid = valid && id > 0 && delivery == 0
	case "webhooks.create":
		_, valid = input.(CreateWebhookInput)
		valid = valid && id == 0 && delivery == 0
	case "webhooks.update":
		_, valid = input.(UpdateWebhookInput)
		valid = valid && id > 0 && delivery == 0
	case "webhooks.redeliver":
		_, valid = input.(struct{})
		valid = valid && id > 0 && delivery > 0
	}
	if !valid {
		return subject, pkgerrors.BadRequest("invalid webhook request")
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return subject, pkgerrors.BadRequest("invalid webhook request")
	}
	digest := sha256.Sum256(raw)
	subject.PayloadDigest = hex.EncodeToString(digest[:])
	return subject, nil
}

// Only database administration runs here. Sending a webhook is a separate
// outbound action and cannot be rolled back with a database transaction.
func withInstallWebhook[T any](s *WebhookService, ctx context.Context, actor *db.User, owner, name, command string, id, delivery int64, input any, effect func(*WebhookService, context.Context) (T, error)) (T, error) {
	var zero T
	info := middleware.AuthInfoFromContext(ctx)
	if actor == nil || info == nil || info.User == nil {
		return zero, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	if s.install.pool == nil {
		return zero, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "webhook store unavailable")
	}
	tx, err := s.install.pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	installed, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return zero, err
	}
	if command != "webhooks.list" && command != "webhooks.get" && command != "webhooks.deliveries" {
		if _, err = tx.Exec(ctx, repoOwnershipSharedLockSQL, installed); err != nil {
			return zero, err
		}
		if err = lockInstallRepositoryAdminMutation(ctx, tx, installed); err != nil {
			return zero, err
		}
	}
	if err = guardInstallMemberCredential(ctx, tx, installed, info.User.ID, false); err != nil {
		return zero, err
	}
	scoped := *s
	scoped.queries = q
	repository, lookup := scoped.resolveRepoByOwnerAndName(ctx, owner, name)
	subject, validation := InstallWebhookSubject(repository.ID, command, id, delivery, input)
	decision, err := Authorize(ctx, q, command, subject)
	if err != nil {
		return zero, err
	}
	if lookup != nil {
		return zero, lookup
	}
	if validation != nil {
		return zero, validation
	}
	if repository.ID != installed || decision.UserID != actor.ID || actor.ID != info.User.ID {
		return zero, confirmationPermission()
	}
	scoped.installAdmitted = true
	// The outer transaction already holds the ownership fence. Reacquiring it
	// through the pool can deadlock a one-connection install.
	scoped.ownershipGuard = nil
	ctx = WithInstallAuthorization(ctx, command, decision, subject)
	result, err := effect(&scoped, ctx)
	if err != nil {
		return zero, err
	}
	if err = guardInstallMemberCredential(ctx, tx, installed, info.User.ID, false); err != nil {
		return zero, err
	}
	if err = tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}
