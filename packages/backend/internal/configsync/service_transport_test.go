package configsync

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// An incomplete read must fail before the service can plan a deletion. These
// responses are possible even though the file was listed at the commit.
func TestSyncFromCommitRejectsIncompleteFileTransport(t *testing.T) {
	paths := []string{configFilePath, protectedBookmarksFilePath, labelsFilePath, webhooksFilePath}
	transports := []struct {
		name           string
		file           repohost.FileContent
		expectedReason string
	}{
		{name: "too_large", file: repohost.FileContent{TooLarge: true}, expectedReason: "exceeds repository host read limit"},
		{name: "too_large_with_content", file: repohost.FileContent{TooLarge: true, Encoding: "utf8", Content: "nonempty"}, expectedReason: "exceeds repository host read limit"},
		{name: "base64", file: repohost.FileContent{Encoding: "base64"}, expectedReason: "unsupported content encoding"},
		{name: "unknown_encoding", file: repohost.FileContent{Encoding: "binary"}, expectedReason: "unsupported content encoding"},
		{name: "missing_path", file: repohost.FileContent{}, expectedReason: "mismatched file path"},
		{name: "mismatched_path", file: repohost.FileContent{}, expectedReason: "mismatched file path"},
	}
	for _, path := range paths {
		for _, transport := range transports {
			for _, dryRun := range []bool{false, true} {
				name := path + "/" + transport.name
				if dryRun {
					name += "/dry_run"
				}
				t.Run(name, func(t *testing.T) {
					store := &mockStore{
						getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
							return db.Repository{ID: id, Name: "demo", UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
						},
						getUserByIDFn: func(context.Context, int64) (db.User, error) {
							return db.User{Username: "alice"}, nil
						},
						listAllProtectedBookmarksByRepoFn: func(context.Context, int64) ([]db.ProtectedBookmark, error) {
							return []db.ProtectedBookmark{{Pattern: "main"}}, nil
						},
						listAllLabelsByRepoFn: func(context.Context, int64) ([]db.Label, error) {
							return []db.Label{{Name: "bug"}}, nil
						},
						listWebhooksByRepoFn: func(context.Context, int64) ([]db.Webhook, error) {
							return []db.Webhook{{ID: 1}}, nil
						},
					}
					repoHost := &mockRepoHost{
						listFilesAtChangeFn: func(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
							return []repohost.ChangeFile{{Path: path}}, nil
						},
						getFileAtChangeFn: func(_ context.Context, _, _, _, gotPath string) (repohost.FileContent, error) {
							require.Equal(t, path, gotPath)
							file := transport.file
							file.Path = path
							if transport.name == "missing_path" {
								file.Path = ""
							}
							if transport.name == "mismatched_path" {
								file.Path = ".smithers/other.yml"
							}
							if transport.name == "too_large_with_content" {
								file.Content = map[string]string{
									configFilePath:             "repository:\n  description: new\n",
									protectedBookmarksFilePath: "protected_bookmarks:\n  - pattern: main\n",
									labelsFilePath:             "labels:\n  - name: bug\n    color: '#d73a4a'\n",
									webhooksFilePath:           "webhooks:\n  - url: https://example.com/hook\n    events: [push]\n",
								}[path]
							}
							return file, nil
						},
					}
					beganTx := false
					audit := &mockAuditLogger{}
					svc := newServiceWithStore(store, repoHost, nil, audit, func(context.Context) (Store, func(bool) error, error) {
						beganTx = true
						return store, func(bool) error { return nil }, nil
					})
					result, err := svc.SyncFromCommit(context.Background(), SyncInput{RepositoryID: 42, CommitSHA: "abc123", DryRun: dryRun})
					assert.ErrorContains(t, err, path)
					if transport.expectedReason != "" {
						assert.ErrorContains(t, err, transport.expectedReason)
					}
					assert.Empty(t, result.Changes)
					assert.False(t, beganTx)
					assert.Empty(t, store.updateRepoCalls)
					assert.Empty(t, store.upsertBookmarkCalls)
					assert.Empty(t, store.deleteBookmarkCalls)
					assert.Empty(t, store.createLabelCalls)
					assert.Empty(t, store.updateLabelCalls)
					assert.Empty(t, store.deleteLabelCalls)
					assert.Empty(t, store.createWebhookCalls)
					assert.Empty(t, store.updateWebhookCalls)
					assert.Empty(t, store.deleteWebhookCalls)
					require.Len(t, audit.events, 1)
					assert.Equal(t, "failed", audit.events[0].Action)
					assert.Contains(t, audit.events[0].Metadata["error"], path)
				})
			}
		}
	}
}

func TestLoadParsedConfigFromCommitAcceptsEmptyUTF8Content(t *testing.T) {
	for _, encoding := range []string{"", "utf8"} {
		t.Run(encoding, func(t *testing.T) {
			store := &mockStore{
				getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
					return db.Repository{ID: id, Name: "demo", UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
				},
				getUserByIDFn: func(context.Context, int64) (db.User, error) {
					return db.User{Username: "alice"}, nil
				},
			}
			repoHost := &mockRepoHost{
				listFilesAtChangeFn: func(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
					return []repohost.ChangeFile{{Path: protectedBookmarksFilePath}}, nil
				},
				getFileAtChangeFn: func(context.Context, string, string, string, string) (repohost.FileContent, error) {
					return repohost.FileContent{Path: protectedBookmarksFilePath, Content: "", Encoding: encoding}, nil
				},
			}
			parsed, err := newServiceWithStore(store, repoHost, nil, nil, nil).LoadParsedConfigFromCommit(context.Background(), 42, "abc123")
			require.NoError(t, err)
			assert.True(t, parsed.ProtectedBookmarksFilePresent)
			assert.Empty(t, parsed.ProtectedBookmarks)
		})
	}
}
