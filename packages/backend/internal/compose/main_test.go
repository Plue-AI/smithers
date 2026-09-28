package compose

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/config"
)

func TestInitializeBlobStore_FilesystemDefault(t *testing.T) {
	t.Setenv("SMITHERS_ENV", "development")
	cfg := config.BlobConfig{
		DataDir: t.TempDir(),
	}

	ctx := context.Background()
	store, client, expiry, err := initializeBlobStore(ctx, cfg)
	require.NoError(t, err)
	require.NotNil(t, store)
	if client != nil {
		require.Same(t, store, client)
		t.Cleanup(func() { require.NoError(t, client.Close()) })
	}
	assert.Equal(t, blob.DefaultSignedURLExpiry, expiry)

	_, isFilesystem := store.(*blob.FilesystemStore)
	assert.True(t, isFilesystem, "Expected store to be *blob.FilesystemStore")
}

func TestMountBlobTransferHandler(t *testing.T) {
	store, err := blob.NewFilesystemStore(blob.FilesystemConfig{
		Root: t.TempDir(), PublicBaseURL: "https://smithers.test", SigningKey: []byte(strings.Repeat("s", 32)),
	})
	require.NoError(t, err)
	require.NoError(t, store.Put(context.Background(), "repos/7/artifacts/result", "text/plain", strings.NewReader("result")))
	downloadURL, err := store.SignedDownloadURL(context.Background(), "repos/7/artifacts/result", time.Minute)
	require.NoError(t, err)

	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	handler := mountBlobTransferHandler(next, store, &config.Config{Server: config.ServerConfig{PublicURL: "https://app.example"}})
	req := httptest.NewRequest(http.MethodGet, downloadURL, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "result", rec.Body.String())

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/unrelated", nil))
	assert.Equal(t, http.StatusTeapot, rec.Code)

	preflight := httptest.NewRequest(http.MethodOptions, "/api/blob-transfer/key", nil)
	preflight.Header.Set("Origin", "https://app.example")
	preflight.Header.Set("Access-Control-Request-Method", "PUT")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, preflight)
	assert.Equal(t, "https://app.example", rec.Header().Get("Access-Control-Allow-Origin"))
}

func TestInitializeBlobStore_ProductionRequiresDurableAdapter(t *testing.T) {
	t.Setenv("SMITHERS_ENV", "production")

	store, client, expiry, err := initializeBlobStore(context.Background(), config.BlobConfig{})
	require.ErrorContains(t, err, "filesystem blob root is required")
	assert.Nil(t, store)
	assert.Nil(t, client)
	assert.Zero(t, expiry)
}

func TestValidateProductionBlobStoreFailsClosed(t *testing.T) {
	require.NoError(t, validateProductionBlobStore("development", config.BlobConfig{}))
	require.NoError(t, validateProductionBlobStore("production", config.BlobConfig{DataDir: "/var/lib/smithers/blobs"}))

	err := validateProductionBlobStore("PRODUCTION", config.BlobConfig{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "SMITHERS_BLOB_DATA_DIR or an injected blob adapter is required")
}

func TestRunRefusesE2ETestRoutesInProduction(t *testing.T) {
	preserveSlog(t)
	for _, tc := range []struct {
		name          string
		environment   string
		flag          string
		injectedBlobs bool
	}{
		{name: "production", environment: "production", flag: "true"},
		{name: "normalized production with injected blobs", environment: "  PrOdUcTiOn  ", flag: "TRUE", injectedBlobs: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SMITHERS_ENV", tc.environment)
			t.Setenv("SMITHERS_ENABLE_E2E_TEST_ROUTES", tc.flag)
			t.Setenv("SMITHERS_DATABASE_URL", "postgres://x@127.0.0.1:1/x?sslmode=disable&connect_timeout=1")
			t.Setenv("SMITHERS_AUTH_MODE", "selfhost")
			t.Setenv("SMITHERS_AUTH_BOOTSTRAP_TOKEN", "test-bootstrap-token")
			t.Setenv("SMITHERS_AUTH_SESSION_SECRET", "test-session-secret")
			t.Setenv("SMITHERS_LFS_SIGNING_SECRET", "test-lfs-signing-secret")
			t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY", "test-webhook-key")
			t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "test-repo-token")
			t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_TOKEN", "test-callback-token")
			t.Setenv("SMITHERS_PUBLIC_URL", "http://127.0.0.1:4000")
			t.Setenv("SMITHERS_FEATURE_FLAGS_WORKFLOWS", "false")
			t.Setenv("SMITHERS_FEATURE_FLAGS_SANDBOXES", "false")
			t.Setenv("SMITHERS_FEATURE_FLAGS_WORKSPACES", "false")
			t.Setenv("SMITHERS_FEATURE_FLAGS_AGENTS", "false")
			t.Setenv("SMITHERS_BLOB_DATA_DIR", t.TempDir())

			options := Options{}
			if tc.injectedBlobs {
				options.Blobs = blob.NewMemoryStore()
			}
			err := RunWithOptions(context.Background(), nil, io.Discard, io.Discard, options)
			require.ErrorContains(t, err, "SMITHERS_ENABLE_E2E_TEST_ROUTES")
		})
	}
}

