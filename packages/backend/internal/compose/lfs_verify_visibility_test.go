package compose

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/lfsauth"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// This unit boundary test substitutes only SQL results. The actual router,
// LFSService, permission resolution, scoped-token verifier and filesystem store
// run together; the separate PostgreSQL test exercises the real SQL/auth loader.
type lfsVerifyVisibilityQueries struct {
	services.LFSQuerier
	repositories  map[string]db.Repository
	permissionErr error
	objectReads   int
	object        db.LfsObject
}

func (q *lfsVerifyVisibilityQueries) GetRepoByOwnerAndLowerName(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	repo, ok := q.repositories[arg.Owner+"/"+arg.LowerName]
	if !ok {
		return db.Repository{}, pgx.ErrNoRows
	}
	return repo, nil
}

func (q *lfsVerifyVisibilityQueries) GetCollaboratorPermissionForRepoUser(_ context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if q.permissionErr != nil {
		return "", q.permissionErr
	}
	if arg.UserID.Int64 == 2 {
		return "read", nil
	}
	return "", nil
}

func (q *lfsVerifyVisibilityQueries) GetLFSObjectByOID(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
	q.objectReads++
	return q.object, nil
}

func (q *lfsVerifyVisibilityQueries) DeleteLFSUploadReservation(context.Context, db.DeleteLFSUploadReservationParams) error {
	return nil
}

func lfsVerifyRequest(repo, oid string, size int64) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/"+repo+"/lfs/verify", strings.NewReader(fmt.Sprintf(`{"oid":%q,"size":%d}`, oid, size)))
	req.Header.Set("Content-Type", routes.LFSJSONMediaType)
	return req
}

func lfsVerifyScopedAuthorization(t *testing.T, repo string, repoID int64, oid string, size int64) string {
	t.Helper()
	manager, err := lfsauth.NewManager(routerTestLFSSigningSecret)
	require.NoError(t, err)
	token, _, err := manager.IssueVerify(lfsauth.VerifyGrant{
		RepositoryID: repoID, Owner: "alice", Repository: repo, OID: oid, Size: size,
		Principal: lfsauth.PrincipalDeployKey,
	}, time.Hour)
	require.NoError(t, err)
	return lfsauth.AuthorizationValue(token)
}

func lfsVerifyActor(req *http.Request, userID int64, token bool, restriction int64) *http.Request {
	rawScopes := string(middleware.ScopeWriteRepository)
	if restriction != 0 {
		rawScopes += "," + middleware.RepositoryRestrictionScope(restriction)
	}
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: userID, Username: "caller"}, IsTokenAuth: token,
		RawScopes: rawScopes, Scopes: middleware.ParseTokenScopes(rawScopes),
	}))
	if !token {
		req.Header.Set("X-CSRF-Token", "lfs-verify-csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "lfs-verify-csrf"})
	}
	return req
}

func TestServerRouter_LFSVerifyRepositoryVisibility(t *testing.T) {
	oid := strings.Repeat("a", 64)
	for _, tc := range []struct {
		name   string
		auth   func(*testing.T, *http.Request, string) *http.Request
		status int
		public int
	}{
		{name: "anonymous", status: 401, public: 401},
		{name: "outsider session", status: 404, public: 403, auth: func(_ *testing.T, r *http.Request, _ string) *http.Request { return lfsVerifyActor(r, 1, false, 0) }},
		{name: "outsider write token", status: 404, public: 403, auth: func(_ *testing.T, r *http.Request, _ string) *http.Request { return lfsVerifyActor(r, 1, true, 0) }},
		{name: "repository bound owner token", status: 404, public: 403, auth: func(_ *testing.T, r *http.Request, _ string) *http.Request { return lfsVerifyActor(r, 99, true, 999) }},
		{name: "scoped verify wrong repository ID", status: 404, public: 403, auth: func(t *testing.T, r *http.Request, repo string) *http.Request {
			r.Header.Set("Authorization", lfsVerifyScopedAuthorization(t, repo, 999, oid, 1))
			return r
		}},
		{name: "scoped verify wrong path", status: 404, public: 404, auth: func(t *testing.T, r *http.Request, _ string) *http.Request {
			r.Header.Set("Authorization", lfsVerifyScopedAuthorization(t, "other", 999, oid, 1))
			return r
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &lfsVerifyVisibilityQueries{repositories: map[string]db.Repository{
				"alice/private": {ID: 101, UserID: pgtype.Int8{Int64: 99, Valid: true}},
				"alice/public":  {ID: 102, UserID: pgtype.Int8{Int64: 99, Valid: true}, IsPublic: true},
			}}
			router := defaultRouter(nil, &routes.LFSHandler{Service: services.NewLFSService(q, nil, time.Minute)})
			serve := func(repo string) *httptest.ResponseRecorder {
				req := lfsVerifyRequest(repo, oid, 1)
				if tc.auth != nil {
					req = tc.auth(t, req, repo)
				}
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)
				return rec
			}
			missing := serve("missing")
			private := serve("private")
			require.Equal(t, tc.status, missing.Code, missing.Body.String())
			require.Equal(t, missing.Code, private.Code, private.Body.String())
			require.JSONEq(t, missing.Body.String(), private.Body.String(), "status, code and message must hide repository existence")
			if tc.status == http.StatusNotFound {
				require.JSONEq(t, `{"code":"not_found","fault":"user","message":"repository not found"}`, private.Body.String())
			}
			public := serve("public")
			require.Equal(t, tc.public, public.Code, public.Body.String())
			require.Zero(t, q.objectReads, "denied verification must not access LFS metadata or blob storage")
		})
	}
}

