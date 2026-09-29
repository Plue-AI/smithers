package configsync

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

type serviceCovCodec struct {
	encryptErr error
	decryptErr error
}

func (c serviceCovCodec) EncryptString(plaintext string) (string, error) {
	if c.encryptErr != nil {
		return "", c.encryptErr
	}
	return "enc:" + plaintext, nil
}

func (c serviceCovCodec) DecryptString(ciphertext string) (string, error) {
	if c.decryptErr != nil {
		return "", c.decryptErr
	}
	return strings.TrimPrefix(ciphertext, "enc:"), nil
}

type serviceCovDBTX struct {
	tx       pgx.Tx
	beginErr error
}

func (d serviceCovDBTX) Begin(context.Context) (pgx.Tx, error) {
	if d.beginErr != nil {
		return nil, d.beginErr
	}
	return d.tx, nil
}

func (d serviceCovDBTX) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func (d serviceCovDBTX) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	return nil, errors.New("query not implemented")
}

func (d serviceCovDBTX) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	return serviceCovRow{}
}

type serviceCovRow struct{}

func (serviceCovRow) Scan(...interface{}) error {
	return errors.New("row not implemented")
}

type serviceCovTx struct {
	commitCount   int
	rollbackCount int
	commitErr     error
	rollbackErr   error
}

func (tx *serviceCovTx) Begin(context.Context) (pgx.Tx, error) { return tx, nil }

func (tx *serviceCovTx) Commit(context.Context) error {
	tx.commitCount++
	return tx.commitErr
}

func (tx *serviceCovTx) Rollback(context.Context) error {
	tx.rollbackCount++
	return tx.rollbackErr
}

func (tx *serviceCovTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}

func (tx *serviceCovTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return nil }
func (tx *serviceCovTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }

func (tx *serviceCovTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}

func (tx *serviceCovTx) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func (tx *serviceCovTx) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	return nil, errors.New("query not implemented")
}

func (tx *serviceCovTx) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	return serviceCovRow{}
}

func (tx *serviceCovTx) Conn() *pgx.Conn { return nil }

func TestService_Cov_NewServiceDefaultsAndTransactionClosure(t *testing.T) {
	t.Parallel()

	audit := &mockAuditLogger{}
	noTxSvc := NewService(db.New(serviceCovDBTX{beginErr: errors.New("begin boom")}), nil, nil, audit)
	require.NotNil(t, noTxSvc)
	_, ok := noTxSvc.secretCodec.(webhook.NoopSecretCodec)
	assert.True(t, ok)
	assert.Same(t, audit, noTxSvc.audit)

	_, _, err := noTxSvc.beginTx(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "begin boom")

	customCodec := serviceCovCodec{}
	tx := &serviceCovTx{}
	svc := NewService(db.New(serviceCovDBTX{tx: tx}), nil, customCodec, nil)
	assert.Equal(t, customCodec, svc.secretCodec)

	txStore, finish, err := svc.beginTx(context.Background())
	require.NoError(t, err)
	require.NotNil(t, txStore)
	require.NoError(t, finish(true))
	assert.Equal(t, 1, tx.commitCount)
	assert.Equal(t, 0, tx.rollbackCount)

	_, finish, err = svc.beginTx(context.Background())
	require.NoError(t, err)
	require.NoError(t, finish(false))
	assert.Equal(t, 1, tx.commitCount)
	assert.Equal(t, 1, tx.rollbackCount)
}

