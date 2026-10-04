package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type retentionTestAuthority struct {
	denied bool
	source RepositorySource
}

func (a *retentionTestAuthority) authorizedRepo(context.Context, int64, int64, bool) (db.Repository, error) {
	if a.denied {
		return db.Repository{}, pkgerrors.Forbidden("write denied")
	}
	return db.Repository{ID: 7}, nil
}
func (a *retentionTestAuthority) Source(context.Context, int64, int64) (RepositorySource, error) {
	return a.source, nil
}

type retentionTestStore struct {
	workspace db.Workspace
	issued    []db.CreateAccessTokenParams
	revoked   int
	payload   json.RawMessage
	eventErr  error
	eventKey  db.GetRepositorySourcePushEventParams
}

func (q *retentionTestStore) GetWorkspaceByRepo(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
	return q.workspace, nil
}
func (q *retentionTestStore) GetRepoOwnerSlugAndNameByID(context.Context, int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
	return db.GetRepoOwnerSlugAndNameByIDRow{OwnerSlug: "local", RepoName: "mirror"}, nil
}
func (q *retentionTestStore) CreateAccessToken(_ context.Context, p db.CreateAccessTokenParams) (db.AccessToken, error) {
	q.issued = append(q.issued, p)
	return db.AccessToken{ID: 1}, nil
}
func (q *retentionTestStore) DeleteAccessToken(context.Context, db.DeleteAccessTokenParams) error {
	q.revoked++
	return nil
}
func (q *retentionTestStore) GetRepositorySourcePushEvent(_ context.Context, p db.GetRepositorySourcePushEventParams) (json.RawMessage, error) {
	q.eventKey = p
	return q.payload, q.eventErr
}

func retentionTestFixture(t *testing.T) (*RepositorySourceRetentionService, *retentionTestStore, *retentionTestAuthority, RepositorySourceRetentionInput, *[][]string) {
	t.Helper()
	input := RepositorySourceRetentionInput{WorkspaceID: uuid.NewString(), Kind: "pull_request", Number: 17, Head: strings.Repeat("a", 40), Base: strings.Repeat("b", 40)}
	q := &retentionTestStore{workspace: db.Workspace{ID: input.WorkspaceID, RepositoryID: 7, UserID: 9, Kind: "vm", Status: "running"}}
	a := &retentionTestAuthority{source: RepositorySource{Source: "github", FullName: "original/source"}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer private-fixture-credential", r.Header.Get("Authorization"))
		if r.URL.Path == "/repos/original/source" {
			_, _ = w.Write([]byte(`{"private":true,"size":1,"default_branch":"main"}`))
			return
		}
		require.Equal(t, "/repos/original/source/pulls/17", r.URL.Path)
		_ = json.NewEncoder(w).Encode(map[string]any{"number": 17, "base": map[string]any{"sha": input.Base, "repo": map[string]string{"full_name": "original/source"}}, "head": map[string]any{"sha": input.Head, "repo": map[string]string{"full_name": "contributor/fork"}}})
	}))
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	imports := &GitHubImportService{tokenDB: testGitHubImportTokenDB{accounts: []db.OauthAccount{{Provider: "github"}}}, decrypter: testGitHubImportDecrypter{token: "private-fixture-credential"}, httpClient: server.Client(), gitBaseURL: "https://native.example.test"}
	s := NewRepositorySourceRetentionService(q, a, imports)
	calls := [][]string{}
	s.runGit = func(ctx context.Context, env []string, args ...string) (string, error) {
		calls = append(calls, append([]string(nil), args...))
		require.NotContains(t, strings.Join(args, " "), "credential")
		joined := strings.Join(args, " ")
		if strings.Contains(joined, " fetch ") {
			require.Contains(t, strings.Join(env, "\n"), "http."+os.Getenv(envGitHubAppAPIBaseURL)+"/original/source.git.extraHeader")
		}
		if strings.Contains(joined, "rev-parse") {
			if strings.Contains(joined, "/head") {
				return input.Head + "\n", nil
			}
			return input.Base + "\n", nil
		}
		if args[0] == "ls-remote" {
			return input.Head + "\t" + repohost.WorkspaceSourceRef(input.WorkspaceID, input.Head) + "\n" + input.Base + "\t" + repohost.WorkspaceSourceRef(input.WorkspaceID, input.Base) + "\n", nil
		}
		return "", nil
	}
	return s, q, a, input, &calls
}

