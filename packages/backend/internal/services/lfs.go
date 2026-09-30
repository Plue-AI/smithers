package services

import (
	"context"
	"crypto/sha256"
	stdErrors "errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/lfsauth"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// maxLFSBatchObjects caps how many objects a single LFS batch request may
// reference. Each object costs a DB lookup and potentially a blob-store
// round-trip, so an unbounded array lets one request monopolize pool
// connections and network egress. 100 matches the default git-lfs client
// batch size.
const maxLFSBatchObjects = 100

// maxLFSObjectSize bounds a single Git LFS object to 5 GiB.
const maxLFSObjectSize int64 = 5 * 1024 * 1024 * 1024

const (
	lfsVerifyContinuationGrace = 15 * time.Minute
	lfsReservationCleanupGrace = 5 * time.Minute
	lfsSignerRollbackTimeout   = 15 * time.Second
)

type LFSObjectInput struct {
	Oid  string `json:"oid"`
	Size int64  `json:"size"`
}

type LFSBatchInput struct {
	Operation string           `json:"operation"`
	Objects   []LFSObjectInput `json:"objects"`
}

// LFSBatchActionLink represents a single action (upload or download) in an LFS
// batch response, as defined by the Git LFS v1 batch API spec.
type LFSBatchActionLink struct {
	Href   string            `json:"href"`
	Header map[string]string `json:"header,omitempty"`
}

// LFSBatchObjectResponse is one object entry in an LFS batch API response.
// Its shape matches the Git LFS v1 batch API spec:
//
//	{"oid": "...", "size": N, "actions": {"download": {...}}}
type LFSBatchObjectResponse struct {
	Oid     string                        `json:"oid"`
	Size    int64                         `json:"size"`
	Actions map[string]LFSBatchActionLink `json:"actions,omitempty"`
	Error   *LFSBatchObjectError          `json:"error,omitempty"`
}

// LFSBatchObjectError is the per-object error structure used by the Git LFS
// batch API spec when an individual object cannot be served.
type LFSBatchObjectError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// LFSBatchResponse is the top-level Git LFS v1 batch API response envelope.
type LFSBatchResponse struct {
	Transfer string                   `json:"transfer"`
	Objects  []LFSBatchObjectResponse `json:"objects"`
}

type lfsBatchObjectState struct {
	oid        string
	size       int64
	row        db.LfsObject
	registered bool
}

type LFSConfirmUploadInput struct {
	Oid  string `json:"oid"`
	Size int64  `json:"size"`
}

type LFSQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	CreateLFSObject(ctx context.Context, arg db.CreateLFSObjectParams) (db.LfsObject, error)
	GetLFSObjectByOID(ctx context.Context, arg db.GetLFSObjectByOIDParams) (db.LfsObject, error)
	DeleteLFSObject(ctx context.Context, arg db.DeleteLFSObjectParams) (int64, error)
	UpsertLFSUploadReservation(ctx context.Context, arg db.UpsertLFSUploadReservationParams) (db.LfsUploadReservation, error)
	GetLFSUploadReservation(ctx context.Context, arg db.GetLFSUploadReservationParams) (db.LfsUploadReservation, error)
	DeleteLFSUploadReservation(ctx context.Context, arg db.DeleteLFSUploadReservationParams) error
	DeleteUnissuedLFSUploadReservation(ctx context.Context, arg db.DeleteUnissuedLFSUploadReservationParams) (int64, error)
	ListExpiredLFSUploadReservationsByOwner(ctx context.Context, repositoryID int64) ([]db.LfsUploadReservation, error)
	DeleteExpiredLFSUploadReservation(ctx context.Context, arg db.DeleteExpiredLFSUploadReservationParams) (int64, error)
	ListLFSObjects(ctx context.Context, arg db.ListLFSObjectsParams) ([]db.LfsObject, error)
	CountLFSObjects(ctx context.Context, repositoryID int64) (int64, error)
}

type lfsStorageDeletionAllocationQuerier interface {
	HasStorageDeletionAllocation(ctx context.Context, arg runtimeports.HasStorageDeletionAllocationParams) (bool, error)
}

type LFSService struct {
	queries         LFSQuerier
	blobs           blob.Store
	signedURLExpiry time.Duration
	billing         BillingPolicy
	verifyBaseURL   string
	verifyTokens    *lfsauth.Manager
	verifyTokenTTL  time.Duration
}

type LFSServiceOption func(*LFSService)

func WithLFSBillingPolicy(policy BillingPolicy) LFSServiceOption {
	return func(s *LFSService) {
		s.billing = policy
	}
}

// WithLFSVerifyBaseURL configures the trusted public origin used for Git LFS
// upload verification callbacks. It must be the externally reachable server
// base URL (without /api); Batch deliberately does not derive this value from
// request Host or forwarded headers.
func WithLFSVerifyBaseURL(baseURL string) LFSServiceOption {
	return func(s *LFSService) {
		s.verifyBaseURL = strings.TrimSpace(baseURL)
	}
}

// WithLFSVerifyTokenManager enables exact object-bound continuation tokens for
// SSH-authenticated uploads. The broad SSH bridge token can then remain short
// lived even when the storage PUT itself takes longer than that credential.
func WithLFSVerifyTokenManager(manager *lfsauth.Manager) LFSServiceOption {
	return func(s *LFSService) {
		s.verifyTokens = manager
	}
}

func NewLFSService(q LFSQuerier, b blob.Store, expiry time.Duration, opts ...LFSServiceOption) *LFSService {
	if expiry <= 0 {
		expiry = blob.DefaultSignedURLExpiry
	}
	if expiry > blob.MaxSignedURLExpiry {
		expiry = blob.MaxSignedURLExpiry
	}
	svc := &LFSService{
		queries:         q,
		blobs:           b,
		signedURLExpiry: expiry,
		verifyTokenTTL:  expiry + lfsVerifyContinuationGrace,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(svc)
		}
	}
	return svc
}

