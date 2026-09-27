package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// --- mock implementations for landing benchmarks ---

type benchLandingQuerier struct {
	repo       db.Repository
	landingRow db.GetLandingRequestWithChangeIDsByNumberRow
	user       db.User
}

func (m *benchLandingQuerier) GetChangeByChangeID(_ context.Context, arg db.GetChangeByChangeIDParams) (db.Change, error) {
	return db.Change{RepositoryID: arg.RepositoryID, ChangeID: arg.ChangeID, CommitID: arg.ChangeID}, nil
}

func (m *benchLandingQuerier) GetRepoByOwnerAndLowerName(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchLandingQuerier) IsOrgOwnerForRepoUser(_ context.Context, _ db.IsOrgOwnerForRepoUserParams) (bool, error) {
	return false, nil
}

func (m *benchLandingQuerier) GetHighestTeamPermissionForRepoUser(_ context.Context, _ db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	return "", nil
}

func (m *benchLandingQuerier) GetCollaboratorPermissionForRepoUser(_ context.Context, _ db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	return "write", nil
}

func (m *benchLandingQuerier) GetUserByID(_ context.Context, _ int64) (db.User, error) {
	return m.user, nil
}

func (m *benchLandingQuerier) CreateLandingRequest(_ context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error) {
	return db.LandingRequest{
		ID:             1,
		RepositoryID:   arg.RepositoryID,
		Number:         1,
		Title:          arg.Title,
		Body:           arg.Body,
		State:          "open",
		AuthorID:       arg.AuthorID,
		TargetBookmark: arg.TargetBookmark,
		SourceBookmark: arg.SourceBookmark,
		ConflictStatus: "clean",
		StackSize:      arg.StackSize,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}, nil
}

func (m *benchLandingQuerier) AddLandingRequestChange(_ context.Context, arg db.AddLandingRequestChangeParams) (db.LandingRequestChange, error) {
	return db.LandingRequestChange{
		ID:               1,
		LandingRequestID: arg.LandingRequestID,
		ChangeID:         arg.ChangeID,
		PositionInStack:  arg.PositionInStack,
	}, nil
}

func (m *benchLandingQuerier) DeleteLandingRequestChanges(_ context.Context, _ int64) error {
	return nil
}

func (m *benchLandingQuerier) UpdateLandingRequest(_ context.Context, _ db.UpdateLandingRequestParams) (db.LandingRequest, error) {
	return db.LandingRequest{}, nil
}

func (m *benchLandingQuerier) MergeLandingRequest(_ context.Context, _ int64) (db.LandingRequest, error) {
	return db.LandingRequest{}, nil
}

func (m *benchLandingQuerier) EnqueueLandingRequest(_ context.Context, _ db.EnqueueLandingRequestParams) (db.LandingRequest, error) {
	return db.LandingRequest{}, nil
}

func (m *benchLandingQuerier) CreateLandingTask(_ context.Context, _ db.CreateLandingTaskParams) (db.LandingTask, error) {
	return db.LandingTask{}, nil
}

func (m *benchLandingQuerier) GetLandingQueuePositionByTaskID(_ context.Context, _ int64) (int64, error) {
	return 1, nil
}

func (m *benchLandingQuerier) GetLandingRequestWithChangeIDsByNumber(_ context.Context, _ db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
	return m.landingRow, nil
}

func (m *benchLandingQuerier) ListLandingRequestsWithChangeIDsByRepoFiltered(_ context.Context, _ db.ListLandingRequestsWithChangeIDsByRepoFilteredParams) ([]db.ListLandingRequestsWithChangeIDsByRepoFilteredRow, error) {
	rows := make([]db.ListLandingRequestsWithChangeIDsByRepoFilteredRow, 5)
	for i := range rows {
		rows[i] = db.ListLandingRequestsWithChangeIDsByRepoFilteredRow{
			ID:             int64(i + 1),
			RepositoryID:   m.repo.ID,
			Number:         int64(i + 1),
			Title:          "Landing request",
			Body:           "Stack of changes for review",
			State:          "open",
			AuthorID:       m.user.ID,
			TargetBookmark: "main",
			ConflictStatus: "clean",
			StackSize:      3,
			ChangeIds:      []string{"abc", "def", "ghi"},
			CreatedAt:      time.Now().UTC(),
			UpdatedAt:      time.Now().UTC(),
		}
	}
	return rows, nil
}