func TestService_Cov_LoadParsedConfigFromCommitErrors(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		service *Service
		repoID  int64
		commit  string
		wantErr string
	}{
		{
			name:    "repository id required",
			service: newServiceWithStore(nil, nil, nil, nil, nil),
			repoID:  0,
			commit:  "abc123",
			wantErr: "repository id must be positive",
		},
		{
			name:    "commit sha required",
			service: newServiceWithStore(nil, nil, nil, nil, nil),
			repoID:  1,
			commit:  "  ",
			wantErr: "commit sha is required",
		},
		{
			name:    "dependencies required",
			service: newServiceWithStore(nil, nil, nil, nil, nil),
			repoID:  1,
			commit:  "abc123",
			wantErr: "config sync dependencies are not configured",
		},
		{
			name: "repository load error",
			service: newServiceWithStore(&mockStore{
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{}, errors.New("repo gone")
				},
			}, &mockRepoHost{}, nil, nil, nil),
			repoID:  1,
			commit:  "abc123",
			wantErr: "load repository: repo gone",
		},
		{
			name: "owner resolution error",
			service: newServiceWithStore(&mockStore{
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{ID: 99, Name: "demo"}, nil
				},
			}, &mockRepoHost{}, nil, nil, nil),
			repoID:  99,
			commit:  "abc123",
			wantErr: "repository 99 has no owner namespace",
		},
		{
			name: "list files error",
			service: newServiceWithStore(&mockStore{
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{ID: 1, Name: "demo", UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
				},
				getUserByIDFn: func(context.Context, int64) (db.User, error) {
					return db.User{Username: "alice"}, nil
				},
			}, &mockRepoHost{
				listFilesAtChangeFn: func(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
					return nil, errors.New("host unavailable")
				},
			}, nil, nil, nil),
			repoID:  1,
			commit:  "abc123",
			wantErr: "list .smithers files: host unavailable",
		},
		{
			name: "read file error",
			service: newServiceWithStore(&mockStore{
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{ID: 1, Name: "demo", UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
				},
				getUserByIDFn: func(context.Context, int64) (db.User, error) {
					return db.User{Username: "alice"}, nil
				},
			}, &mockRepoHost{
				listFilesAtChangeFn: func(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
					return []repohost.ChangeFile{{Path: configFilePath}}, nil
				},
				getFileAtChangeFn: func(context.Context, string, string, string, string) (repohost.FileContent, error) {
					return repohost.FileContent{}, errors.New("read denied")
				},
			}, nil, nil, nil),
			repoID:  1,
			commit:  "abc123",
			wantErr: "read .smithers/config.yml: read denied",
		},
		{
			name: "parse error",
			service: newServiceWithStore(&mockStore{
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{ID: 1, Name: "demo", UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
				},
				getUserByIDFn: func(context.Context, int64) (db.User, error) {
					return db.User{Username: "alice"}, nil
				},
			}, &mockRepoHost{
				listFilesAtChangeFn: func(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
					return []repohost.ChangeFile{{Path: labelsFilePath}}, nil
				},
				getFileAtChangeFn: func(context.Context, string, string, string, string) (repohost.FileContent, error) {
					return repohost.FileContent{Path: labelsFilePath, Content: "labels:\n  - name: bug\n    color: bad\n"}, nil
				},
			}, nil, nil, nil),
			repoID:  1,
			commit:  "abc123",
			wantErr: "labels.color is invalid",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := tc.service.LoadParsedConfigFromCommit(context.Background(), tc.repoID, tc.commit)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantErr)
		})
	}
}

