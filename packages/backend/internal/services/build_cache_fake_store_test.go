package services

import (
	"context"
	"errors"
	"maps"
	"strings"
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
	createdAt        time.Time
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
	if !ok || !entry.createdAt.After(arg.Cutoff) {
		return "", pgx.ErrNoRows
	}
	for digest := range s.refs[fakeKey(arg.RepositoryID, arg.KeyDigest)] {
		if !s.artifacts[fakeKey(arg.RepositoryID, digest)].CreatedAt.After(arg.Cutoff) {
			return "", pgx.ErrNoRows
		}
	}
	entry.touched++
	s.entries[fakeKey(arg.RepositoryID, arg.KeyDigest)] = entry
	return entry.body, nil
}

func (t *fakeBuildCacheTx) DeleteBuildCacheEntry(_ context.Context, arg db.DeleteBuildCacheEntryParams) (string, error) {
	k := fakeKey(arg.RepositoryID, arg.KeyDigest)
	if _, ok := t.store.entries[k]; !ok {
		return "", pgx.ErrNoRows
	}
	delete(t.store.entries, k)
	delete(t.store.refs, k)
	return arg.KeyDigest, nil
}

func (t *fakeBuildCacheTx) DeleteBuildCacheEntryFenced(_ context.Context, arg db.DeleteBuildCacheEntryFencedParams) (string, error) {
	k := fakeKey(arg.RepositoryID, arg.KeyDigest)
	entry, ok := t.store.entries[k]
	if !ok || !entry.recordedRunID.Valid || entry.recordedRunID.String != arg.RecordedRunID.String || entry.recordedEventSeq.Int64 != arg.RecordedEventSeq.Int64 {
		return "", pgx.ErrNoRows
	}
	delete(t.store.entries, k)
	delete(t.store.refs, k)
	return arg.KeyDigest, nil
}

func (s *fakeBuildCacheStore) GetBuildCacheArtifact(_ context.Context, arg db.GetBuildCacheArtifactParams) (db.GetBuildCacheArtifactRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.artifacts[fakeKey(arg.RepositoryID, arg.Digest)]
	if !ok || !row.CreatedAt.After(arg.Cutoff) {
		return db.GetBuildCacheArtifactRow{}, pgx.ErrNoRows
	}
	return db.GetBuildCacheArtifactRow(row), nil
}

func (s *fakeBuildCacheStore) ListPresentBuildCacheArtifacts(_ context.Context, arg db.ListPresentBuildCacheArtifactsParams) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	present := []string{}
	for _, digest := range arg.Digests {
		if row, ok := s.artifacts[fakeKey(arg.RepositoryID, digest)]; ok && row.CreatedAt.After(arg.Cutoff) {
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
	store     *fakeBuildCacheStore
	done      bool
	entries   map[string]fakeEntry
	artifacts map[string]db.LockBuildCacheArtifactRow
	refs      map[string]map[string]struct{}
}

func (s *fakeBuildCacheStore) Begin(context.Context) (BuildCacheTx, error) {
	if s.beginErr != nil {
		return nil, s.beginErr
	}
	s.mu.Lock()
	refs := map[string]map[string]struct{}{}
	for key, values := range s.refs {
		refs[key] = maps.Clone(values)
	}
	return &fakeBuildCacheTx{store: s, entries: maps.Clone(s.entries), artifacts: maps.Clone(s.artifacts), refs: refs}, nil
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
		t.store.entries, t.store.artifacts, t.store.refs = t.entries, t.artifacts, t.refs
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
	t.store.entries[k] = fakeEntry{createdAt: time.Now(), body: arg.Body, canonical: arg.ResultCanonical, recordedRunID: arg.RecordedRunID, recordedEventSeq: arg.RecordedEventSeq}
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
	t.store.artifacts[k] = db.LockBuildCacheArtifactRow{Digest: arg.Digest, SizeBytes: arg.SizeBytes, GcsKey: arg.GcsKey, CreatedAt: time.Now()}
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
	row.CreatedAt = time.Now()
	t.store.artifacts[k] = row
	return nil
}

func (t *fakeBuildCacheTx) ExpireBuildCacheEntries(_ context.Context, arg db.ExpireBuildCacheEntriesParams) error {
	removed := 0
	for key, entry := range t.store.entries {
		if !strings.HasPrefix(key, fakeKey(arg.RepositoryID, "")) {
			continue
		}
		expired := !entry.createdAt.After(arg.Cutoff)
		for digest := range t.store.refs[key] {
			if !t.store.artifacts[fakeKey(arg.RepositoryID, digest)].CreatedAt.After(arg.Cutoff) {
				expired = true
			}
		}
		if expired {
			delete(t.store.entries, key)
			delete(t.store.refs, key)
			removed++
		}
		if removed == 64 {
			break
		}
	}
	return nil
}
func (t *fakeBuildCacheTx) ExpireBuildCacheArtifacts(_ context.Context, arg db.ExpireBuildCacheArtifactsParams) ([]string, error) {
	var keys []string
	for key, row := range t.store.artifacts {
		if !strings.HasPrefix(key, fakeKey(arg.RepositoryID, "")) || row.CreatedAt.After(arg.Cutoff) {
			continue
		}
		referenced := false
		for entry, refs := range t.store.refs {
			if strings.HasPrefix(entry, fakeKey(arg.RepositoryID, "")) {
				if _, ok := refs[row.Digest]; ok {
					referenced = true
				}
			}
		}
		if referenced {
			continue
		}
		keys = append(keys, row.GcsKey)
		delete(t.store.artifacts, key)
		if len(keys) == 16 {
			break
		}
	}
	return keys, nil
}
func (s *fakeBuildCacheStore) ListExpiredBuildCacheRepositories(_ context.Context, cutoff time.Time) ([]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := map[int64]bool{}
	for key, row := range s.entries {
		if !row.createdAt.After(cutoff) {
			ids[int64([]rune(key)[0])] = true
		}
	}
	for key, row := range s.artifacts {
		if !row.CreatedAt.After(cutoff) {
			ids[int64([]rune(key)[0])] = true
		}
	}
	var result []int64
	for id := range ids {
		result = append(result, id)
	}
	return result, nil
}
func (t *fakeBuildCacheTx) BuildCacheRepositoryBytes(_ context.Context, repositoryID int64) (int64, error) {
	var total int64
	prefix := fakeKey(repositoryID, "")
	for key, entry := range t.store.entries {
		if strings.HasPrefix(key, prefix) {
			total += max(1024, int64(len(entry.body)+len(entry.canonical)))
		}
	}
	for key, artifact := range t.store.artifacts {
		if strings.HasPrefix(key, prefix) {
			total += max(1024, artifact.SizeBytes)
		}
	}
	return total, nil
}
