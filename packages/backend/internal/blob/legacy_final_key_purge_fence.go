package blob

import (
	"context"
	"errors"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/buildcache"
	"io"
	"strconv"
	"strings"
	"time"
)

// ErrLegacyFinalKeyPurgeFenced means final-key deletion is intentionally
// disabled until the persisted legacy upload-capability horizon has passed.
var ErrLegacyFinalKeyPurgeFenced = errors.New("legacy final-key upload capability horizon has not passed")

// LegacyFinalKeyPurgeGate returns true only after the operator-attested
// absolute horizon for capabilities issued by former signers has passed.
type LegacyFinalKeyPurgeGate func(context.Context) (bool, error)

// LegacyFinalKeyPurgeFencedStore transparently preserves the production GCS
// store's create-only upload/promotion features while guarding physical purges
// of legacy client-upload names. Staging and server-only cache keys remain purgeable.
type LegacyFinalKeyPurgeFencedStore struct {
	store    Store
	signer   CreateOnlyUploadSigner
	promoter CreateOnlyPromoter
	purger   GenerationPurger
	gate     LegacyFinalKeyPurgeGate
}

// NewLegacyFinalKeyPurgeFencedStore wraps a production-capable store. The
// wrapper is intentionally rejected for stores lacking create-only/purge
// support so wrapping cannot silently alter upload safety semantics.
func NewLegacyFinalKeyPurgeFencedStore(store Store, gate LegacyFinalKeyPurgeGate) (*LegacyFinalKeyPurgeFencedStore, error) {
	if store == nil || gate == nil {
		return nil, errors.New("legacy final-key purge fence requires store and gate")
	}
	signer, signerOK := store.(CreateOnlyUploadSigner)
	promoter, promoterOK := store.(CreateOnlyPromoter)
	purger, purgerOK := store.(GenerationPurger)
	if !signerOK || !promoterOK || !purgerOK {
		return nil, errors.New("legacy final-key purge fence requires create-only signing, promotion, and generation purge")
	}
	return &LegacyFinalKeyPurgeFencedStore{
		store: store, signer: signer, promoter: promoter, purger: purger, gate: gate,
	}, nil
}

func (s *LegacyFinalKeyPurgeFencedStore) SignedUploadURL(ctx context.Context, key, contentType string, maxSizeBytes int64, expiry time.Duration) (string, error) {
	return s.store.SignedUploadURL(ctx, key, contentType, maxSizeBytes, expiry)
}

func (s *LegacyFinalKeyPurgeFencedStore) SignedCreateOnlyUploadURL(ctx context.Context, key, contentType string, exactSizeBytes int64, expiry time.Duration) (SignedUpload, error) {
	return s.signer.SignedCreateOnlyUploadURL(ctx, key, contentType, exactSizeBytes, expiry)
}

func (s *LegacyFinalKeyPurgeFencedStore) SignedDownloadURL(ctx context.Context, key string, expiry time.Duration) (string, error) {
	return s.store.SignedDownloadURL(ctx, key, expiry)
}

func (s *LegacyFinalKeyPurgeFencedStore) Delete(ctx context.Context, key string) error {
	if err := s.allowPurge(ctx, key); err != nil {
		return err
	}
	return s.store.Delete(ctx, key)
}

func (s *LegacyFinalKeyPurgeFencedStore) PurgeAllGenerations(ctx context.Context, key string) error {
	if err := s.allowPurge(ctx, key); err != nil {
		return err
	}
	return s.purger.PurgeAllGenerations(ctx, key)
}

func (s *LegacyFinalKeyPurgeFencedStore) PromoteCreateOnly(ctx context.Context, sourceKey, destinationKey string) error {
	return s.promoter.PromoteCreateOnly(ctx, sourceKey, destinationKey)
}

func (s *LegacyFinalKeyPurgeFencedStore) Exists(ctx context.Context, key string) (bool, error) {
	return s.store.Exists(ctx, key)
}

func (s *LegacyFinalKeyPurgeFencedStore) Stat(ctx context.Context, key string) (ObjectAttrs, error) {
	return s.store.Stat(ctx, key)
}

func (s *LegacyFinalKeyPurgeFencedStore) NewReader(ctx context.Context, key string) (io.ReadCloser, error) {
	return s.store.NewReader(ctx, key)
}

// Put forwards server-side writes when the wrapped store supports them.
func (s *LegacyFinalKeyPurgeFencedStore) Put(ctx context.Context, key, contentType string, r io.Reader) error {
	return Put(ctx, s.store, key, contentType, r)
}

func (s *LegacyFinalKeyPurgeFencedStore) allowPurge(ctx context.Context, key string) error {
	if isKnownStagingUploadKey(key) || isServerWrittenBuildCacheKey(key) {
		return nil
	}
	allowed, err := s.gate(ctx)
	if err != nil {
		return fmt.Errorf("check legacy final-key purge horizon: %w", err)
	}
	if !allowed {
		return fmt.Errorf("%w: %s", ErrLegacyFinalKeyPurgeFenced, key)
	}
	return nil
}

// Build-cache artifacts have only ever used verified, server-side Put; no
// legacy signed upload capability can recreate these exact keys after purge.
func isServerWrittenBuildCacheKey(key string) bool {
	parts := strings.Split(key, "/")
	if len(parts) != 3 || parts[0] != "build-cache" || !buildcache.IsHexDigest(parts[2]) {
		return false
	}
	id, err := strconv.ParseInt(parts[1], 10, 64)
	return err == nil && id > 0 && strconv.FormatInt(id, 10) == parts[1]
}

func isKnownStagingUploadKey(key string) bool {
	normalized := strings.TrimLeft(strings.TrimSpace(key), "/")
	for _, prefix := range []string{
		"lfs-pending/",
		"pending/workflow-caches/",
		"pending/workflow-artifacts/",
		"pending/issue-artifacts/",
		"pending/release-assets/",
	} {
		if strings.HasPrefix(normalized, prefix) {
			return true
		}
	}
	return false
}

var _ Store = (*LegacyFinalKeyPurgeFencedStore)(nil)
var _ CreateOnlyUploadSigner = (*LegacyFinalKeyPurgeFencedStore)(nil)
var _ CreateOnlyPromoter = (*LegacyFinalKeyPurgeFencedStore)(nil)
var _ GenerationPurger = (*LegacyFinalKeyPurgeFencedStore)(nil)
