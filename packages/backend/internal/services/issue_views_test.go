package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// issueViewHost serves one factory projection on main, or the failure named.
type issueViewHost struct {
	factory     string
	noBookmark  bool
	bookmarkErr error
	fileErr     error
	file        *repohost.FileContent
	reads       []string
}

func (h *issueViewHost) GetBookmark(_ context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	if h.bookmarkErr != nil {
		return repohost.Bookmark{}, h.bookmarkErr
	}
	if h.noBookmark || name != "main" {
		return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
	}
	return repohost.Bookmark{Name: "main", TargetCommitID: strings.Repeat("c", 40)}, nil
}

func (h *issueViewHost) GetFileAtChange(context.Context, string, string, string, string) (repohost.FileContent, error) {
	return repohost.FileContent{}, errors.New("views read main's commit, never a change")
}

func (h *issueViewHost) GetFileAtCommit(_ context.Context, owner, repo, commit, path string) (repohost.FileContent, error) {
	h.reads = append(h.reads, owner+"/"+repo+"@"+commit+":"+path)
	if h.fileErr != nil {
		return repohost.FileContent{}, h.fileErr
	}
	if h.file != nil {
		return *h.file, nil
	}
	if h.factory == "" {
		return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404, Code: "file_not_found"}
	}
	return repohost.FileContent{Content: h.factory}, nil
}

const issueViewsFactory = `{"summary":"S.","flows":[],"on":[],"github":{"mirror":"pull","issues":"read","changes":"send-upstream"},
"issueViews":[{"id":"bugs","title":"Open bugs","state":"open","labels":["Bug","P1"]},{"id":"everything","title":"Everything"}]}`

// viewRepo is a repository whose default bookmark is main.
func viewRepo(overrides func(*db.Repository)) db.Repository {
	return issueRepo(func(r *db.Repository) {
		r.DefaultBookmark = "main"
		if overrides != nil {
			overrides(r)
		}
	})
}

func issueViewQuerier(repo db.Repository) *mockIssueQuerier {
	return &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		listIssuesByRepoFilteredKeysetFn: func(_ context.Context, arg db.ListIssuesByRepoFilteredKeysetParams) ([]db.Issue, error) {
			return []db.Issue{issueDBRecord(10, arg.RepositoryID, 9, 2, nil), issueDBRecord(11, arg.RepositoryID, 7, 2, nil)}, nil
		},
		countIssuesByRepoFilteredFn: func(context.Context, db.CountIssuesByRepoFilteredParams) (int64, error) {
			return 5, nil
		},
		listIssueAssigneesFn: func(context.Context, int64) ([]db.ListIssueAssigneesRow, error) {
			return []db.ListIssueAssigneesRow{}, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
	}
}

func TestParseFactoryIssueViews(t *testing.T) {
	t.Parallel()
	views, err := parseFactoryIssueViews([]byte(issueViewsFactory))
	require.NoError(t, err)
	assert.Equal(t, []IssueView{
		{ID: "bugs", Title: "Open bugs", State: "open", Labels: []string{"Bug", "P1"}},
		{ID: "everything", Title: "Everything"},
	}, views)

	for name, projection := range map[string]string{"absent": "", "no key": `{"on":[]}`, "empty": `{"issueViews":[]}`} {
		views, err := parseFactoryIssueViews([]byte(projection))
		require.NoError(t, err, name)
		assert.NotNil(t, views, name)
		assert.Empty(t, views, name)
	}

	many := make([]string, 0, maximumIssueViews+1)
	for i := 0; i <= maximumIssueViews; i++ {
		many = append(many, `{"id":"v`+strings.Repeat("x", i%3)+string(rune('a'+i%26))+`","title":"V"}`)
	}
	labels := make([]string, 0, maximumIssueViewLabels+1)
	for i := 0; i <= maximumIssueViewLabels; i++ {
		labels = append(labels, `"l`+string(rune('a'+i))+`"`)
	}
	refused := map[string]string{
		"not json":        `{`,
		"not a list":      `{"issueViews":{}}`,
		"too many":        `{"issueViews":[` + strings.Join(many, ",") + `]}`,
		"bad id":          `{"issueViews":[{"id":"Bugs","title":"B"}]}`,
		"empty id":        `{"issueViews":[{"id":"","title":"B"}]}`,
		"duplicate id":    `{"issueViews":[{"id":"b","title":"B"},{"id":"b","title":"C"}]}`,
		"empty title":     `{"issueViews":[{"id":"b","title":" "}]}`,
		"two-line title":  `{"issueViews":[{"id":"b","title":"a\nb"}]}`,
		"bad state":       `{"issueViews":[{"id":"b","title":"B","state":"stale"}]}`,
		"too many labels": `{"issueViews":[{"id":"b","title":"B","labels":[` + strings.Join(labels, ",") + `]}]}`,
		"blank label":     `{"issueViews":[{"id":"b","title":"B","labels":[""]}]}`,
		"padded label":    `{"issueViews":[{"id":"b","title":"B","labels":[" bug"]}]}`,
		"long label":      `{"issueViews":[{"id":"b","title":"B","labels":["` + strings.Repeat("é", 256) + `"]}]}`,
		"repeated label":  `{"issueViews":[{"id":"b","title":"B","labels":["Bug","bug"]}]}`,
	}
	for name, projection := range refused {
		_, err := parseFactoryIssueViews([]byte(projection))
		assert.Error(t, err, name)
	}
	_, err = parseFactoryIssueViews([]byte(`{"issueViews":[{"id":"b","title":"B","labels":["` + strings.Repeat("é", 255) + `"]}]}`))
	assert.NoError(t, err, "255 characters is a label name")
}

