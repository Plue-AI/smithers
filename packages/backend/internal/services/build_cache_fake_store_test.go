package services

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// fakeBuildCacheStore is an in-memory BuildCacheStore. Transactions are
// serialized by one mutex, which is the same guarantee the advisory lock
// gives the real store for one key.
type fakeBuildCacheStore struct {
	mu        sync.Mutex
	entries   map[string]fakeEntry
	artifacts map[string]db.LockBuildCacheArtifactRow
	refs      map[string]map[string]struct{}
	tokens    map[int64]db.BuildCacheReadToken
	nextToken int64
	pingErr   error
	beginErr  error
}

type fakeEntry struct {
	body             string
	canonical        string
	recordedRunID    pgtype.Text
	recordedEventSeq pgtype.Int8
	touched          int
}

func newFakeBuildCacheStore() *fakeBuildCacheStore {
	return &fakeBuildCacheStore{
		entries:   map[string]fakeEntry{},
		artifacts: map[string]db.LockBuildCacheArtifactRow{},
		refs:      map[string]map[string]struct{}{},
		tokens:    map[int64]db.BuildCacheReadToken{},
	}
}

func fakeKey(repositoryID int64, key string) string {
	return string(rune(repositoryID)) + "|" + key
}

func (s *fakeBuildCacheStore) GetBuildCacheEntry(_ context.Context, arg db.GetBuildCacheEntryParams) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[fakeKey(arg.RepositoryID, arg.KeyDigest)]
	if !ok {
		return "", pgx.ErrNoRows
	}
	entry.touched++
	s.entries[fakeKey(arg.RepositoryID, arg.KeyDigest)] = entry
	return entry.body, nil
}

func (s *fakeBuildCacheStore) DeleteBuildCacheEntry(_ context.Context, arg db.DeleteBuildCacheEntryParams) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := fakeKey(arg.RepositoryID, arg.KeyDigest)
	if _, ok := s.entries[k]; !ok {
		return "", pgx.ErrNoRows
	}
	delete(s.entries, k)
	delete(s.refs, k)
	return arg.KeyDigest, nil
}

func (s *fakeBuildCacheStore) DeleteBuildCacheEntryFenced(_ context.Context, arg db.DeleteBuildCacheEntryFencedParams) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := fakeKey(arg.RepositoryID, arg.KeyDigest)
	entry, ok := s.entries[k]
	if !ok || !entry.recordedRunID.Valid || entry.recordedRunID.String != arg.RecordedRunID.String || entry.recordedEventSeq.Int64 != arg.RecordedEventSeq.Int64 {
		return "", pgx.ErrNoRows
	}
	delete(s.entries, k)
	delete(s.refs, k)
	return arg.KeyDigest, nil
}

func (s *fakeBuildCacheStore) GetBuildCacheArtifact(_ context.Context, arg db.GetBuildCacheArtifactParams) (db.GetBuildCacheArtifactRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.artifacts[fakeKey(arg.RepositoryID, arg.Digest)]
	if !ok {
		return db.GetBuildCacheArtifactRow{}, pgx.ErrNoRows
	}
	return db.GetBuildCacheArtifactRow(row), nil
}

func (s *fakeBuildCacheStore) ListPresentBuildCacheArtifacts(_ context.Context, arg db.ListPresentBuildCacheArtifactsParams) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	present := []string{}
	for _, digest := range arg.Digests {
		if _, ok := s.artifacts[fakeKey(arg.RepositoryID, digest)]; ok {
			present = append(present, digest)
		}
	}
	return present, nil
}

func (s *fakeBuildCacheStore) CreateBuildCacheReadToken(_ context.Context, arg db.CreateBuildCacheReadTokenParams) (db.BuildCacheReadToken, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextToken++
	row := db.BuildCacheReadToken{ID: s.nextToken, RepositoryID: arg.RepositoryID, CreatedBy: arg.CreatedBy, Name: arg.Name, TokenHash: arg.TokenHash, TokenLastEight: arg.TokenLastEight, NamespacePrefix: arg.NamespacePrefix, CreatedAt: time.Now()}
	s.tokens[row.ID] = row
	return row, nil
}

func (s *fakeBuildCacheStore) ListBuildCacheReadTokens(_ context.Context, repositoryID int64) ([]db.BuildCacheReadToken, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []db.BuildCacheReadToken{}
	for _, row := range s.tokens {
		if row.RepositoryID == repositoryID && !row.RevokedAt.Valid {
			out = append(out, row)
		}
	}
	return out, nil
}

func (s *fakeBuildCacheStore) GetActiveBuildCacheReadTokenByHash(_ context.Context, tokenHash string) (db.BuildCacheReadToken, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, row := range s.tokens {
		if row.TokenHash == tokenHash && !row.RevokedAt.Valid {
			return row, nil
		}
	}
	return db.BuildCacheReadToken{}, pgx.ErrNoRows
}