func (m *benchLandingQuerier) ListLandingRequestsByRepoFilteredKeyset(_ context.Context, _ db.ListLandingRequestsByRepoFilteredKeysetParams) ([]db.ListLandingRequestsByRepoFilteredKeysetRow, error) {
	rows := make([]db.ListLandingRequestsByRepoFilteredKeysetRow, 5)
	for i := range rows {
		rows[i] = db.ListLandingRequestsByRepoFilteredKeysetRow{
			ID:             int64(i + 1),
			RepositoryID:   m.repo.ID,
			Number:         int64(i + 1),
			Title:          "Landing request",
			Body:           "Stack of changes for review",
			State:          "open",
			AuthorID:       m.user.ID,
			TargetBookmark: "main",
			ConflictStatus: "clean",
			StackSize:      3,
			ChangeIds:      []string{"abc", "def", "ghi"},
			CreatedAt:      time.Now().UTC(),
			UpdatedAt:      time.Now().UTC(),
		}
	}
	return rows, nil
}

func (m *benchLandingQuerier) CountLandingRequestsByRepoFiltered(_ context.Context, _ db.CountLandingRequestsByRepoFilteredParams) (int64, error) {
	return 5, nil
}

func (m *benchLandingQuerier) ListLandingRequestReviews(_ context.Context, _ db.ListLandingRequestReviewsParams) ([]db.LandingRequestReview, error) {
	return nil, nil
}

func (m *benchLandingQuerier) CountLandingRequestReviews(_ context.Context, _ int64) (int64, error) {
	return 0, nil
}

func (m *benchLandingQuerier) CreateLandingRequestReview(_ context.Context, _ db.CreateLandingRequestReviewParams) (db.LandingRequestReview, error) {
	return db.LandingRequestReview{}, nil
}

func (m *benchLandingQuerier) GetLandingRequestChangeRevisionByCommitID(_ context.Context, arg db.GetLandingRequestChangeRevisionByCommitIDParams) (db.ChangeRevision, error) {
	return db.ChangeRevision{RepositoryID: arg.RepositoryID, ChangeID: "abc", CommitID: arg.CommitID, Seq: 1}, nil
}

func (m *benchLandingQuerier) UpdateLandingRequestReviewState(_ context.Context, _ db.UpdateLandingRequestReviewStateParams) (db.LandingRequestReview, error) {
	return db.LandingRequestReview{}, nil
}

func (m *benchLandingQuerier) GetLandingRequestReviewByID(_ context.Context, _ int64) (db.LandingRequestReview, error) {
	return db.LandingRequestReview{}, nil
}

func (m *benchLandingQuerier) GetLandingTaskByLandingRequestID(_ context.Context, _ int64) (db.LandingTask, error) {
	return db.LandingTask{}, pgx.ErrNoRows
}

func (m *benchLandingQuerier) ListLandingRequestComments(_ context.Context, _ db.ListLandingRequestCommentsParams) ([]db.LandingRequestComment, error) {
	return nil, nil
}

func (m *benchLandingQuerier) CountLandingRequestComments(_ context.Context, _ int64) (int64, error) {
	return 0, nil
}

func (m *benchLandingQuerier) ListChangesRequestedLandingReviewers(context.Context, int64) ([]string, error) {
	return nil, nil
}

func (m *benchLandingQuerier) CountUnresolvedLandingRequestThreads(_ context.Context, _ int64) (int64, error) {
	return 0, nil
}

func (m *benchLandingQuerier) CreateLandingRequestComment(_ context.Context, arg db.CreateLandingRequestCommentParams) (db.LandingRequestComment, error) {
	return db.LandingRequestComment{
		ID:               1,
		LandingRequestID: arg.LandingRequestID,
		UserID:           arg.UserID,
		Body:             arg.Body,
		Path:             arg.Path,
		Line:             arg.Line,
		Side:             arg.Side,
		CommitID:         arg.CommitID,
		AnchorHash:       arg.AnchorHash,
		CreatedAt:        time.Now().UTC(),
		UpdatedAt:        time.Now().UTC(),
	}, nil
}

