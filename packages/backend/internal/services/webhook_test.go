package services

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// --- mock querier ---

type mockWebhookQuerier struct {
	getRepoByOwnerAndLowerNameFn       func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	isOrgOwnerForRepoUserFn            func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	getHighestTeamPermissionForRepoFn  func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	getCollaboratorPermissionForRepoFn func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	listRepoWebhooksByOwnerAndRepoFn   func(ctx context.Context, arg db.ListRepoWebhooksByOwnerAndRepoParams) ([]db.Webhook, error)
	countWebhooksByRepoFn              func(ctx context.Context, repositoryID int64) (int64, error)
	getRepoWebhookByOwnerAndRepoFn     func(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error)
	createWebhookFn                    func(ctx context.Context, arg db.CreateWebhookParams) (db.Webhook, error)
	updateRepoWebhookByOwnerAndRepoFn  func(ctx context.Context, arg db.UpdateRepoWebhookByOwnerAndRepoParams) (db.Webhook, error)
	deleteRepoWebhookByOwnerAndRepoFn  func(ctx context.Context, arg db.DeleteRepoWebhookByOwnerAndRepoParams) (int64, error)
	createWebhookDeliveryFn            func(ctx context.Context, arg db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error)
	listWebhookDeliveriesForRepoFn     func(ctx context.Context, arg db.ListWebhookDeliveriesForRepoParams) ([]db.WebhookDelivery, error)
	getWebhookDeliveryForRepoFn        func(ctx context.Context, arg db.GetWebhookDeliveryForRepoParams) (db.WebhookDelivery, error)
	updateWebhookDeliveryResultFn      func(ctx context.Context, arg db.UpdateWebhookDeliveryResultParams) error
	ensureWebhookAtURLFn               func(ctx context.Context, arg db.CreateWebhookParams) (db.Webhook, bool, error)

	lastCreateWebhookArg  db.CreateWebhookParams
	lastUpdateWebhookArg  db.UpdateRepoWebhookByOwnerAndRepoParams
	lastDeleteWebhookArg  db.DeleteRepoWebhookByOwnerAndRepoParams
	lastCreateDeliveryArg db.CreateWebhookDeliveryParams
}

type mockWebhookSecretCodec struct {
	encryptFn func(plaintext string) (string, error)
	decryptFn func(ciphertext string) (string, error)
}

func (m *mockWebhookSecretCodec) EncryptString(plaintext string) (string, error) {
	if m.encryptFn != nil {
		return m.encryptFn(plaintext)
	}
	return plaintext, nil
}

func (m *mockWebhookSecretCodec) DecryptString(ciphertext string) (string, error) {
	if m.decryptFn != nil {
		return m.decryptFn(ciphertext)
	}
	return ciphertext, nil
}

func (m *mockWebhookQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *mockWebhookQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}

func (m *mockWebhookQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.getHighestTeamPermissionForRepoFn != nil {
		return m.getHighestTeamPermissionForRepoFn(ctx, arg)
	}
	return "", nil
}

func (m *mockWebhookQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.getCollaboratorPermissionForRepoFn != nil {
		return m.getCollaboratorPermissionForRepoFn(ctx, arg)
	}
	return "", nil
}

func (m *mockWebhookQuerier) EnsureWebhookAtURL(ctx context.Context, arg db.CreateWebhookParams) (db.Webhook, bool, error) {
	if m.ensureWebhookAtURLFn != nil {
		return m.ensureWebhookAtURLFn(ctx, arg)
	}
	return db.Webhook{}, false, nil
}

func (m *mockWebhookQuerier) ListRepoWebhooksByOwnerAndRepo(ctx context.Context, arg db.ListRepoWebhooksByOwnerAndRepoParams) ([]db.Webhook, error) {
	if m.listRepoWebhooksByOwnerAndRepoFn != nil {
		return m.listRepoWebhooksByOwnerAndRepoFn(ctx, arg)
	}
	return []db.Webhook{}, nil
}