// Batch implements the Git LFS v1 batch API.  Download operations require only
// read permission; upload operations require write permission.  The response
// envelope matches the Git LFS spec: {"transfer":"basic","objects":[...]}.
func (s *LFSService) Batch(ctx context.Context, actor *db.User, owner, repo string, input LFSBatchInput) (LFSBatchResponse, error) {
	op := strings.ToLower(strings.TrimSpace(input.Operation))
	if op != "upload" && op != "download" {
		return LFSBatchResponse{}, pkgerrors.BadRequest("operation must be upload or download")
	}
	if len(input.Objects) == 0 {
		return LFSBatchResponse{}, pkgerrors.BadRequest("objects are required")
	}
	if len(input.Objects) > maxLFSBatchObjects {
		return LFSBatchResponse{}, pkgerrors.UnprocessableEntity(fmt.Sprintf(
			"too many objects: batch supports at most %d objects per request", maxLFSBatchObjects,
		))
	}
	batchObjectSizes := make(map[string]int64, len(input.Objects))
	for _, obj := range input.Objects {
		oid, size, err := validateLFSObjectInput(obj)
		if err != nil {
			return LFSBatchResponse{}, err
		}
		if previousSize, duplicate := batchObjectSizes[oid]; duplicate && previousSize != size {
			return LFSBatchResponse{}, pkgerrors.UnprocessableEntity("duplicate lfs oid has conflicting sizes")
		}
		batchObjectSizes[oid] = size
	}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return LFSBatchResponse{}, err
	}
	_, scoped := lfsauth.ClaimsFromContext(ctx)
	if !repository.IsPublic && !scoped {
		if err := s.requireReadAccess(ctx, repository, actor); err != nil {
			if apiErr, ok := err.(*pkgerrors.APIError); ok && apiErr.Status == 403 {
				return LFSBatchResponse{}, pkgerrors.NotFound("repository not found")
			}
			return LFSBatchResponse{}, err
		}
	}
	if err := validateLFSScopedPath(ctx, owner, repo, lfsauth.Operation(op), false); err != nil {
		if !repository.IsPublic {
			return LFSBatchResponse{}, pkgerrors.NotFound("repository not found")
		}
		return LFSBatchResponse{}, err
	}
	if err := enforceLFSRepositoryRestriction(ctx, repository.ID); err != nil {
		if !repository.IsPublic {
			return LFSBatchResponse{}, pkgerrors.NotFound("repository not found")
		}
		return LFSBatchResponse{}, err
	}
	if authInfo := middleware.AuthInfoFromContext(ctx); authInfo != nil && authInfo.User != nil && authInfo.IsTokenAuth {
		requiredScope := middleware.ScopeReadRepository
		if op == "upload" {
			requiredScope = middleware.ScopeWriteRepository
		}
		if !authInfo.Scopes.Has(requiredScope) {
			if !repository.IsPublic && !authInfo.Scopes.Has(middleware.ScopeReadRepository) {
				return LFSBatchResponse{}, pkgerrors.NotFound("repository not found")
			}
			return LFSBatchResponse{}, pkgerrors.Forbidden("insufficient token scope")
		}
	}
	if op == "upload" && actor == nil && !scoped {
		return LFSBatchResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	// Download only requires read access; upload requires write access.
	if op == "upload" {
		if err := s.requireLFSScopedOrWriteAccess(ctx, repository, actor, lfsauth.OperationUpload); err != nil {
			if scoped && !repository.IsPublic {
				return LFSBatchResponse{}, pkgerrors.NotFound("repository not found")
			}
			return LFSBatchResponse{}, err
		}
	} else if err := s.requireLFSScopedOrReadAccess(ctx, repository, actor, lfsauth.OperationDownload); err != nil {
		if scoped && !repository.IsPublic {
			return LFSBatchResponse{}, pkgerrors.NotFound("repository not found")
		}
		return LFSBatchResponse{}, err
	}
	// Resolve the full batch before issuing any upload capability. This makes
	// the preflight quota check account for the aggregate of every new object,
	// not merely whether each object would fit independently. The confirm path
	// performs the authoritative serialized check again before promotion.
	states := make([]lfsBatchObjectState, 0, len(input.Objects))
	var preflightBytes int64
	preflightOIDs := make(map[string]struct{}, len(input.Objects))
	newObjectSizes := make(map[string]int64, len(input.Objects))
	for _, inputObject := range input.Objects {
		oid, size, _ := validateLFSObjectInput(inputObject)
		state := lfsBatchObjectState{oid: oid, size: size}
		row, lookupErr := s.queries.GetLFSObjectByOID(ctx, db.GetLFSObjectByOIDParams{RepositoryID: repository.ID, Oid: oid})
		switch {
		case lookupErr == nil:
			state.row = row
			state.registered = true
		case stdErrors.Is(lookupErr, pgx.ErrNoRows):
			if op == "upload" {
				if _, duplicate := preflightOIDs[oid]; duplicate {
					break
				}
				preflightOIDs[oid] = struct{}{}
				newObjectSizes[oid] = size
				if size > math.MaxInt64-preflightBytes {
					return LFSBatchResponse{}, pkgerrors.UnprocessableEntity("batch object sizes exceed the supported range")
				}
				preflightBytes += size
			}
		default:
			return LFSBatchResponse{}, pkgerrors.Internal("failed to load lfs object")
		}
		states = append(states, state)
	}
	preSignedNewUploads := make(map[string]blob.SignedUpload)
	if op == "upload" && s.billing != nil && preflightBytes > 0 {
		preSignedNewUploads, err = s.reserveLFSUploadCapacity(ctx, repository.ID, newObjectSizes)
		if err != nil {
			return LFSBatchResponse{}, err
		}
	}

	out := make([]LFSBatchObjectResponse, 0, len(input.Objects))
	for _, state := range states {
		oid, size := state.oid, state.size
		if !state.registered {
			if op == "download" {
				// Object not registered — return per-object 404 per the Git LFS spec.
				out = append(out, LFSBatchObjectResponse{
					Oid:   oid,
					Size:  size,
					Error: &LFSBatchObjectError{Code: 404, Message: "object not found"},
				})
				continue
			}
			key := lfsObjectKey(repository.ID, oid)
			if _, createOnly := s.blobs.(blob.CreateOnlyUploadSigner); createOnly {
				// Create-only URLs cannot overwrite an existing blob. If an earlier
				// upload landed but its verification request was interrupted, adopt
				// it now after the same integrity, billing, and metadata checks used
				// by the verify endpoint. Returning no actions is only correct after
				// that registration succeeds: git-lfs does not call verify when the
				// upload action is omitted.
				candidateKeys := []string{key}
				adopted := false
				if s.usesStagedLFSUploads() {
					candidateKeys = append(candidateKeys, lfsPendingObjectKey(repository.ID, oid))
				}
				for _, candidateKey := range candidateKeys {
					exists, e := s.blobs.Exists(ctx, candidateKey)
					if e != nil {
						return LFSBatchResponse{}, pkgerrors.Internal("failed to check blob existence").WithCause(e)
					}
					if !exists {
						continue
					}
					confirmed, confirmErr := s.confirmUploadForRepository(ctx, repository, oid, size)
					if confirmErr == nil {
						out = append(out, LFSBatchObjectResponse{Oid: oid, Size: confirmed.Size})
						adopted = true
						break
					}
					// Integrity failures remove the bad orphan, so this request can
					// immediately try another candidate or issue a fresh action.
					if !isLFSIntegrityError(confirmErr) {
						return LFSBatchResponse{}, confirmErr
					}
				}
				if adopted {
					continue
				}
			}
			upload, preSigned := preSignedNewUploads[oid]
			if !preSigned {
				uploadKey := s.lfsUploadObjectKey(repository.ID, oid)
				signedUpload, signErr := blob.SignedCreateOnlyUpload(ctx, s.blobs, uploadKey, "application/octet-stream", size, s.signedURLExpiry)
				if signErr != nil {
					return LFSBatchResponse{}, pkgerrors.Internal("failed to create upload url").WithCause(signErr)
				}
				upload = signedUpload
			}
			actions, e := s.lfsUploadActions(ctx, repository.ID, owner, repo, oid, size, upload)
			if e != nil {
				return LFSBatchResponse{}, e
			}
			out = append(out, LFSBatchObjectResponse{
				Oid:     oid,
				Size:    size,
				Actions: actions,
			})
			continue
		}
		row := state.row
		exists, err := s.blobs.Exists(ctx, row.GcsPath)
		if err != nil {
			return LFSBatchResponse{}, pkgerrors.Internal("failed to check blob existence").WithCause(err)
		}
		if op == "upload" {
			if exists {
				// Already uploaded — no actions needed.
				s.consumeLFSUploadReservation(ctx, repository.ID, oid)
				out = append(out, LFSBatchObjectResponse{Oid: oid, Size: row.Size})
				continue
			}
			if s.usesStagedLFSUploads() {
				pendingKey := lfsPendingObjectKey(repository.ID, oid)
				pendingExists, e := s.blobs.Exists(ctx, pendingKey)
				if e != nil {
					return LFSBatchResponse{}, pkgerrors.Internal("failed to check staged lfs upload").WithCause(e)
				}
				if pendingExists {
					// A prior repair upload may have completed while its verify
					// response was lost or its HTTP credential expired. Adopt it
					// before signing the same create-only key again; otherwise every
					// retry would receive 412 from the live pending generation.
					confirmed, confirmErr := s.confirmUploadForRepository(ctx, repository, oid, row.Size)
					if confirmErr == nil {
						out = append(out, LFSBatchObjectResponse{Oid: oid, Size: confirmed.Size})
						continue
					}
					if !isLFSIntegrityError(confirmErr) {
						return LFSBatchResponse{}, confirmErr
					}
					// Integrity failures delete the invalid pending object, making
					// the deterministic create-only key available for a fresh PUT.
				}
			}
			u, e := blob.SignedCreateOnlyUpload(ctx, s.blobs, s.lfsUploadObjectKey(repository.ID, oid), "application/octet-stream", row.Size, s.signedURLExpiry)
			if e != nil {
				return LFSBatchResponse{}, pkgerrors.Internal("failed to create upload url").WithCause(e)
			}
			actions, e := s.lfsUploadActions(ctx, repository.ID, owner, repo, oid, row.Size, u)
			if e != nil {
				return LFSBatchResponse{}, e
			}
			out = append(out, LFSBatchObjectResponse{
				Oid:     oid,
				Size:    row.Size,
				Actions: actions,
			})
			continue
		}
		if !exists {
			out = append(out, LFSBatchObjectResponse{
				Oid:   oid,
				Size:  row.Size,
				Error: &LFSBatchObjectError{Code: 404, Message: "object not found"},
			})
			continue
		}
		d, e := s.blobs.SignedDownloadURL(ctx, row.GcsPath, s.signedURLExpiry)
		if e != nil {
			return LFSBatchResponse{}, pkgerrors.Internal("failed to create download url").WithCause(e)
		}
		out = append(out, LFSBatchObjectResponse{
			Oid:     oid,
			Size:    row.Size,
			Actions: map[string]LFSBatchActionLink{"download": {Href: d}},
		})
	}
	return LFSBatchResponse{Transfer: "basic", Objects: out}, nil
}