func TestIssueService_ListIssueViews(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("reads main's committed projection in declaration order", func(t *testing.T) {
		host := &issueViewHost{factory: issueViewsFactory}
		svc := NewIssueService(issueViewQuerier(viewRepo(nil)), WithIssueFactoryReader(host))
		views, err := svc.ListIssueViews(ctx, nil, "alice", "demo")
		require.NoError(t, err)
		require.Len(t, views, 2)
		assert.Equal(t, "bugs", views[0].ID)
		assert.Equal(t, "everything", views[1].ID)
		assert.Equal(t, []string{"alice/demo@" + strings.Repeat("c", 40) + ":.smithers/factory.json"}, host.reads)
	})

	none := map[string]IssueServiceOption{
		"no reader":     nil,
		"no bookmark":   WithIssueFactoryReader(&issueViewHost{noBookmark: true}),
		"no projection": WithIssueFactoryReader(&issueViewHost{}),
		"no views":      WithIssueFactoryReader(&issueViewHost{factory: `{"on":[]}`}),
	}
	for name, option := range none {
		t.Run(name+" declares none", func(t *testing.T) {
			svc := NewIssueService(issueViewQuerier(viewRepo(nil)), option)
			views, err := svc.ListIssueViews(ctx, nil, "alice", "demo")
			require.NoError(t, err)
			assert.NotNil(t, views)
			assert.Empty(t, views)
		})
	}

	failures := map[string]struct {
		host   *issueViewHost
		status int
	}{
		"bookmark read fails": {host: &issueViewHost{bookmarkErr: errors.New("down")}, status: 500},
		"file read fails":     {host: &issueViewHost{fileErr: errors.New("down")}, status: 500},
		"too large":           {host: &issueViewHost{file: &repohost.FileContent{TooLarge: true}}, status: 422},
		"binary":              {host: &issueViewHost{file: &repohost.FileContent{Encoding: "base64"}}, status: 422},
		"malformed":           {host: &issueViewHost{factory: `{"issueViews":[{"id":"B","title":"B"}]}`}, status: 422},
	}
	for name, tc := range failures {
		t.Run(name+" fails visibly", func(t *testing.T) {
			svc := NewIssueService(issueViewQuerier(viewRepo(nil)), WithIssueFactoryReader(tc.host))
			_, err := svc.ListIssueViews(ctx, nil, "alice", "demo")
			assert.Equal(t, tc.status, issueAPIStatus(t, err))
		})
	}

	t.Run("a private repository refuses an anonymous viewer before reading", func(t *testing.T) {
		host := &issueViewHost{factory: issueViewsFactory}
		private := viewRepo(func(r *db.Repository) {
			r.IsPublic = false
			r.OrgID = pgtype.Int8{Int64: 9, Valid: true}
			r.UserID = pgtype.Int8{}
		})
		svc := NewIssueService(issueViewQuerier(private), WithIssueFactoryReader(host))
		_, err := svc.ListIssueViews(ctx, nil, "alice", "demo")
		assert.Equal(t, 403, issueAPIStatus(t, err))
		assert.Empty(t, host.reads)
		_, _, _, err = svc.ListIssuesInView(ctx, nil, "alice", "demo", "bugs", 0, 10)
		assert.Equal(t, 403, issueAPIStatus(t, err))
		assert.Empty(t, host.reads)
	})

	t.Run("an unknown repository is not found", func(t *testing.T) {
		q := issueViewQuerier(viewRepo(nil))
		q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, errors.New("no rows")
		}
		svc := NewIssueService(q, WithIssueFactoryReader(&issueViewHost{factory: issueViewsFactory}))
		_, err := svc.ListIssueViews(ctx, nil, "alice", "demo")
		assert.Error(t, err)
		_, _, _, err = svc.ListIssuesInView(ctx, nil, "alice", "demo", "bugs", 0, 10)
		assert.Error(t, err)
	})
}