func (m *mockWebhookQuerier) CountWebhooksByRepo(ctx context.Context, repositoryID int64) (int64, error) {
	if m.countWebhooksByRepoFn != nil {
		return m.countWebhooksByRepoFn(ctx, repositoryID)
	}
	return 0, nil
}

func (m *mockWebhookQuerier) GetRepoWebhookByOwnerAndRepo(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
	if m.getRepoWebhookByOwnerAndRepoFn != nil {
		return m.getRepoWebhookByOwnerAndRepoFn(ctx, arg)
	}
	return db.Webhook{}, pgx.ErrNoRows
}

func (m *mockWebhookQuerier) CreateWebhook(ctx context.Context, arg db.CreateWebhookParams) (db.Webhook, error) {
	m.lastCreateWebhookArg = arg
	if m.createWebhookFn != nil {
		return m.createWebhookFn(ctx, arg)
	}
	return db.Webhook{
		ID:           1,
		RepositoryID: arg.RepositoryID,
		Url:          arg.Url,
		Secret:       arg.Secret,
		Events:       arg.Events,
		IsActive:     arg.IsActive,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}, nil
}

func (m *mockWebhookQuerier) UpdateRepoWebhookByOwnerAndRepo(ctx context.Context, arg db.UpdateRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
	m.lastUpdateWebhookArg = arg
	if m.updateRepoWebhookByOwnerAndRepoFn != nil {
		return m.updateRepoWebhookByOwnerAndRepoFn(ctx, arg)
	}
	return db.Webhook{
		ID:       arg.WebhookID,
		Url:      arg.Url,
		Secret:   arg.Secret,
		Events:   arg.Events,
		IsActive: arg.IsActive,
	}, nil
}

func (m *mockWebhookQuerier) DeleteRepoWebhookByOwnerAndRepo(ctx context.Context, arg db.DeleteRepoWebhookByOwnerAndRepoParams) (int64, error) {
	m.lastDeleteWebhookArg = arg
	if m.deleteRepoWebhookByOwnerAndRepoFn != nil {
		return m.deleteRepoWebhookByOwnerAndRepoFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockWebhookQuerier) CreateWebhookDelivery(ctx context.Context, arg db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error) {
	m.lastCreateDeliveryArg = arg
	if m.createWebhookDeliveryFn != nil {
		return m.createWebhookDeliveryFn(ctx, arg)
	}
	return db.WebhookDelivery{
		ID:        1,
		WebhookID: arg.WebhookID,
		EventType: arg.EventType,
		Payload:   arg.Payload,
		Status:    arg.Status,
	}, nil
}

func (m *mockWebhookQuerier) ListWebhookDeliveriesForRepo(ctx context.Context, arg db.ListWebhookDeliveriesForRepoParams) ([]db.WebhookDelivery, error) {
	if m.listWebhookDeliveriesForRepoFn != nil {
		return m.listWebhookDeliveriesForRepoFn(ctx, arg)
	}
	return []db.WebhookDelivery{}, nil
}

func (m *mockWebhookQuerier) GetWebhookDeliveryForRepo(ctx context.Context, arg db.GetWebhookDeliveryForRepoParams) (db.WebhookDelivery, error) {
	if m.getWebhookDeliveryForRepoFn != nil {
		return m.getWebhookDeliveryForRepoFn(ctx, arg)
	}
	return db.WebhookDelivery{}, pgx.ErrNoRows
}

func (m *mockWebhookQuerier) UpdateWebhookDeliveryResult(ctx context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
	if m.updateWebhookDeliveryResultFn != nil {
		return m.updateWebhookDeliveryResultFn(ctx, arg)
	}
	return nil
}

// --- helpers ---

func sampleWebhook() db.Webhook {
	return db.Webhook{
		ID:           1,
		RepositoryID: 10,
		Url:          "https://example.com/webhook",
		Secret:       "s3cr3t",
		Events:       []string{"push", "issues"},
		IsActive:     true,
		CreatedAt:    time.Now().UTC().Truncate(time.Second),
		UpdatedAt:    time.Now().UTC().Truncate(time.Second),
	}
}

func ownerRepo() (db.Repository, *db.User) {
	return db.Repository{
			ID:        10,
			Name:      "demo",
			LowerName: "demo",
			UserID:    pgtype.Int8{Int64: 1, Valid: true},
			IsPublic:  true,
		}, &db.User{
			ID:       1,
			Username: "alice",
		}
}

func webhookQuerier() *mockWebhookQuerier {
	repo, _ := ownerRepo()
	return &mockWebhookQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
	}
}

