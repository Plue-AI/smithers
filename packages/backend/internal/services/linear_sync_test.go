package services

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type linearSyncRoundTripper func(*http.Request) (*http.Response, error)

func (f linearSyncRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

type fakeLinearIssueImportTxManager struct {
	tx *fakeLinearIssueImportTx
}

func (m *fakeLinearIssueImportTxManager) BeginLinearIssueImportTx(ctx context.Context) (linearIssueImportTx, error) {
	return m.tx, nil
}

type fakeLinearIssueImportTx struct {
	mapErr     error
	committed  bool
	rolledBack bool
}

func (t *fakeLinearIssueImportTx) CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
	return db.Issue{
		ID:     101,
		Number: 7,
		Title:  arg.Title,
		Body:   arg.Body,
	}, nil
}

func (t *fakeLinearIssueImportTx) CreateLinearIssueMap(ctx context.Context, arg db.CreateLinearIssueMapParams) (db.LinearIssueMap, error) {
	if t.mapErr != nil {
		return db.LinearIssueMap{}, t.mapErr
	}
	return db.LinearIssueMap{
		IntegrationID: arg.IntegrationID,
		JjhubIssueID:  arg.JjhubIssueID,
	}, nil
}

func (t *fakeLinearIssueImportTx) Commit(ctx context.Context) error {
	t.committed = true
	return nil
}

func (t *fakeLinearIssueImportTx) Rollback(ctx context.Context) error {
	t.rolledBack = true
	return nil
}

func TestLinearSyncService_ImportLinearIssueCommitsTransaction(t *testing.T) {
	tx := &fakeLinearIssueImportTx{}
	svc := &LinearSyncService{
		issueImportTxManager: &fakeLinearIssueImportTxManager{tx: tx},
	}

	err := svc.importLinearIssue(context.Background(), db.LinearIntegration{
		ID:           1,
		UserID:       2,
		JjhubRepoID:  3,
		LinearTeamID: "team-1",
	}, "lin-1", "PLT-1", "Imported title", "Imported body")

	require.NoError(t, err)
	assert.True(t, tx.committed)
	assert.False(t, tx.rolledBack)
}

func TestLinearSyncService_ImportLinearIssueRollsBackOnMapFailure(t *testing.T) {
	tx := &fakeLinearIssueImportTx{mapErr: errors.New("map insert failed")}
	svc := &LinearSyncService{
		issueImportTxManager: &fakeLinearIssueImportTxManager{tx: tx},
	}

	err := svc.importLinearIssue(context.Background(), db.LinearIntegration{
		ID:           1,
		UserID:       2,
		JjhubRepoID:  3,
		LinearTeamID: "team-1",
	}, "lin-1", "PLT-1", "Imported title", "Imported body")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "create linear issue map")
	assert.False(t, tx.committed)
	assert.True(t, tx.rolledBack)
}

