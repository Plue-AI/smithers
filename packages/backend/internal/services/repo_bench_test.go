package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// --- mock implementations for benchmarks ---

type benchRepoQuerier struct {
	repo db.Repository
}

func (m *benchRepoQuerier) CreateRepo(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
	return db.Repository{
		ID:              1,
		Name:            arg.Name,
		LowerName:       arg.LowerName,
		IsPublic:        arg.IsPublic,
		UserID:          arg.UserID,
		DefaultBookmark: arg.DefaultBookmark,
	}, nil
}

func (m *benchRepoQuerier) CreateOrgRepo(_ context.Context, _ db.CreateOrgRepoParams) (db.Repository, error) {
	return db.Repository{}, nil
}

func (m *benchRepoQuerier) CreateForkRepo(_ context.Context, _ db.CreateForkRepoParams) (db.Repository, error) {
	return db.Repository{}, nil
}

func (m *benchRepoQuerier) DeleteRepo(_ context.Context, _ int64) error { return nil }

func (m *benchRepoQuerier) GetRepoByID(_ context.Context, _ int64) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchRepoQuerier) GetRepoByOwnerAndLowerName(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchRepoQuerier) UpdateRepo(_ context.Context, _ db.UpdateRepoParams) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchRepoQuerier) UpdateRepoTopics(_ context.Context, arg db.UpdateRepoTopicsParams) (db.Repository, error) {
	r := m.repo
	r.Topics = arg.Topics
	return r, nil
}

func (m *benchRepoQuerier) IsOrgOwnerForRepoUser(_ context.Context, _ db.IsOrgOwnerForRepoUserParams) (bool, error) {
	return false, nil
}

func (m *benchRepoQuerier) GetHighestTeamPermissionForRepoUser(_ context.Context, _ db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	return "", nil
}

func (m *benchRepoQuerier) GetCollaboratorPermissionForRepoUser(_ context.Context, _ db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	return "admin", nil
}

func (m *benchRepoQuerier) GetOrgByLowerName(_ context.Context, _ string) (db.Organization, error) {
	return db.Organization{}, nil
}

func (m *benchRepoQuerier) GetOrgMember(_ context.Context, _ db.GetOrgMemberParams) (db.OrgMember, error) {
	return db.OrgMember{}, nil
}

func (m *benchRepoQuerier) ListRepoStargazers(_ context.Context, _ db.ListRepoStargazersParams) ([]db.User, error) {
	return nil, nil
}

func (m *benchRepoQuerier) CountRepoStars(_ context.Context, _ int64) (int64, error) {
	return 0, nil
}

func (m *benchRepoQuerier) CountRepoForks(_ context.Context, _ pgtype.Int8) (int64, error) {
	return 0, nil
}

func (m *benchRepoQuerier) IsRepoStarred(_ context.Context, _ db.IsRepoStarredParams) (bool, error) {
	return false, nil
}

func (m *benchRepoQuerier) StarRepo(_ context.Context, _ db.StarRepoParams) (db.Star, error) {
	return db.Star{}, nil
}

func (m *benchRepoQuerier) UnstarRepo(_ context.Context, _ db.UnstarRepoParams) (int64, error) {
	return 1, nil
}

func (m *benchRepoQuerier) ArchiveRepo(_ context.Context, _ int64) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchRepoQuerier) UnarchiveRepo(_ context.Context, _ int64) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchRepoQuerier) GetUserByLowerUsername(_ context.Context, _ string) (db.User, error) {
	return db.User{ID: 1, Username: "testuser"}, nil
}

func (m *benchRepoQuerier) TransferRepoToUser(_ context.Context, _ db.TransferRepoToUserParams) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchRepoQuerier) TransferRepoToOrg(_ context.Context, _ db.TransferRepoToOrgParams) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchRepoQuerier) DeleteCollaboratorsByRepo(_ context.Context, _ int64) error { return nil }
func (m *benchRepoQuerier) DeleteTeamReposByRepo(_ context.Context, _ int64) error     { return nil }
func (m *benchRepoQuerier) ListCollaboratorsByRepo(_ context.Context, _ int64) ([]db.Collaborator, error) {
	return nil, nil
}
func (m *benchRepoQuerier) ListTeamReposByRepo(_ context.Context, _ int64) ([]db.TeamRepo, error) {
	return nil, nil
}
func (m *benchRepoQuerier) AddCollaborator(_ context.Context, arg db.AddCollaboratorParams) (db.Collaborator, error) {
	return db.Collaborator{RepositoryID: arg.RepositoryID, UserID: arg.UserID, Permission: arg.Permission}, nil
}
func (m *benchRepoQuerier) AddTeamRepo(_ context.Context, arg db.AddTeamRepoParams) (db.TeamRepo, error) {
	return db.TeamRepo{TeamID: arg.TeamID, RepositoryID: arg.RepositoryID}, nil
}

type benchRepoHostClient struct{}

