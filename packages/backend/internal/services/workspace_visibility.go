package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"regexp"
	"strconv"
	"strings"
)

type workspaceVisibilityQuerier interface {
	SetWorkspaceServicePublic(context.Context, db.SetWorkspaceServicePublicParams) error
	WorkspaceServicePublic(context.Context, db.WorkspaceServicePublicParams) (bool, error)
	AuthorizePublicWorkspaceService(context.Context, db.AuthorizePublicWorkspaceServiceParams) (bool, error)
}

func (s *WorkspaceService) workspaceVisibilityOwner(ctx context.Context, id string, repo, user int64, port uint16) (workspaceVisibilityQuerier, error) {
	if port == 0 {
		return nil, pkgerrors.BadRequest("invalid preview port")
	}
	if s == nil || s.q == nil {
		return nil, pkgerrors.Internal("workspace store unavailable")
	}
	w, err := s.loadWorkspaceWithAccess(ctx, id, repo, user, WorkspaceAccessRead)
	if err != nil {
		return nil, err
	}
	// A write share permits operating a service, never publishing its data.
	if w.UserID != user {
		return nil, pkgerrors.Forbidden("workspace owner required")
	}
	if err := s.AuthorizeWorkspacePreview(ctx, id, repo, user); err != nil {
		return nil, err
	}
	q, ok := s.q.(workspaceVisibilityQuerier)
	if !ok {
		return nil, pkgerrors.Internal("workspace visibility unavailable")
	}
	return q, nil
}
func (s *WorkspaceService) SetWorkspaceServicePublic(ctx context.Context, id string, repo, user int64, port uint16, public bool) error {
	if s != nil && s.installQueries != nil {
		return s.setInstallWorkspaceServicePublic(ctx, id, repo, user, port, public)
	}
	return s.setWorkspaceServicePublic(ctx, id, repo, user, port, public)
}
func (s *WorkspaceService) setWorkspaceServicePublic(ctx context.Context, id string, repo, user int64, port uint16, public bool) error {
	q, err := s.workspaceVisibilityOwner(ctx, id, repo, user, port)
	if err != nil {
		return err
	}
	if err := q.SetWorkspaceServicePublic(ctx, db.SetWorkspaceServicePublicParams{WorkspaceID: id, Port: int32(port), Public: public}); err != nil {
		return pkgerrors.Internal("save workspace visibility").WithCause(err)
	}
	return nil
}

type WorkspaceVisibilityInput struct {
	Public *bool `json:"public"`
}

func InstallWorkspaceVisibilityWriteSubject(repo int64, workspace string, port uint16, public bool) InstallSubject {
	subject := InstallWorkspaceVisibilitySubject(repo, workspace, port)
	digest := sha256.Sum256([]byte(strconv.FormatBool(public)))
	subject.PayloadDigest = hex.EncodeToString(digest[:])
	return subject
}

func (s *WorkspaceService) setInstallWorkspaceServicePublic(ctx context.Context, id string, repo, user int64, port uint16, public bool) error {
	if s.transactions == nil {
		return confirmationPermission()
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	scoped := *s
	scoped.q, scoped.installQueries = q, q
	subject := InstallWorkspaceVisibilityWriteSubject(repo, id, port, public)
	ctx, err = scoped.authorizeInstallWorkspaceMetadata(ctx, "workspace.preview.update", repo, user, subject)
	if err != nil {
		return err
	}
	if err = guardInstallMemberCredential(ctx, tx, repo, user, false); err != nil {
		return err
	}
	// Consent cannot race a change of workspace ownership.
	if _, err = tx.Exec(ctx, "SELECT id FROM workspaces WHERE id=$1::uuid AND repository_id=$2 FOR UPDATE", id, repo); err != nil {
		if isInvalidTextRepresentation(err) {
			return pkgerrors.NotFound("workspace not found")
		}
		return err
	}
	if err = scoped.setWorkspaceServicePublic(ctx, id, repo, user, port, public); err != nil {
		return err
	}
	if err = guardInstallMemberCredential(ctx, tx, repo, user, false); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// InstallWorkspaceVisibilitySubject binds the exact preview consent being read.
func InstallWorkspaceVisibilitySubject(repository int64, workspace string, port uint16) InstallSubject {
	return InstallSubject{RepositoryID: repository, WorkspaceID: workspace, Resource: "preview:" + strconv.Itoa(int(port))}
}

func (s *WorkspaceService) WorkspaceServicePublic(ctx context.Context, id string, repo, user int64, port uint16) (bool, error) {
	return readInstallWorkspaceMetadata(ctx, s, "branch.read", repo, user, func(ctx context.Context, scoped *WorkspaceService) (bool, error) {
		return scoped.workspaceServicePublic(ctx, id, repo, user, port)
	}, InstallWorkspaceVisibilitySubject(repo, id, port))
}
func (s *WorkspaceService) workspaceServicePublic(ctx context.Context, id string, repo, user int64, port uint16) (bool, error) {
	q, err := s.workspaceVisibilityOwner(ctx, id, repo, user, port)
	if err != nil {
		return false, err
	}
	public, err := q.WorkspaceServicePublic(ctx, db.WorkspaceServicePublicParams{WorkspaceID: id, Port: int32(port)})
	if err != nil {
		return false, pkgerrors.Internal("load workspace visibility").WithCause(err)
	}
	return public, nil
}

var publicPreviewLabel = regexp.MustCompile(`^([1-9][0-9]{0,4})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`)
var publicPreviewDNSLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

// AuthorizePublicPreview rechecks durable consent and the owner's current status.
func (s *WorkspaceService) AuthorizePublicPreview(ctx context.Context, domain string) error {
	// The relay-authenticated gateway enforces its configured suffix allowlist.
	// Product authorization binds the service port and workspace, independently
	// of the deployment's domain, while rejecting ambiguous host spellings.
	labels := strings.Split(domain, ".")
	if len(domain) > 253 || len(labels) < 2 {
		return pkgerrors.Forbidden("preview is private")
	}
	for _, label := range labels {
		if !publicPreviewDNSLabel.MatchString(label) {
			return pkgerrors.Forbidden("preview is private")
		}
	}
	parts := publicPreviewLabel.FindStringSubmatch(labels[0])
	if len(parts) != 3 {
		return pkgerrors.Forbidden("preview is private")
	}
	port, err := strconv.ParseUint(parts[1], 10, 16)
	if err != nil || port == 0 {
		return pkgerrors.Forbidden("preview is private")
	}
	if s == nil || s.q == nil {
		return pkgerrors.Internal("workspace store unavailable")
	}
	q, ok := s.q.(workspaceVisibilityQuerier)
	if !ok {
		return pkgerrors.Internal("workspace visibility unavailable")
	}
	allowed, err := q.AuthorizePublicWorkspaceService(ctx, db.AuthorizePublicWorkspaceServiceParams{WorkspaceID: parts[2], Port: int32(port)})
	if err != nil {
		return pkgerrors.Internal("authorize public preview").WithCause(err)
	}
	if !allowed {
		return pkgerrors.Forbidden("preview is private")
	}
	// Public consent cannot outlive the owner's repository permission.
	workspace, err := s.q.GetWorkspace(ctx, parts[2])
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Forbidden("preview is private")
		}
		return pkgerrors.Internal("load public preview workspace").WithCause(err)
	}
	return s.AuthorizeWorkspacePreview(ctx, workspace.ID, workspace.RepositoryID, workspace.UserID)
}
