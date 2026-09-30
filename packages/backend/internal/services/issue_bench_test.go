package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// --- mock implementations for issue benchmarks ---

type benchIssueQuerier struct {
	repo  db.Repository
	issue db.Issue
	user  db.User
}

func (m *benchIssueQuerier) GetRepoByOwnerAndLowerName(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchIssueQuerier) IsOrgOwnerForRepoUser(_ context.Context, _ db.IsOrgOwnerForRepoUserParams) (bool, error) {
	return false, nil
}

func (m *benchIssueQuerier) GetHighestTeamPermissionForRepoUser(_ context.Context, _ db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	return "", nil
}

func (m *benchIssueQuerier) GetCollaboratorPermissionForRepoUser(_ context.Context, _ db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	return "write", nil
}

func (m *benchIssueQuerier) GetUserByID(_ context.Context, _ int64) (db.User, error) {
	return m.user, nil
}

func (m *benchIssueQuerier) GetUserByLowerUsername(_ context.Context, _ string) (db.User, error) {
	return m.user, nil
}

func (m *benchIssueQuerier) GetMilestoneByID(_ context.Context, _ db.GetMilestoneByIDParams) (db.Milestone, error) {
	return db.Milestone{}, nil
}

func (m *benchIssueQuerier) CreateIssueEvent(_ context.Context, arg db.CreateIssueEventParams) (db.IssueEvent, error) {
	return db.IssueEvent{IssueID: arg.IssueID, ActorID: arg.ActorID, EventType: arg.EventType, Payload: arg.Payload}, nil
}

func (m *benchIssueQuerier) CreateIssue(_ context.Context, arg db.CreateIssueParams) (db.Issue, error) {
	return db.Issue{
		ID:           1,
		RepositoryID: arg.RepositoryID,
		Number:       1,
		Title:        arg.Title,
		Body:         arg.Body,
		State:        "open",
		AuthorID:     arg.AuthorID,
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}, nil
}

func (m *benchIssueQuerier) GetIssueByNumber(_ context.Context, _ db.GetIssueByNumberParams) (db.Issue, error) {
	return m.issue, nil
}

func (m *benchIssueQuerier) GetIssueByID(_ context.Context, _ int64) (db.Issue, error) {
	return m.issue, nil
}

func (m *benchIssueQuerier) ListIssuesByRepoFiltered(_ context.Context, _ db.ListIssuesByRepoFilteredParams) ([]db.Issue, error) {
	issues := make([]db.Issue, 10)
	for i := range issues {
		issues[i] = db.Issue{
			ID:           int64(i + 1),
			RepositoryID: m.repo.ID,
			Number:       int64(i + 1),
			Title:        "Test issue",
			Body:         "This is a test issue body for benchmarking",
			State:        "open",
			AuthorID:     m.user.ID,
			CreatedAt:    time.Now().UTC(),
			UpdatedAt:    time.Now().UTC(),
		}
	}
	return issues, nil
}

func (m *benchIssueQuerier) CountIssuesByRepoFiltered(_ context.Context, _ db.CountIssuesByRepoFilteredParams) (int64, error) {
	return 10, nil
}

func (m *benchIssueQuerier) UpdateIssue(_ context.Context, _ db.UpdateIssueParams) (db.Issue, error) {
	return m.issue, nil
}

func (m *benchIssueQuerier) ListIssueAssignees(_ context.Context, _ int64) ([]db.ListIssueAssigneesRow, error) {
	return []db.ListIssueAssigneesRow{
		{ID: 1, Username: "testuser"},
	}, nil
}

func (m *benchIssueQuerier) ReplaceIssueAssignees(_ context.Context, _ db.ReplaceIssueAssigneesParams) error {
	return nil
}

func (m *benchIssueQuerier) ListLabelsByNames(_ context.Context, _ db.ListLabelsByNamesParams) ([]db.Label, error) {
	return nil, nil
}

func (m *benchIssueQuerier) ReplaceIssueLabels(_ context.Context, _ db.ReplaceIssueLabelsParams) error {
	return nil
}

func (m *benchIssueQuerier) CountLabelsForIssue(_ context.Context, _ int64) (int64, error) {
	return 0, nil
}

func (m *benchIssueQuerier) ListLabelsForIssue(_ context.Context, _ db.ListLabelsForIssueParams) ([]db.Label, error) {
	return nil, nil
}

func (m *benchIssueQuerier) CreateIssueComment(_ context.Context, arg db.CreateIssueCommentParams) (db.IssueComment, error) {
	return db.IssueComment{
		ID:        1,
		IssueID:   arg.IssueID,
		UserID:    arg.UserID,
		Body:      arg.Body,
		Commenter: arg.Commenter,
		Type:      "comment",
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}, nil
}

func (m *benchIssueQuerier) ListIssueComments(_ context.Context, _ db.ListIssueCommentsParams) ([]db.IssueComment, error) {
	return nil, nil
}