// ConfirmUpload finalizes an LFS upload.  After verifying that the blob exists
// in object storage, it validates:
//  1. The actual blob size matches the declared size.
//  2. The SHA-256 hash of the blob content matches the declared OID.
//
// If either check fails, the orphaned blob is deleted and a 422 is returned.
func (s *LFSService) ConfirmUpload(ctx context.Context, actor *db.User, owner, repo string, input LFSConfirmUploadInput) (db.LfsObject, error) {
	if err := validateLFSScopedPath(ctx, owner, repo, lfsauth.OperationUpload, true); err != nil {
		return db.LfsObject{}, err
	}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.LfsObject{}, err
	}
	// Match Batch: a caller that cannot see a private repository receives the
	// same 404 as for a missing one, so verify never confirms its existence.
	_, scoped := lfsauth.ClaimsFromContext(ctx)
	if !repository.IsPublic && !scoped && actor != nil {
		if err := s.requireReadAccess(ctx, repository, actor); err != nil {
			return db.LfsObject{}, hidePrivateLFSRepository(repository, err)
		}
	}
	if err := enforceLFSRepositoryRestriction(ctx, repository.ID); err != nil {
		return db.LfsObject{}, hidePrivateLFSRepository(repository, err)
	}
	if err := s.requireLFSScopedOrWriteAccess(ctx, repository, actor, lfsauth.OperationUpload); err != nil {
		if scoped {
			return db.LfsObject{}, hidePrivateLFSRepository(repository, err)
		}
		return db.LfsObject{}, err
	}
	oid, size, err := validateLFSObjectInput(LFSObjectInput(input))
	if err != nil {
		return db.LfsObject{}, err
	}
	if claims, ok := lfsauth.ClaimsFromContext(ctx); ok && claims.Purpose == lfsauth.PurposeVerify {
		if claims.OID != oid || claims.Size != size {
			return db.LfsObject{}, pkgerrors.Forbidden("lfs verify credential does not authorize this object")
		}
	}
	return s.confirmUploadForRepository(ctx, repository, oid, size)
}