func TestLinearSyncService_RunInitialSync_ImportsUnmappedLinearIssues(t *testing.T) {
	pool := setupTestPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	repoOwner, repoName, integration := createLinearSyncTestIntegration(t, queries, pool)
	sessionSecret := "linear-sync-test-secret"
	syncSvc := newLinearSyncTestService(t, queries, integration, sessionSecret, `{
		"data": {
			"issues": {
				"pageInfo": {"hasNextPage": false},
				"nodes": [
					{"id":"lin-1","identifier":"PLT-101","title":"Imported issue one","description":"First description"},
					{"id":"lin-2","identifier":"PLT-102","title":"Imported issue two","description":"Second description"}
				]
			}
		}
	}`)

	syncSvc.RunInitialSync(ctx, integration)

	issues, err := queries.ListIssuesByRepoFiltered(ctx, db.ListIssuesByRepoFilteredParams{
		RepositoryID: integration.JjhubRepoID,
		State:        "",
		PageOffset:   0,
		PageSize:     20,
	})
	require.NoError(t, err)
	require.Len(t, issues, 2)

	issuesByTitle := make(map[string]db.Issue, len(issues))
	for _, issue := range issues {
		issuesByTitle[issue.Title] = issue
	}

	first := issuesByTitle["Imported issue one"]
	second := issuesByTitle["Imported issue two"]
	assert.Equal(t, integration.UserID, first.AuthorID)
	assert.Equal(t, integration.UserID, second.AuthorID)
	assert.Equal(t, "Imported from Linear issue `PLT-101`.\n\nFirst description", first.Body)
	assert.Equal(t, "Imported from Linear issue `PLT-102`.\n\nSecond description", second.Body)

	firstMap, err := queries.GetLinearIssueMapByLinearIssue(ctx, db.GetLinearIssueMapByLinearIssueParams{
		IntegrationID: integration.ID,
		LinearIssueID: "lin-1",
	})
	require.NoError(t, err)
	assert.Equal(t, first.ID, firstMap.JjhubIssueID)
	assert.Equal(t, first.Number, firstMap.JjhubIssueNumber)

	secondMap, err := queries.GetLinearIssueMapByLinearIssue(ctx, db.GetLinearIssueMapByLinearIssueParams{
		IntegrationID: integration.ID,
		LinearIssueID: "lin-2",
	})
	require.NoError(t, err)
	assert.Equal(t, second.ID, secondMap.JjhubIssueID)
	assert.Equal(t, second.Number, secondMap.JjhubIssueNumber)

	repo, err := queries.GetRepoByID(ctx, integration.JjhubRepoID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), repo.NumIssues)

	storedIntegration, err := queries.GetLinearIntegration(ctx, integration.ID)
	require.NoError(t, err)
	assert.True(t, storedIntegration.LastSyncAt.Valid)
	assert.Equal(t, repoOwner, storedIntegration.JjhubRepoOwner)
	assert.Equal(t, repoName, storedIntegration.JjhubRepoName)
}

func TestLinearSyncService_RunInitialSync_SkipsAlreadyMappedIssues(t *testing.T) {
	pool := setupTestPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	_, _, integration := createLinearSyncTestIntegration(t, queries, pool)
	sessionSecret := "linear-sync-test-secret"

	existingIssue, err := queries.CreateIssue(ctx, db.CreateIssueParams{
		RepositoryID: integration.JjhubRepoID,
		Title:        "Already imported",
		Body:         "Existing Smithers issue",
		AuthorID:     integration.UserID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)
	_, err = queries.CreateLinearIssueMap(ctx, db.CreateLinearIssueMapParams{
		IntegrationID:    integration.ID,
		JjhubIssueID:     existingIssue.ID,
		JjhubIssueNumber: existingIssue.Number,
		LinearIssueID:    "lin-existing",
		LinearIdentifier: "PLT-200",
	})
	require.NoError(t, err)

	syncSvc := newLinearSyncTestService(t, queries, integration, sessionSecret, `{
		"data": {
			"issues": {
				"pageInfo": {"hasNextPage": false},
				"nodes": [
					{"id":"lin-existing","identifier":"PLT-200","title":"Already imported","description":"Existing Smithers issue"}
				]
			}
		}
	}`)

	syncSvc.RunInitialSync(ctx, integration)

	issues, err := queries.ListIssuesByRepoFiltered(ctx, db.ListIssuesByRepoFilteredParams{
		RepositoryID: integration.JjhubRepoID,
		State:        "",
		PageOffset:   0,
		PageSize:     20,
	})
	require.NoError(t, err)
	require.Len(t, issues, 1)
	assert.Equal(t, existingIssue.ID, issues[0].ID)

	repo, err := queries.GetRepoByID(ctx, integration.JjhubRepoID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), repo.NumIssues)
}