func (m *benchIssueQuerier) ListIssuesByRepoFilteredKeyset(_ context.Context, arg db.ListIssuesByRepoFilteredKeysetParams) ([]db.Issue, error) {
	issues := make([]db.Issue, 10)
	for i := range issues {
		issues[i] = db.Issue{
			ID:           int64(i + 1),
			RepositoryID: m.repo.ID,
			Number:       int64(i + 1),
			Title:        "Test issue",
			State:        "open",
			AuthorID:     m.user.ID,
			CreatedAt:    time.Now().UTC(),
			UpdatedAt:    time.Now().UTC(),
		}
	}
	return issues, nil
}

func (m *benchIssueQuerier) ListIssueCommentsByIssueKeyset(_ context.Context, _ db.ListIssueCommentsByIssueKeysetParams) ([]db.IssueComment, error) {
	return nil, nil
}

func (m *benchIssueQuerier) ListIssueLastComments(_ context.Context, _ []int64) ([]db.ListIssueLastCommentsRow, error) {
	return nil, nil
}

func (m *benchIssueQuerier) CountIssueCommentsByIssue(_ context.Context, _ int64) (int64, error) {
	return 0, nil
}

func (m *benchIssueQuerier) GetIssueCommentByID(_ context.Context, _ int64) (db.IssueComment, error) {
	return db.IssueComment{}, nil
}

func (m *benchIssueQuerier) UpdateIssueComment(_ context.Context, _ db.UpdateIssueCommentParams) (db.IssueComment, error) {
	return db.IssueComment{}, nil
}

func (m *benchIssueQuerier) DeleteIssueComment(_ context.Context, _ int64) error { return nil }

func (m *benchIssueQuerier) GetIssueByCommentID(_ context.Context, _ int64) (db.Issue, error) {
	return m.issue, nil
}

func (m *benchIssueQuerier) CreateMention(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
	return db.Mention{}, nil
}

func (m *benchIssueQuerier) DeleteMentionsForComment(_ context.Context, _ db.DeleteMentionsForCommentParams) error {
	return nil
}

// --- benchmarks ---

func newBenchIssueService() (*IssueService, *benchIssueQuerier) {
	user := db.User{ID: 1, Username: "testuser", LowerUsername: "testuser"}
	repo := db.Repository{
		ID:        1,
		Name:      "test-repo",
		LowerName: "test-repo",
		IsPublic:  true,
		UserID:    pgtype.Int8{Int64: 1, Valid: true},
	}
	issue := db.Issue{
		ID:           1,
		RepositoryID: 1,
		Number:       1,
		Title:        "Test issue",
		Body:         "This is a test issue body for benchmarking",
		State:        "open",
		AuthorID:     1,
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}

	q := &benchIssueQuerier{repo: repo, issue: issue, user: user}
	svc := NewIssueService(q)
	return svc, q
}

func BenchmarkIssueService_CreateIssue(b *testing.B) {
	svc, _ := newBenchIssueService()
	actor := &db.User{ID: 1, Username: "testuser"}
	ctx := context.Background()

	req := CreateIssueInput{
		Title: "Benchmark issue",
		Body:  "This issue is created during a benchmark run to measure allocation overhead.",
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := svc.CreateIssue(ctx, actor, "testuser", "test-repo", req)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkIssueService_GetIssue(b *testing.B) {
	svc, _ := newBenchIssueService()
	viewer := &db.User{ID: 1, Username: "testuser"}
	ctx := context.Background()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := svc.GetIssue(ctx, viewer, "testuser", "test-repo", 1)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkIssueService_ListIssues(b *testing.B) {
	svc, _ := newBenchIssueService()
	viewer := &db.User{ID: 1, Username: "testuser"}
	ctx := context.Background()

	b.Run("OpenState", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _, _, err := svc.ListIssues(ctx, viewer, "testuser", "test-repo", 1, 20, "open")
			if err != nil {
				b.Fatal(err)
			}
		}
	})

	b.Run("AllStates", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _, _, err := svc.ListIssues(ctx, viewer, "testuser", "test-repo", 1, 20, "")
			if err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkIssueService_CreateIssueComment(b *testing.B) {
	svc, _ := newBenchIssueService()
	actor := &db.User{ID: 1, Username: "testuser"}
	ctx := context.Background()

	req := CreateIssueCommentInput{
		Body: "This is a benchmark comment with some realistic content.",
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := svc.CreateIssueComment(ctx, actor, "testuser", "test-repo", 1, req)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkNormalizeIssueFilterState(b *testing.B) {
	b.Run("Open", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeIssueFilterState("open")
		}
	})

	b.Run("Closed", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeIssueFilterState("closed")
		}
	})

	b.Run("Empty", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeIssueFilterState("")
		}
	})

	b.Run("MixedCase", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeIssueFilterState("  OPEN  ")
		}
	})
}

func BenchmarkNormalizeAssigneeUsernames(b *testing.B) {
	b.Run("SingleAssignee", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeAssigneeUsernames([]string{"testuser"})
		}
	})

	b.Run("MultipleAssignees", func(b *testing.B) {
		usernames := []string{"alice", "bob", "charlie", "dave", "eve"}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeAssigneeUsernames(usernames)
		}
	})

	b.Run("WithDuplicates", func(b *testing.B) {
		usernames := []string{"alice", "bob", "alice", "charlie", "bob"}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeAssigneeUsernames(usernames)
		}
	})
}