// confirmUploadForRepository is shared by the standard Git LFS verify action
// and Batch's recovery of an uploaded-but-unregistered object. The caller must
// already have resolved the repository and enforced write access.
func (s *LFSService) confirmUploadForRepository(ctx context.Context, repository db.Repository, oid string, size int64) (db.LfsObject, error) {
	key := lfsObjectKey(repository.ID, oid)
	pendingKey := lfsPendingObjectKey(repository.ID, oid)
	stagedUploads := s.usesStagedLFSUploads()

	// A verify request is idempotent. A row can also predate a replacement
	// upload when its blob was lost; validate the registered path, but never
	// charge its already-accounted-for bytes a second time.
	existing, lookupErr := s.queries.GetLFSObjectByOID(ctx, db.GetLFSObjectByOIDParams{RepositoryID: repository.ID, Oid: oid})
	if lookupErr == nil {
		if existing.Size != size {
			return db.LfsObject{}, pkgerrors.UnprocessableEntity(fmt.Sprintf(
				"blob size mismatch: registered object is %d bytes but verify declared %d bytes", existing.Size, size,
			))
		}
		exists, err := s.blobs.Exists(ctx, existing.GcsPath)
		if err != nil {
			return db.LfsObject{}, pkgerrors.Internal("failed to check blob existence").WithCause(err)
		}
		if exists {
			if err := s.validateUploadedBlob(ctx, existing.GcsPath, oid, existing.Size); err != nil {
				if isLFSIntegrityError(err) {
					if deleteErr := s.blobs.Delete(ctx, existing.GcsPath); deleteErr == nil {
						s.consumeLFSUploadReservation(ctx, repository.ID, oid)
					}
				}
				return db.LfsObject{}, err
			}
			s.consumeLFSUploadReservation(ctx, repository.ID, oid)
			return existing, nil
		}
		if !stagedUploads {
			return db.LfsObject{}, pkgerrors.BadRequest("blob does not exist")
		}
		if err := s.validateUploadedBlob(ctx, pendingKey, oid, existing.Size); err != nil {
			if isLFSIntegrityError(err) {
				if deleteErr := s.blobs.Delete(ctx, pendingKey); deleteErr == nil {
					s.releaseLFSUploadReservation(ctx, repository.ID, oid)
				}
			}
			return db.LfsObject{}, err
		}
		if err := s.promoteLFSUpload(ctx, pendingKey, existing.GcsPath, oid, existing.Size); err != nil {
			return db.LfsObject{}, err
		}
		// DeleteObject may have removed the metadata while promotion was in
		// flight. Never leave a promoted object behind without its original row.
		current, err := s.queries.GetLFSObjectByOID(ctx, db.GetLFSObjectByOIDParams{RepositoryID: repository.ID, Oid: oid})
		if stdErrors.Is(err, pgx.ErrNoRows) {
			_ = s.blobs.Delete(ctx, existing.GcsPath)
			return db.LfsObject{}, pkgerrors.Conflict("lfs object changed during upload verification")
		}
		if err != nil {
			// A transient read does not prove the promoted object is orphaned. The
			// original row may still be live, so preserve both authoritative bytes
			// and metadata for a later idempotent retry.
			return db.LfsObject{}, pkgerrors.Internal("failed to recheck lfs object").WithCause(err)
		}
		if current.ID != existing.ID {
			// LFS uses a deterministic final key per repository/OID. A replacement
			// row may already own the same valid content; never delete a key that a
			// known current row still references.
			if current.GcsPath == existing.GcsPath && current.Size == existing.Size {
				s.consumeLFSUploadReservation(ctx, repository.ID, oid)
				return current, nil
			}
			if current.GcsPath != existing.GcsPath {
				_ = s.blobs.Delete(ctx, existing.GcsPath)
			}
			return db.LfsObject{}, pkgerrors.Conflict("lfs object changed during upload verification")
		}
		s.consumeLFSUploadReservation(ctx, repository.ID, oid)
		return existing, nil
	}
	if !stdErrors.Is(lookupErr, pgx.ErrNoRows) {
		return db.LfsObject{}, pkgerrors.Internal("failed to load lfs object")
	}

	// Validate that the blob was actually uploaded and that its size and
	// SHA-256 match the declared values. On an integrity mismatch, delete the
	// orphan so a retry can obtain a fresh create-only URL. Do not delete on a
	// transient reader failure: a concurrent verifier may already be adopting
	// the same valid object.
	uploadKey := key
	staged := false
	if stagedUploads {
		finalExists, err := s.blobs.Exists(ctx, key)
		if err != nil {
			return db.LfsObject{}, pkgerrors.Internal("failed to check blob existence").WithCause(err)
		}
		if !finalExists {
			uploadKey = pendingKey
			staged = true
		}
	}
	if err := s.validateUploadedBlob(ctx, uploadKey, oid, size); err != nil {
		if isLFSIntegrityError(err) {
			if deleteErr := s.blobs.Delete(ctx, uploadKey); deleteErr != nil {
				// A create-only replacement cannot use this deterministic key until
				// the invalid generation is actually gone. Preserve the metered
				// reservation and surface cleanup failure instead of returning a 422
				// that makes Batch sign an unusable replacement URL.
				return db.LfsObject{}, pkgerrors.Internal("failed to remove invalid lfs upload").WithCause(deleteErr)
			}
			// Keep the reservation: Batch already admitted these bytes and will
			// issue a replacement capability without another reservation pass.
		}
		return db.LfsObject{}, err
	}
	var obj db.LfsObject
	alreadyRegistered := false
	resolveAdditionalBytes := func(ctx context.Context) (int64, error) {
		// This callback runs under BillingService's per-owner storage lock.
		// Re-check the row here so two concurrent verify requests for the
		// same uploaded object do not both count +size against the quota.
		existing, err := s.queries.GetLFSObjectByOID(ctx, db.GetLFSObjectByOIDParams{RepositoryID: repository.ID, Oid: oid})
		if err == nil {
			if existing.Size != size {
				return 0, pkgerrors.UnprocessableEntity("registered lfs object size does not match upload")
			}
			if err := s.validateUploadedBlob(ctx, existing.GcsPath, oid, existing.Size); err != nil {
				return 0, err
			}
			obj = existing
			alreadyRegistered = true
			return 0, nil
		}
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			return 0, pkgerrors.Internal("failed to load lfs object")
		}
		reservation, reservationErr := s.queries.GetLFSUploadReservation(ctx, db.GetLFSUploadReservationParams{
			RepositoryID: repository.ID,
			Oid:          oid,
		})
		if reservationErr == nil {
			if reservation.Size != size {
				return 0, pkgerrors.UnprocessableEntity("lfs upload reservation size does not match upload")
			}
			// These bytes already count in SumStorageBytesByOwner. Persist will
			// atomically replace the reservation with authoritative metadata
			// while the same owner advisory lock remains held.
			return 0, nil
		}
		if !stdErrors.Is(reservationErr, pgx.ErrNoRows) {
			return 0, pkgerrors.Internal("failed to load lfs upload reservation")
		}
		return size, nil
	}
	persist := func(ctx context.Context) error {
		if alreadyRegistered {
			s.consumeLFSUploadReservation(ctx, repository.ID, oid)
			return nil
		}
		created, err := s.queries.CreateLFSObject(ctx, db.CreateLFSObjectParams{RepositoryID: repository.ID, Oid: oid, Size: size, GcsPath: key})
		if err == nil {
			if staged {
				if err := s.promoteLFSUpload(ctx, pendingKey, key, oid, size); err != nil {
					_, _ = s.queries.DeleteLFSObject(ctx, db.DeleteLFSObjectParams{ID: created.ID, RepositoryID: repository.ID, Oid: oid})
					return err
				}
				// A concurrent DeleteObject can remove the just-created row while
				// promotion runs. Recheck identity and remove the promoted blob if
				// the row is gone, avoiding a permanent final-key orphan.
				current, currentErr := s.queries.GetLFSObjectByOID(ctx, db.GetLFSObjectByOIDParams{RepositoryID: repository.ID, Oid: oid})
				if stdErrors.Is(currentErr, pgx.ErrNoRows) {
					_ = s.blobs.Delete(ctx, key)
					return pkgerrors.Conflict("lfs object changed during upload verification")
				}
				if currentErr != nil {
					return pkgerrors.Internal("failed to recheck lfs object").WithCause(currentErr)
				}
				if current.ID != created.ID {
					return pkgerrors.Conflict("lfs object changed during upload verification")
				}
				s.consumeLFSUploadReservation(ctx, repository.ID, oid)
				obj = created
				return nil
			}
			// Re-verify the blob still exists after winning the row write. A
			// concurrent DeleteObject removes the blob before the metadata row,
			// so it may have deleted both between our validation read above and
			// this insert; without this check the insert would resurrect
			// metadata for a blob that no longer exists. Because DeleteObject
			// removes the blob first, any delete that starts after this check
			// passes will also see and remove our row.
			exists, ee := s.blobs.Exists(ctx, key)
			if ee != nil {
				_, _ = s.queries.DeleteLFSObject(ctx, db.DeleteLFSObjectParams{ID: created.ID, RepositoryID: repository.ID, Oid: oid})
				return pkgerrors.Internal("failed to verify uploaded blob").WithCause(ee)
			}
			if !exists {
				_, _ = s.queries.DeleteLFSObject(ctx, db.DeleteLFSObjectParams{ID: created.ID, RepositoryID: repository.ID, Oid: oid})
				return pkgerrors.BadRequest("blob does not exist")
			}
			obj = created
			s.releaseLFSUploadReservation(ctx, repository.ID, oid)
			return nil
		}
		if isUniqueViolation(err) {
			existing, ge := s.queries.GetLFSObjectByOID(ctx, db.GetLFSObjectByOIDParams{RepositoryID: repository.ID, Oid: oid})
			if ge == nil {
				if existing.Size != size {
					return pkgerrors.UnprocessableEntity("registered lfs object size does not match upload")
				}
				if ve := s.validateUploadedBlob(ctx, existing.GcsPath, oid, existing.Size); ve != nil {
					return ve
				}
				s.consumeLFSUploadReservation(ctx, repository.ID, oid)
				obj = existing
				return nil
			}
		}
		return pkgerrors.Internal("failed to persist lfs object")
	}
	// Meter the new bytes and persist the metadata row under the per-owner
	// storage lock so concurrent confirms cannot overdraw the cap (issue 136).
	if err := authorizeStorageIncreaseThenCommitDynamic(ctx, s.billing, repository.ID, resolveAdditionalBytes, persist); err != nil {
		s.reconcileRejectedLFSUpload(ctx, repository.ID, oid, uploadKey, staged)
		return db.LfsObject{}, err
	}
	return obj, nil
}