func TestIssueService_ListIssuesInView(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("applies the view's state and lowercased labels to the page and the count", func(t *testing.T) {
		q := issueViewQuerier(viewRepo(nil))
		svc := NewIssueService(q, WithIssueFactoryReader(&issueViewHost{factory: issueViewsFactory}))
		items, cursor, total, err := svc.ListIssuesInView(ctx, nil, "alice", "demo", "bugs", 40, 2)
		require.NoError(t, err)
		require.Len(t, items, 2)
		assert.Equal(t, int64(5), total)
		assert.Equal(t, encodeIssueNumberCursor(7), cursor, "a full page continues after its last number")
		assert.Equal(t, "open", q.lastListIssuesKeysetArg.State)
		assert.Equal(t, []string{"bug", "p1"}, q.lastListIssuesKeysetArg.Labels)
		assert.Equal(t, int64(40), q.lastListIssuesKeysetArg.AfterNumber)
		assert.Equal(t, int32(2), q.lastListIssuesKeysetArg.PageSize)
		assert.Equal(t, "open", q.lastCountIssuesArg.State)
		assert.Equal(t, []string{"bug", "p1"}, q.lastCountIssuesArg.Labels)
	})

	t.Run("a view without filters lists every state and label", func(t *testing.T) {
		q := issueViewQuerier(viewRepo(nil))
		svc := NewIssueService(q, WithIssueFactoryReader(&issueViewHost{factory: issueViewsFactory}))
		_, cursor, _, err := svc.ListIssuesInView(ctx, nil, "alice", "demo", "everything", 0, 30)
		require.NoError(t, err)
		assert.Empty(t, cursor, "a short page is the last")
		assert.Equal(t, "", q.lastListIssuesKeysetArg.State)
		assert.Empty(t, q.lastListIssuesKeysetArg.Labels)
	})

	t.Run("the plain list carries no labels", func(t *testing.T) {
		q := issueViewQuerier(viewRepo(nil))
		svc := NewIssueService(q, WithIssueFactoryReader(&issueViewHost{factory: issueViewsFactory}))
		_, _, _, err := svc.ListIssues(ctx, nil, "alice", "demo", 0, 30, "closed")
		require.NoError(t, err)
		assert.Nil(t, q.lastListIssuesKeysetArg.Labels)
		assert.Equal(t, "closed", q.lastListIssuesKeysetArg.State)
	})

	t.Run("an undeclared view is not found and lists nothing", func(t *testing.T) {
		q := issueViewQuerier(viewRepo(nil))
		svc := NewIssueService(q, WithIssueFactoryReader(&issueViewHost{factory: issueViewsFactory}))
		_, _, _, err := svc.ListIssuesInView(ctx, nil, "alice", "demo", "missing", 0, 30)
		assert.Equal(t, 404, issueAPIStatus(t, err))
		assert.Equal(t, db.ListIssuesByRepoFilteredKeysetParams{}, q.lastListIssuesKeysetArg)
	})

	t.Run("a failed projection read fails the list", func(t *testing.T) {
		svc := NewIssueService(issueViewQuerier(viewRepo(nil)), WithIssueFactoryReader(&issueViewHost{fileErr: errors.New("down")}))
		_, _, _, err := svc.ListIssuesInView(ctx, nil, "alice", "demo", "bugs", 0, 30)
		assert.Equal(t, 500, issueAPIStatus(t, err))
	})

	t.Run("a failed count fails the list", func(t *testing.T) {
		q := issueViewQuerier(viewRepo(nil))
		q.countIssuesByRepoFilteredFn = func(context.Context, db.CountIssuesByRepoFilteredParams) (int64, error) {
			return 0, errors.New("db down")
		}
		svc := NewIssueService(q, WithIssueFactoryReader(&issueViewHost{factory: issueViewsFactory}))
		_, _, _, err := svc.ListIssuesInView(ctx, nil, "alice", "demo", "bugs", 0, 30)
		assert.Equal(t, 500, issueAPIStatus(t, err))
	})
}