func TestSourceRetentionCanonicalForkAndImmutableTransport(t *testing.T) {
	s, q, _, input, calls := retentionTestFixture(t)
	for range 2 {
		result, err := s.Retain(context.Background(), 7, 9, input)
		require.NoError(t, err)
		require.Equal(t, "retained", result.Status)
		require.Equal(t, "original/source", result.FullName)
		require.Equal(t, "https://native.example.test/local/mirror.git", result.CloneURL)
		encoded, _ := json.Marshal(result)
		require.NotContains(t, string(encoded), "credential")
	}
	require.Len(t, q.issued, 2)
	require.Equal(t, 2, q.revoked)
	for _, p := range q.issued {
		require.Equal(t, workspaceHeadTokenScopes(7, input.WorkspaceID), p.Scopes)
	}
	for _, args := range *calls {
		joined := strings.Join(args, " ")
		require.NotContains(t, joined, "--force")
		require.NotContains(t, joined, "--prune")
		require.NotContains(t, joined, "--mirror")
		if strings.Contains(joined, " fetch ") {
			require.Contains(t, joined, os.Getenv(envGitHubAppAPIBaseURL)+"/original/source.git refs/pull/17/head:refs/smithers-fetch/head")
		}
		if strings.Contains(joined, "push") {
			require.Contains(t, joined, "--atomic")
			require.NotContains(t, joined, "refs/heads/")
			require.NotContains(t, joined, "refs/tags/")
		}
	}
}

func TestSourceRetentionRejectsMovedForeignAndRefusedPR(t *testing.T) {
	for _, mode := range []string{"head", "base", "foreign", "wrong-number", "missing", "refused", "moved-during-fetch", "bad-fetch-ack"} {
		t.Run(mode, func(t *testing.T) {
			s, q, _, input, _ := retentionTestFixture(t)
			if mode == "bad-fetch-ack" {
				old := s.runGit
				s.runGit = func(ctx context.Context, env []string, args ...string) (string, error) {
					if strings.Contains(strings.Join(args, " "), "rev-parse") {
						return strings.Repeat("c", 40), nil
					}
					return old(ctx, env, args...)
				}
			} else {
				calls := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if !strings.Contains(r.URL.Path, "/pulls/") {
						_, _ = w.Write([]byte(`{"size":1}`))
						return
					}
					calls++
					if mode == "missing" {
						w.WriteHeader(404)
						return
					}
					if mode == "refused" {
						w.WriteHeader(403)
						return
					}
					head, base, source, number := input.Head, input.Base, "original/source", input.Number
					if mode == "head" || (mode == "moved-during-fetch" && calls > 1) {
						head = strings.Repeat("c", 40)
					}
					if mode == "base" {
						base = strings.Repeat("c", 40)
					}
					if mode == "foreign" {
						source = "other/source"
					}
					if mode == "wrong-number" {
						number++
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"number": number, "base": map[string]any{"sha": base, "repo": map[string]string{"full_name": source}}, "head": map[string]string{"sha": head}})
				}))
				defer server.Close()
				t.Setenv(envGitHubAppAPIBaseURL, server.URL)
			}
			_, err := s.Retain(context.Background(), 7, 9, input)
			require.Error(t, err)
			require.Empty(t, q.issued)
			var api *pkgerrors.APIError
			require.ErrorAs(t, err, &api)
			require.Contains(t, []int{403, 404, 409}, api.Status)
		})
	}
}