func TestService_Cov_SyncFromCommitSuccessAndFailureAudit(t *testing.T) {
	t.Parallel()

	audit := &mockAuditLogger{}
	failSvc := newServiceWithStore(nil, nil, nil, audit, nil)
	_, err := failSvc.SyncFromCommit(context.Background(), SyncInput{
		RepositoryID: 0,
		CommitSHA:    "abc123",
		Trigger:      "push",
	})
	require.Error(t, err)
	require.Len(t, audit.events, 1)
	assert.Equal(t, "failed", audit.events[0].Action)
	assert.Nil(t, audit.events[0].TargetID)

	store := &mockStore{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{
				ID:          42,
				Name:        "demo",
				Description: "loaded",
				UserID:      pgtype.Int8{Int64: 7, Valid: true},
			}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{Username: "alice"}, nil
		},
	}
	repoHost := &mockRepoHost{
		listFilesAtChangeFn: func(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
			return []repohost.ChangeFile{{Path: configFilePath}}, nil
		},
		getFileAtChangeFn: func(context.Context, string, string, string, string) (repohost.FileContent, error) {
			return repohost.FileContent{Path: configFilePath, Content: "repository:\n  description: loaded\n"}, nil
		},
	}

	successSvc := newServiceWithStore(store, repoHost, webhook.NoopSecretCodec{}, nil, nil)
	result, err := successSvc.SyncFromCommit(context.Background(), SyncInput{
		RepositoryID: 42,
		CommitSHA:    "abc123",
		Trigger:      "push",
		DryRun:       true,
	})
	require.NoError(t, err)
	assert.Equal(t, []string{configFilePath}, result.FilesProcessed)
	assert.Empty(t, result.Changes)
}

func TestService_Cov_SyncParsedConfigFailureBranches(t *testing.T) {
	t.Parallel()

	t.Run("load repository failure logs audit", func(t *testing.T) {
		t.Parallel()
		audit := &mockAuditLogger{}
		svc := newServiceWithStore(&mockStore{
			getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
				return db.Repository{}, errors.New("db down")
			},
		}, nil, nil, audit, nil)

		_, err := svc.SyncParsedConfig(context.Background(), SyncInput{RepositoryID: 42, CommitSHA: "abc123"}, ParsedConfig{})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "load repository: db down")
		require.Len(t, audit.events, 1)
		assert.Equal(t, "failed", audit.events[0].Action)
		require.NotNil(t, audit.events[0].TargetID)
		assert.Equal(t, int64(42), *audit.events[0].TargetID)
	})

	t.Run("begin transaction failure logs audit", func(t *testing.T) {
		t.Parallel()
		audit := &mockAuditLogger{}
		svc := newServiceWithStore(&mockStore{
			getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
				return db.Repository{ID: 42, Name: "demo", Description: "old"}, nil
			},
		}, nil, nil, audit, func(context.Context) (Store, func(bool) error, error) {
			return nil, nil, errors.New("tx denied")
		})

		_, err := svc.SyncParsedConfig(context.Background(), SyncInput{RepositoryID: 42, CommitSHA: "abc123"}, ParsedConfig{
			ConfigFilePresent: true,
			Config: ConfigFile{
				Repository: &RepositorySettings{Description: stringPtr("new")},
			},
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "begin config sync transaction: tx denied")
		require.Len(t, audit.events, 1)
		assert.Equal(t, "demo", audit.events[0].TargetName)
	})

	t.Run("apply failure rolls back transaction", func(t *testing.T) {
		t.Parallel()
		audit := &mockAuditLogger{}
		txStore := &mockStore{
			updateRepoConfigStateFn: func(context.Context, db.UpdateRepoConfigStateParams) (db.Repository, error) {
				return db.Repository{}, errors.New("write failed")
			},
		}
		finished := false
		successValue := true
		svc := newServiceWithStore(&mockStore{
			getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
				return db.Repository{ID: 42, Name: "demo", Description: "old"}, nil
			},
		}, nil, nil, audit, func(context.Context) (Store, func(bool) error, error) {
			return txStore, func(success bool) error {
				finished = true
				successValue = success
				return nil
			}, nil
		})

		_, err := svc.SyncParsedConfig(context.Background(), SyncInput{RepositoryID: 42, CommitSHA: "abc123"}, ParsedConfig{
			ConfigFilePresent: true,
			Config: ConfigFile{
				Repository: &RepositorySettings{Description: stringPtr("new")},
			},
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "update repository config: write failed")
		assert.True(t, finished)
		assert.False(t, successValue)
		require.Len(t, audit.events, 1)
		assert.Equal(t, "failed", audit.events[0].Action)
	})

	t.Run("changes apply without transaction hook", func(t *testing.T) {
		t.Parallel()
		store := &mockStore{
			getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
				return db.Repository{ID: 42, Name: "demo", Description: "old"}, nil
			},
		}
		svc := newServiceWithStore(store, nil, nil, nil, nil)
		result, err := svc.SyncParsedConfig(context.Background(), SyncInput{RepositoryID: 42}, ParsedConfig{
			ConfigFilePresent: true,
			Config: ConfigFile{
				Repository: &RepositorySettings{Description: stringPtr("new")},
			},
		})
		require.NoError(t, err)
		require.Len(t, result.Changes, 1)
		require.Len(t, store.updateRepoCalls, 1)
		assert.Equal(t, "new", store.updateRepoCalls[0].Description)
	})
}