func (m *benchRepoHostClient) InitRepo(_ context.Context, _, _, _ string, _ bool) error { return nil }
func (m *benchRepoHostClient) DeleteRepo(_ context.Context, _, _ string) error {
	return nil
}

func (m *benchRepoHostClient) MoveRepo(_ context.Context, _, _, _, _ string) error { return nil }
func (m *benchRepoHostClient) GetFileAtChange(_ context.Context, _, _, _, _ string) (repohost.FileContent, error) {
	return repohost.FileContent{Content: "test content"}, nil
}
func (m *benchRepoHostClient) ListBookmarks(_ context.Context, _, _, _ string, _ int) ([]repohost.Bookmark, string, error) {
	return []repohost.Bookmark{
		{Name: "main", TargetCommitID: "abc123", TargetChangeID: "xyz789"},
	}, "", nil
}
func (m *benchRepoHostClient) ListFilesAtChange(_ context.Context, _, _, _, _ string) ([]repohost.ChangeFile, error) {
	return nil, nil
}

// --- benchmarks ---

func BenchmarkRepoService_CreateRepo(b *testing.B) {
	user := &db.User{ID: 1, Username: "testuser"}
	svc := NewRepoService(&benchRepoQuerier{}, &benchRepoHostClient{}, "s1")
	ctx := context.Background()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := svc.CreateRepo(ctx, user, "test-repo", "A test repository", true, "", false)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkRepoService_GetRepo(b *testing.B) {
	repo := db.Repository{
		ID:        1,
		Name:      "test-repo",
		LowerName: "test-repo",
		IsPublic:  true,
		UserID:    pgtype.Int8{Int64: 1, Valid: true},
	}
	viewer := &db.User{ID: 1, Username: "testuser"}
	svc := NewRepoService(&benchRepoQuerier{repo: repo}, &benchRepoHostClient{}, "s1")
	ctx := context.Background()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := svc.GetRepo(ctx, viewer, "testuser", "test-repo")
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkRepoService_GetRepo_PublicAnonymous(b *testing.B) {
	repo := db.Repository{
		ID:        1,
		Name:      "test-repo",
		LowerName: "test-repo",
		IsPublic:  true,
	}
	svc := NewRepoService(&benchRepoQuerier{repo: repo}, &benchRepoHostClient{}, "s1")
	ctx := context.Background()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := svc.GetRepo(ctx, nil, "testuser", "test-repo")
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkValidateRepoName(b *testing.B) {
	b.Run("ValidShortName", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = validateRepoName("my-repo")
		}
	})

	b.Run("ValidLongName", func(b *testing.B) {
		name := "a-really-long-repository-name-with-dots.and-dashes-42"
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = validateRepoName(name)
		}
	})

	b.Run("ReservedName", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = validateRepoName("settings")
		}
	})

	b.Run("InvalidCharacters", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = validateRepoName("invalid repo name!")
		}
	})

	b.Run("DotGitSuffix", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = validateRepoName("repo.git")
		}
	})
}

func BenchmarkRepoPermission_OwnerCheck(b *testing.B) {
	repo := db.Repository{
		ID:     1,
		UserID: pgtype.Int8{Int64: 42, Valid: true},
	}
	svc := NewRepoService(&benchRepoQuerier{repo: repo}, &benchRepoHostClient{}, "s1")
	ctx := context.Background()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, err := repoPermissionForUser(ctx, svc.queries, repo, 42)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkRepoPermission_CollaboratorCheck(b *testing.B) {
	repo := db.Repository{
		ID:     1,
		UserID: pgtype.Int8{Int64: 99, Valid: true},
	}
	svc := NewRepoService(&benchRepoQuerier{repo: repo}, &benchRepoHostClient{}, "s1")
	ctx := context.Background()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, err := repoPermissionForUser(ctx, svc.queries, repo, 42)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkHighestRepoPermission(b *testing.B) {
	b.Run("SingleAdmin", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = highestRepoPermission("admin")
		}
	})

	b.Run("MultiplePermissions", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = highestRepoPermission("read", "write", "admin")
		}
	})

	b.Run("EmptyPermissions", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = highestRepoPermission("", "")
		}
	})
}

func BenchmarkNormalizeTopics(b *testing.B) {
	b.Run("FewTopics", func(b *testing.B) {
		topics := []string{"go", "testing", "benchmark"}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeTopics(topics)
		}
	})

	b.Run("ManyTopics", func(b *testing.B) {
		topics := make([]string, 20)
		for i := range topics {
			topics[i] = "topic-" + string(rune('a'+i))
		}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeTopics(topics)
		}
	})

	b.Run("WithDuplicates", func(b *testing.B) {
		topics := []string{"go", "testing", "go", "benchmark", "testing"}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeTopics(topics)
		}
	})
}

func (m *benchRepoHostClient) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	items, _, err := m.ListBookmarks(ctx, owner, repo, "", 100)
	if err != nil {
		return repohost.Bookmark{}, err
	}
	for _, bookmark := range items {
		if bookmark.Name == name {
			return bookmark, nil
		}
	}
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
}
