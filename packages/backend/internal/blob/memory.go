package blob

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/url"
	"sync"
	"time"
)

type MemoryStore struct {
	mu      sync.Mutex
	objects map[string]ObjectAttrs
	data    map[string][]byte
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{objects: make(map[string]ObjectAttrs), data: make(map[string][]byte)}
}

// SignedUploadURL ignores maxSizeBytes: MemoryStore is a test double that
// does not enforce upload size at the URL layer (see ConfirmAssetUpload's
// blob.Stat comparison, which is what actually enforces size in tests).
func (m *MemoryStore) SignedUploadURL(_ context.Context, key string, contentType string, _ int64, expiry time.Duration) (string, error) {
	m.mu.Lock()
	m.objects[key] = ObjectAttrs{Size: UnknownObjectSize}
	m.mu.Unlock()
	q := url.Values{}
	q.Set("content_type", contentType)
	q.Set("expiry", normalizeSignedURLExpiry(expiry).String())
	return fmt.Sprintf("http://localhost:0/memory/upload/%s?%s", url.PathEscape(key), q.Encode()), nil
}

func (m *MemoryStore) SignedDownloadURL(_ context.Context, key string, expiry time.Duration) (string, error) {
	m.mu.Lock()
	_, ok := m.objects[key]
	m.mu.Unlock()
	if !ok {
		return "", ErrObjectNotFound
	}
	q := url.Values{}
	q.Set("expiry", normalizeSignedURLExpiry(expiry).String())
	return fmt.Sprintf("http://localhost:0/memory/download/%s?%s", url.PathEscape(key), q.Encode()), nil
}

func (m *MemoryStore) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	delete(m.objects, key)
	delete(m.data, key)
	m.mu.Unlock()
	return nil
}

// PromoteCreateOnly mirrors the create-only promotion contract for local
// development. It moves the attributes and any bytes written through Put.
func (m *MemoryStore) PromoteCreateOnly(_ context.Context, sourceKey, destinationKey string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	attrs, ok := m.objects[sourceKey]
	if !ok {
		return ErrObjectNotFound
	}
	if _, exists := m.objects[destinationKey]; exists {
		return ErrObjectAlreadyExists
	}
	m.objects[destinationKey] = attrs
	delete(m.objects, sourceKey)
	if payload, ok := m.data[sourceKey]; ok {
		m.data[destinationKey] = payload
		delete(m.data, sourceKey)
	}
	return nil
}

var _ CreateOnlyPromoter = (*MemoryStore)(nil)

func (m *MemoryStore) Exists(_ context.Context, key string) (bool, error) {
	m.mu.Lock()
	_, ok := m.objects[key]
	m.mu.Unlock()
	return ok, nil
}

func (m *MemoryStore) Stat(_ context.Context, key string) (ObjectAttrs, error) {
	m.mu.Lock()
	attrs, ok := m.objects[key]
	m.mu.Unlock()
	if !ok {
		return ObjectAttrs{}, ErrObjectNotFound
	}
	return attrs, nil
}

// NewReader returns content only for objects written through Put. Objects
// registered by a signed upload carry metadata only, so they stay unreadable
// here; callers that need those bytes use a GCSStore or a fuller test double.
func (m *MemoryStore) NewReader(_ context.Context, key string) (io.ReadCloser, error) {
	m.mu.Lock()
	payload, ok := m.data[key]
	_, exists := m.objects[key]
	m.mu.Unlock()
	if !ok {
		if exists {
			return nil, fmt.Errorf("MemoryStore holds no content for %q", key)
		}
		return nil, ErrObjectNotFound
	}
	return io.NopCloser(bytes.NewReader(payload)), nil
}

// Put stores bytes so NewReader can return them; the object also becomes
// visible to Exists and Stat with its real size.
func (m *MemoryStore) Put(_ context.Context, key, _ string, r io.Reader) error {
	payload, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.data[key] = payload
	m.objects[key] = ObjectAttrs{Size: int64(len(payload))}
	m.mu.Unlock()
	return nil
}

var _ Putter = (*MemoryStore)(nil)