func (s *LFSService) usesStagedLFSUploads() bool {
	_, ok := s.blobs.(blob.CreateOnlyPromoter)
	return ok
}

// reserveLFSUploadCapacity persists an expiring capability reservation and
// signs URLs for reservations proven new while the same per-owner advisory
// lock remains held. Existing reservations are never eligible for immediate
// signer-failure rollback because an older capability may still be live for
// their deterministic LFS keys.
func (s *LFSService) reserveLFSUploadCapacity(ctx context.Context, repositoryID int64, objectSizes map[string]int64) (map[string]blob.SignedUpload, error) {
	preSigned := make(map[string]blob.SignedUpload)
	if s.billing == nil || len(objectSizes) == 0 {
		return preSigned, nil
	}
	oids := make([]string, 0, len(objectSizes))
	for oid := range objectSizes {
		oids = append(oids, oid)
	}
	sort.Strings(oids)
	// Use the provider ceiling, not this process's current configured expiry.
	// Older processes may have issued a longer-lived URL for the same
	// deterministic pending key; a config-lowering restart must neither shorten
	// that reservation nor purge bytes while the older capability is live.
	expiresAt := time.Now().UTC().Add(blob.MaxSignedURLExpiry + lfsVerifyContinuationGrace + lfsReservationCleanupGrace)
	freshReservations := make(map[string]bool, len(oids))
	reservationRows := make(map[string]db.LfsUploadReservation, len(oids))

	resolveAdditionalBytes := func(ctx context.Context) (int64, error) {
		// Production BillingService invokes this callback while holding the
		// owner's storage advisory lock. Cleanup and refresh therefore serialize
		// with every Batch/Confirm for any repository owned by the same account.
		if err := s.cleanupExpiredLFSUploadReservations(ctx, repositoryID, objectSizes); err != nil {
			return 0, err
		}
		var additionalBytes int64
		for _, oid := range oids {
			freshReservations[oid] = false
			size := objectSizes[oid]
			reservation, err := s.queries.GetLFSUploadReservation(ctx, db.GetLFSUploadReservationParams{
				RepositoryID: repositoryID,
				Oid:          oid,
			})
			if err == nil {
				if reservation.Size != size {
					return 0, pkgerrors.UnprocessableEntity("lfs upload reservation size does not match batch object")
				}
				continue
			}
			if !stdErrors.Is(err, pgx.ErrNoRows) {
				return 0, pkgerrors.Internal("failed to load lfs upload reservation")
			}
			freshReservations[oid] = true
			if allocationStore, ok := s.queries.(lfsStorageDeletionAllocationQuerier); ok {
				queued, queueErr := allocationStore.HasStorageDeletionAllocation(ctx, runtimeports.HasStorageDeletionAllocationParams{
					RepositoryID:  repositoryID,
					AllocationKey: lfsStorageAllocationKey(repositoryID, oid),
				})
				if queueErr != nil {
					return 0, pkgerrors.Internal("failed to load lfs deletion allocation").WithCause(queueErr)
				}
				if queued {
					// The tombstone already accounts for these exact bytes. The
					// reservation upsert below deletes that allocation under its row
					// lock, replacing it without a transient double charge.
					continue
				}
			}
			if size > math.MaxInt64-additionalBytes {
				return 0, pkgerrors.UnprocessableEntity("batch object sizes exceed the supported range")
			}
			additionalBytes += size
		}
		return additionalBytes, nil
	}
	persist := func(ctx context.Context) error {
		for _, oid := range oids {
			reservation, err := s.queries.UpsertLFSUploadReservation(ctx, db.UpsertLFSUploadReservationParams{
				RepositoryID: repositoryID,
				Oid:          oid,
				Size:         objectSizes[oid],
				ExpiresAt:    expiresAt,
			})
			if err != nil {
				return pkgerrors.Internal("failed to reserve lfs upload storage").WithCause(err)
			}
			reservationRows[oid] = reservation
		}

		// Check every fresh deterministic key before signing any of them. A live
		// object proves an older capability may exist, so that reservation remains
		// metered and is handled by the normal adoption path instead.
		eligible := make([]string, 0, len(freshReservations))
		for _, oid := range oids {
			if !freshReservations[oid] {
				continue
			}
			finalExists, existsErr := s.blobs.Exists(ctx, lfsObjectKey(repositoryID, oid))
			if existsErr != nil {
				return pkgerrors.Internal("failed to check lfs object before signing").WithCause(existsErr)
			}
			pendingExists, existsErr := s.blobs.Exists(ctx, lfsPendingObjectKey(repositoryID, oid))
			if existsErr != nil {
				return pkgerrors.Internal("failed to check staged lfs object before signing").WithCause(existsErr)
			}
			if !finalExists && !pendingExists {
				eligible = append(eligible, oid)
			}
		}

		for _, oid := range eligible {
			upload, signErr := blob.SignedCreateOnlyUpload(
				ctx,
				s.blobs,
				s.lfsUploadObjectKey(repositoryID, oid),
				"application/octet-stream",
				objectSizes[oid],
				s.signedURLExpiry,
			)
			if signErr != nil {
				s.rollbackUnissuedLFSReservations(ctx, repositoryID, eligible, reservationRows)
				return pkgerrors.Internal("failed to create upload url").WithCause(signErr)
			}
			preSigned[oid] = upload
		}
		return nil
	}
	if err := authorizeStorageIncreaseThenCommitDynamic(ctx, s.billing, repositoryID, resolveAdditionalBytes, persist); err != nil {
		return nil, err
	}
	return preSigned, nil
}