func createLinearSyncTestIntegration(t *testing.T, queries *db.Queries, pool db.DBTX) (string, string, db.LinearIntegration) {
	t.Helper()

	now := time.Now().UnixNano()
	repoOwner := fmt.Sprintf("linear_sync_user_%d", now)
	repoName := fmt.Sprintf("linear-sync-repo-%d", now)
	repoOwnerLower := strings.ToLower(repoOwner)
	repoNameLower := strings.ToLower(repoName)

	var userID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO users (username, lower_username, email, lower_email, display_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		repoOwner,
		repoOwnerLower,
		fmt.Sprintf("%s@example.com", repoOwnerLower),
		fmt.Sprintf("%s@example.com", repoOwnerLower),
		repoOwner,
	).Scan(&userID)
	require.NoError(t, err)

	var repoID int64
	err = pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number) VALUES ($1, $2, $3, '', TRUE, 'main', 1) RETURNING id`,
		userID,
		repoName,
		repoNameLower,
	).Scan(&repoID)
	require.NoError(t, err)

	const sessionSecret = "linear-sync-test-secret"
	accessTokenEncrypted, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey(sessionSecret), []byte("linear-access-token"))
	require.NoError(t, err)

	webhookSecretEncrypted, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey(sessionSecret), []byte("webhook-secret"))
	require.NoError(t, err)

	integration, err := queries.CreateLinearIntegration(context.Background(), db.CreateLinearIntegrationParams{
		UserID:               userID,
		LinearTeamID:         fmt.Sprintf("team-%d", now),
		LinearTeamName:       "Platform",
		LinearTeamKey:        "PLT",
		AccessTokenEncrypted: accessTokenEncrypted,
		TokenExpiresAt:       pgtype.Timestamptz{},
		WebhookSecret:        base64.StdEncoding.EncodeToString(webhookSecretEncrypted),
		JjhubRepoID:          repoID,
		JjhubRepoOwner:       repoOwner,
		JjhubRepoName:        repoName,
		LinearActorID:        "actor-1",
	})
	require.NoError(t, err)

	return repoOwner, repoName, integration
}

func newLinearSyncTestService(t *testing.T, queries *db.Queries, integration db.LinearIntegration, sessionSecret, responseBody string) *LinearSyncService {
	t.Helper()

	integrationSvc := NewLinearIntegrationService(queries, nil, sessionSecret)
	syncSvc := NewLinearSyncService(queries, integrationSvc)
	syncSvc.httpClient = &http.Client{
		Transport: linearSyncRoundTripper(func(req *http.Request) (*http.Response, error) {
			assert.Equal(t, "POST", req.Method)
			assert.Equal(t, "https://api.linear.app/graphql", req.URL.String())
			assert.Equal(t, "Bearer linear-access-token", req.Header.Get("Authorization"))
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(responseBody)),
				Header:     make(http.Header),
			}, nil
		}),
	}
	return syncSvc
}

// newLinearSyncTestServiceWithCapture creates a sync service that captures the GraphQL request bodies.
func newLinearSyncTestServiceWithCapture(t *testing.T, queries *db.Queries, sessionSecret, responseBody string) (*LinearSyncService, *[]string) {
	t.Helper()

	var captured []string
	integrationSvc := NewLinearIntegrationService(queries, nil, sessionSecret)
	syncSvc := NewLinearSyncService(queries, integrationSvc)
	syncSvc.httpClient = &http.Client{
		Transport: linearSyncRoundTripper(func(req *http.Request) (*http.Response, error) {
			body, _ := io.ReadAll(req.Body)
			captured = append(captured, string(body))
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(responseBody)),
				Header:     make(http.Header),
			}, nil
		}),
	}
	return syncSvc, &captured
}

// createLinearSyncTestCommentMapping creates a Smithers issue + comment + Linear mappings for comment sync tests.
func createLinearSyncTestCommentMapping(t *testing.T, queries *db.Queries, pool db.DBTX, integration db.LinearIntegration) (db.Issue, db.IssueComment, db.LinearIssueMap, db.LinearCommentMap) {
	t.Helper()
	ctx := context.Background()

	issue, err := queries.CreateIssue(ctx, db.CreateIssueParams{
		RepositoryID: integration.JjhubRepoID,
		Title:        "Test issue for comment sync",
		Body:         "Test body",
		AuthorID:     integration.UserID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	comment, err := queries.CreateIssueComment(ctx, db.CreateIssueCommentParams{
		IssueID:   issue.ID,
		UserID:    pgtype.Int8{Int64: integration.UserID, Valid: true},
		Body:      "Original comment body",
		Commenter: "testuser",
	})
	require.NoError(t, err)

	issueMap, err := queries.CreateLinearIssueMap(ctx, db.CreateLinearIssueMapParams{
		IntegrationID:    integration.ID,
		JjhubIssueID:     issue.ID,
		JjhubIssueNumber: issue.Number,
		LinearIssueID:    "lin-issue-1",
		LinearIdentifier: "PLT-1",
	})
	require.NoError(t, err)

	commentMap, err := queries.CreateLinearCommentMap(ctx, db.CreateLinearCommentMapParams{
		IssueMapID:      issueMap.ID,
		JjhubCommentID:  comment.ID,
		LinearCommentID: "lin-comment-1",
	})
	require.NoError(t, err)

	return issue, comment, issueMap, commentMap
}

// --- Smithers→Linear comment edit/delete tests ---

func TestLinearSyncService_CommentEditedToLinear(t *testing.T) {
	pool := setupTestPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	_, _, integration := createLinearSyncTestIntegration(t, queries, pool)
	_, comment, _, _ := createLinearSyncTestCommentMapping(t, queries, pool, integration)

	sessionSecret := "linear-sync-test-secret"
	syncSvc, captured := newLinearSyncTestServiceWithCapture(t, queries, sessionSecret, `{
		"data": { "commentUpdate": { "success": true } }
	}`)

	event := webhooks.IssueCommentEventPayload{
		Action: "edited",
		Issue:  webhooks.IssuePayload{ID: comment.IssueID},
		Comment: webhooks.IssueCommentPayload{
			ID:        comment.ID,
			IssueID:   comment.IssueID,
			Body:      "Updated comment body",
			Commenter: "testuser",
		},
	}

	syncSvc.HandleSmithersCommentEvent(ctx, integration.JjhubRepoID, event)

	require.Len(t, *captured, 1)
	assert.Contains(t, (*captured)[0], "CommentUpdate")
	assert.Contains(t, (*captured)[0], "lin-comment-1")
	assert.Contains(t, (*captured)[0], "Updated comment body")
}

func TestLinearSyncService_CommentDeletedToLinear(t *testing.T) {
	pool := setupTestPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	_, _, integration := createLinearSyncTestIntegration(t, queries, pool)
	_, comment, issueMap, _ := createLinearSyncTestCommentMapping(t, queries, pool, integration)

	sessionSecret := "linear-sync-test-secret"
	syncSvc, captured := newLinearSyncTestServiceWithCapture(t, queries, sessionSecret, `{
		"data": { "commentDelete": { "success": true } }
	}`)

	event := webhooks.IssueCommentEventPayload{
		Action: "deleted",
		Issue:  webhooks.IssuePayload{ID: comment.IssueID},
		Comment: webhooks.IssueCommentPayload{
			ID:        comment.ID,
			IssueID:   comment.IssueID,
			Body:      "Original comment body",
			Commenter: "testuser",
		},
	}

	syncSvc.HandleSmithersCommentEvent(ctx, integration.JjhubRepoID, event)

	require.Len(t, *captured, 1)
	assert.Contains(t, (*captured)[0], "CommentDelete")
	assert.Contains(t, (*captured)[0], "lin-comment-1")

	// Verify the comment map was cleaned up.
	_, err := queries.GetLinearCommentMapBySmithersComment(ctx, db.GetLinearCommentMapBySmithersCommentParams{
		IssueMapID:     issueMap.ID,
		JjhubCommentID: comment.ID,
	})
	assert.Error(t, err, "comment map should be deleted after linear comment delete")
}

func TestLinearSyncService_CommentEditSkipsUnmapped(t *testing.T) {
	pool := setupTestPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	_, _, integration := createLinearSyncTestIntegration(t, queries, pool)

	// Create issue + issue map but NO comment map
	issue, err := queries.CreateIssue(ctx, db.CreateIssueParams{
		RepositoryID: integration.JjhubRepoID,
		Title:        "Test issue",
		Body:         "Body",
		AuthorID:     integration.UserID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)
	_, err = queries.CreateLinearIssueMap(ctx, db.CreateLinearIssueMapParams{
		IntegrationID:    integration.ID,
		JjhubIssueID:     issue.ID,
		JjhubIssueNumber: issue.Number,
		LinearIssueID:    "lin-issue-unmapped",
		LinearIdentifier: "PLT-99",
	})
	require.NoError(t, err)

	sessionSecret := "linear-sync-test-secret"
	syncSvc, captured := newLinearSyncTestServiceWithCapture(t, queries, sessionSecret, `{"data":{}}`)

	event := webhooks.IssueCommentEventPayload{
		Action: "edited",
		Issue:  webhooks.IssuePayload{ID: issue.ID},
		Comment: webhooks.IssueCommentPayload{
			ID:        99999,
			IssueID:   issue.ID,
			Body:      "Edited but not mapped",
			Commenter: "testuser",
		},
	}

	syncSvc.HandleSmithersCommentEvent(ctx, integration.JjhubRepoID, event)

	// No GraphQL call should have been made since the comment is not mapped.
	assert.Empty(t, *captured)
}

// --- Linear→Smithers comment update/remove tests ---

func TestLinearSyncService_WebhookCommentUpdate(t *testing.T) {
	pool := setupTestPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	_, _, integration := createLinearSyncTestIntegration(t, queries, pool)
	_, comment, _, _ := createLinearSyncTestCommentMapping(t, queries, pool, integration)

	sessionSecret := "linear-sync-test-secret"
	syncSvc := newLinearSyncTestService(t, queries, integration, sessionSecret, `{"data":{}}`)

	webhookBody := withFreshWebhookTimestamp(t, fmt.Sprintf(`{
		"action": "update",
		"type": "Comment",
		"organizationId": "org-1",
		"data": {
			"id": "lin-comment-1",
			"body": "Updated from Linear",
			"issueId": "lin-issue-1",
			"teamId": "%s",
			"creatorId": "someone-else"
		}
	}`, integration.LinearTeamID))

	signature := computeTestHMAC(t, webhookBody, "webhook-secret")
	err := syncSvc.HandleLinearWebhook(ctx, webhookBody, signature)
	require.NoError(t, err)

	// Verify the Smithers comment was updated.
	updated, err := queries.GetIssueCommentByID(ctx, comment.ID)
	require.NoError(t, err)
	assert.Equal(t, "Updated from Linear", updated.Body)
}

func TestLinearSyncService_WebhookCommentRemove(t *testing.T) {
	pool := setupTestPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	_, _, integration := createLinearSyncTestIntegration(t, queries, pool)
	issue, comment, issueMap, _ := createLinearSyncTestCommentMapping(t, queries, pool, integration)

	sessionSecret := "linear-sync-test-secret"
	syncSvc := newLinearSyncTestService(t, queries, integration, sessionSecret, `{"data":{}}`)

	webhookBody := withFreshWebhookTimestamp(t, fmt.Sprintf(`{
		"action": "remove",
		"type": "Comment",
		"organizationId": "org-1",
		"data": {
			"id": "lin-comment-1",
			"body": "Doesn't matter",
			"issueId": "lin-issue-1",
			"teamId": "%s",
			"creatorId": "someone-else"
		}
	}`, integration.LinearTeamID))

	signature := computeTestHMAC(t, webhookBody, "webhook-secret")
	err := syncSvc.HandleLinearWebhook(ctx, webhookBody, signature)
	require.NoError(t, err)

	// Verify the Smithers comment was deleted.
	_, err = queries.GetIssueCommentByID(ctx, comment.ID)
	assert.Error(t, err, "smithers comment should be deleted")

	// Verify the comment map was cleaned up.
	_, err = queries.GetLinearCommentMapByLinearComment(ctx, db.GetLinearCommentMapByLinearCommentParams{
		IssueMapID:      issueMap.ID,
		LinearCommentID: "lin-comment-1",
	})
	assert.Error(t, err, "comment map should be deleted")

	// Verify the issue comment count was decremented.
	updatedIssue, err := queries.GetIssueByID(ctx, issue.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(0), updatedIssue.CommentCount)
}

func TestLinearSyncService_WebhookCommentUpdateSkipsUnmappedComment(t *testing.T) {
	pool := setupTestPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	_, _, integration := createLinearSyncTestIntegration(t, queries, pool)

	// Create issue + issue map but NO comment map
	issue, err := queries.CreateIssue(ctx, db.CreateIssueParams{
		RepositoryID: integration.JjhubRepoID,
		Title:        "Test issue",
		Body:         "Body",
		AuthorID:     integration.UserID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)
	_, err = queries.CreateLinearIssueMap(ctx, db.CreateLinearIssueMapParams{
		IntegrationID:    integration.ID,
		JjhubIssueID:     issue.ID,
		JjhubIssueNumber: issue.Number,
		LinearIssueID:    "lin-issue-no-comment",
		LinearIdentifier: "PLT-50",
	})
	require.NoError(t, err)

	sessionSecret := "linear-sync-test-secret"
	syncSvc := newLinearSyncTestService(t, queries, integration, sessionSecret, `{"data":{}}`)

	webhookBody := withFreshWebhookTimestamp(t, fmt.Sprintf(`{
		"action": "update",
		"type": "Comment",
		"organizationId": "org-1",
		"data": {
			"id": "lin-comment-unknown",
			"body": "Unknown comment",
			"issueId": "lin-issue-no-comment",
			"teamId": "%s",
			"creatorId": "someone-else"
		}
	}`, integration.LinearTeamID))

	signature := computeTestHMAC(t, webhookBody, "webhook-secret")
	err = syncSvc.HandleLinearWebhook(ctx, webhookBody, signature)
	assert.NoError(t, err, "should gracefully skip unmapped comment")
}

func TestLinearSyncService_WebhookCommentRemoveSkipsUnmappedIssue(t *testing.T) {
	pool := setupTestPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	_, _, integration := createLinearSyncTestIntegration(t, queries, pool)

	sessionSecret := "linear-sync-test-secret"
	syncSvc := newLinearSyncTestService(t, queries, integration, sessionSecret, `{"data":{}}`)

	webhookBody := withFreshWebhookTimestamp(t, fmt.Sprintf(`{
		"action": "remove",
		"type": "Comment",
		"organizationId": "org-1",
		"data": {
			"id": "lin-comment-orphan",
			"body": "Orphan comment",
			"issueId": "lin-issue-nonexistent",
			"teamId": "%s",
			"creatorId": "someone-else"
		}
	}`, integration.LinearTeamID))

	signature := computeTestHMAC(t, webhookBody, "webhook-secret")
	err := syncSvc.HandleLinearWebhook(ctx, webhookBody, signature)
	assert.NoError(t, err, "should gracefully skip unmapped issue")
}

// computeTestHMAC generates an HMAC-SHA256 signature for testing webhook verification.
func computeTestHMAC(t *testing.T, body []byte, secret string) string {
	t.Helper()
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// withFreshWebhookTimestamp injects a current webhookTimestamp into a JSON
// webhook body so the replay guard accepts it. Call before signing.
func withFreshWebhookTimestamp(t *testing.T, body string) []byte {
	t.Helper()
	var payload map[string]any
	require.NoError(t, json.Unmarshal([]byte(body), &payload))
	payload["webhookTimestamp"] = time.Now().UnixMilli()
	out, err := json.Marshal(payload)
	require.NoError(t, err)
	return out
}