func defaultWebhookSecretCodec(t *testing.T) webhook.SecretCodec {
	t.Helper()
	return &mockWebhookSecretCodec{
		encryptFn: func(plaintext string) (string, error) {
			return plaintext, nil
		},
		decryptFn: func(ciphertext string) (string, error) {
			return ciphertext, nil
		},
	}
}

func newWebhookService(t *testing.T, q WebhookQuerier) *WebhookService {
	t.Helper()
	return NewWebhookService(q, defaultWebhookSecretCodec(t))
}

// --- tests ---

func TestWebhookService_ListWebhooks(t *testing.T) {
	t.Parallel()

	t.Run("returns webhooks for repo owner", func(t *testing.T) {
		_, actor := ownerRepo()
		hook := sampleWebhook()
		mock := webhookQuerier()
		mock.listRepoWebhooksByOwnerAndRepoFn = func(ctx context.Context, arg db.ListRepoWebhooksByOwnerAndRepoParams) ([]db.Webhook, error) {
			assert.Equal(t, "alice", arg.Owner)
			assert.Equal(t, "demo", arg.Repo)
			return []db.Webhook{hook}, nil
		}
		svc := newWebhookService(t, mock)
		hooks, err := svc.ListWebhooks(context.Background(), actor, "alice", "demo")
		require.NoError(t, err)
		require.Len(t, hooks, 1)
		assert.Equal(t, hook.ID, hooks[0].ID)
	})

	t.Run("repo not found returns 404", func(t *testing.T) {
		mock := &mockWebhookQuerier{}
		svc := newWebhookService(t, mock)
		_, err := svc.ListWebhooks(context.Background(), &db.User{ID: 1}, "nobody", "missing")
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 404, apiErr.Status)
	})

	t.Run("non-admin cannot list hooks on private repo", func(t *testing.T) {
		mock := &mockWebhookQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{
					ID:        10,
					Name:      "priv",
					LowerName: "priv",
					UserID:    pgtype.Int8{Int64: 99, Valid: true},
					IsPublic:  false,
				}, nil
			},
		}
		svc := newWebhookService(t, mock)
		_, err := svc.ListWebhooks(context.Background(), &db.User{ID: 2, Username: "bob"}, "owner", "priv")
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 403, apiErr.Status)
	})
}

func TestWebhookService_GetWebhook(t *testing.T) {
	t.Parallel()

	t.Run("returns webhook by id scoped to repo", func(t *testing.T) {
		_, actor := ownerRepo()
		hook := sampleWebhook()
		mock := webhookQuerier()
		mock.getRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
			assert.Equal(t, int64(1), arg.WebhookID)
			assert.Equal(t, "alice", arg.Owner)
			assert.Equal(t, "demo", arg.Repo)
			return hook, nil
		}
		svc := newWebhookService(t, mock)
		result, err := svc.GetWebhook(context.Background(), actor, "alice", "demo", 1)
		require.NoError(t, err)
		assert.Equal(t, hook.Url, result.Url)
	})

	t.Run("invalid webhook id returns 400", func(t *testing.T) {
		_, actor := ownerRepo()
		mock := webhookQuerier()
		svc := newWebhookService(t, mock)
		_, err := svc.GetWebhook(context.Background(), actor, "alice", "demo", 0)
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 400, apiErr.Status)
	})

	t.Run("webhook not found returns 404", func(t *testing.T) {
		_, actor := ownerRepo()
		mock := webhookQuerier()
		svc := newWebhookService(t, mock)
		_, err := svc.GetWebhook(context.Background(), actor, "alice", "demo", 999)
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 404, apiErr.Status)
	})
}

