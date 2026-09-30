package apiclient_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/apiclient"
	"github.com/smithersai/smithers/packages/backend/controlstore"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit"
)

// keyStore is an in-memory SSHKeyRouteService for one user.
type keyStore struct {
	user int64
	keys []services.SSHKeyResponse
	next int64
}

func (s *keyStore) ListKeys(_ context.Context, userID int64) ([]services.SSHKeyResponse, error) {
	if userID != s.user {
		return nil, nil
	}
	return s.keys, nil
}

func (s *keyStore) GetKeyByID(_ context.Context, userID, keyID int64) (services.SSHKeyResponse, error) {
	for _, key := range s.keys {
		if userID == s.user && key.ID == keyID {
			return key, nil
		}
	}
	return services.SSHKeyResponse{}, pkgerrors.NotFound("ssh key not found")
}

func (s *keyStore) CreateKey(_ context.Context, _ int64, req services.CreateSSHKeyRequest) (services.SSHKeyResponse, error) {
	s.next++
	key := services.SSHKeyResponse{ID: s.next, Name: req.Title, Fingerprint: "SHA256:" + req.Key[len(req.Key)-4:], KeyType: "ssh-ed25519", CreatedAt: time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)}
	s.keys = append(s.keys, key)
	return key, nil
}

func (s *keyStore) DeleteKey(_ context.Context, _ int64, keyID int64) error {
	for index, key := range s.keys {
		if key.ID == keyID {
			s.keys = append(s.keys[:index], s.keys[index+1:]...)
			return nil
		}
	}
	return pkgerrors.NotFound("ssh key not found")
}

// sshKeyRouter mounts the SSH key handlers at the paths the spec declares,
// signed in as user 7.
func sshKeyRouter(store *keyStore) http.Handler {
	handler := &routes.SSHKeyHandler{Service: store}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(testkit.UserContext(r.Context(), &controlstore.User{ID: 7, Username: "alice"})))
		})
	})
	router.Get("/api/user/keys", handler.ListSSHKeys)
	router.Get("/api/user/keys/{id}", handler.GetSSHKey)
	router.Post("/api/user/keys", handler.CreateSSHKey)
	router.Delete("/api/user/keys/{id}", handler.DeleteSSHKey)
	return router
}

// The spec's SSH key operations decode what the real handlers write.
func TestSSHKeyOperationsAgainstTheHandlers(t *testing.T) {
	ctx := context.Background()
	store := &keyStore{user: 7}
	client := testkit.APIClient(sshKeyRouter(store), nil)

	empty, err := client.GetAPIUserKeys(ctx)
	require.NoError(t, err)
	assert.Empty(t, empty)

	created, err := client.PostAPIUserKeys(ctx, apiclient.PostAPIUserKeysBody{Title: "laptop", Key: "ssh-ed25519 AAAAbeef"})
	require.NoError(t, err)
	assert.Equal(t, apiclient.SSHKey{ID: 1, Name: "laptop", Fingerprint: "SHA256:beef", KeyType: "ssh-ed25519", CreatedAt: time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)}, created)

	listed, err := client.GetAPIUserKeys(ctx)
	require.NoError(t, err)
	assert.Equal(t, []apiclient.SSHKey{created}, listed)

	read, err := client.GetAPIUserKeysID(ctx, created.ID)
	require.NoError(t, err)
	assert.Equal(t, created, read)

	require.NoError(t, client.DeleteAPIUserKeysID(ctx, created.ID))
	err = client.DeleteAPIUserKeysID(ctx, created.ID)
	var failure *apiclient.ResponseError
	require.True(t, errors.As(err, &failure), "%v", err)
	assert.Equal(t, http.StatusNotFound, failure.StatusCode)
}