func (m *benchLandingQuerier) GetLandingRequestCommentByID(_ context.Context, _ db.GetLandingRequestCommentByIDParams) (db.LandingRequestComment, error) {
	return db.LandingRequestComment{}, pgx.ErrNoRows
}

func (m *benchLandingQuerier) MarkLandingRequestThreadDone(_ context.Context, _ db.MarkLandingRequestThreadDoneParams) (db.LandingRequestComment, error) {
	return db.LandingRequestComment{}, pgx.ErrNoRows
}

func (m *benchLandingQuerier) AckLandingRequestThread(_ context.Context, _ db.AckLandingRequestThreadParams) (db.LandingRequestComment, error) {
	return db.LandingRequestComment{}, pgx.ErrNoRows
}

func (m *benchLandingQuerier) ReopenLandingRequestThread(_ context.Context, _ db.ReopenLandingRequestThreadParams) (db.LandingRequestComment, error) {
	return db.LandingRequestComment{}, pgx.ErrNoRows
}

func (m *benchLandingQuerier) ListLandingRequestChanges(_ context.Context, _ db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
	return nil, nil
}

func (m *benchLandingQuerier) CountLandingRequestChanges(_ context.Context, _ int64) (int64, error) {
	return 0, nil
}

func (m *benchLandingQuerier) ListAllProtectedBookmarksByRepo(_ context.Context, _ int64) ([]db.ProtectedBookmark, error) {
	return nil, nil
}

func (m *benchLandingQuerier) CountApprovedLandingRequestReviews(_ context.Context, _ int64) (int64, error) {
	return 0, nil
}

func (m *benchLandingQuerier) CountCurrentApprovedLandingRequestReviews(context.Context, db.CountCurrentApprovedLandingRequestReviewsParams) (int64, error) {
	return 0, nil
}

func (m *benchLandingQuerier) RevertLandingRequestToOpen(_ context.Context, id int64) (db.LandingRequest, error) {
	return db.LandingRequest{ID: id, State: "open"}, nil
}

func (m *benchLandingQuerier) GetLatestCommitStatusesByChangeIDsAndContexts(_ context.Context, _ db.GetLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.GetLatestCommitStatusesByChangeIDsAndContextsRow, error) {
	return nil, nil
}

func (m *benchLandingQuerier) ListLatestCommitStatusesByChangeIDsAndContexts(_ context.Context, _ db.ListLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.ListLatestCommitStatusesByChangeIDsAndContextsRow, error) {
	return nil, nil
}

func (m *benchLandingQuerier) GetUserByLowerUsername(_ context.Context, _ string) (db.User, error) {
	return m.user, nil
}

func (m *benchLandingQuerier) CreateMention(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
	return db.Mention{}, nil
}

func (m *benchLandingQuerier) DeleteMentionsForComment(_ context.Context, _ db.DeleteMentionsForCommentParams) error {
	return nil
}

type benchLandingRepoHost struct{}

func (m *benchLandingRepoHost) LandChanges(_ context.Context, _, _ string, _ repohost.LandRequest) (repohost.LandResult, error) {
	return repohost.LandResult{}, nil
}

func (m *benchLandingRepoHost) GetChangeConflicts(_ context.Context, _, _, _ string) ([]repohost.Conflict, error) {
	return nil, nil
}

func (m *benchLandingRepoHost) GetChange(_ context.Context, _, _, changeID string) (repohost.Change, error) {
	return repohost.Change{ChangeID: changeID}, nil
}

func (m *benchLandingRepoHost) GetChangeDiff(_ context.Context, _, _, _ string) (repohost.ChangeDiff, error) {
	return repohost.ChangeDiff{}, nil
}

func (m *benchLandingRepoHost) GetChangeFiles(_ context.Context, _, _, _ string) ([]repohost.ChangeFile, error) {
	return nil, nil
}

func (m *benchLandingRepoHost) GetFileAtChange(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
	return repohost.FileContent{Path: path}, nil
}

// --- helper ---