func TestWebhookService_CreateWebhook(t *testing.T) {
	t.Parallel()

	t.Run("creates webhook for repo admin", func(t *testing.T) {
		_, actor := ownerRepo()
		mock := webhookQuerier()
		svc := newWebhookService(t, mock)
		result, err := svc.CreateWebhook(context.Background(), actor, "alice", "demo", CreateWebhookInput{
			URL:      "https://example.com/hook",
			Secret:   "mykey",
			Events:   []string{"push", "issues"},
			IsActive: true,
		})
		require.NoError(t, err)
		assert.Equal(t, "https://example.com/hook", result.Url)
		assert.Equal(t, "mykey", mock.lastCreateWebhookArg.Secret)
		assert.Equal(t, []string{"push", "issues"}, mock.lastCreateWebhookArg.Events)
		assert.True(t, mock.lastCreateWebhookArg.IsActive)
	})

	t.Run("requires authentication", func(t *testing.T) {
		mock := webhookQuerier()
		svc := newWebhookService(t, mock)
		_, err := svc.CreateWebhook(context.Background(), nil, "alice", "demo", CreateWebhookInput{
			URL: "https://example.com/hook",
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 401, apiErr.Status)
	})

	t.Run("missing url returns validation error", func(t *testing.T) {
		_, actor := ownerRepo()
		mock := webhookQuerier()
		svc := newWebhookService(t, mock)
		_, err := svc.CreateWebhook(context.Background(), actor, "alice", "demo", CreateWebhookInput{
			URL: "",
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
	})

	t.Run("non-https url returns validation error", func(t *testing.T) {
		_, actor := ownerRepo()
		mock := webhookQuerier()
		svc := newWebhookService(t, mock)
		_, err := svc.CreateWebhook(context.Background(), actor, "alice", "demo", CreateWebhookInput{
			URL: "http://example.com/hook",
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
	})

	t.Run("non-admin cannot create webhook", func(t *testing.T) {
		mock := &mockWebhookQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{
					ID:       10,
					UserID:   pgtype.Int8{Int64: 99, Valid: true},
					IsPublic: true,
				}, nil
			},
		}
		svc := newWebhookService(t, mock)
		_, err := svc.CreateWebhook(context.Background(), &db.User{ID: 2, Username: "bob"}, "owner", "repo", CreateWebhookInput{
			URL: "https://example.com/hook",
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 403, apiErr.Status)
	})
}

func TestCreateWebhook_MaxPerRepo(t *testing.T) {
	t.Parallel()

	_, actor := ownerRepo()
	mock := webhookQuerier()
	mock.countWebhooksByRepoFn = func(ctx context.Context, repositoryID int64) (int64, error) {
		assert.Equal(t, int64(10), repositoryID)
		return maxWebhooksPerRepo, nil
	}

	svc := newWebhookService(t, mock)
	_, err := svc.CreateWebhook(context.Background(), actor, "alice", "demo", CreateWebhookInput{
		URL:      "https://example.com/hook",
		Secret:   "mykey",
		Events:   []string{"push"},
		IsActive: true,
	})
	require.Error(t, err)

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestWebhookService_UpdateWebhook(t *testing.T) {
	t.Parallel()

	t.Run("updates webhook fields", func(t *testing.T) {
		_, actor := ownerRepo()
		hook := sampleWebhook()
		mock := webhookQuerier()
		mock.getRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
			return hook, nil
		}
		newURL := "https://new.example.com/hook"
		newActive := false
		svc := newWebhookService(t, mock)
		_, err := svc.UpdateWebhook(context.Background(), actor, "alice", "demo", 1, UpdateWebhookInput{
			URL:      &newURL,
			IsActive: &newActive,
		})
		require.NoError(t, err)
		assert.Equal(t, newURL, mock.lastUpdateWebhookArg.Url)
		assert.False(t, mock.lastUpdateWebhookArg.IsActive)
		// unchanged fields should keep current values
		assert.Equal(t, hook.Secret, mock.lastUpdateWebhookArg.Secret)
		assert.Equal(t, hook.Events, mock.lastUpdateWebhookArg.Events)
	})

	t.Run("requires authentication", func(t *testing.T) {
		mock := webhookQuerier()
		svc := newWebhookService(t, mock)
		_, err := svc.UpdateWebhook(context.Background(), nil, "alice", "demo", 1, UpdateWebhookInput{})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 401, apiErr.Status)
	})

	t.Run("webhook not found returns 404", func(t *testing.T) {
		_, actor := ownerRepo()
		mock := webhookQuerier()
		svc := newWebhookService(t, mock)
		_, err := svc.UpdateWebhook(context.Background(), actor, "alice", "demo", 999, UpdateWebhookInput{})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 404, apiErr.Status)
	})

	t.Run("non-https url returns validation error", func(t *testing.T) {
		_, actor := ownerRepo()
		hook := sampleWebhook()
		mock := webhookQuerier()
		mock.getRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
			return hook, nil
		}
		badURL := "http://example.com/hook"
		svc := newWebhookService(t, mock)
		_, err := svc.UpdateWebhook(context.Background(), actor, "alice", "demo", 1, UpdateWebhookInput{
			URL: &badURL,
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
	})
}

func TestWebhookService_DeleteWebhook(t *testing.T) {
	t.Parallel()

	t.Run("deletes webhook for repo admin", func(t *testing.T) {
		_, actor := ownerRepo()
		mock := webhookQuerier()
		mock.deleteRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.DeleteRepoWebhookByOwnerAndRepoParams) (int64, error) {
			assert.Equal(t, int64(1), arg.WebhookID)
			assert.Equal(t, "alice", arg.Owner)
			assert.Equal(t, "demo", arg.Repo)
			return 1, nil
		}
		svc := newWebhookService(t, mock)
		err := svc.DeleteWebhook(context.Background(), actor, "alice", "demo", 1)
		require.NoError(t, err)
	})

	t.Run("requires authentication", func(t *testing.T) {
		mock := webhookQuerier()
		svc := newWebhookService(t, mock)
		err := svc.DeleteWebhook(context.Background(), nil, "alice", "demo", 1)
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 401, apiErr.Status)
	})

	t.Run("webhook not found returns 404", func(t *testing.T) {
		_, actor := ownerRepo()
		mock := webhookQuerier()
		mock.deleteRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.DeleteRepoWebhookByOwnerAndRepoParams) (int64, error) {
			return 0, nil
		}
		svc := newWebhookService(t, mock)
		err := svc.DeleteWebhook(context.Background(), actor, "alice", "demo", 999)
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 404, apiErr.Status)
	})
}