func TestValidateProductionConfig(t *testing.T) {
	for _, environment := range []string{"production", "PRODUCTION", "  production  ", "development", "test", ""} {
		for _, enabled := range []bool{false, true} {
			err := validateProductionConfig(environment, enabled)
			if enabled && (environment == "production" || environment == "PRODUCTION" || environment == "  production  ") {
				require.ErrorContains(t, err, "SMITHERS_ENABLE_E2E_TEST_ROUTES", "environment=%q", environment)
			} else {
				require.NoError(t, err, "environment=%q, enabled=%t", environment, enabled)
			}
		}
	}
}

func TestInitializeBlobStore_ExpiryParsing(t *testing.T) {
	tests := []struct {
		name          string
		cfg           config.BlobConfig
		expectedDur   time.Duration
		expectedError bool
	}{
		{
			name: "Valid Duration",
			cfg: config.BlobConfig{
				SignedURLExpiry: "2h",
			},
			expectedDur:   2 * time.Hour,
			expectedError: false,
		},
		{
			name: "Empty Duration",
			cfg: config.BlobConfig{
				SignedURLExpiry: "",
			},
			expectedDur:   blob.DefaultSignedURLExpiry,
			expectedError: false,
		},
		{
			name: "Invalid Duration",
			cfg: config.BlobConfig{
				SignedURLExpiry: "invalid",
			},
			expectedDur:   0,
			expectedError: true,
		},
		{
			name: "Above Provider Maximum",
			cfg: config.BlobConfig{
				SignedURLExpiry: "168h1ns",
			},
			expectedDur:   0,
			expectedError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			tt.cfg.DataDir = t.TempDir()
			_, _, expiry, err := initializeBlobStore(ctx, tt.cfg)
			if tt.expectedError {
				assert.Error(t, err)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.expectedDur, expiry)
			}
		})
	}
}

func TestBuildServer_WiresGitHTTPProxyWebhookDependencies(t *testing.T) {
	t.Parallel()

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "main.go", nil, 0)
	require.NoError(t, err)

	found := false
	singleOwnerOption := false
	singleOwnerGuard := false
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}

		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}

		pkgIdent, ok := sel.X.(*ast.Ident)
		if !ok {
			return true
		}
		if pkgIdent.Name == "config" && sel.Sel.Name == "IsSingleOwner" {
			singleOwnerGuard = true
			return true
		}
		if pkgIdent.Name != "services" {
			return true
		}
		if sel.Sel.Name == "WithGitHTTPSingleOwnerBoundary" {
			singleOwnerOption = true
			return true
		}
		if sel.Sel.Name != "NewGitHTTPProxyService" {
			return true
		}

		found = true
		require.Len(t, call.Args, 4)
		expected := []string{"queries", "sshAuthzService", "repoHostClient"}
		for i, arg := range call.Args[:3] {
			ident, ok := arg.(*ast.Ident)
			require.Truef(t, ok, "arg %d should be identifier", i)
			assert.Equal(t, expected[i], ident.Name)
		}
		optionIdent, ok := call.Args[3].(*ast.Ident)
		require.True(t, ok, "Git HTTP options should be forwarded as a slice")
		assert.Equal(t, "gitHTTPOptions", optionIdent.Name)
		assert.True(t, call.Ellipsis.IsValid(), "Git HTTP options should be expanded")
		return true
	})

	require.True(t, found, "expected services.NewGitHTTPProxyService call in main.go")
	require.True(t, singleOwnerOption, "single-owner mode must fence Git HTTP requests")
	require.True(t, singleOwnerGuard, "single-owner fencing must follow the configured auth mode")
}