func (s *LFSService) rollbackUnissuedLFSReservations(
	ctx context.Context,
	repositoryID int64,
	oids []string,
	reservations map[string]db.LfsUploadReservation,
) {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), lfsSignerRollbackTimeout)
	defer cancel()

	for _, oid := range oids {
		reservation, ok := reservations[oid]
		if !ok {
			continue
		}
		finalKey := lfsObjectKey(repositoryID, oid)
		pendingKey := lfsPendingObjectKey(repositoryID, oid)
		keys := []string{finalKey, pendingKey}
		purged := true
		for _, key := range keys {
			if err := blob.PurgeAllGenerations(cleanupCtx, s.blobs, key); err != nil && !stdErrors.Is(err, blob.ErrObjectNotFound) {
				purged = false
				slog.Warn("lfs signer rollback object purge failed", "repository_id", repositoryID, "oid", oid, "object_key", key, "error", err)
				break
			}
		}
		if !purged {
			continue
		}

		deleted, err := s.queries.DeleteUnissuedLFSUploadReservation(cleanupCtx, db.DeleteUnissuedLFSUploadReservationParams{
			RepositoryID: repositoryID,
			Oid:          oid,
			Size:         reservation.Size,
			ExpiresAt:    reservation.ExpiresAt,
			CreatedAt:    reservation.CreatedAt,
			UpdatedAt:    reservation.UpdatedAt,
		})
		if err != nil || deleted != 1 {
			if err != nil {
				slog.Warn("lfs unissued reservation cleanup failed", "repository_id", repositoryID, "oid", oid, "error", err)
			}
			continue
		}
		if err := clearPurgedStorageDeletionKeys(
			cleanupCtx,
			s.queries,
			repositoryID,
			lfsStorageAllocationKey(repositoryID, oid),
			finalKey,
			pendingKey,
		); err != nil {
			slog.Warn("lfs purged deletion fence cleanup failed", "repository_id", repositoryID, "oid", oid, "error", err)
		}
	}
}

// cleanupExpiredLFSUploadReservations reclaims expired reservations owned by
// the same billing account as repositoryID. Requested objects are protected:
// an existing same-size row is refreshed and remains counted, avoiding a
// delete-versus-new-upload race. For every other row, quota is released only
// after its unregistered upload object is known deleted. Failures deliberately
// retain the row, which may over-count storage but can never under-count it.
func (s *LFSService) cleanupExpiredLFSUploadReservations(ctx context.Context, repositoryID int64, requestedObjectSizes map[string]int64) error {
	reservations, err := s.queries.ListExpiredLFSUploadReservationsByOwner(ctx, repositoryID)
	if err != nil {
		return pkgerrors.Internal("failed to list expired lfs upload reservations").WithCause(err)
	}
	for _, reservation := range reservations {
		if reservation.RepositoryID == repositoryID {
			if _, requested := requestedObjectSizes[reservation.Oid]; requested {
				continue
			}
		}

		_, objectErr := s.queries.GetLFSObjectByOID(ctx, db.GetLFSObjectByOIDParams{
			RepositoryID: reservation.RepositoryID,
			Oid:          reservation.Oid,
		})
		switch {
		case objectErr == nil:
			// A staged retry can coexist briefly with authoritative metadata.
			// Remove that duplicate before dropping the reservation that accounts
			// for it. Direct-upload stores use the authoritative final key and must
			// not delete it here.
			if s.usesStagedLFSUploads() {
				if err := s.blobs.Delete(ctx, lfsPendingObjectKey(reservation.RepositoryID, reservation.Oid)); err != nil {
					continue
				}
			}
		case stdErrors.Is(objectErr, pgx.ErrNoRows):
			if err := s.blobs.Delete(ctx, s.lfsUploadObjectKey(reservation.RepositoryID, reservation.Oid)); err != nil {
				continue
			}
		default:
			continue
		}

		// The expiry predicate prevents a concurrent refresh from being removed
		// even in a test/development policy that does not provide owner locking.
		_, _ = s.queries.DeleteExpiredLFSUploadReservation(ctx, db.DeleteExpiredLFSUploadReservationParams{
			RepositoryID: reservation.RepositoryID,
			Oid:          reservation.Oid,
		})
	}
	return nil
}

func (s *LFSService) lfsUploadObjectKey(repositoryID int64, oid string) string {
	if s.usesStagedLFSUploads() {
		return lfsPendingObjectKey(repositoryID, oid)
	}
	return lfsObjectKey(repositoryID, oid)
}

func (s *LFSService) promoteLFSUpload(ctx context.Context, sourceKey, destinationKey, oid string, size int64) error {
	promoter, ok := s.blobs.(blob.CreateOnlyPromoter)
	if !ok {
		return pkgerrors.Internal("blob store does not support staged lfs uploads")
	}
	if err := promoter.PromoteCreateOnly(ctx, sourceKey, destinationKey); err != nil && !stdErrors.Is(err, blob.ErrObjectAlreadyExists) {
		if stdErrors.Is(err, blob.ErrObjectNotFound) {
			return pkgerrors.BadRequest("blob does not exist")
		}
		return pkgerrors.Internal("failed to promote lfs upload").WithCause(err)
	}
	if err := s.validateUploadedBlob(ctx, destinationKey, oid, size); err != nil {
		if isLFSIntegrityError(err) {
			_ = s.blobs.Delete(ctx, destinationKey)
		}
		return err
	}
	return nil
}

func (s *LFSService) releaseLFSUploadReservation(ctx context.Context, repositoryID int64, oid string) {
	_ = s.queries.DeleteLFSUploadReservation(ctx, db.DeleteLFSUploadReservationParams{
		RepositoryID: repositoryID,
		Oid:          oid,
	})
}

// consumeLFSUploadReservation replaces a reservation with authoritative
// metadata only after every staged generation at the deterministic pending key
// is confirmed deleted. GCSStore's pending delete is a hard all-generations
// purge, so a versioned bucket cannot hide archived bytes from billing. Any
// cleanup or DB error retains the reservation and therefore fails safe by
// over-counting rather than under-counting physical storage.
func (s *LFSService) consumeLFSUploadReservation(ctx context.Context, repositoryID int64, oid string) bool {
	if s.usesStagedLFSUploads() {
		if err := s.blobs.Delete(ctx, lfsPendingObjectKey(repositoryID, oid)); err != nil {
			return false
		}
	}
	if err := s.queries.DeleteLFSUploadReservation(ctx, db.DeleteLFSUploadReservationParams{
		RepositoryID: repositoryID,
		Oid:          oid,
	}); err != nil {
		return false
	}
	return true
}

