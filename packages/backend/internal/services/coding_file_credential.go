package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// CodingFileCredentials narrows an authenticated S1 coding host to one exact
// file batch, using the existing revocable access-token store. The run identity
// is the trusted host's assertion, not an independently trusted guest journal.
// S2 registered daemon sessions are a separate cutover, not this S1 credential.
type CodingFileCredentials struct {
	auth       *AuthService
	hosts      *FlowHostCallbacks
	workspaces *WorkspaceService
}

func NewCodingFileCredentials(auth *AuthService, hosts *FlowHostCallbacks, workspaces *WorkspaceService) *CodingFileCredentials {
	return &CodingFileCredentials{auth: auth, hosts: hosts, workspaces: workspaces}
}

type CodingFileGrantInput struct {
	RunID       string `json:"run_id"`
	BatchDigest string `json:"batch_digest"`
}

type CodingFileGrant struct {
	TokenID        int64  `json:"token_id"`
	Token          string `json:"token"`
	RunID          string `json:"run_id"`
	WorkspaceID    string `json:"workspace_id"`
	RepositorySlug string `json:"repository_slug"`
	ExpiresAt      int64  `json:"expires_at"`
	BatchDigest    string `json:"batch_digest"`
}

func (s *CodingFileCredentials) Mint(ctx context.Context, hostID, bearer string, input CodingFileGrantInput) (CodingFileGrant, error) {
	var result CodingFileGrant
	if s == nil || s.auth == nil || s.hosts == nil || s.workspaces == nil {
		return result, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "coding file issuer unavailable")
	}
	target, err := s.hosts.AuthorizeHostCallback(ctx, hostID, bearer)
	if err != nil {
		return result, err
	}
	if err := s.auth.requireDelegatedMember(ctx, target.UserID); err != nil {
		return result, err
	}
	fence := sha256.Sum256([]byte(bearer))
	binding := middleware.CodingFileBinding{HostID: target.HostID, WorkspaceID: target.WorkspaceID,
		RepositoryID: target.RepositoryID, RunID: input.RunID, BatchDigest: input.BatchDigest, Fence: hex.EncodeToString(fence[:])}
	if !binding.Valid() {
		return result, pkgerrors.BadRequest("invalid coding file grant subject")
	}
	err = s.workspaces.withWorkspaceMutation(ctx, binding.WorkspaceID, binding.RepositoryID, target.UserID, func(ctx context.Context, _ db.Workspace) error {
		// Hold the live host fence while issuing. A concurrent rotation cannot
		// produce a newly-issued token already detached from its authenticated host.
		tx := heldWorkspaceMutationTransaction(ctx, binding.WorkspaceID, target.UserID)
		ownsTransaction := tx == nil
		if ownsTransaction {
			tx, err = s.auth.Members.Pool.Begin(ctx)
			if err != nil {
				return pkgerrors.Internal("begin coding file grant").WithCause(err)
			}
			defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
		}
		var live int
		err = tx.QueryRow(ctx, `SELECT 1 FROM flow_runtime_host_bindings
			WHERE id=$1::uuid AND user_id=$2 AND repository_id=$3 AND workspace_id=$4::uuid
			AND state IN ('starting','running') AND encode(credential_hash,'hex')=$5 FOR SHARE`,
			binding.HostID, target.UserID, binding.RepositoryID, binding.WorkspaceID, binding.Fence).Scan(&live)
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Unauthorized("coding host credential changed")
		}
		if err != nil {
			return pkgerrors.Internal("lock coding host credential").WithCause(err)
		}
		var slug string
		err = tx.QueryRow(ctx, `SELECT u.username || '/' || r.name FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, binding.RepositoryID).Scan(&slug)
		if err != nil {
			return pkgerrors.Internal("load coding file repository").WithCause(err)
		}
		// Token creation is part of this transaction; failed issuance retains no
		// bearer. Two minutes bounds a lost response or failed finalizer cleanup.
		token, err := issueTemporaryRepoTokenWithTTL(ctx, db.New(tx), target.UserID,
			"coding-file-"+binding.HostID, strings.Join(middleware.CodingFileScopes(binding), ","), 2*time.Minute)
		if err != nil {
			return pkgerrors.Internal("issue coding file grant").WithCause(err)
		}
		result = CodingFileGrant{TokenID: token.ID, Token: token.Plaintext, RunID: binding.RunID,
			WorkspaceID: binding.WorkspaceID, RepositorySlug: slug, ExpiresAt: token.ExpiresAt.UnixMilli(), BatchDigest: binding.BatchDigest}

		if ownsTransaction {
			if err = tx.Commit(ctx); err != nil {
				return pkgerrors.Internal("commit coding file grant").WithCause(err)
			}
		}
		return nil
	})
	if err != nil {
		return CodingFileGrant{}, err
	}
	return result, nil
}

// Revoke may run after a host stops, a member is removed or its control
// credential rotates. The grant's own bearer is sufficient to revoke itself;
// it can never delete another token. Repeating cleanup is harmless.
func (s *CodingFileCredentials) Revoke(ctx context.Context, hostID string, tokenID int64, bearer string) error {
	if s == nil || s.auth == nil || s.auth.Members == nil || s.auth.Members.Pool == nil {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "coding file issuer unavailable")
	}
	if tokenID <= 0 || bearer == "" {
		return pkgerrors.Unauthorized("coding file grant required")
	}
	hash := sha256.Sum256([]byte(bearer))
	_, err := s.auth.Members.Pool.Exec(ctx, `DELETE FROM access_tokens WHERE id=$1 AND token_hash=$2
		AND system_issued AND string_to_array(scopes, ',') @> ARRAY['profile:coding_file_s1', 'coding-file-host:' || $3]`, tokenID, hex.EncodeToString(hash[:]), hostID)
	if err != nil {
		return pkgerrors.Internal("revoke coding file grant").WithCause(err)
	}
	return nil
}

// authorizeCodingFileWrite admits only the issuer's exact verified batch.
// The mutation retains its serialized token and host fence below; this command
// decision cannot be reused for another body, workspace or run.
func authorizeCodingFileWrite(ctx context.Context, q *db.Queries, subject InstallSubject) (InstallAuthorization, error) {
	info := middleware.AuthInfoFromContext(ctx)
	binding, valid := middleware.CodingFileCredential(info)
	if q == nil || !valid || info.User == nil || !middleware.CodingFileBatchVerified(info, binding.BatchDigest) ||
		subject != (InstallSubject{RepositoryID: binding.RepositoryID, WorkspaceID: binding.WorkspaceID, RunID: binding.RunID, PayloadDigest: binding.BatchDigest}) {
		return InstallAuthorization{}, confirmationPermission()
	}
	token, err := q.GetAccessTokenByID(ctx, info.TokenID)
	if errors.Is(err, pgx.ErrNoRows) {
		return InstallAuthorization{}, confirmationPermission()
	}
	if err != nil {
		return InstallAuthorization{}, err
	}
	if !token.SystemIssued || token.UserID != info.User.ID || token.TokenHash != info.TokenHash || token.Scopes != info.RawScopes || !token.ExpiresAt.Valid || !token.ExpiresAt.Time.After(time.Now()) {
		return InstallAuthorization{}, confirmationPermission()
	}
	role, err := InstallRoleOf(ctx, q, info.User.ID)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if role.rank() < InstallMember.rank() {
		return InstallAuthorization{}, confirmationPermission()
	}
	return InstallAuthorization{UserID: info.User.ID, Role: role}, nil
}

// withCodingFileMutationAuthority rechecks and locks both stored token and host
// fence until the complete provider call settles. Revocation/rotation waits for
// an admitted batch; a later request cannot use a revoked or superseded grant.
func (s *WorkspaceService) withCodingFileMutationAuthority(ctx context.Context, workspaceID string, repositoryID, userID int64, fn func(context.Context) error) error {
	info := middleware.AuthInfoFromContext(ctx)
	if !middleware.IsCodingFileCredential(info) {
		return fn(ctx)
	}
	binding, valid := middleware.CodingFileCredential(info)
	if s.installQueries != nil {
		if _, err := Authorize(ctx, s.installQueries, "branch.join", InstallSubject{RepositoryID: binding.RepositoryID, WorkspaceID: binding.WorkspaceID, RunID: binding.RunID, PayloadDigest: binding.BatchDigest}); err != nil {
			return err
		}
	}
	if !valid || !middleware.CodingFileBatchVerified(info, binding.BatchDigest) || binding.WorkspaceID != workspaceID ||
		binding.RepositoryID != repositoryID || info.User == nil || info.User.ID != userID || info.TokenID <= 0 || info.TokenHash == "" {
		return pkgerrors.Forbidden("coding file grant refused")
	}
	if s.transactions == nil {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "coding file authority unavailable")
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return pkgerrors.Internal("begin coding file authority").WithCause(err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	var live int
	err = tx.QueryRow(ctx, `SELECT 1 FROM access_tokens t JOIN flow_runtime_host_bindings h ON h.id=$1::uuid
		WHERE t.id=$2 AND t.token_hash=$3 AND t.user_id=$4 AND t.system_issued AND t.scopes=$5
		AND t.expires_at > clock_timestamp() AND h.user_id=$4 AND h.repository_id=$6 AND h.workspace_id=$7::uuid
		AND h.state IN ('starting','running') AND encode(h.credential_hash,'hex')=$8 FOR SHARE OF t,h`,
		binding.HostID, info.TokenID, info.TokenHash, userID, info.RawScopes, repositoryID, workspaceID, binding.Fence).Scan(&live)
	if errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Forbidden("coding file grant is no longer active")
	}
	if err != nil {
		return pkgerrors.Internal("lock coding file authority").WithCause(err)
	}
	return fn(ctx)
}