func TestWebhookService_TestWebhook(t *testing.T) {
	t.Parallel()

	t.Run("creates ping delivery", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		t.Cleanup(server.Close)

		_, actor := ownerRepo()
		hook := sampleWebhook()
		hook.Url = server.URL
		mock := webhookQuerier()
		mock.getRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
			return hook, nil
		}
		svc := newWebhookService(t, mock)
		svc.httpClient = server.Client()
		_, err := svc.TestWebhook(context.Background(), actor, "alice", "demo", 1)
		require.NoError(t, err)
		assert.Equal(t, "ping", mock.lastCreateDeliveryArg.EventType)
		assert.Equal(t, "pending", mock.lastCreateDeliveryArg.Status)
		assert.Equal(t, hook.ID, mock.lastCreateDeliveryArg.WebhookID)

		var payload map[string]interface{}
		require.NoError(t, json.Unmarshal(mock.lastCreateDeliveryArg.Payload, &payload))
		assert.Equal(t, "ping", payload["event"])
	})

	t.Run("requires authentication", func(t *testing.T) {
		mock := webhookQuerier()
		svc := newWebhookService(t, mock)
		_, err := svc.TestWebhook(context.Background(), nil, "alice", "demo", 1)
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 401, apiErr.Status)
	})

	// Regression: the delivery result was written with the (possibly expired)
	// request context and the error discarded, so failed/slow test deliveries
	// were never recorded. The write must run on a detached context.
	t.Run("records delivery result even when caller context is cancelled", func(t *testing.T) {
		_, actor := ownerRepo()
		hook := sampleWebhook()
		mock := webhookQuerier()
		mock.getRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
			return hook, nil
		}
		var resultCtxErr error = assert.AnError
		var recordedStatus string
		mock.updateWebhookDeliveryResultFn = func(ctx context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
			resultCtxErr = ctx.Err()
			recordedStatus = arg.Status
			return nil
		}
		svc := newWebhookService(t, mock)

		ctx, cancel := context.WithCancel(context.Background())
		cancel() // caller context is already dead; delivery will fail immediately

		result, err := svc.TestWebhook(ctx, actor, "alice", "demo", 1)
		require.NoError(t, err)
		assert.NotEmpty(t, result.Error, "delivery itself fails on the cancelled context")
		assert.NoError(t, resultCtxErr, "the delivery result must be written on a detached context")
		assert.Equal(t, "failed", recordedStatus)
	})

	t.Run("webhook not found returns 404", func(t *testing.T) {
		_, actor := ownerRepo()
		mock := webhookQuerier()
		svc := newWebhookService(t, mock)
		_, err := svc.TestWebhook(context.Background(), actor, "alice", "demo", 999)
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 404, apiErr.Status)
	})
}