// reconcileRejectedLFSUpload releases quota only after the bytes either became
// authoritative metadata or were successfully removed. If cleanup itself
// fails, retaining the expiring reservation is the safe failure mode: physical
// pending bytes remain counted until the DB and bucket lifecycles recover.
func (s *LFSService) reconcileRejectedLFSUpload(ctx context.Context, repositoryID int64, oid, uploadKey string, staged bool) {
	_, lookupErr := s.queries.GetLFSObjectByOID(ctx, db.GetLFSObjectByOIDParams{RepositoryID: repositoryID, Oid: oid})
	if lookupErr == nil {
		s.consumeLFSUploadReservation(ctx, repositoryID, oid)
		return
	}
	if !stdErrors.Is(lookupErr, pgx.ErrNoRows) {
		return
	}
	if err := s.blobs.Delete(ctx, uploadKey); err == nil {
		s.releaseLFSUploadReservation(ctx, repositoryID, oid)
	}
}

func isLFSIntegrityError(err error) bool {
	var apiErr *pkgerrors.APIError
	return stdErrors.As(err, &apiErr) && apiErr.Status == 422
}

// lfsUploadActions couples every upload action with the standard Git LFS
// verify action. Git LFS posts {oid,size} to this callback only after the PUT
// succeeds. The callback URL is built solely from trusted server
// configuration, never request headers.
func (s *LFSService) lfsUploadActions(ctx context.Context, repositoryID int64, owner, repo, oid string, size int64, upload blob.SignedUpload) (map[string]LFSBatchActionLink, error) {
	verifyHref, err := s.lfsVerifyHref(owner, repo)
	if err != nil {
		return nil, err
	}
	verify := LFSBatchActionLink{Href: verifyHref}
	// An SSH git-lfs-authenticate credential is deliberately not a general PAT,
	// and may expire while a large direct-to-storage PUT is still running. Mint
	// a longer-lived continuation capability bound to this exact verify payload;
	// never extend or echo the broad repository upload credential.
	if claims, ok := lfsauth.ClaimsFromContext(ctx); ok {
		if claims.Purpose != lfsauth.PurposeBridge || claims.Operation != lfsauth.OperationUpload {
			return nil, pkgerrors.Forbidden("lfs credential cannot issue upload actions")
		}
		if s.verifyTokens == nil {
			return nil, pkgerrors.Internal("lfs verify credentials are not configured")
		}
		token, _, err := s.verifyTokens.IssueVerify(lfsauth.VerifyGrant{
			RepositoryID: repositoryID,
			Owner:        owner,
			Repository:   repo,
			OID:          oid,
			Size:         size,
			Principal:    claims.Principal,
		}, s.verifyTokenTTL)
		if err != nil {
			return nil, pkgerrors.Internal("failed to issue lfs verify credential").WithCause(err)
		}
		verify.Header = map[string]string{"Authorization": lfsauth.AuthorizationValue(token)}
	}
	return map[string]LFSBatchActionLink{
		"upload": {Href: upload.URL, Header: upload.Header},
		"verify": verify,
	}, nil
}

func (s *LFSService) lfsVerifyHref(owner, repo string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(s.verifyBaseURL), "/")
	if base == "" {
		return "", pkgerrors.Internal("lfs verify base url is not configured")
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", pkgerrors.Internal("lfs verify base url is invalid")
	}
	return base + "/api/repos/" + url.PathEscape(strings.ToLower(strings.TrimSpace(owner))) + "/" +
		url.PathEscape(strings.ToLower(strings.TrimSpace(repo))) + "/lfs/verify", nil
}

// validateUploadedBlob opens the blob at key, streams its content, and
// verifies that the actual byte count equals declaredSize and that the
// SHA-256 digest (hex-encoded) matches the oid.  Returns a 422-class error on
// any mismatch and a 400-class error when the blob does not exist yet.
func (s *LFSService) validateUploadedBlob(ctx context.Context, key, oid string, declaredSize int64) error {
	r, err := s.blobs.NewReader(ctx, key)
	if stdErrors.Is(err, blob.ErrObjectNotFound) {
		return pkgerrors.BadRequest("blob does not exist")
	}
	if err != nil {
		return pkgerrors.Internal("failed to verify uploaded blob").WithCause(err)
	}
	defer func() { _ = r.Close() }()

	h := sha256.New()
	n, err := io.Copy(h, r)
	if err != nil {
		return pkgerrors.Internal("failed to read blob for verification").WithCause(err)
	}
	if n != declaredSize {
		return pkgerrors.UnprocessableEntity(fmt.Sprintf(
			"blob size mismatch: declared %d bytes but blob is %d bytes", declaredSize, n,
		))
	}
	actualOID := fmt.Sprintf("%x", h.Sum(nil))
	if actualOID != oid {
		return pkgerrors.UnprocessableEntity(fmt.Sprintf(
			"blob integrity check failed: oid %s does not match sha256 of uploaded content", oid,
		))
	}
	return nil
}

func (s *LFSService) DeleteObject(ctx context.Context, actor *db.User, owner, repo, oid string) error {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err := enforceLFSRepositoryRestriction(ctx, repository.ID); err != nil {
		return err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return err
	}
	norm, err := validateLFSOID(oid)
	if err != nil {
		return err
	}
	obj, err := s.queries.GetLFSObjectByOID(ctx, db.GetLFSObjectByOIDParams{RepositoryID: repository.ID, Oid: norm})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("lfs object not found")
		}
		return pkgerrors.Internal("failed to load lfs object").WithCause(err)
	}
	// Serialize deletion with Batch reservations and verify finalization under
	// the owner's storage lock. Without this fence, a verifier can create a new
	// row and promote a replacement between the two blob sweeps below, after
	// which the delete would remove the new row's bytes while reporting success.
	resolveAdditionalBytes := func(lockCtx context.Context) (int64, error) {
		current, getErr := s.queries.GetLFSObjectByOID(lockCtx, db.GetLFSObjectByOIDParams{
			RepositoryID: repository.ID,
			Oid:          norm,
		})
		if getErr != nil {
			if stdErrors.Is(getErr, pgx.ErrNoRows) {
				return 0, pkgerrors.NotFound("lfs object not found")
			}
			return 0, pkgerrors.Internal("failed to load lfs object").WithCause(getErr)
		}
		if current.ID != obj.ID || current.GcsPath != obj.GcsPath || current.Size != obj.Size {
			return 0, pkgerrors.Conflict("lfs object changed during deletion")
		}
		return 0, nil
	}
	deleteObject := func(lockCtx context.Context) error {
		if err := s.blobs.Delete(lockCtx, obj.GcsPath); err != nil && !isDeferredOrMissingLFSBlobDelete(err) {
			return pkgerrors.Internal("failed to delete lfs object blob").WithCause(err)
		}
		deleted, err := s.queries.DeleteLFSObject(lockCtx, db.DeleteLFSObjectParams{
			ID:           obj.ID,
			RepositoryID: repository.ID,
			Oid:          norm,
		})
		if err != nil {
			return pkgerrors.Internal("failed to delete lfs object").WithCause(err)
		}
		if deleted != 1 {
			return pkgerrors.Conflict("lfs object changed during deletion")
		}
		// Delete the final key again after the exact metadata CAS. A verifier
		// that began before this lock may have promoted while the row was live;
		// one that begins afterward cannot finalize until this callback returns.
		if err := s.blobs.Delete(lockCtx, obj.GcsPath); err != nil && !isDeferredOrMissingLFSBlobDelete(err) {
			// Retain any reservation on failure so a physical orphan remains
			// conservatively metered until a later cleanup attempt.
			return pkgerrors.Internal("failed to finalize lfs object blob deletion").WithCause(err)
		}
		s.consumeLFSUploadReservation(lockCtx, repository.ID, norm)
		return nil
	}
	return authorizeStorageIncreaseThenCommitDynamic(ctx, s.billing, repository.ID, resolveAdditionalBytes, deleteObject)
}