func TestSourceRetentionWriteOwnerAndSignedPushAdmission(t *testing.T) {
	for _, mode := range []string{"write-denied", "foreign-workspace", "unsigned", "wrong-repository", "wrong-head", "deleted", "good"} {
		t.Run(mode, func(t *testing.T) {
			s, q, a, input, calls := retentionTestFixture(t)
			input.Kind = "push"
			input.Number = 0
			input.Ref = "refs/heads/main"
			input.DeliveryKey = "github:" + uuid.NewString()
			payload := map[string]any{"before": input.Base, "after": input.Head, "ref": input.Ref, "repository": map[string]string{"full_name": "original/source"}}
			switch mode {
			case "write-denied":
				a.denied = true
			case "foreign-workspace":
				q.workspace.UserID = 99
			case "unsigned":
				q.eventErr = pgx.ErrNoRows
			case "wrong-repository":
				payload["repository"] = map[string]string{"full_name": "other/source"}
			case "wrong-head":
				payload["after"] = strings.Repeat("c", 40)
			case "deleted":
				payload["deleted"] = true
			}
			q.payload, _ = json.Marshal(payload)
			_, err := s.Retain(context.Background(), 7, 9, input)
			if mode == "good" {
				require.NoError(t, err)
				require.Equal(t, db.GetRepositorySourcePushEventParams{RepositoryID: 7, DeliveryKey: input.DeliveryKey}, q.eventKey)
			} else {
				require.Error(t, err)
				require.Empty(t, *calls)
				require.Empty(t, q.issued)
			}
		})
	}
}

func TestSourceRetentionSecretSafeFailureCleanupAndEnvironment(t *testing.T) {
	s, q, _, input, _ := retentionTestFixture(t)
	old := s.runGit
	var temporary string
	s.runGit = func(ctx context.Context, env []string, args ...string) (string, error) {
		if args[0] == "init" {
			temporary = args[len(args)-1]
		}
		if strings.Contains(strings.Join(args, " "), " push ") {
			return "private-fixture-credential", errors.New("private-fixture-credential")
		}
		return old(ctx, env, args...)
	}
	_, err := s.Retain(context.Background(), 7, 9, input)
	require.Error(t, err)
	require.NotContains(t, err.Error(), "credential")
	require.Equal(t, 1, q.revoked)
	_, statErr := os.Stat(temporary)
	require.True(t, os.IsNotExist(statErr))
	t.Setenv("GIT_TRACE", "credential-leak")
	t.Setenv("GIT_CONFIG_COUNT", "99")
	env := sourceRetentionGitEnv("https://native.example.test/local/mirror.git", "Bearer bounded-token")
	require.NotContains(t, strings.Join(env, "\n"), "credential-leak")
	require.Contains(t, strings.Join(env, "\n"), "GIT_CONFIG_GLOBAL=/dev/null")
	result := RepositorySourceRetentionResult{Head: input.Head, Base: input.Base, HeadRef: "refs/head", BaseRef: "refs/base"}
	require.False(t, verifyRetainedRefs(fmt.Sprintf("%s refs/head\n", input.Head), result))
}

func TestRepositoryJobsIntegrationSourcePushIdentity(t *testing.T) {
	_, q, _, g, _ := repositoryJobFixture(t)
	ctx := context.Background()
	key := "github:" + uuid.NewString()
	input := db.AdmitRepositoryJobEventParams{RepositoryID: g.target.RepositoryID, DeliveryKey: key, Source: "github", EventType: "push", Payload: json.RawMessage(`{"before":"first"}`)}
	require.NoError(t, q.AdmitRepositoryJobEvent(ctx, input))
	input.Payload = json.RawMessage(`{"before":"forged-retry"}`)
	require.NoError(t, q.AdmitRepositoryJobEvent(ctx, input))
	read := db.GetRepositorySourcePushEventParams{RepositoryID: g.target.RepositoryID, DeliveryKey: key}
	payload, err := q.GetRepositorySourcePushEvent(ctx, read)
	require.NoError(t, err)
	require.JSONEq(t, `{"before":"first"}`, string(payload))
	read.RepositoryID++
	_, err = q.GetRepositorySourcePushEvent(ctx, read)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	input.DeliveryKey = "github:" + uuid.NewString()
	input.Source = "smithers-cloud"
	require.NoError(t, q.AdmitRepositoryJobEvent(ctx, input))
	_, err = q.GetRepositorySourcePushEvent(ctx, db.GetRepositorySourcePushEventParams{RepositoryID: input.RepositoryID, DeliveryKey: input.DeliveryKey})
	require.ErrorIs(t, err, pgx.ErrNoRows)
}
