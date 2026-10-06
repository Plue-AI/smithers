package services

import (
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// #3693 follow-up: the member roster and the owner check mint through the one
// installation-token minter at metadata:read, and no other code path in
// packages/backend creates installation access tokens.

type recordingMinter struct {
	installations []int64
	scopes        []GitHubTokenScope
}

func (m *recordingMinter) CreateGitHubInstallationToken(_ context.Context, installationID int64, scope GitHubTokenScope) (GitHubInstallationToken, error) {
	m.installations = append(m.installations, installationID)
	m.scopes = append(m.scopes, scope)
	return GitHubInstallationToken{InstallationID: installationID, Token: "minted-token"}, nil
}

var wantMemberScope = GitHubTokenScope{AllRepositories: true, Permissions: map[string]string{"metadata": "read"}}

type memberResultMinter struct{ result GitHubInstallationToken }

func (m memberResultMinter) CreateGitHubInstallationToken(context.Context, int64, GitHubTokenScope) (GitHubInstallationToken, error) {
	return m.result, nil
}

func TestRosterRejectsEmptyOrMismatchedMintedToken(t *testing.T) {
	for _, token := range []GitHubInstallationToken{
		{InstallationID: 12},
		{InstallationID: 13, Token: "other-installation"},
	} {
		m := &Members{Minter: memberResultMinter{token}}
		value, err := m.memberToken(t.Context(), 12)
		require.Error(t, err)
		require.Empty(t, value)
	}
}

// memberGitHub answers the installation lookup and the collaborator
// permission read, and fails the test on any token mint it sees.
func memberGitHub(t *testing.T, role string) *[]string {
	t.Helper()
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/repos/acme/app/installation":
			_, _ = w.Write([]byte(`{"id":91}`))
		case strings.HasPrefix(r.URL.Path, "/repos/acme/app/collaborators/"):
			_ = json.NewEncoder(w).Encode(map[string]string{"permission": role, "role_name": role})
		default:
			t.Errorf("unexpected GitHub call %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	return &calls
}

func TestRosterTokenComesFromTheOneMinterAtMetadataRead(t *testing.T) {
	calls := memberGitHub(t, "write")
	minter := &recordingMinter{}
	m := &Members{Credentials: memberCredentials{}, Minter: minter}
	repo := memberRepository{Owner: "acme", Name: "app", ID: 5}
	token, err := m.installationAccess(context.Background(), repo)
	require.NoError(t, err)
	require.Equal(t, "minted-token", token)
	require.Equal(t, []int64{91}, minter.installations)
	require.Equal(t, []GitHubTokenScope{wantMemberScope}, minter.scopes)
	role, err := m.permission(context.Background(), token, repo, "writer")
	require.NoError(t, err)
	require.Equal(t, "write", role)
	require.Equal(t, []string{
		"GET /repos/acme/app/installation Bearer app-jwt",
		"GET /repos/acme/app/collaborators/writer/permission Bearer minted-token",
	}, *calls)
}

func TestRosterWithoutMinterFailsBeforeGitHub(t *testing.T) {
	calls := memberGitHub(t, "write")
	_, err := (&Members{Credentials: memberCredentials{}}).installationAccess(context.Background(), memberRepository{Owner: "acme", Name: "app", ID: 5})
	require.ErrorIs(t, err, ErrGitHubAppNotConfigured)
	require.Empty(t, *calls)
}

// The roster's reads count against the installation's budget: the minter
// registers the token it mints and the roster's client is wrapped by the same
// tracker, so GitHub's rate-limit receipt lands under the installation.
func TestRosterReadsShareTheInstallationBudget(t *testing.T) {
	server, credentials := manifestFixture(t)
	invalidateCachedInstallationToken(91)
	t.Cleanup(func() { invalidateCachedInstallationToken(91) })
	tracker := NewGitHubResponseBudgetTracker()
	minter := NewRepoConnectionService(nil, &callerCredentialFixture{credentials: credentials})
	minter.SetGitHubBudgetTracker(tracker)
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/access_tokens") {
			server.Handler().ServeHTTP(w, r)
			return
		}
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "4321")
		w.Header().Set("X-RateLimit-Reset", "4102444800")
		_, _ = w.Write([]byte(`{"permission":"write","role_name":"write"}`))
	}))
	t.Cleanup(github.Close)
	t.Setenv(envGitHubAppAPIBaseURL, github.URL)
	m := &Members{Credentials: memberCredentials{}, Minter: minter, Budget: tracker}
	token, err := m.memberToken(context.Background(), 91)
	require.NoError(t, err)
	_, err = m.permission(context.Background(), token, memberRepository{Owner: "acme", Name: "app", ID: 5}, "writer")
	require.NoError(t, err)
	require.Equal(t, 4321, tracker.Status(91).Remaining)
	writes := server.Writes()
	require.Len(t, writes, 1)
	require.JSONEq(t, `{"permissions":{"metadata":"read"}}`, string(writes[0].Body))
}

func TestOwnerCheckTokenComesFromTheOneMinterAtMetadataReadPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, user.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	calls := memberGitHub(t, "admin")
	minter := &recordingMinter{}
	m := &Members{Pool: pool, Credentials: memberCredentials{}, Minter: minter}
	require.NoError(t, m.BindRepository(ctx, user, "acme", "app", repo.ID))
	require.Equal(t, []int64{91}, minter.installations)
	require.Equal(t, []GitHubTokenScope{wantMemberScope}, minter.scopes)
	require.Contains(t, *calls, "GET /repos/acme/app/collaborators/owner/permission Bearer minted-token")
}

func TestMemberScopeFitsTheManifestGrant(t *testing.T) {
	granted := gitHubAppPermissions()
	for permission, access := range gitHubMemberPermissions {
		require.Equal(t, "read", access)
		require.Contains(t, []string{"read", "write"}, granted[permission], "the manifest grants %s", permission)
	}
}

// installationTokenMinterFile is the one file allowed to create GitHub App
// installation access tokens (§12.1.3).
const installationTokenMinterFile = "internal/services/repo_connection_github_app.go"

// TestOnlyTheMinterCreatesInstallationTokens fails when production code in
// packages/backend names the installation access-token endpoint in a string,
// or calls a go-github style CreateInstallationToken, anywhere but the
// minter. Add a caller to GitHubInstallationTokenMinter instead.
func TestOnlyTheMinterCreatesInstallationTokens(t *testing.T) {
	root, err := filepath.Abs("../..")
	require.NoError(t, err)
	var offenders []string
	require.NoError(t, filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if name := entry.Name(); path != root && (name == "node_modules" || name == "testdata" || strings.HasPrefix(name, ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		// The GitHub fake serves the endpoint; it never calls it.
		if rel == installationTokenMinterFile || strings.HasPrefix(rel, "internal/githubfake/") {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch n := node.(type) {
			case *ast.BasicLit:
				if n.Kind == token.STRING {
					if value, err := strconv.Unquote(n.Value); err == nil && strings.Contains(value, "/access_tokens") {
						offenders = append(offenders, rel+": "+n.Value)
					}
				}
			case *ast.SelectorExpr:
				if n.Sel.Name == "CreateInstallationToken" {
					offenders = append(offenders, rel+": CreateInstallationToken")
				}
			}
			return true
		})
		return nil
	}))
	require.Empty(t, offenders, "only %s may create installation access tokens", installationTokenMinterFile)
}
