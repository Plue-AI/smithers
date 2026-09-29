package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockRepoRouteService struct {
	createRepoFn      func(ctx context.Context, user *db.User, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error)
	createOrgRepoFn   func(ctx context.Context, actor *db.User, orgName, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error)
	getRepoFn         func(ctx context.Context, viewer *db.User, owner, repo string) (db.Repository, error)
	updateRepoFn      func(ctx context.Context, actor *db.User, owner, repo string, req services.UpdateRepoRequest) (db.Repository, error)
	deleteRepoFn      func(ctx context.Context, actor *db.User, owner, repo string) error
	transferRepoFn    func(ctx context.Context, actor *db.User, owner, repo, newOwner string) (services.RepoTransferResult, error)
	listTransfersFn   func(ctx context.Context, actor *db.User) ([]db.RepositoryTransferRequest, error)
	acceptTransferFn  func(ctx context.Context, actor *db.User, id int64) (db.Repository, error)
	declineTransferFn func(ctx context.Context, actor *db.User, id int64) error
	cancelTransferFn  func(ctx context.Context, actor *db.User, id int64) error
	forkRepoFn        func(ctx context.Context, actor *db.User, owner, repo string, nameOverride, descriptionOverride string) (db.Repository, error)
	forkOutcomeFn     func(ctx context.Context, actor *db.User, owner, repo string, nameOverride, descriptionOverride string) (services.ForkOutcome, error)
	getRepoViewFn     func(ctx context.Context, viewer *db.User, owner, repo string) (services.RepoView, error)
	getContentsFn     func(ctx context.Context, viewer *db.User, owner, repo, ref, path string) (services.RepoContent, error)
	listContentsFn    func(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]services.RepoContent, error)
}

func TestRepositoryHomeResolution(t *testing.T) {
	for _, tc := range []struct {
		name   string
		files  map[string]string
		want   string
		status int
		paths  []string
	}{
		{"blocks", map[string]string{".smithers/home.json": `{"blocks":[{"type":"markdown","path":"docs/intro.md"}]}`, "docs/intro.md": "# Intro", "README.md": "# Fallback"}, `"kind":"blocks"`, 200, []string{".smithers/home.json", "docs/intro.md"}},
		{"stack", map[string]string{".smithers/home.json": `{"blocks":[{"type":"stack","title":"Stack"}]}`}, `{"type":"stack","title":"Stack"}`, 200, []string{".smithers/home.json"}},
		{"app", map[string]string{".smithers/home.json": `{"blocks":[{"type":"prompt","title":"What should we work on?"},{"type":"app","flow":"issue.implement","title":"Fix an issue","picture":"issue"}]}`}, `{"type":"app","title":"Fix an issue","flow":"issue.implement","picture":"issue"}`, 200, []string{".smithers/home.json"}},
		{"unknown", map[string]string{".smithers/home.json": `{"blocks":[{"type":"html"},{"type":"text","text":"Hi"}]}`}, `"blocks":[{"type":"text","text":"Hi"}]`, 200, []string{".smithers/home.json"}},
		{"readme", map[string]string{"README.md": "# Fallback"}, `"kind":"readme"`, 200, []string{".smithers/home.json", "README.md"}},
		{"none", map[string]string{}, `"kind":"none"`, 200, []string{".smithers/home.json", "README.md"}},
		{"empty markdown", map[string]string{".smithers/home.json": `{"blocks":[{"type":"markdown","path":"README.md"}]}`, "README.md": ""}, `"markdown":""`, 200, []string{".smithers/home.json", "README.md"}},
		{"oversized markdown", map[string]string{".smithers/home.json": `{"blocks":[{"type":"markdown","path":"README.md"}]}`, "README.md": strings.Repeat("x", homeMarkdownLimit+1)}, "", 400, []string{".smithers/home.json", "README.md"}},
		{"missing markdown", map[string]string{".smithers/home.json": `{"blocks":[{"type":"markdown","path":"docs/gone.md"}]}`}, "", 400, []string{".smithers/home.json", "docs/gone.md"}},
		{"escape", map[string]string{".smithers/home.json": `{"blocks":[{"type":"markdown","path":"../secret"}]}`}, "", 400, []string{".smithers/home.json"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var seen []string
			h := RepoHandler{Service: mockRepoRouteService{getContentsFn: func(_ context.Context, _ *db.User, _, _, ref, path string) (services.RepoContent, error) {
				require.Equal(t, "main", ref)
				seen = append(seen, path)
				if content, ok := tc.files[path]; ok {
					return services.RepoContent{Content: content, Size: int64(len(content))}, nil
				}
				return services.RepoContent{}, pkgerrors.NotFound("content not found")
			}}}
			req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/home", nil), map[string]string{"owner": "alice", "repo": "demo"})
			rec := httptest.NewRecorder()
			h.GetRepositoryHome(rec, req)
			require.Equal(t, tc.status, rec.Code)
			if tc.want != "" {
				assert.Contains(t, rec.Body.String(), tc.want)
			}
			assert.Equal(t, tc.paths, seen)
		})
	}
}

