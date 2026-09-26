package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const maxWikiAttachmentBytes = 16 << 20

func WithWikiContent(store blob.Store) WikiServiceOption {
	return func(s *WikiService) { s.content = store }
}
func wikiDigest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func wikiContentKey(repoID int64, visibility, digest string) string {
	return fmt.Sprintf("repos/%d/wiki/%s/cas/%s", repoID, visibility, digest)
}

func (s *WikiService) putWikiContent(ctx context.Context, repoID int64, data []byte) (string, error) {
	if s.content == nil {
		return "", wikiUnavailable("wiki content storage is unavailable")
	}
	digest := wikiDigest(data)
	if err := blob.Put(ctx, s.content, wikiContentKey(repoID, wikiVisibility(ctx), digest), "application/octet-stream", bytes.NewReader(data)); err != nil {
		return "", wikiUnavailable("wiki content could not be stored")
	}
	return digest, nil
}
func (s *WikiService) readWikiContent(ctx context.Context, repoID int64, digest string) ([]byte, error) {
	if s.content == nil {
		return nil, wikiUnavailable("wiki content storage is unavailable")
	}
	reader, err := s.content.NewReader(ctx, wikiContentKey(repoID, wikiVisibility(ctx), digest))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, maxWikiAttachmentBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxWikiAttachmentBytes || wikiDigest(data) != digest {
		return nil, wikiUnavailable("wiki content integrity check failed")
	}
	return data, nil
}

// Existing SQL snapshots are the transactional search/replay projection. On
// upgrade they hydrate the content store after verifying their recorded digest.
// Corrupt existing CAS bytes are never served or silently repaired on a read.
func (s *WikiService) materializeWikiMarkdown(ctx context.Context, repoID int64, body, digest string) error {
	if wikiDigest([]byte(body)) != digest {
		return wikiUnavailable("wiki snapshot integrity check failed")
	}
	_, err := s.readWikiContent(ctx, repoID, digest)
	if errors.Is(err, blob.ErrObjectNotFound) {
		_, err = s.putWikiContent(ctx, repoID, []byte(body))
	}
	if err != nil {
		return wikiUnavailable("wiki content is unavailable or corrupt")
	}
	return nil
}
func validWikiBody(body string) error {
	if !utf8.ValidString(body) || strings.ContainsRune(body, 0) {
		return pkgerrors.BadRequest("body must be UTF-8 without NUL")
	}
	return nil
}

// Recheck permissions after blob IO before accepting an edit.
func (s *WikiService) wikiWriteStillAuthorized(ctx context.Context, actor *db.User, owner, repo string, repoID int64) error {
	current, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if current.ID != repoID {
		return pkgerrors.Conflict("repository was replaced")
	}
	return s.requireWriteAccess(ctx, current, actor)
}

// Blob reads can outlast the access grant that admitted the request.
func (s *WikiService) wikiReadStillAuthorized(ctx context.Context, viewer *db.User, owner, repo string, repoID int64) error {
	current, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if current.ID != repoID {
		return pkgerrors.Conflict("repository was replaced")
	}
	return s.requireReadAccess(ctx, current, viewer)
}