func TestService_Cov_BuildPlanListErrors(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		store   *mockStore
		parsed  ParsedConfig
		wantErr string
	}{
		{
			name: "protected bookmarks list error",
			store: &mockStore{
				listAllProtectedBookmarksByRepoFn: func(context.Context, int64) ([]db.ProtectedBookmark, error) {
					return nil, errors.New("bookmarks unavailable")
				},
			},
			parsed:  ParsedConfig{ProtectedBookmarksFilePresent: true},
			wantErr: "list protected bookmarks: bookmarks unavailable",
		},
		{
			name: "labels list error",
			store: &mockStore{
				listAllLabelsByRepoFn: func(context.Context, int64) ([]db.Label, error) {
					return nil, errors.New("labels unavailable")
				},
			},
			parsed:  ParsedConfig{LabelsFilePresent: true},
			wantErr: "list labels: labels unavailable",
		},
		{
			name: "label reference count error",
			store: &mockStore{
				listAllLabelsByRepoFn: func(context.Context, int64) ([]db.Label, error) {
					return []db.Label{{ID: 7, Name: "stale", Color: "#999999"}}, nil
				},
				countIssueLabelsByLabelFn: func(context.Context, int64) (int64, error) {
					return 0, errors.New("count unavailable")
				},
			},
			parsed:  ParsedConfig{LabelsFilePresent: true},
			wantErr: "count label references for stale: count unavailable",
		},
		{
			name: "webhooks list error",
			store: &mockStore{
				listWebhooksByRepoFn: func(context.Context, int64) ([]db.Webhook, error) {
					return nil, errors.New("webhooks unavailable")
				},
			},
			parsed:  ParsedConfig{WebhooksFilePresent: true},
			wantErr: "list webhooks: webhooks unavailable",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			svc := newServiceWithStore(tc.store, nil, nil, nil, nil)
			_, err := svc.buildPlan(context.Background(), db.Repository{ID: 42}, tc.parsed)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantErr)
		})
	}
}

func TestService_Cov_BuildRepoUpdateNoopAndMirrorDisable(t *testing.T) {
	t.Parallel()

	repository := db.Repository{
		ID:                42,
		Description:       "same",
		IsPublic:          false,
		Topics:            []string{"api"},
		IsMirror:          true,
		MirrorDestination: "https://github.com/acme/demo",
	}

	update, changes := buildRepoUpdate(repository, ConfigFile{
		Repository: &RepositorySettings{
			Description: stringPtr("same"),
			Topics:      []string{"api"},
		},
	})
	assert.Nil(t, update)
	assert.Nil(t, changes)

	update, changes = buildRepoUpdate(repository, ConfigFile{
		Repository: &RepositorySettings{
			Mirror: &MirrorSettings{Enabled: boolPtr(false)},
		},
	})
	require.NotNil(t, update)
	require.Len(t, changes, 1)
	assert.False(t, update.IsMirror)
	assert.Empty(t, update.MirrorDestination)
	assert.Equal(t, "repository.mirror", changes[0].Identifier)
	assert.Equal(t, "public", visibilityLabel(true))
}