func TestRepositoryHomeMissingStorage(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want int
	}{
		{"missing storage", pkgerrors.NotFound("repository storage not found"), http.StatusNotFound},
		{"upstream failure", pkgerrors.Internal("failed to resolve bookmark"), http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			h := RepoHandler{Service: mockRepoRouteService{getContentsFn: func(context.Context, *db.User, string, string, string, string) (services.RepoContent, error) {
				calls++
				return services.RepoContent{}, tc.err
			}}}
			req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/home", nil), map[string]string{"owner": "alice", "repo": "demo"})
			rec := httptest.NewRecorder()
			h.GetRepositoryHome(rec, req)
			require.Equal(t, tc.want, rec.Code, rec.Body.String())
			assert.Equal(t, 1, calls)
		})
	}
}

type pagedRepoRouteService struct{ mockRepoRouteService }

func (pagedRepoRouteService) ListRepoContentsPage(_ context.Context, _ *db.User, _, _, _, path, after string, limit int) ([]services.RepoContent, string, string, error) {
	if path != "" || after != "README.md" || limit != 1 {
		return nil, "", "", pkgerrors.BadRequest("unexpected page query")
	}
	return []services.RepoContent{{Name: "apps", Path: "apps", Type: "dir"}}, "apps", "0123456789012345678901234567890123456789", nil
}

func TestRepoHandler_GetRepoContentsPage(t *testing.T) {
	h := RepoHandler{Service: pagedRepoRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/contents?limit=1&after=README.md", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()
	h.GetRepoContents(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "apps", rec.Header().Get("X-Next-Cursor"))
	assert.Equal(t, "0123456789012345678901234567890123456789", rec.Header().Get("X-Contents-Commit"))
	var entries []services.RepoContent
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &entries))
	assert.Equal(t, "apps", entries[0].Path)
	invalid := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/contents?limit=1001", nil)
	invalid = withRouteParams(invalid, map[string]string{"owner": "alice", "repo": "demo"})
	bad := httptest.NewRecorder()
	h.GetRepoContents(bad, invalid)
	assert.Equal(t, http.StatusBadRequest, bad.Code)
}

func (m mockRepoRouteService) CreateRepo(ctx context.Context, user *db.User, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error) {
	if m.createRepoFn != nil {
		return m.createRepoFn(ctx, user, name, description, isPublic, defaultBookmark, autoInit)
	}
	return db.Repository{}, nil
}

func (m mockRepoRouteService) GetRepo(ctx context.Context, viewer *db.User, owner, repo string) (db.Repository, error) {
	if m.getRepoFn != nil {
		return m.getRepoFn(ctx, viewer, owner, repo)
	}
	return db.Repository{}, nil
}

func (m mockRepoRouteService) CreateOrgRepo(ctx context.Context, actor *db.User, orgName, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error) {
	if m.createOrgRepoFn != nil {
		return m.createOrgRepoFn(ctx, actor, orgName, name, description, isPublic, defaultBookmark, autoInit)
	}
	return db.Repository{}, nil
}

func (m mockRepoRouteService) UpdateRepo(ctx context.Context, actor *db.User, owner, repo string, req services.UpdateRepoRequest) (db.Repository, error) {
	if m.updateRepoFn != nil {
		return m.updateRepoFn(ctx, actor, owner, repo, req)
	}
	return db.Repository{}, nil
}

func (m mockRepoRouteService) DeleteRepo(ctx context.Context, actor *db.User, owner, repo string) error {
	if m.deleteRepoFn != nil {
		return m.deleteRepoFn(ctx, actor, owner, repo)
	}
	return nil
}

func (m mockRepoRouteService) ForkRepo(ctx context.Context, actor *db.User, owner, repo string, nameOverride, descriptionOverride string) (services.ForkOutcome, error) {
	if m.forkOutcomeFn != nil {
		return m.forkOutcomeFn(ctx, actor, owner, repo, nameOverride, descriptionOverride)
	}
	if m.forkRepoFn != nil {
		forked, err := m.forkRepoFn(ctx, actor, owner, repo, nameOverride, descriptionOverride)
		return services.ForkOutcome{Repository: forked, Created: true}, err
	}
	return services.ForkOutcome{Created: true}, nil
}

