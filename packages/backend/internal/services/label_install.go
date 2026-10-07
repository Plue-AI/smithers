package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type installLabelMutationStore struct {
	q    *db.Queries
	pool *pgxpool.Pool
}

func WithLabelInstallAuthorization(q *db.Queries, pool *pgxpool.Pool) LabelServiceOption {
	return func(s *LabelService) { s.install = &installLabelMutationStore{q: q, pool: pool} }
}

// InstallLabelMutationSubject validates the same typed input the existing label
// implementation consumes. Its canonical digest binds the requested fields;
// normalization and persistence still belong to that implementation.
func InstallLabelMutationSubject(repository int64, command string, id int64, input any) (InstallSubject, error) {
	subject := InstallSubject{RepositoryID: repository, Resource: "label:" + strconv.FormatInt(id, 10)}
	switch command {
	case "labels.create":
		req, ok := input.(CreateLabelInput)
		if !ok || id != 0 {
			return subject, pkgerrors.BadRequest("invalid label request")
		}
		if _, err := validateLabelName(req.Name); err != nil {
			return subject, err
		}
		if _, err := normalizeLabelColor(req.Color); err != nil {
			return subject, err
		}
		if err := validateSafeText("Label", "description", req.Description); err != nil {
			return subject, err
		}
	case "labels.update":
		req, ok := input.(UpdateLabelInput)
		if !ok || id <= 0 {
			return subject, pkgerrors.BadRequest("invalid label request")
		}
		if req.Name != nil {
			if _, err := validateLabelName(*req.Name); err != nil {
				return subject, err
			}
		}
		if req.Color != nil {
			if _, err := normalizeLabelColor(*req.Color); err != nil {
				return subject, err
			}
		}
		if req.Description != nil {
			if err := validateSafeText("Label", "description", *req.Description); err != nil {
				return subject, err
			}
		}
	case "labels.delete":
		if _, ok := input.(struct{}); !ok || id <= 0 {
			return subject, pkgerrors.BadRequest("invalid label request")
		}
	default:
		return subject, confirmationPermission()
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return subject, pkgerrors.BadRequest("invalid label request")
	}
	digest := sha256.Sum256(raw)
	subject.PayloadDigest = hex.EncodeToString(digest[:])
	return subject, nil
}

func withInstallLabelMutation[T any](s *LabelService, ctx context.Context, actor *db.User, owner, name, command string, id int64, input any, effect func(*LabelService, context.Context) (T, error)) (T, error) {
	var zero T
	if actor == nil {
		return zero, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	if s.install.pool == nil {
		return zero, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "label store unavailable")
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
	// Authenticate and serialize credential death before resolving a private
	// repository or validating its input. All subsequent queries share this
	// transaction, including on installations with one database connection.
	if err := guardInstallMemberCredential(ctx, tx, installed, actor.ID, false); err != nil {
		return zero, err
	}
	scoped := *s
	scoped.queries = q
	repository, lookup := scoped.resolveRepoByOwnerAndName(ctx, owner, name)
	subject, validation := InstallLabelMutationSubject(repository.ID, command, id, input)
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
	if repository.ID != installed || actor.ID != decision.UserID {
		return zero, confirmationPermission()
	}
	ctx = WithInstallAuthorization(ctx, command, decision, subject)
	if id > 0 {
		var locked int64
		err := tx.QueryRow(ctx, `SELECT id FROM labels WHERE repository_id=$1 AND id=$2 FOR UPDATE`, repository.ID, id).Scan(&locked)
		if errors.Is(err, pgx.ErrNoRows) {
			return zero, pkgerrors.NotFound("label not found")
		}
		if err != nil {
			return zero, err
		}
	}
	scoped.installAdmitted = true
	scoped.installRepository = &repository
	result, err := effect(&scoped, ctx)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}