func TestService_Cov_BuildProtectedBookmarkChangesEqualAndDelete(t *testing.T) {
	t.Parallel()

	current := []db.ProtectedBookmark{
		{
			RepositoryID:          42,
			Pattern:               "main",
			RequireReview:         true,
			RequireHumanApprovals: 1,
			RequiredChecks:        []string{"ci"},
			DismissStaleReviews:   true,
			RestrictPushTeams:     []string{"maintainers"},
		},
		{
			RepositoryID:          42,
			Pattern:               "legacy",
			RequireReview:         true,
			RequireHumanApprovals: 1,
		},
	}
	desired := []ProtectedBookmarkRule{
		{
			Pattern:               "main",
			RequireReview:         true,
			RequireHumanApprovals: 1,
			RequiredChecks:        []string{"ci"},
			DismissStaleReviews:   true,
			RestrictPushTeams:     []string{"maintainers"},
		},
	}

	upsert, deletes, changes := buildProtectedBookmarkChanges(42, current, desired)
	assert.Empty(t, upsert)
	require.Len(t, deletes, 1)
	assert.Equal(t, "legacy", deletes[0].Pattern)
	require.Len(t, changes, 1)
	assert.Equal(t, "delete", changes[0].Action)
}

func TestService_Cov_BuildLabelChangesDeleteAndCountError(t *testing.T) {
	t.Parallel()

	t.Run("matching label skipped and unreferenced label deleted", func(t *testing.T) {
		t.Parallel()
		store := &mockStore{
			countIssueLabelsByLabelFn: func(context.Context, int64) (int64, error) {
				return 0, nil
			},
		}
		svc := newServiceWithStore(store, nil, nil, nil, nil)
		create, update, deletes, changes, warnings, err := svc.buildLabelChanges(context.Background(), 42, []db.Label{
			{ID: 1, RepositoryID: 42, Name: "keep", Color: "#111111", Description: "same"},
			{ID: 2, RepositoryID: 42, Name: "delete", Color: "#222222", Description: "old"},
		}, []LabelDefinition{
			{Name: "keep", Color: "#111111", Description: "same"},
		})
		require.NoError(t, err)
		assert.Empty(t, create)
		assert.Empty(t, update)
		require.Len(t, deletes, 1)
		assert.Equal(t, int64(2), deletes[0].ID)
		require.Len(t, changes, 1)
		assert.Equal(t, "delete", changes[0].Action)
		assert.Empty(t, warnings)
	})

	t.Run("reference count failure is wrapped with label name", func(t *testing.T) {
		t.Parallel()
		store := &mockStore{
			countIssueLabelsByLabelFn: func(context.Context, int64) (int64, error) {
				return 0, errors.New("count failed")
			},
		}
		svc := newServiceWithStore(store, nil, nil, nil, nil)
		_, _, _, _, _, err := svc.buildLabelChanges(context.Background(), 42, []db.Label{
			{ID: 3, RepositoryID: 42, Name: "stale", Color: "#333333"},
		}, nil)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "count label references for stale: count failed")
	})
}