func (m mockRepoRouteService) GetRepoView(ctx context.Context, viewer *db.User, owner, repo string) (services.RepoView, error) {
	if m.getRepoViewFn != nil {
		return m.getRepoViewFn(ctx, viewer, owner, repo)
	}
	repository, err := m.GetRepo(ctx, viewer, owner, repo)
	if err != nil {
		return services.RepoView{}, err
	}
	return services.RepoView{Repository: repository}, nil
}

func (m mockRepoRouteService) CheckRepoStarred(ctx context.Context, actor *db.User, owner, repo string) (bool, error) {
	return false, nil
}

func routeRepo(overrides func(*db.Repository)) db.Repository {
	now := time.Now().UTC().Truncate(time.Second)
	r := db.Repository{
		ID:              9,
		UserID:          pgtype.Int8{Int64: 1, Valid: true},
		Name:            "demo",
		LowerName:       "demo",
		Description:     "demo repo",
		IsPublic:        true,
		DefaultBookmark: "main",
		Topics:          []string{"jj"},
		IsArchived:      false,
		IsFork:          false,
		NumStars:        5,
		NumWatches:      7,
		NumIssues:       2,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if overrides != nil {
		overrides(&r)
	}
	return r
}

func TestRepoHandler_GetRepo(t *testing.T) {
	t.Parallel()
	h := RepoHandler{
		Service: mockRepoRouteService{
			getRepoFn: func(ctx context.Context, viewer *db.User, owner, repo string) (db.Repository, error) {
				require.Nil(t, viewer)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				return routeRepo(nil), nil
			},
		},
		SSHHost: "smithers.test",
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()
	h.GetRepo(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	var body RepoResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "alice", body.Owner)
	assert.Equal(t, "demo", body.Name)
	assert.Equal(t, []string{"jj"}, body.Topics)
	assert.Equal(t, int64(5), body.NumStars)
	assert.False(t, body.Private)
	assert.Equal(t, "unconfigured", body.MirrorStatus)
	assert.Nil(t, body.LastMirrorAt)
}

func TestMapRepoResponse_MirrorStatus(t *testing.T) {
	completedAt := time.Date(2026, 9, 2, 14, 47, 59, 999, time.UTC)
	repo := routeRepo(func(r *db.Repository) {
		r.MirrorStatus = "failed"
		r.LastMirrorAt = pgtype.Timestamptz{Time: completedAt, Valid: true}
		r.LastMirrorError = pgtype.Text{String: "destination rejected push", Valid: true}
		r.LastMirrorGithubHead = pgtype.Text{String: "0123456789abcdef", Valid: true}
		r.MirrorBehindRefs = 4
		r.MirrorFailedRefs = 2
	})

	resp := mapRepoResponse("alice", repo, "smithers.test")
	assert.Equal(t, "failed", resp.MirrorStatus)
	assert.Equal(t, int32(4), resp.BehindRefs)
	assert.Equal(t, int32(2), resp.FailedRefs)
	require.NotNil(t, resp.LastMirrorAt)
	assert.Equal(t, completedAt.Truncate(time.Second), *resp.LastMirrorAt)
	require.NotNil(t, resp.LastMirrorError)
	assert.Equal(t, "destination rejected push", *resp.LastMirrorError)
	require.NotNil(t, resp.LastMirrorGitHubHead)
	assert.Equal(t, "0123456789abcdef", *resp.LastMirrorGitHubHead)

	unconfigured := mapRepoResponse("alice", routeRepo(nil), "smithers.test")
	assert.Equal(t, "unconfigured", unconfigured.MirrorStatus)
	assert.Nil(t, unconfigured.LastMirrorAt)
}

func TestRepoHandler_CreateRepo(t *testing.T) {
	t.Parallel()
	t.Run("unauthorized when missing user", func(t *testing.T) {
		h := RepoHandler{Service: mockRepoRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/user/repos", strings.NewReader(`{"name":"demo"}`))
		rec := httptest.NewRecorder()
		h.CreateRepo(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})
	t.Run("invalid json", func(t *testing.T) {
		h := RepoHandler{Service: mockRepoRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/user/repos", strings.NewReader("not-json"))
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateRepo(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
	t.Run("happy path response contains repo fields", func(t *testing.T) {
		now := time.Now().UTC().Truncate(time.Second)
		h := RepoHandler{
			Service: mockRepoRouteService{
				createRepoFn: func(ctx context.Context, user *db.User, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error) {
					assert.Equal(t, int64(1), user.ID)
					assert.Equal(t, "alice", user.Username)
					assert.Equal(t, "demo", name)
					assert.Equal(t, "seed", description)
					assert.False(t, isPublic)
					assert.Equal(t, "trunk", defaultBookmark)
					assert.True(t, autoInit)
					return routeRepo(func(r *db.Repository) {
						r.ID = 11
						r.Name = "demo"
						r.Description = "seed"
						r.IsPublic = false
						r.DefaultBookmark = "trunk"
						r.Topics = []string{"jj", "stacked"}
						r.CreatedAt = now
						r.UpdatedAt = now
					}), nil
				},
			},
			SSHHost: "smithers.test",
		}
		req := httptest.NewRequest(http.MethodPost, "/api/user/repos", strings.NewReader(`{"name":"demo","description":"seed","private":true,"auto_init":true,"default_bookmark":"trunk"}`))
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateRepo(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)
		var body RepoResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, int64(11), body.ID)
		assert.Equal(t, "alice", body.Owner)
		assert.Equal(t, "alice/demo", body.FullName)
		assert.Equal(t, "seed", body.Description)
		assert.True(t, body.Private)
		assert.False(t, body.IsPublic)
		assert.Equal(t, "trunk", body.DefaultBookmark)
		assert.Equal(t, []string{"jj", "stacked"}, body.Topics)
		assert.Equal(t, "git@smithers.test:alice/demo.git", body.CloneURL)
	})
}

func TestRepoHandler_CreateOrgRepo(t *testing.T) {
	t.Parallel()
	t.Run("unauthorized when missing user", func(t *testing.T) {
		h := RepoHandler{Service: mockRepoRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/repos", strings.NewReader(`{"name":"demo"}`))
		req = withRouteParams(req, map[string]string{"org": "acme"})
		rec := httptest.NewRecorder()
		h.CreateOrgRepo(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})
	t.Run("invalid json", func(t *testing.T) {
		h := RepoHandler{Service: mockRepoRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/repos", strings.NewReader("not-json"))
		req = withRouteParams(req, map[string]string{"org": "acme"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateOrgRepo(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
	t.Run("happy path response contains org owner fields", func(t *testing.T) {
		now := time.Now().UTC().Truncate(time.Second)
		h := RepoHandler{
			Service: mockRepoRouteService{
				createOrgRepoFn: func(ctx context.Context, actor *db.User, orgName, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error) {
					assert.Equal(t, int64(1), actor.ID)
					assert.Equal(t, "acme", orgName)
					assert.Equal(t, "demo", name)
					assert.Equal(t, "seed", description)
					assert.True(t, isPublic)
					assert.Equal(t, "main", defaultBookmark)
					assert.False(t, autoInit)
					return routeRepo(func(r *db.Repository) {
						r.ID = 19
						r.Name = "demo"
						r.Description = "seed"
						r.IsPublic = true
						r.CreatedAt = now
						r.UpdatedAt = now
					}), nil
				},
			},
			SSHHost: "smithers.test",
		}
		req := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/repos", strings.NewReader(`{"name":"demo","description":"seed"}`))
		req = withRouteParams(req, map[string]string{"org": "acme"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateOrgRepo(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)
		var body RepoResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, int64(19), body.ID)
		assert.Equal(t, "acme", body.Owner)
		assert.Equal(t, "acme/demo", body.FullName)
		assert.False(t, body.Private)
		assert.True(t, body.IsPublic)
		assert.Equal(t, "git@smithers.test:acme/demo.git", body.CloneURL)
	})
}

func TestRepoHandler_GetRepo_PropagatesServiceError(t *testing.T) {
	t.Parallel()
	h := RepoHandler{
		Service: mockRepoRouteService{
			getRepoFn: func(ctx context.Context, viewer *db.User, owner, repo string) (db.Repository, error) {
				return db.Repository{}, pkgerrors.NotFound("repository not found")
			},
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/missing", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "missing"})
	rec := httptest.NewRecorder()
	h.GetRepo(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestRepoHandler_GetRepoContents(t *testing.T) {
	t.Parallel()

	t.Run("root lists directory entries", func(t *testing.T) {
		h := RepoHandler{
			Service: mockRepoRouteService{
				listContentsFn: func(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]services.RepoContent, error) {
					assert.Equal(t, "alice", owner)
					assert.Equal(t, "demo", repo)
					assert.Equal(t, "dev", ref)
					assert.Empty(t, dirPath)
					return []services.RepoContent{{Name: "README.md", Path: "README.md", Type: "file"}}, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/contents?ref=dev", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.GetRepoContents(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var body []services.RepoContent
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.Len(t, body, 1)
		assert.Equal(t, "README.md", body[0].Name)
	})

	t.Run("subdirectory path lists immediate children", func(t *testing.T) {
		getCalled := false
		h := RepoHandler{
			Service: mockRepoRouteService{
				listContentsFn: func(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]services.RepoContent, error) {
					assert.Equal(t, "src", dirPath)
					return []services.RepoContent{{Name: "main.go", Path: "src/main.go", Type: "file"}}, nil
				},
				getContentsFn: func(ctx context.Context, viewer *db.User, owner, repo, ref, path string) (services.RepoContent, error) {
					getCalled = true
					return services.RepoContent{}, pkgerrors.NotFound("content not found")
				},
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/contents/src", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "*": "src"})
		rec := httptest.NewRecorder()

		h.GetRepoContents(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, getCalled)
		var body []services.RepoContent
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.Len(t, body, 1)
		assert.Equal(t, "src/main.go", body[0].Path)
	})

	t.Run("nested directory path (multi-segment) lists via the catch-all", func(t *testing.T) {
		h := RepoHandler{
			Service: mockRepoRouteService{
				listContentsFn: func(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]services.RepoContent, error) {
					// The catch-all must deliver the FULL nested path — a regex
					// {path:.*} param only matched a single segment, so every
					// 2+ segment path 404'd and folder drill-down was broken.
					assert.Equal(t, "apps/cli", dirPath)
					return []services.RepoContent{{Name: "main.go", Path: "apps/cli/main.go", Type: "file"}}, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/contents/apps/cli", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "*": "apps/cli"})
		rec := httptest.NewRecorder()

		h.GetRepoContents(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var body []services.RepoContent
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.Len(t, body, 1)
		assert.Equal(t, "apps/cli/main.go", body[0].Path)
	})

	t.Run("file path falls back to content", func(t *testing.T) {
		h := RepoHandler{
			Service: mockRepoRouteService{
				listContentsFn: func(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]services.RepoContent, error) {
					assert.Equal(t, "README.md", dirPath)
					return []services.RepoContent{}, nil
				},
				getContentsFn: func(ctx context.Context, viewer *db.User, owner, repo, ref, path string) (services.RepoContent, error) {
					assert.Equal(t, "README.md", path)
					return services.RepoContent{Name: "README.md", Path: "README.md", Type: "file", Content: "# Demo"}, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/contents/README.md", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "*": "README.md"})
		rec := httptest.NewRecorder()

		h.GetRepoContents(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var body services.RepoContent
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "# Demo", body.Content)
	})

	// Regression: a NUL byte / control char in the ref (or path) must be rejected
	// with a clean 400 before it reaches the git/jj resolver, not surface as a 500.
	t.Run("ref with NUL byte returns 400 without hitting the service", func(t *testing.T) {
		called := false
		h := RepoHandler{
			Service: mockRepoRouteService{
				listContentsFn: func(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]services.RepoContent, error) {
					called = true
					return nil, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/contents", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		q := req.URL.Query()
		q.Set("ref", "\x00nul")
		req.URL.RawQuery = q.Encode()
		rec := httptest.NewRecorder()

		h.GetRepoContents(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, called, "service must not be reached for an invalid ref")
	})

	t.Run("ref with control char returns 400", func(t *testing.T) {
		h := RepoHandler{Service: mockRepoRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/contents", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		q := req.URL.Query()
		q.Set("ref", "main\x07bell")
		req.URL.RawQuery = q.Encode()
		rec := httptest.NewRecorder()

		h.GetRepoContents(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("path with NUL byte returns 400", func(t *testing.T) {
		h := RepoHandler{Service: mockRepoRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/contents/x", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "*": "src/\x00evil"})
		rec := httptest.NewRecorder()

		h.GetRepoContents(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("normal ref still works", func(t *testing.T) {
		h := RepoHandler{
			Service: mockRepoRouteService{
				listContentsFn: func(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]services.RepoContent, error) {
					assert.Equal(t, "main", ref)
					return []services.RepoContent{{Name: "README.md", Path: "README.md", Type: "file"}}, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/contents?ref=main", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.GetRepoContents(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
	})
}

func TestRepoHandler_PatchRepo(t *testing.T) {
	t.Parallel()
	t.Run("invalid json", func(t *testing.T) {
		h := RepoHandler{Service: mockRepoRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo", strings.NewReader("not-json"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PatchRepo(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
	t.Run("unauthorized when missing user", func(t *testing.T) {
		h := RepoHandler{Service: mockRepoRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo", strings.NewReader(`{"description":"new"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.PatchRepo(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})
	t.Run("happy path", func(t *testing.T) {
		h := RepoHandler{
			Service: mockRepoRouteService{
				updateRepoFn: func(ctx context.Context, actor *db.User, owner, repo string, req services.UpdateRepoRequest) (db.Repository, error) {
					assert.Equal(t, int64(1), actor.ID)
					assert.Equal(t, "alice", owner)
					assert.Equal(t, "demo", repo)
					require.NotNil(t, req.Description)
					assert.Equal(t, "new description", *req.Description)
					require.NotNil(t, req.Private)
					assert.True(t, *req.Private)
					require.NotNil(t, req.DefaultBookmark)
					assert.Equal(t, "trunk", *req.DefaultBookmark)
					require.NotNil(t, req.Topics)
					assert.Equal(t, []string{"jj", "stacked"}, *req.Topics)
					return routeRepo(func(r *db.Repository) {
						r.Description = "new description"
						r.IsPublic = false
						r.DefaultBookmark = "trunk"
						r.Topics = []string{"jj", "stacked"}
					}), nil
				},
			},
			SSHHost: "smithers.test",
		}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo", strings.NewReader(`{"description":"new description","private":true,"default_bookmark":"trunk","topics":["jj","stacked"]}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PatchRepo(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		var body RepoResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "new description", body.Description)
		assert.True(t, body.Private)
		assert.False(t, body.IsPublic)
		assert.Equal(t, "trunk", body.DefaultBookmark)
	})
}

func TestRepoHandler_DeleteRepo(t *testing.T) {
	t.Parallel()
	t.Run("unauthorized when missing user", func(t *testing.T) {
		h := RepoHandler{Service: mockRepoRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.DeleteRepo(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})
	t.Run("happy path", func(t *testing.T) {
		h := RepoHandler{
			Service: mockRepoRouteService{
				deleteRepoFn: func(ctx context.Context, actor *db.User, owner, repo string) error {
					assert.Equal(t, int64(1), actor.ID)
					assert.Equal(t, "alice", owner)
					assert.Equal(t, "demo", repo)
					return nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.DeleteRepo(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})
}

func TestRepoHandler_MissingOwnerOrRepoParams(t *testing.T) {
	t.Parallel()
	h := RepoHandler{Service: mockRepoRouteService{}}
	tests := []struct {
		name   string
		method string
		hit    func(http.ResponseWriter, *http.Request)
	}{
		{name: "get missing owner", method: http.MethodGet, hit: h.GetRepo},
		{name: "patch missing owner", method: http.MethodPatch, hit: h.PatchRepo},
		{name: "delete missing owner", method: http.MethodDelete, hit: h.DeleteRepo},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/api/repos//demo", strings.NewReader(`{}`))
			req = withRouteParams(req, map[string]string{"repo": "demo"})
			req = withAuth(req, 1, "alice")
			rec := httptest.NewRecorder()
			tc.hit(rec, req)
			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestRepoHandler_MissingRepoParam(t *testing.T) {
	t.Parallel()
	h := RepoHandler{Service: mockRepoRouteService{}}
	tests := []struct {
		name   string
		method string
		hit    func(http.ResponseWriter, *http.Request)
	}{
		{name: "get missing repo", method: http.MethodGet, hit: h.GetRepo},
		{name: "patch missing repo", method: http.MethodPatch, hit: h.PatchRepo},
		{name: "delete missing repo", method: http.MethodDelete, hit: h.DeleteRepo},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/api/repos/alice/", strings.NewReader(`{}`))
			req = withRouteParams(req, map[string]string{"owner": "alice"})
			req = withAuth(req, 1, "alice")
			rec := httptest.NewRecorder()
			tc.hit(rec, req)
			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestRepoHandler_CreateRepo_BodyTooLarge(t *testing.T) {
	t.Parallel()
	h := RepoHandler{Service: mockRepoRouteService{}}
	bigBody := `{"name":"` + strings.Repeat("a", 2<<20) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/user/repos", strings.NewReader(bigBody))
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.CreateRepo(rec, req)
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "request body too large", body["message"])
}

func TestRepoHandler_CreateOrgRepo_BodyTooLarge(t *testing.T) {
	t.Parallel()
	h := RepoHandler{Service: mockRepoRouteService{}}
	bigBody := `{"name":"` + strings.Repeat("a", 2<<20) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/repos", strings.NewReader(bigBody))
	req = withRouteParams(req, map[string]string{"org": "acme"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.CreateOrgRepo(rec, req)
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "request body too large", body["message"])
}

func TestRepoHandler_PatchRepo_BodyTooLarge(t *testing.T) {
	t.Parallel()
	h := RepoHandler{Service: mockRepoRouteService{}}
	bigBody := `{"description":"` + strings.Repeat("a", 2<<20) + `"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo", strings.NewReader(bigBody))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.PatchRepo(rec, req)
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "request body too large", body["message"])
}

func TestRepoHandler_ReplaceRepoTopics_BodyTooLarge(t *testing.T) {
	t.Parallel()
	h := RepoHandler{Service: mockRepoRouteService{}}
	bigBody := `{"topics":["` + strings.Repeat("a", 2<<20) + `"]}`
	req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/topics", strings.NewReader(bigBody))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.ReplaceRepoTopics(rec, req)
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "request body too large", body["message"])
}

func TestRepoHandler_CreateRepo_ServiceError(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		err      error
		wantCode int
	}{
		{name: "api error propagated", err: pkgerrors.NotFound("repo not found"), wantCode: http.StatusNotFound},
		{name: "non-api error becomes 500", err: assert.AnError, wantCode: http.StatusInternalServerError},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := RepoHandler{
				Service: mockRepoRouteService{
					createRepoFn: func(ctx context.Context, user *db.User, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error) {
						return db.Repository{}, tc.err
					},
				},
			}
			req := httptest.NewRequest(http.MethodPost, "/api/user/repos", strings.NewReader(`{"name":"demo"}`))
			req = withAuth(req, 1, "alice")
			rec := httptest.NewRecorder()
			h.CreateRepo(rec, req)
			require.Equal(t, tc.wantCode, rec.Code)
		})
	}
}

func TestRepoHandler_CreateOrgRepo_MissingOrgParam(t *testing.T) {
	t.Parallel()
	h := RepoHandler{Service: mockRepoRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/orgs//repos", strings.NewReader(`{"name":"demo"}`))
	req = withRouteParams(req, map[string]string{})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.CreateOrgRepo(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestRepoHandler_CreateOrgRepo_ServiceError(t *testing.T) {
	t.Parallel()
	h := RepoHandler{
		Service: mockRepoRouteService{
			createOrgRepoFn: func(ctx context.Context, actor *db.User, orgName, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error) {
				return db.Repository{}, pkgerrors.Forbidden("insufficient permissions")
			},
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/repos", strings.NewReader(`{"name":"demo"}`))
	req = withRouteParams(req, map[string]string{"org": "acme"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.CreateOrgRepo(rec, req)
	require.Equal(t, http.StatusForbidden, rec.Code)
}

func TestRepoHandler_DeleteRepo_ServiceError(t *testing.T) {
	t.Parallel()
	h := RepoHandler{
		Service: mockRepoRouteService{
			deleteRepoFn: func(ctx context.Context, actor *db.User, owner, repo string) error {
				return pkgerrors.NotFound("repository not found")
			},
		},
	}
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.DeleteRepo(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestMapRepoResponse_EmptyOwnerAndSSHHost(t *testing.T) {
	t.Parallel()
	repo := routeRepo(nil)
	resp := mapRepoResponse("", repo, "")
	assert.Equal(t, "unknown", resp.Owner)
	assert.False(t, resp.Private)
	assert.Equal(t, "git@localhost:unknown/demo.git", resp.CloneURL)
	assert.Equal(t, "unknown/demo", resp.FullName)
}

func TestMapRepoResponse_SSHURLFormat(t *testing.T) {
	t.Parallel()
	repo := routeRepo(nil)
	resp := mapRepoResponse("alice", repo, "smithers.sh")
	assert.Equal(t, "alice/demo", resp.FullName)
	assert.False(t, resp.Private)
	assert.Equal(t, "git@smithers.sh:alice/demo.git", resp.CloneURL)
}

func TestMapRepoResponse_PrivateMatchesVisibility(t *testing.T) {
	t.Parallel()
	resp := mapRepoResponse("alice", routeRepo(func(r *db.Repository) {
		r.IsPublic = false
	}), "smithers.sh")
	assert.False(t, resp.IsPublic)
	assert.True(t, resp.Private)
}

func TestRepoHandler_PatchRepo_ServiceError(t *testing.T) {
	t.Parallel()
	h := RepoHandler{
		Service: mockRepoRouteService{
			updateRepoFn: func(ctx context.Context, actor *db.User, owner, repo string, req services.UpdateRepoRequest) (db.Repository, error) {
				return db.Repository{}, pkgerrors.Conflict("repository name already exists")
			},
		},
	}
	req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo", strings.NewReader(`{"description":"new"}`))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.PatchRepo(rec, req)
	require.Equal(t, http.StatusConflict, rec.Code)
}

func TestRepoHandler_TransferRepo(t *testing.T) {
	t.Parallel()

	t.Run("unauthorized when missing user", func(t *testing.T) {
		h := RepoHandler{Service: mockRepoRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/transfer", strings.NewReader(`{"new_owner":"bob"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.TransferRepo(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("invalid json", func(t *testing.T) {
		h := RepoHandler{Service: mockRepoRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/transfer", strings.NewReader("not-json"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.TransferRepo(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("body too large", func(t *testing.T) {
		h := RepoHandler{Service: mockRepoRouteService{}}
		bigBody := `{"new_owner":"` + strings.Repeat("a", 2<<20) + `"}`
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/transfer", strings.NewReader(bigBody))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.TransferRepo(rec, req)
		require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	})

	t.Run("user transfer remains at source until accepted", func(t *testing.T) {
		now := time.Now().UTC().Truncate(time.Second)
		pending := &db.RepositoryTransferRequest{ID: 77, RepositoryID: 1, SenderID: 1, RecipientID: 2, SourceOwner: "alice", SourceName: "demo", Status: "pending"}
		h := RepoHandler{
			Service: mockRepoRouteService{
				transferRepoFn: func(ctx context.Context, actor *db.User, owner, repo, newOwner string) (services.RepoTransferResult, error) {
					assert.Equal(t, int64(1), actor.ID)
					assert.Equal(t, "alice", owner)
					assert.Equal(t, "demo", repo)
					assert.Equal(t, "bob", newOwner)
					return services.RepoTransferResult{Repository: routeRepo(func(r *db.Repository) {
						r.UserID = pgtype.Int8{Int64: 1, Valid: true}
						r.CreatedAt = now
						r.UpdatedAt = now
					}), Owner: "alice", PendingTransfer: pending}, nil
				},
			},
			SSHHost: "smithers.test",
		}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/transfer", strings.NewReader(`{"new_owner":"bob"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.TransferRepo(rec, req)
		require.Equal(t, http.StatusAccepted, rec.Code)
		var body RepoResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "alice", body.Owner)
		assert.Equal(t, "alice/demo", body.FullName)
		assert.Equal(t, "demo", body.Name)
		assert.Equal(t, "git@smithers.test:alice/demo.git", body.CloneURL)
		require.NotNil(t, body.PendingTransfer)
		assert.Equal(t, pending.ID, body.PendingTransfer.ID)
	})

	t.Run("organization transfer changes owner immediately", func(t *testing.T) {
		h := RepoHandler{Service: mockRepoRouteService{transferRepoFn: func(_ context.Context, _ *db.User, _, _, _ string) (services.RepoTransferResult, error) {
			return services.RepoTransferResult{Repository: routeRepo(nil), Owner: "acme"}, nil
		}}, SSHHost: "smithers.test"}
		req := withAuth(withRouteParams(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/transfer", strings.NewReader(`{"new_owner":"acme"}`)), map[string]string{"owner": "alice", "repo": "demo"}), 1, "alice")
		rec := httptest.NewRecorder()
		h.TransferRepo(rec, req)
		require.Equal(t, http.StatusAccepted, rec.Code)
		var body RepoResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "acme/demo", body.FullName)
		assert.Equal(t, "git@smithers.test:acme/demo.git", body.CloneURL)
		assert.Nil(t, body.PendingTransfer)
	})

	t.Run("service 403 propagated", func(t *testing.T) {
		h := RepoHandler{
			Service: mockRepoRouteService{
				transferRepoFn: func(ctx context.Context, actor *db.User, owner, repo, newOwner string) (services.RepoTransferResult, error) {
					return services.RepoTransferResult{}, pkgerrors.Forbidden("permission denied")
				},
			},
		}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/transfer", strings.NewReader(`{"new_owner":"bob"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "mallory")
		rec := httptest.NewRecorder()
		h.TransferRepo(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("service 404 propagated", func(t *testing.T) {
		h := RepoHandler{
			Service: mockRepoRouteService{
				transferRepoFn: func(ctx context.Context, actor *db.User, owner, repo, newOwner string) (services.RepoTransferResult, error) {
					return services.RepoTransferResult{}, pkgerrors.NotFound("user or organization 'nobody' not found")
				},
			},
		}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/transfer", strings.NewReader(`{"new_owner":"nobody"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.TransferRepo(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("service 409 propagated", func(t *testing.T) {
		h := RepoHandler{
			Service: mockRepoRouteService{
				transferRepoFn: func(ctx context.Context, actor *db.User, owner, repo, newOwner string) (services.RepoTransferResult, error) {
					return services.RepoTransferResult{}, pkgerrors.Conflict("user 'bob' already has a repository named 'demo'")
				},
			},
		}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/transfer", strings.NewReader(`{"new_owner":"bob"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.TransferRepo(rec, req)
		require.Equal(t, http.StatusConflict, rec.Code)
	})
}