func newBenchLandingService() (*LandingService, *benchLandingQuerier) {
	user := db.User{ID: 1, Username: "testuser", LowerUsername: "testuser"}
	repo := db.Repository{
		ID:        1,
		Name:      "test-repo",
		LowerName: "test-repo",
		IsPublic:  true,
		UserID:    pgtype.Int8{Int64: 1, Valid: true},
	}
	landingRow := db.GetLandingRequestWithChangeIDsByNumberRow{
		ID:             1,
		RepositoryID:   1,
		Number:         1,
		Title:          "Stack review",
		Body:           "Three stacked changes for landing",
		State:          "open",
		AuthorID:       1,
		TargetBookmark: "main",
		ConflictStatus: "clean",
		StackSize:      3,
		ChangeIds:      []string{"abc", "def", "ghi"},
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}

	q := &benchLandingQuerier{repo: repo, landingRow: landingRow, user: user}
	svc := NewLandingService(q, &benchLandingRepoHost{})
	return svc, q
}

// --- benchmarks ---

func BenchmarkLandingService_CreateLandingRequest(b *testing.B) {
	svc, _ := newBenchLandingService()
	actor := &db.User{ID: 1, Username: "testuser"}
	ctx := context.Background()

	req := CreateLandingRequestInput{
		Title:          "Stack review",
		Body:           "Three stacked changes for review and landing",
		TargetBookmark: "main",
		SourceBookmark: "feature/my-branch",
		ChangeIDs:      []string{"abc", "def", "ghi"},
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := svc.CreateLandingRequest(ctx, actor, "testuser", "test-repo", req)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkLandingService_GetLandingRequest(b *testing.B) {
	svc, _ := newBenchLandingService()
	viewer := &db.User{ID: 1, Username: "testuser"}
	ctx := context.Background()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := svc.GetLandingRequest(ctx, viewer, "testuser", "test-repo", 1)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkLandingService_ListLandingRequests(b *testing.B) {
	svc, _ := newBenchLandingService()
	viewer := &db.User{ID: 1, Username: "testuser"}
	ctx := context.Background()

	b.Run("OpenState", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _, _, err := svc.ListLandingRequests(ctx, viewer, "testuser", "test-repo", 1, 20, "open")
			if err != nil {
				b.Fatal(err)
			}
		}
	})

	b.Run("AllStates", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _, _, err := svc.ListLandingRequests(ctx, viewer, "testuser", "test-repo", 1, 20, "")
			if err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkNormalizeChangeIDs(b *testing.B) {
	b.Run("SmallStack", func(b *testing.B) {
		ids := []string{"abc", "def", "ghi"}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeChangeIDs(ids)
		}
	})

	b.Run("LargeStack", func(b *testing.B) {
		ids := make([]string, 20)
		for i := range ids {
			ids[i] = "change-" + string(rune('a'+i))
		}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeChangeIDs(ids)
		}
	})
}

func BenchmarkNormalizeLandingFilterState(b *testing.B) {
	b.Run("Open", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeLandingFilterState("open")
		}
	})

	b.Run("Closed", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeLandingFilterState("closed")
		}
	})

	b.Run("Empty", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = normalizeLandingFilterState("")
		}
	})
}

func BenchmarkIsValidLandingTransition(b *testing.B) {
	transitions := [][2]string{
		{"open", "closed"},
		{"open", "draft"},
		{"draft", "open"},
		{"closed", "open"},
		{"merged", "open"},
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		pair := transitions[i%len(transitions)]
		_ = isValidLandingTransition(pair[0], pair[1])
	}
}

func BenchmarkLandingService_CreateLandingComment(b *testing.B) {
	svc, _ := newBenchLandingService()
	actor := &db.User{ID: 1, Username: "testuser"}
	ctx := context.Background()

	req := CreateLandingCommentInput{
		CommitID: "commit-1",
		Path:     "src/main.go",
		Line:     42,
		Side:     "right",
		Body:     "This is a review comment on a specific line of code.",
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := svc.CreateLandingComment(ctx, actor, "testuser", "test-repo", 1, req)
		if err != nil {
			b.Fatal(err)
		}
	}
}