func TestService_Cov_BuildWebhookChangesBranches(t *testing.T) {
	t.Parallel()

	t.Run("empty secret creates webhook with encrypted empty secret", func(t *testing.T) {
		t.Parallel()
		svc := newServiceWithStore(&mockStore{}, nil, serviceCovCodec{}, nil, nil)
		create, update, deletes, changes, err := svc.buildWebhookChanges(context.Background(), 42, nil, []WebhookDefinition{
			{URL: "https://example.com/new", Events: []string{"push"}, Active: true},
		})
		require.NoError(t, err)
		require.Len(t, create, 1)
		assert.Equal(t, "enc:", create[0].Secret)
		assert.Empty(t, update)
		assert.Empty(t, deletes)
		require.Len(t, changes, 1)
		assert.Equal(t, "create", changes[0].Action)
	})

	t.Run("invalid secret expression fails before store lookup", func(t *testing.T) {
		t.Parallel()
		svc := newServiceWithStore(&mockStore{}, nil, webhook.NoopSecretCodec{}, nil, nil)
		_, err := svc.resolveSecretReference(context.Background(), 42, "plain-secret")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "webhook secret reference")
	})

	t.Run("encrypt failure is wrapped with webhook url", func(t *testing.T) {
		t.Parallel()
		svc := newServiceWithStore(&mockStore{}, nil, serviceCovCodec{encryptErr: errors.New("encrypt failed")}, nil, nil)
		_, _, _, _, err := svc.buildWebhookChanges(context.Background(), 42, nil, []WebhookDefinition{
			{URL: "https://example.com/hook", Events: []string{"push"}, Active: true},
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "encrypt webhook secret for https://example.com/hook: encrypt failed")
	})

	t.Run("decrypt existing failure is wrapped with webhook url", func(t *testing.T) {
		t.Parallel()
		svc := newServiceWithStore(&mockStore{}, nil, serviceCovCodec{decryptErr: errors.New("decrypt failed")}, nil, nil)
		_, _, _, _, err := svc.buildWebhookChanges(context.Background(), 42, []db.Webhook{
			{ID: 7, RepositoryID: 42, Url: "https://example.com/hook", Secret: "bad", Events: []string{"push"}, IsActive: true},
		}, []WebhookDefinition{
			{URL: "https://example.com/hook", Events: []string{"push"}, Active: true},
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "decrypt existing webhook secret for https://example.com/hook: decrypt failed")
	})

	t.Run("matching existing webhook skipped and leftover deleted", func(t *testing.T) {
		t.Parallel()
		svc := newServiceWithStore(&mockStore{}, nil, webhook.NoopSecretCodec{}, nil, nil)
		create, update, deletes, changes, err := svc.buildWebhookChanges(context.Background(), 42, []db.Webhook{
			{ID: 7, RepositoryID: 42, Url: "https://example.com/hook", Events: []string{"push"}, IsActive: true},
			{ID: 8, RepositoryID: 42, Url: "https://example.com/legacy", Events: []string{"push"}, IsActive: false},
		}, []WebhookDefinition{
			{URL: "https://example.com/hook", Events: []string{"push"}, Active: true},
		})
		require.NoError(t, err)
		assert.Empty(t, create)
		assert.Empty(t, update)
		require.Len(t, deletes, 1)
		assert.Equal(t, int64(8), deletes[0].ID)
		require.Len(t, changes, 1)
		assert.Equal(t, "delete", changes[0].Action)
	})
}

func TestService_Cov_ApplyPlanSuccessAllOperations(t *testing.T) {
	t.Parallel()

	store := &mockStore{}
	err := applyPlan(context.Background(), store, syncPlan{
		repoUpdate: &db.UpdateRepoConfigStateParams{ID: 42, Description: "new"},
		bookmarksUpsert: []db.UpsertProtectedBookmarkParams{
			{RepositoryID: 42, Pattern: "main"},
		},
		bookmarksDelete: []db.DeleteProtectedBookmarkByPatternParams{
			{RepositoryID: 42, Pattern: "legacy"},
		},
		labelsCreate: []db.CreateLabelParams{
			{RepositoryID: 42, Name: "bug"},
		},
		labelsUpdate: []db.UpdateLabelParams{
			{RepositoryID: 42, ID: 1, Name: "docs"},
		},
		labelsDelete: []db.DeleteLabelParams{
			{RepositoryID: 42, ID: 2},
		},
		webhooksCreate: []db.CreateWebhookParams{
			{RepositoryID: 42, Url: "https://example.com/new"},
		},
		webhooksUpdate: []db.UpdateWebhookByIDParams{
			{RepositoryID: 42, ID: 3, Url: "https://example.com/update"},
		},
		webhooksDelete: []db.DeleteWebhookByIDParams{
			{RepositoryID: 42, ID: 4},
		},
	})
	require.NoError(t, err)
	assert.Len(t, store.updateRepoCalls, 1)
	assert.Len(t, store.upsertBookmarkCalls, 1)
	assert.Len(t, store.deleteBookmarkCalls, 1)
	assert.Len(t, store.createLabelCalls, 1)
	assert.Len(t, store.updateLabelCalls, 1)
	assert.Len(t, store.deleteLabelCalls, 1)
	assert.Len(t, store.createWebhookCalls, 1)
	assert.Len(t, store.updateWebhookCalls, 1)
	assert.Len(t, store.deleteWebhookCalls, 1)
}

func TestService_Cov_ApplyPlanErrorWrappers(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		store   *mockStore
		plan    syncPlan
		wantErr string
	}{
		{
			name: "repo update",
			store: &mockStore{
				updateRepoConfigStateFn: func(context.Context, db.UpdateRepoConfigStateParams) (db.Repository, error) {
					return db.Repository{}, errors.New("boom")
				},
			},
			plan:    syncPlan{repoUpdate: &db.UpdateRepoConfigStateParams{ID: 42}},
			wantErr: "update repository config: boom",
		},
		{
			name: "bookmark upsert",
			store: &mockStore{
				upsertProtectedBookmarkFn: func(context.Context, db.UpsertProtectedBookmarkParams) (db.ProtectedBookmark, error) {
					return db.ProtectedBookmark{}, errors.New("boom")
				},
			},
			plan:    syncPlan{bookmarksUpsert: []db.UpsertProtectedBookmarkParams{{Pattern: "main"}}},
			wantErr: "upsert protected bookmark main: boom",
		},
		{
			name: "bookmark delete",
			store: &mockStore{
				deleteProtectedBookmarkByPatternFn: func(context.Context, db.DeleteProtectedBookmarkByPatternParams) (int64, error) {
					return 0, errors.New("boom")
				},
			},
			plan:    syncPlan{bookmarksDelete: []db.DeleteProtectedBookmarkByPatternParams{{Pattern: "legacy"}}},
			wantErr: "delete protected bookmark legacy: boom",
		},
		{
			name: "label create",
			store: &mockStore{
				createLabelFn: func(context.Context, db.CreateLabelParams) (db.Label, error) {
					return db.Label{}, errors.New("boom")
				},
			},
			plan:    syncPlan{labelsCreate: []db.CreateLabelParams{{Name: "bug"}}},
			wantErr: "create label bug: boom",
		},
		{
			name: "label update",
			store: &mockStore{
				updateLabelFn: func(context.Context, db.UpdateLabelParams) (db.Label, error) {
					return db.Label{}, errors.New("boom")
				},
			},
			plan:    syncPlan{labelsUpdate: []db.UpdateLabelParams{{ID: 1, Name: "docs"}}},
			wantErr: "update label docs: boom",
		},
		{
			name: "label delete",
			store: &mockStore{
				deleteLabelFn: func(context.Context, db.DeleteLabelParams) error {
					return errors.New("boom")
				},
			},
			plan:    syncPlan{labelsDelete: []db.DeleteLabelParams{{ID: 2}}},
			wantErr: "delete label 2: boom",
		},
		{
			name: "webhook create",
			store: &mockStore{
				createWebhookFn: func(context.Context, db.CreateWebhookParams) (db.Webhook, error) {
					return db.Webhook{}, errors.New("boom")
				},
			},
			plan:    syncPlan{webhooksCreate: []db.CreateWebhookParams{{Url: "https://example.com/new"}}},
			wantErr: "create webhook https://example.com/new: boom",
		},
		{
			name: "webhook update",
			store: &mockStore{
				updateWebhookByIDFn: func(context.Context, db.UpdateWebhookByIDParams) (db.Webhook, error) {
					return db.Webhook{}, errors.New("boom")
				},
			},
			plan:    syncPlan{webhooksUpdate: []db.UpdateWebhookByIDParams{{ID: 3, Url: "https://example.com/update"}}},
			wantErr: "update webhook https://example.com/update: boom",
		},
		{
			name: "webhook delete",
			store: &mockStore{
				deleteWebhookByIDFn: func(context.Context, db.DeleteWebhookByIDParams) error {
					return errors.New("boom")
				},
			},
			plan:    syncPlan{webhooksDelete: []db.DeleteWebhookByIDParams{{ID: 4}}},
			wantErr: "delete webhook 4: boom",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := applyPlan(context.Background(), tc.store, tc.plan)
			require.Error(t, err)
			assert.Equal(t, tc.wantErr, err.Error())
		})
	}
}