func TestServerRouter_LFSVerifyReadableRepositoryPermissions(t *testing.T) {
	for _, token := range []bool{false, true} {
		for _, public := range []bool{false, true} {
			t.Run(fmt.Sprintf("token=%v public=%v", token, public), func(t *testing.T) {
				q := &lfsVerifyVisibilityQueries{repositories: map[string]db.Repository{
					"alice/demo": {ID: 101, UserID: pgtype.Int8{Int64: 99, Valid: true}, IsPublic: public},
				}}
				router := defaultRouter(nil, &routes.LFSHandler{Service: services.NewLFSService(q, nil, time.Minute)})
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, lfsVerifyActor(lfsVerifyRequest("demo", strings.Repeat("a", 64), 1), 2, token, 0))
				require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
				require.JSONEq(t, `{"code":"forbidden","fault":"user","message":"permission denied"}`, rec.Body.String())
				require.Zero(t, q.objectReads)
			})
		}
	}
}

func TestServerRouter_LFSVerifyAuthorizedConfirmation(t *testing.T) {
	body := "verified LFS content"
	oid := fmt.Sprintf("%x", sha256.Sum256([]byte(body)))
	size := int64(len(body))
	for _, auth := range []string{"session", "write token", "scoped verify", "scoped wrong OID", "scoped wrong size"} {
		t.Run(auth, func(t *testing.T) {
			store, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: "https://plue.test"})
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, store.Close()) })
			key := "repos/101/lfs/" + oid
			require.NoError(t, store.Put(context.Background(), key, "application/octet-stream", strings.NewReader(body)))
			q := &lfsVerifyVisibilityQueries{
				repositories: map[string]db.Repository{"alice/demo": {ID: 101, UserID: pgtype.Int8{Int64: 99, Valid: true}}},
				object:       db.LfsObject{ID: 7, RepositoryID: 101, Oid: oid, Size: size, GcsPath: key},
			}
			router := defaultRouter(nil, &routes.LFSHandler{Service: services.NewLFSService(q, store, time.Minute)})
			req := lfsVerifyRequest("demo", oid, size)
			expected := http.StatusOK
			switch auth {
			case "session", "write token":
				req = lfsVerifyActor(req, 99, auth == "write token", 0)
			default:
				grantOID, grantSize := oid, size
				if auth == "scoped wrong OID" {
					grantOID = strings.Repeat("b", 64)
					expected = http.StatusForbidden
				}
				if auth == "scoped wrong size" {
					grantSize++
					expected = http.StatusForbidden
				}
				req.Header.Set("Authorization", lfsVerifyScopedAuthorization(t, "demo", 101, grantOID, grantSize))
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, expected, rec.Code, rec.Body.String())
			if expected == http.StatusOK {
				require.Empty(t, rec.Body.String())
				require.Equal(t, routes.LFSJSONMediaType, rec.Header().Get("Content-Type"))
				require.Equal(t, 1, q.objectReads)
			} else {
				require.Zero(t, q.objectReads)
				require.JSONEq(t, `{"code":"forbidden","fault":"user","message":"lfs verify credential does not authorize this object"}`, rec.Body.String())
			}
		})
	}
}

func TestServerRouter_LFSVerifyPermissionFailureRemainsInternal(t *testing.T) {
	q := &lfsVerifyVisibilityQueries{
		repositories:  map[string]db.Repository{"alice/demo": {ID: 101, UserID: pgtype.Int8{Int64: 99, Valid: true}}},
		permissionErr: fmt.Errorf("database unavailable"),
	}
	router := defaultRouter(nil, &routes.LFSHandler{Service: services.NewLFSService(q, nil, time.Minute)})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, lfsVerifyActor(lfsVerifyRequest("demo", strings.Repeat("a", 64), 1), 1, false, 0))
	require.Equal(t, http.StatusInternalServerError, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), string(pkgerrors.CodeInternal))
	require.Zero(t, q.objectReads)
}