// --- ListWebhookDeliveries ---

func TestWebhookService_ListWebhookDeliveries(t *testing.T) {
	t.Parallel()

	sampleDeliveries := []db.WebhookDelivery{
		{
			ID:        1,
			WebhookID: 1,
			EventType: "issues",
			Payload:   []byte(`{"action":"opened"}`),
			Status:    "delivered",
			Attempts:  1,
			CreatedAt: time.Now().UTC().Truncate(time.Second),
			UpdatedAt: time.Now().UTC().Truncate(time.Second),
		},
	}

	t.Run("returns deliveries for repo admin", func(t *testing.T) {
		_, actor := ownerRepo()
		hook := sampleWebhook()
		mock := webhookQuerier()
		mock.getRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
			assert.Equal(t, int64(1), arg.WebhookID)
			return hook, nil
		}
		mock.listWebhookDeliveriesForRepoFn = func(ctx context.Context, arg db.ListWebhookDeliveriesForRepoParams) ([]db.WebhookDelivery, error) {
			assert.Equal(t, int64(1), arg.WebhookID)
			assert.Equal(t, "alice", arg.Owner)
			assert.Equal(t, "demo", arg.Repo)
			assert.Equal(t, int32(30), arg.PageSize)
			assert.Equal(t, int32(0), arg.PageOffset)
			return sampleDeliveries, nil
		}
		svc := newWebhookService(t, mock)
		deliveries, err := svc.ListWebhookDeliveries(context.Background(), actor, "alice", "demo", 1, 1, 30)
		require.NoError(t, err)
		require.Len(t, deliveries, 1)
		assert.Equal(t, "issues", deliveries[0].EventType)
	})

	t.Run("invalid webhook id returns 400", func(t *testing.T) {
		_, actor := ownerRepo()
		mock := webhookQuerier()
		svc := newWebhookService(t, mock)
		_, err := svc.ListWebhookDeliveries(context.Background(), actor, "alice", "demo", 0, 1, 30)
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 400, apiErr.Status)
	})

	t.Run("requires authentication", func(t *testing.T) {
		mock := webhookQuerier()
		svc := newWebhookService(t, mock)
		_, err := svc.ListWebhookDeliveries(context.Background(), nil, "alice", "demo", 1, 1, 30)
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 401, apiErr.Status)
	})

	t.Run("webhook not found returns 404", func(t *testing.T) {
		_, actor := ownerRepo()
		mock := webhookQuerier()
		// getRepoWebhookByOwnerAndRepoFn defaults to pgx.ErrNoRows → 404
		svc := newWebhookService(t, mock)
		_, err := svc.ListWebhookDeliveries(context.Background(), actor, "alice", "demo", 999, 1, 30)
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 404, apiErr.Status)
	})

	t.Run("non-admin cannot list deliveries", func(t *testing.T) {
		nonAdmin := &db.User{ID: 999, Username: "stranger"}
		mock := webhookQuerier()
		// Owner is user 1 (from ownerRepo), non-admin is 999 — no collab perm.
		svc := newWebhookService(t, mock)
		_, err := svc.ListWebhookDeliveries(context.Background(), nonAdmin, "alice", "demo", 1, 1, 30)
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 403, apiErr.Status)
	})

	t.Run("pagination: page 2 per_page 10 sets correct offset", func(t *testing.T) {
		_, actor := ownerRepo()
		hook := sampleWebhook()
		mock := webhookQuerier()
		mock.getRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
			return hook, nil
		}
		mock.listWebhookDeliveriesForRepoFn = func(ctx context.Context, arg db.ListWebhookDeliveriesForRepoParams) ([]db.WebhookDelivery, error) {
			assert.Equal(t, int32(10), arg.PageSize)
			assert.Equal(t, int32(10), arg.PageOffset) // (page-1)*perPage = 1*10
			return sampleDeliveries, nil
		}
		svc := newWebhookService(t, mock)
		_, err := svc.ListWebhookDeliveries(context.Background(), actor, "alice", "demo", 1, 2, 10)
		require.NoError(t, err)
	})

	t.Run("pagination caps huge page before int32 offset", func(t *testing.T) {
		_, actor := ownerRepo()
		hook := sampleWebhook()
		mock := webhookQuerier()
		mock.getRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
			return hook, nil
		}
		mock.listWebhookDeliveriesForRepoFn = func(ctx context.Context, arg db.ListWebhookDeliveriesForRepoParams) ([]db.WebhookDelivery, error) {
			assert.Equal(t, int32(30), arg.PageSize)
			assert.Equal(t, int32((math.MaxInt32/30)*30), arg.PageOffset)
			assert.GreaterOrEqual(t, arg.PageOffset, int32(0))
			return []db.WebhookDelivery{}, nil
		}
		svc := newWebhookService(t, mock)
		_, err := svc.ListWebhookDeliveries(context.Background(), actor, "alice", "demo", 1, 1_000_000_000, 30)
		require.NoError(t, err)
	})
}