func (s *fakeBuildCacheStore) TouchBuildCacheReadToken(_ context.Context, id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.tokens[id]
	if ok {
		row.LastUsedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
		s.tokens[id] = row
	}
	return nil
}

func (s *fakeBuildCacheStore) RevokeBuildCacheReadToken(_ context.Context, arg db.RevokeBuildCacheReadTokenParams) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.tokens[arg.ID]
	if !ok || row.RepositoryID != arg.RepositoryID || row.RevokedAt.Valid {
		return 0, pgx.ErrNoRows
	}
	row.RevokedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	s.tokens[arg.ID] = row
	return arg.ID, nil
}

func (s *fakeBuildCacheStore) Ping(context.Context) error { return s.pingErr }

type fakeBuildCacheTx struct {
	store *fakeBuildCacheStore
	done  bool
}

func (s *fakeBuildCacheStore) Begin(context.Context) (BuildCacheTx, error) {
	if s.beginErr != nil {
		return nil, s.beginErr
	}
	s.mu.Lock()
	return &fakeBuildCacheTx{store: s}, nil
}

func (t *fakeBuildCacheTx) AdvisoryLock(context.Context, int32, int32) error { return nil }

func (t *fakeBuildCacheTx) Commit(context.Context) error {
	if !t.done {
		t.done = true
		t.store.mu.Unlock()
	}
	return nil
}

func (t *fakeBuildCacheTx) Rollback(context.Context) error {
	if !t.done {
		t.done = true
		t.store.mu.Unlock()
	}
	return nil
}

func (t *fakeBuildCacheTx) InsertBuildCacheEntry(_ context.Context, arg db.InsertBuildCacheEntryParams) (string, error) {
	k := fakeKey(arg.RepositoryID, arg.KeyDigest)
	if _, ok := t.store.entries[k]; ok {
		return "", pgx.ErrNoRows
	}
	t.store.entries[k] = fakeEntry{body: arg.Body, canonical: arg.ResultCanonical, recordedRunID: arg.RecordedRunID, recordedEventSeq: arg.RecordedEventSeq}
	return arg.KeyDigest, nil
}

func (t *fakeBuildCacheTx) LockBuildCacheEntry(_ context.Context, arg db.LockBuildCacheEntryParams) (bool, error) {
	entry, ok := t.store.entries[fakeKey(arg.RepositoryID, arg.KeyDigest)]
	if !ok {
		return false, pgx.ErrNoRows
	}
	return entry.canonical == arg.ResultCanonical, nil
}

func (t *fakeBuildCacheTx) TouchBuildCacheEntry(_ context.Context, arg db.TouchBuildCacheEntryParams) error {
	k := fakeKey(arg.RepositoryID, arg.KeyDigest)
	entry := t.store.entries[k]
	entry.touched++
	t.store.entries[k] = entry
	return nil
}

func (t *fakeBuildCacheTx) RecordBuildCacheEntryArtifacts(_ context.Context, arg db.RecordBuildCacheEntryArtifactsParams) error {
	k := fakeKey(arg.RepositoryID, arg.KeyDigest)
	if t.store.refs[k] == nil {
		t.store.refs[k] = map[string]struct{}{}
	}
	for _, digest := range arg.Digests {
		if _, ok := t.store.artifacts[fakeKey(arg.RepositoryID, digest)]; ok {
			t.store.refs[k][digest] = struct{}{}
		}
	}
	return nil
}

func (t *fakeBuildCacheTx) InsertBuildCacheArtifact(_ context.Context, arg db.InsertBuildCacheArtifactParams) (string, error) {
	k := fakeKey(arg.RepositoryID, arg.Digest)
	if _, ok := t.store.artifacts[k]; ok {
		return "", pgx.ErrNoRows
	}
	t.store.artifacts[k] = db.LockBuildCacheArtifactRow{Digest: arg.Digest, SizeBytes: arg.SizeBytes, GcsKey: arg.GcsKey}
	return arg.Digest, nil
}

func (t *fakeBuildCacheTx) LockBuildCacheArtifact(_ context.Context, arg db.LockBuildCacheArtifactParams) (db.LockBuildCacheArtifactRow, error) {
	row, ok := t.store.artifacts[fakeKey(arg.RepositoryID, arg.Digest)]
	if !ok {
		return db.LockBuildCacheArtifactRow{}, pgx.ErrNoRows
	}
	return row, nil
}

func (t *fakeBuildCacheTx) TouchBuildCacheArtifact(context.Context, db.TouchBuildCacheArtifactParams) error {
	return nil
}

func (t *fakeBuildCacheTx) RepairBuildCacheArtifact(_ context.Context, arg db.RepairBuildCacheArtifactParams) error {
	k := fakeKey(arg.RepositoryID, arg.Digest)
	row, ok := t.store.artifacts[k]
	if !ok {
		return errors.New("no artifact row to repair")
	}
	row.SizeBytes = arg.SizeBytes
	row.GcsKey = arg.GcsKey
	t.store.artifacts[k] = row
	return nil
}