func isDeferredOrMissingLFSBlobDelete(err error) bool {
	// Deleting the metadata row durably enqueues both the final and staged keys.
	// A closed legacy-capability fence therefore defers physical cleanup without
	// invalidating the user-visible delete, while the queue keeps the bytes
	// conservatively metered until its purge can run. Missing blobs are already
	// in the requested state and make both delete passes idempotent.
	return stdErrors.Is(err, blob.ErrLegacyFinalKeyPurgeFenced) ||
		stdErrors.Is(err, blob.ErrObjectNotFound)
}

func (s *LFSService) ListObjects(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.LfsObject, int64, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, 0, err
	}
	if err := enforceLFSRepositoryRestriction(ctx, repository.ID); err != nil {
		return nil, 0, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return nil, 0, err
	}
	pageSize, pageOffset, _, _ := normalizePage(page, perPage)
	total, err := s.queries.CountLFSObjects(ctx, repository.ID)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count lfs objects").WithCause(err)
	}
	rows, err := s.queries.ListLFSObjects(ctx, db.ListLFSObjectsParams{RepositoryID: repository.ID, PageOffset: pageOffset, PageSize: pageSize})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list lfs objects").WithCause(err)
	}
	return rows, total, nil
}

func enforceLFSRepositoryRestriction(ctx context.Context, repositoryID int64) error {
	authInfo := middleware.AuthInfoFromContext(ctx)
	if authInfo == nil {
		return nil
	}
	if restricted := authInfo.RepositoryRestriction(); restricted != 0 && restricted != repositoryID {
		return pkgerrors.Forbidden("repository-bound token cannot access resources outside its repository")
	}
	return nil
}

// hidePrivateLFSRepository converts an authorization failure on a private
// repository into the not-found response a missing repository produces.
func hidePrivateLFSRepository(repository db.Repository, err error) error {
	if apiErr, ok := err.(*pkgerrors.APIError); ok && apiErr.Status == 403 && !repository.IsPublic {
		return pkgerrors.NotFound("repository not found")
	}
	return err
}

func (s *LFSService) resolveRepoByOwnerAndName(ctx context.Context, owner, repo string) (db.Repository, error) {
	lowerOwner := strings.ToLower(strings.TrimSpace(owner))
	lowerRepo := strings.ToLower(strings.TrimSpace(repo))
	if lowerOwner == "" {
		return db.Repository{}, pkgerrors.BadRequest("owner is required")
	}
	if lowerRepo == "" {
		return db.Repository{}, pkgerrors.BadRequest("repository name is required")
	}
	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: lowerOwner, LowerName: lowerRepo})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, pkgerrors.NotFound("repository not found")
		}
		return db.Repository{}, pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	return repository, nil
}

func (s *LFSService) requireReadAccess(ctx context.Context, repository db.Repository, viewer *db.User) error {
	if repository.IsPublic {
		return nil
	}
	if viewer == nil {
		return pkgerrors.Forbidden("permission denied")
	}
	ok, err := s.canReadRepo(ctx, repository, viewer.ID)
	if err != nil {
		return err
	}
	if !ok {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *LFSService) requireLFSScopedOrReadAccess(ctx context.Context, repository db.Repository, viewer *db.User, operation lfsauth.Operation) error {
	if claims, ok := lfsauth.ClaimsFromContext(ctx); ok {
		if claims.RepositoryID != repository.ID || claims.Operation != operation {
			return pkgerrors.Forbidden("lfs credential does not authorize this repository operation")
		}
		return nil
	}
	return s.requireReadAccess(ctx, repository, viewer)
}

func (s *LFSService) requireLFSScopedOrWriteAccess(ctx context.Context, repository db.Repository, actor *db.User, operation lfsauth.Operation) error {
	if claims, ok := lfsauth.ClaimsFromContext(ctx); ok {
		if claims.RepositoryID != repository.ID || claims.Operation != operation {
			return pkgerrors.Forbidden("lfs credential does not authorize this repository operation")
		}
		return nil
	}
	return s.requireWriteAccess(ctx, repository, actor)
}

func validateLFSScopedPath(ctx context.Context, owner, repo string, operation lfsauth.Operation, allowVerify bool) error {
	claims, ok := lfsauth.ClaimsFromContext(ctx)
	if !ok {
		return nil
	}
	if claims.Purpose == lfsauth.PurposeVerify && !allowVerify {
		return pkgerrors.Forbidden("lfs verify credential cannot authorize this operation")
	}
	owner = strings.ToLower(strings.TrimSpace(owner))
	repo = strings.ToLower(strings.TrimSpace(repo))
	if claims.Owner != owner || claims.Repository != repo || claims.Operation != operation {
		return pkgerrors.Forbidden("lfs credential does not authorize this repository operation")
	}
	return nil
}

func (s *LFSService) requireWriteAccess(ctx context.Context, repository db.Repository, actor *db.User) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	ok, err := s.canWriteRepo(ctx, repository, actor.ID)
	if err != nil {
		return err
	}
	if !ok {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *LFSService) canReadRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canReadRepo(ctx, s.queries, repository, userID)
}

func (s *LFSService) canWriteRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canWriteRepo(ctx, s.queries, repository, userID)
}

func validateLFSObjectInput(input LFSObjectInput) (string, int64, error) {
	oid, err := validateLFSOID(input.Oid)
	if err != nil {
		return "", 0, err
	}
	if input.Size < 0 {
		return "", 0, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LFSObject", Field: "size", Code: "invalid"})
	}
	if input.Size > maxLFSObjectSize {
		return "", 0, pkgerrors.RequestEntityTooLarge(fmt.Sprintf("lfs object exceeds the %d byte size limit", maxLFSObjectSize))
	}
	return oid, input.Size, nil
}

func validateLFSOID(raw string) (string, error) {
	oid := strings.ToLower(strings.TrimSpace(raw))
	if len(oid) != 64 {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LFSObject", Field: "oid", Code: "invalid"})
	}
	for _, ch := range oid {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LFSObject", Field: "oid", Code: "invalid"})
		}
	}
	return oid, nil
}

func lfsObjectKey(repositoryID int64, oid string) string {
	return "repos/" + strconv.FormatInt(repositoryID, 10) + "/lfs/" + oid
}

func lfsPendingObjectKey(repositoryID int64, oid string) string {
	return "lfs-pending/" + strconv.FormatInt(repositoryID, 10) + "/" + oid
}
