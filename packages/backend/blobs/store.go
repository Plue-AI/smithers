// Package blobs exposes the canonical blob storage contract and integrity policy.
package blobs

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"io"
	"time"
)

type Store = blob.Store

// FilesystemConfig configures the durable local blob store.
type FilesystemConfig = blob.FilesystemConfig
type FilesystemStore = blob.FilesystemStore

// NewFilesystemStore opens a durable filesystem-backed blob store.
func NewFilesystemStore(cfg FilesystemConfig) (*FilesystemStore, error) {
	return blob.NewFilesystemStore(cfg)
}

type ObjectAttrs = blob.ObjectAttrs
type SignedUpload = blob.SignedUpload
type CreateOnlyUploadSigner = blob.CreateOnlyUploadSigner
type CreateOnlyPromoter = blob.CreateOnlyPromoter
type GenerationPurger = blob.GenerationPurger
type Putter = blob.Putter
type AgentLogStore = blob.AgentLogStore
type LegacyFinalKeyPurgeGate = blob.LegacyFinalKeyPurgeGate
type LegacyFinalKeyPurgeFencedStore = blob.LegacyFinalKeyPurgeFencedStore

const DefaultSignedURLExpiry = blob.DefaultSignedURLExpiry
const MaxSignedURLExpiry = blob.MaxSignedURLExpiry
const PendingUploadPrefix = blob.PendingUploadPrefix
const UnknownObjectSize = blob.UnknownObjectSize
const MaxAgentSessionLogBytes = blob.MaxAgentSessionLogBytes

var ErrObjectNotFound = blob.ErrObjectNotFound
var ErrObjectAlreadyExists = blob.ErrObjectAlreadyExists
var ErrLegacyFinalKeyPurgeFenced = blob.ErrLegacyFinalKeyPurgeFenced

func PurgeAllGenerations(ctx context.Context, store Store, key string) error {
	return blob.PurgeAllGenerations(ctx, store, key)
}
func PendingUploadKey(namespace, finalKey string) string {
	return blob.PendingUploadKey(namespace, finalKey)
}
func AgentLogObjectKey(repositoryID int64, sessionID string) string {
	return blob.AgentLogObjectKey(repositoryID, sessionID)
}
func NormalizeSignedURLExpiry(expiry time.Duration) time.Duration {
	return blob.NormalizeSignedURLExpiry(expiry)
}
func ParseSignedURLExpiry(raw string) (time.Duration, error) { return blob.ParseSignedURLExpiry(raw) }
func SignedCreateOnlyUpload(ctx context.Context, store Store, key, contentType string, exactSizeBytes int64, expiry time.Duration) (SignedUpload, error) {
	return blob.SignedCreateOnlyUpload(ctx, store, key, contentType, exactSizeBytes, expiry)
}
func Put(ctx context.Context, store Store, key, contentType string, r io.Reader) error {
	return blob.Put(ctx, store, key, contentType, r)
}
func NewLegacyFinalKeyPurgeFencedStore(store Store, gate LegacyFinalKeyPurgeGate) (*LegacyFinalKeyPurgeFencedStore, error) {
	return blob.NewLegacyFinalKeyPurgeFencedStore(store, gate)
}