func TestService_Cov_ResolveRepoOwnerBranches(t *testing.T) {
	t.Parallel()

	t.Run("user lookup error", func(t *testing.T) {
		t.Parallel()
		svc := newServiceWithStore(&mockStore{
			getUserByIDFn: func(context.Context, int64) (db.User, error) {
				return db.User{}, errors.New("user missing")
			},
		}, nil, nil, nil, nil)
		_, err := svc.resolveRepoOwner(context.Background(), db.Repository{
			ID:     42,
			UserID: pgtype.Int8{Int64: 7, Valid: true},
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "load repository owner user: user missing")
	})

	t.Run("organization owner", func(t *testing.T) {
		t.Parallel()
		svc := newServiceWithStore(&mockStore{
			getOrgByIDFn: func(context.Context, int64) (db.Organization, error) {
				return db.Organization{Name: "acme"}, nil
			},
		}, nil, nil, nil, nil)
		owner, err := svc.resolveRepoOwner(context.Background(), db.Repository{
			ID:    42,
			OrgID: pgtype.Int8{Int64: 9, Valid: true},
		})
		require.NoError(t, err)
		assert.Equal(t, "acme", owner)
	})

	t.Run("organization lookup error", func(t *testing.T) {
		t.Parallel()
		svc := newServiceWithStore(&mockStore{
			getOrgByIDFn: func(context.Context, int64) (db.Organization, error) {
				return db.Organization{}, errors.New("org missing")
			},
		}, nil, nil, nil, nil)
		_, err := svc.resolveRepoOwner(context.Background(), db.Repository{
			ID:    42,
			OrgID: pgtype.Int8{Int64: 9, Valid: true},
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "load repository owner org: org missing")
	})
}

func TestService_Cov_AuditLoggingBranches(t *testing.T) {
	t.Parallel()

	t.Run("dry run uses system actor when actor name blank", func(t *testing.T) {
		t.Parallel()
		audit := &mockAuditLogger{}
		svc := newServiceWithStore(nil, nil, nil, audit, nil)
		svc.logAuditEvents(context.Background(), SyncInput{
			RepositoryID: 42,
			CommitSHA:    "abc123",
			Trigger:      "manual",
			DryRun:       true,
		}, "demo", SyncResult{
			FilesProcessed: []string{configFilePath},
			Changes: []Change{
				{ConfigType: "config", Identifier: "repository.description", Action: "update"},
			},
		})
		require.Len(t, audit.events, 1)
		assert.Equal(t, "system", audit.events[0].ActorName)
		assert.Equal(t, "dry_run", audit.events[0].Action)
	})

	t.Run("failure without positive repository id has nil target", func(t *testing.T) {
		t.Parallel()
		audit := &mockAuditLogger{}
		svc := newServiceWithStore(nil, nil, nil, audit, nil)
		svc.logFailure(context.Background(), SyncInput{
			RepositoryID: -1,
			CommitSHA:    "abc123",
			Trigger:      "manual",
			ActorName:    "  ",
		}, errors.New("broken config"), "")
		require.Len(t, audit.events, 1)
		assert.Equal(t, "system", audit.events[0].ActorName)
		assert.Equal(t, "failed", audit.events[0].Action)
		assert.Nil(t, audit.events[0].TargetID)
		assert.Equal(t, "broken config", audit.events[0].Metadata["error"])
	})
}