func TestWebhookService_CreateWebhook_EncryptsSecretBeforePersist(t *testing.T) {
	t.Parallel()

	_, actor := ownerRepo()
	mock := webhookQuerier()
	codec := &mockWebhookSecretCodec{
		encryptFn: func(plaintext string) (string, error) {
			assert.Equal(t, "mykey", plaintext)
			return "ciphertext-value", nil
		},
		decryptFn: func(ciphertext string) (string, error) {
			assert.Equal(t, "ciphertext-value", ciphertext)
			return "mykey", nil
		},
	}

	svc := NewWebhookService(mock, codec)
	created, err := svc.CreateWebhook(context.Background(), actor, "alice", "demo", CreateWebhookInput{
		URL:      "https://example.com/hook",
		Secret:   "mykey",
		Events:   []string{"push"},
		IsActive: true,
	})
	require.NoError(t, err)
	assert.Equal(t, "ciphertext-value", mock.lastCreateWebhookArg.Secret)
	assert.Equal(t, "mykey", created.Secret)
}

func TestWebhookService_UpdateWebhook_EncryptsSecretWhenProvided(t *testing.T) {
	t.Parallel()

	_, actor := ownerRepo()
	current := sampleWebhook()
	current.Secret = "old-cipher"
	mock := webhookQuerier()
	mock.getRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return current, nil
	}
	codec := &mockWebhookSecretCodec{
		encryptFn: func(plaintext string) (string, error) {
			assert.Equal(t, "new-plain", plaintext)
			return "new-cipher", nil
		},
		decryptFn: func(ciphertext string) (string, error) {
			assert.Equal(t, "new-cipher", ciphertext)
			return "new-plain", nil
		},
	}

	newSecret := "new-plain"
	svc := NewWebhookService(mock, codec)
	updated, err := svc.UpdateWebhook(context.Background(), actor, "alice", "demo", 1, UpdateWebhookInput{
		Secret: &newSecret,
	})
	require.NoError(t, err)
	assert.Equal(t, "new-cipher", mock.lastUpdateWebhookArg.Secret)
	assert.Equal(t, "new-plain", updated.Secret)
}