func TestBuildRouter_RepoForkRouteRequiresWriteScopeAndReadPermission(t *testing.T) {
	t.Parallel()

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "router.go", nil, 0)
	require.NoError(t, err)

	routeUsesForkRepo := false
	forkRepoRequiresWriteScope := false
	forkRepoRequiresReadPermission := false
	ast.Inspect(file, func(n ast.Node) bool {
		if postCall, ok := n.(*ast.CallExpr); ok {
			postSelector, ok := postCall.Fun.(*ast.SelectorExpr)
			if !ok || postSelector.Sel.Name != "Post" || len(postCall.Args) == 0 {
				return true
			}

			route, ok := postCall.Args[0].(*ast.BasicLit)
			if !ok || route.Value != "\"/forks\"" {
				return true
			}

			withCall, ok := postSelector.X.(*ast.CallExpr)
			require.True(t, ok, "POST /forks should be mounted through r.With")

			withSelector, ok := withCall.Fun.(*ast.SelectorExpr)
			require.True(t, ok, "POST /forks should be mounted through r.With")
			assert.Equal(t, "With", withSelector.Sel.Name)
			require.Len(t, withCall.Args, 1)

			middlewareIdent, ok := withCall.Args[0].(*ast.Ident)
			require.True(t, ok, "POST /forks should pass a middleware slice to r.With")
			assert.Equal(t, "forkRepo", middlewareIdent.Name)

			routeUsesForkRepo = true
		}

		assign, ok := n.(*ast.AssignStmt)
		if !ok || len(assign.Lhs) != len(assign.Rhs) {
			return true
		}
		for i, lhs := range assign.Lhs {
			ident, ok := lhs.(*ast.Ident)
			if !ok || ident.Name != "forkRepo" {
				continue
			}
			if hasMiddlewareCall(assign.Rhs[i], "RequireScope", "ScopeWriteRepository") {
				forkRepoRequiresWriteScope = true
			}
			if hasMiddlewareCall(assign.Rhs[i], "RequireRepoPermission", "PermissionRead") {
				forkRepoRequiresReadPermission = true
			}
		}

		return true
	})

	require.True(t, routeUsesForkRepo, "expected POST /forks route to use forkRepo middleware")
	require.True(t, forkRepoRequiresWriteScope, "forkRepo should require write:repository token scope")
	require.True(t, forkRepoRequiresReadPermission, "forkRepo should preserve source repository read permission")
}

func TestBuildRouter_GitHubReconcileUsesRepositoryWriteMiddleware(t *testing.T) {
	t.Parallel()

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "router.go", nil, 0)
	require.NoError(t, err)

	found := false
	writeRepoRequiresWriteScope := false
	writeRepoRequiresWritePermission := false
	ast.Inspect(file, func(n ast.Node) bool {
		if assign, ok := n.(*ast.AssignStmt); ok && len(assign.Lhs) == len(assign.Rhs) {
			for i, lhs := range assign.Lhs {
				ident, ok := lhs.(*ast.Ident)
				if !ok || ident.Name != "writeRepo" {
					continue
				}
				if hasMiddlewareCall(assign.Rhs[i], "RequireScope", "ScopeWriteRepository") {
					writeRepoRequiresWriteScope = true
				}
				if hasMiddlewareCall(assign.Rhs[i], "RequireRepoPermission", "PermissionWrite") {
					writeRepoRequiresWritePermission = true
				}
			}
		}

		postCall, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		postSelector, ok := postCall.Fun.(*ast.SelectorExpr)
		if !ok || postSelector.Sel.Name != "Post" || len(postCall.Args) < 2 {
			return true
		}
		route, ok := postCall.Args[0].(*ast.BasicLit)
		if !ok || route.Value != `"/github/reconcile"` {
			return true
		}

		withCall, ok := postSelector.X.(*ast.CallExpr)
		require.True(t, ok, "POST /github/reconcile should be mounted through r.With")
		withSelector, ok := withCall.Fun.(*ast.SelectorExpr)
		require.True(t, ok)
		assert.Equal(t, "With", withSelector.Sel.Name)
		require.Len(t, withCall.Args, 1)
		middlewareIdent, ok := withCall.Args[0].(*ast.Ident)
		require.True(t, ok)
		assert.Equal(t, "writeRepo", middlewareIdent.Name)
		found = true
		return false
	})

	require.True(t, found, "expected POST /github/reconcile route")
	require.True(t, writeRepoRequiresWriteScope, "github reconcile should require write:repository scope")
	require.True(t, writeRepoRequiresWritePermission, "github reconcile should require repository write permission")
}

func hasMiddlewareCall(expr ast.Expr, functionName, argumentName string) bool {
	found := false
	ast.Inspect(expr, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}

		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != functionName || len(call.Args) != 1 {
			return true
		}

		arg, ok := call.Args[0].(*ast.SelectorExpr)
		if !ok || arg.Sel.Name != argumentName {
			return true
		}

		found = true
		return false
	})
	return found
}
