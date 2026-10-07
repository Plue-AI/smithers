package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
)

// unverifiedOwner is an install whose owner signed in but has not yet passed
// the repository step's access check (no owner.access setting).
type unverifiedOwner struct{}

func (unverifiedOwner) GetSelfHostOwner(context.Context) (db.User, error) {
	return db.User{ID: 7}, nil
}
func (unverifiedOwner) ReadInstallRepositoryBinding(context.Context) (db.InstallRepositoryBinding, error) {
	return db.InstallRepositoryBinding{}, db.ErrInstallRepositoryUnavailable
}
func (unverifiedOwner) GetInstallSetting(context.Context, string) (db.InstallSetting, error) {
	return db.InstallSetting{}, pgx.ErrNoRows
}

type ownerBindingSettings struct {
	unverifiedOwner
	settings map[string]string
}

func (q ownerBindingSettings) GetInstallSetting(_ context.Context, key string) (db.InstallSetting, error) {
	value, ok := q.settings[key]
	if !ok {
		return db.InstallSetting{}, pgx.ErrNoRows
	}
	return db.InstallSetting{Value: []byte(value)}, nil
}

func TestInstallationOwnerSettingsAdapterHTTPRequiresVerifiedBinding(t *testing.T) {
	const binding = `{"owner_login":"maya","repository_name":"demo","repository_id":7}`
	const verified = `{"owner_login":"maya","repository_name":"demo","repository_id":7,"last_access_check_at":"2026-10-05T10:00:00Z"}`
	for _, tc := range []struct {
		name, access, repository string
		want                     int
	}{
		{"unverified", "", binding, http.StatusForbidden},
		{"malformed binding", verified, "{", http.StatusForbidden},
		{"different repository", verified, `{"owner_login":"maya","repository_name":"other","repository_id":7}`, http.StatusForbidden},
		{"verified", verified, binding, http.StatusNoContent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			boundary := identity.NewMemberBoundary(ownerBindingSettings{settings: map[string]string{
				"owner.access": tc.access, "github.repository": tc.repository,
			}})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if authorizeInstallationOwner(w, r, &AuthInfo{User: &db.User{ID: 7}}, boundary) {
					w.WriteHeader(http.StatusNoContent)
				}
			}))
			defer server.Close()
			response, err := server.Client().Get(server.URL + "/api/todos")
			require.NoError(t, err)
			defer response.Body.Close()
			require.Equal(t, tc.want, response.StatusCode)
		})
	}
}

// GitHub returns the owner's browser to /setup/github/callback and
// /setup/github/installed during setup, before the repository step verifies
// the owner; those returns are setup routes, not owner_unverified refusals.
func TestInstallationOwnerSetupScopeCoversGitHubReturns(t *testing.T) {
	boundary := identity.NewMemberBoundary(unverifiedOwner{})
	owner := &AuthInfo{User: &db.User{ID: 7}}
	for path, allowed := range map[string]bool{
		"/setup/github/installed": true, "/setup/github/callback": true, "/api/install": true, "/api/install/setup/repository": true,
		"/api/auth/github/callback": true, "/api/todos": false, "/setup/github/installed/extra": false, "/setup": false,
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "http://localhost:4000"+path, nil)
		require.Equal(t, allowed, authorizeInstallationOwner(w, r, owner, boundary), path)
		if !allowed {
			require.Equal(t, http.StatusForbidden, w.Code, path)
			require.Contains(t, w.Body.String(), "owner_unverified", path)
		}
	}
	w := httptest.NewRecorder()
	stranger := &AuthInfo{User: &db.User{ID: 8}}
	require.False(t, authorizeInstallationOwner(w, httptest.NewRequest(http.MethodGet, "http://localhost:4000/setup/github/installed", nil), stranger, boundary))
	require.Equal(t, http.StatusForbidden, w.Code, "setup scope never admits another person")
	// §5.2.1: the refusal is 403 permission in the §6.2.3 envelope.
	require.JSONEq(t, `{"code":"forbidden","class":"permission","fault":"user","message":"credential does not belong to the installation owner"}`, w.Body.String())
}