func TestWebhookService_UpdateWebhook_KeepsStoredCiphertextWhenSecretOmitted(t *testing.T) {
	t.Parallel()

	_, actor := ownerRepo()
	current := sampleWebhook()
	current.Secret = "stored-cipher"
	mock := webhookQuerier()
	mock.getRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return current, nil
	}
	codec := &mockWebhookSecretCodec{
		decryptFn: func(ciphertext string) (string, error) {
			assert.Equal(t, "stored-cipher", ciphertext)
			return "stored-plain", nil
		},
	}

	svc := NewWebhookService(mock, codec)
	updated, err := svc.UpdateWebhook(context.Background(), actor, "alice", "demo", 1, UpdateWebhookInput{})
	require.NoError(t, err)
	assert.Equal(t, "stored-cipher", mock.lastUpdateWebhookArg.Secret)
	assert.Equal(t, "stored-plain", updated.Secret)
}

func TestWebhookService_GetWebhook_DecryptsSecretForResponse(t *testing.T) {
	t.Parallel()

	_, actor := ownerRepo()
	hook := sampleWebhook()
	hook.Secret = "ciphertext-value"
	mock := webhookQuerier()
	mock.getRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return hook, nil
	}
	codec := &mockWebhookSecretCodec{
		decryptFn: func(ciphertext string) (string, error) {
			assert.Equal(t, "ciphertext-value", ciphertext)
			return "plain-secret", nil
		},
	}

	svc := NewWebhookService(mock, codec)
	got, err := svc.GetWebhook(context.Background(), actor, "alice", "demo", hook.ID)
	require.NoError(t, err)
	assert.Equal(t, "plain-secret", got.Secret)
}

func TestWebhookService_ListWebhooks_RedactsSecretsInResponse(t *testing.T) {
	t.Parallel()

	_, actor := ownerRepo()
	mock := webhookQuerier()
	mock.listRepoWebhooksByOwnerAndRepoFn = func(ctx context.Context, arg db.ListRepoWebhooksByOwnerAndRepoParams) ([]db.Webhook, error) {
		return []db.Webhook{
			{ID: 1, Secret: "cipher-1"},
			{ID: 2, Secret: ""},
		}, nil
	}
	codec := &mockWebhookSecretCodec{
		decryptFn: func(ciphertext string) (string, error) {
			return "", assert.AnError
		},
	}

	svc := NewWebhookService(mock, codec)
	hooks, err := svc.ListWebhooks(context.Background(), actor, "alice", "demo")
	require.NoError(t, err)
	require.Len(t, hooks, 2)
	assert.Equal(t, redactedWebhookSecret, hooks[0].Secret)
	assert.Equal(t, "", hooks[1].Secret)
}

func TestWebhookService_GetWebhook_DecryptFailureReturnsInternal(t *testing.T) {
	t.Parallel()

	_, actor := ownerRepo()
	hook := sampleWebhook()
	hook.Secret = "bad-cipher"
	mock := webhookQuerier()
	mock.getRepoWebhookByOwnerAndRepoFn = func(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return hook, nil
	}
	codec := &mockWebhookSecretCodec{
		decryptFn: func(ciphertext string) (string, error) {
			return "", assert.AnError
		},
	}

	svc := NewWebhookService(mock, codec)
	_, err := svc.GetWebhook(context.Background(), actor, "alice", "demo", hook.ID)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 500, apiErr.Status)
}
