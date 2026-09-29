package services

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type linearSyncHBadReader struct{}

func (linearSyncHBadReader) Read([]byte) (int, error) { return 0, errors.New("read failed") }
func (linearSyncHBadReader) Close() error             { return nil }

type linearSyncHCommentMapErrQuerier struct {
	*linearSyncCovQuerier
	err error
}

func (q *linearSyncHCommentMapErrQuerier) CreateLinearCommentMap(context.Context, db.CreateLinearCommentMapParams) (db.LinearCommentMap, error) {
	return db.LinearCommentMap{}, q.err
}

func TestLinearSync_H_PgxBeginAndHandlerErrorBranches(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := (&pgxLinearIssueImportTxManager{pool: pool}).BeginLinearIssueImportTx(ctx)
	require.Error(t, err)

	integration, goodIntegrationSvc := linearSyncCovIntegration(t)
	badIntegrationSvc := NewLinearIntegrationService(nil, nil, "wrong-secret")

	q := &linearSyncCovQuerier{integration: integration, listIntegrationsErr: errors.New("list failed")}
	NewLinearSyncService(q, goodIntegrationSvc).HandleSmithersIssueEvent(context.Background(), integration.JjhubRepoID, webhooks.IssueEventPayload{Action: "opened"})

	q = &linearSyncCovQuerier{integration: integration}
	NewLinearSyncService(q, badIntegrationSvc).HandleSmithersIssueEvent(context.Background(), integration.JjhubRepoID, webhooks.IssueEventPayload{
		Action: "opened",
		Issue:  webhooks.IssuePayload{ID: 10, Number: 10, Title: "bad token"},
	})

	q = &linearSyncCovQuerier{integration: integration, issueMap: db.LinearIssueMap{ID: 1, JjhubIssueID: 10, LinearIssueID: "lin-10"}}
	NewLinearSyncService(q, badIntegrationSvc).HandleSmithersCommentEvent(context.Background(), integration.JjhubRepoID, webhooks.IssueCommentEventPayload{
		Action:  "created",
		Issue:   webhooks.IssuePayload{ID: 10},
		Comment: webhooks.IssueCommentPayload{ID: 20, IssueID: 10},
	})
}

func TestLinearSync_H_WebhookTeamSecretAndShapeBranches(t *testing.T) {
	ctx := context.Background()
	integration, integrationSvc := linearSyncCovIntegration(t)

	body := withFreshWebhookTimestamp(t, `{"action":"update","type":"Issue","data":{"id":"lin-issue","team":{"id":"team-cover"},"creatorId":"other-user"}}`)
	q := &linearSyncCovQuerier{integration: integration}
	svc := NewLinearSyncService(q, integrationSvc)
	require.NoError(t, svc.HandleLinearWebhook(ctx, body, computeTestHMAC(t, body, "linear-webhook-cover")))
	require.Len(t, q.logs, 1)

	badSecret := integration
	badSecret.WebhookSecret = "not-base64"
	q = &linearSyncCovQuerier{integration: badSecret}
	svc = NewLinearSyncService(q, integrationSvc)
	err := svc.HandleLinearWebhook(ctx, body, "anything")
	requireAPIErrorStatus(t, err, http.StatusUnauthorized)

	unknownType := withFreshWebhookTimestamp(t, `{"action":"update","type":"Project","data":{"id":"project","teamId":"team-cover","creatorId":"other-user"}}`)
	q = &linearSyncCovQuerier{integration: integration}
	svc = NewLinearSyncService(q, integrationSvc)
	require.NoError(t, svc.HandleLinearWebhook(ctx, unknownType, computeTestHMAC(t, unknownType, "linear-webhook-cover")))
	assert.Empty(t, q.logs)

	staleBody := []byte(`{"action":"update","type":"Issue","webhookTimestamp":1000,"data":{"id":"lin-issue","teamId":"team-cover","creatorId":"other-user"}}`)
	q = &linearSyncCovQuerier{integration: integration}
	svc = NewLinearSyncService(q, integrationSvc)
	err = svc.HandleLinearWebhook(ctx, staleBody, computeTestHMAC(t, staleBody, "linear-webhook-cover"))
	requireAPIErrorStatus(t, err, http.StatusUnauthorized)
	assert.Empty(t, q.logs, "stale replayed payloads must not be processed")

	missingTimestamp := []byte(`{"action":"update","type":"Issue","data":{"id":"lin-issue","teamId":"team-cover","creatorId":"other-user"}}`)
	err = svc.HandleLinearWebhook(ctx, missingTimestamp, computeTestHMAC(t, missingTimestamp, "linear-webhook-cover"))
	requireAPIErrorStatus(t, err, http.StatusUnauthorized)
}

func TestLinearSync_H_StartInitialSyncDedupesPerIntegration(t *testing.T) {
	integration, integrationSvc := linearSyncCovIntegration(t)
	// No access token makes RunInitialSync fail fast without touching the network.
	integration.AccessTokenEncrypted = nil

	q := &linearSyncCovQuerier{integration: integration}
	svc := NewLinearSyncService(q, integrationSvc)

	svc.initialSyncInFlight.Store(integration.ID, struct{}{})
	assert.False(t, svc.StartInitialSync(integration), "in-flight sync must not be duplicated")
	svc.initialSyncInFlight.Delete(integration.ID)

	require.True(t, svc.StartInitialSync(integration))
	require.Eventually(t, func() bool {
		_, inFlight := svc.initialSyncInFlight.Load(integration.ID)
		return !inFlight
	}, 2*time.Second, 10*time.Millisecond, "background sync should release the in-flight slot")
}

func TestLinearSync_H_OutboundIssueAndCommentFailureBranches(t *testing.T) {
	ctx := context.Background()
	integration, integrationSvc := linearSyncCovIntegration(t)
	expiredBadRefresh := integration
	expiredBadRefresh.TokenExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-time.Hour), Valid: true}
	expiredBadRefresh.RefreshTokenEncrypted = []byte("bad-refresh")

	q := &linearSyncCovQuerier{integration: expiredBadRefresh}
	svc := NewLinearSyncService(q, integrationSvc)
	err := svc.syncIssueToLinear(ctx, expiredBadRefresh, webhooks.IssueEventPayload{Action: "opened", Issue: webhooks.IssuePayload{ID: 29}})
	require.Error(t, err)

	q = &linearSyncCovQuerier{integration: integration}
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusInternalServerError, "linear down", nil
	})
	err = svc.createLinearIssue(ctx, integration, "token", webhooks.IssueEventPayload{
		Issue: webhooks.IssuePayload{ID: 30, Number: 30, Title: "fail"},
	})
	require.Error(t, err)
	require.Len(t, q.logs, 1)
	assert.Equal(t, "failed", q.logs[0].Status)

	q = &linearSyncCovQuerier{integration: integration, issueMap: db.LinearIssueMap{ID: 1, LinearIssueID: "already"}}
	require.NoError(t, NewLinearSyncService(q, integrationSvc).createLinearIssue(ctx, integration, "token", webhooks.IssueEventPayload{
		Issue: webhooks.IssuePayload{ID: 30, Number: 30},
	}))

	q = &linearSyncCovQuerier{integration: integration, createIssueMapErr: errors.New("map failed")}
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusOK, `{"data":{"issueCreate":{"issue":{"id":"lin-31","identifier":"PLT-31"}}}}`, nil
	})
	err = svc.createLinearIssue(ctx, integration, "token", webhooks.IssueEventPayload{
		Issue: webhooks.IssuePayload{ID: 31, Number: 31, Title: "map fail"},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to create issue map")

	q = &linearSyncCovQuerier{integration: integration}
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusOK, `{"data":{"issueCreate":"bad"}}`, nil
	})
	err = svc.createLinearIssue(ctx, integration, "token", webhooks.IssueEventPayload{Issue: webhooks.IssuePayload{ID: 32}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unexpected issueCreate")

	issueMap := db.LinearIssueMap{ID: 2, IntegrationID: integration.ID, JjhubIssueID: 40, LinearIssueID: "lin-40"}
	for _, tc := range []struct {
		name   string
		action string
		call   func(*LinearSyncService) error
	}{
		{"update", "update", func(s *LinearSyncService) error {
			return s.updateLinearIssue(ctx, integration, "token", webhooks.IssueEventPayload{Issue: webhooks.IssuePayload{ID: 40}})
		}},
		{"close state", "close", func(s *LinearSyncService) error {
			return s.closeLinearIssue(ctx, integration, "token", webhooks.IssueEventPayload{Issue: webhooks.IssuePayload{ID: 40}})
		}},
		{"reopen state", "reopen", func(s *LinearSyncService) error {
			return s.reopenLinearIssue(ctx, integration, "token", webhooks.IssueEventPayload{Issue: webhooks.IssuePayload{ID: 40}})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &linearSyncCovQuerier{integration: integration, issueMap: issueMap}
			svc := NewLinearSyncService(q, integrationSvc)
			svc.httpClient = linearSyncCovHTTPClient(t, nil, func(body string) (int, string, error) {
				if strings.Contains(body, "WorkflowStates") {
					return http.StatusOK, `{"data":{"workflowStates":{"nodes":[{"id":"done-state","name":"Done","type":"completed"},{"id":"todo-state","name":"Todo","type":"unstarted"}]}}}`, nil
				}
				return http.StatusInternalServerError, "linear down", nil
			})
			err := tc.call(svc)
			require.Error(t, err)
			require.Len(t, q.logs, 1)
			assert.Equal(t, "failed", q.logs[0].Status)
		})
	}

	q = &linearSyncCovQuerier{integration: integration, issueMapBySmithersErr: pgx.ErrNoRows}
	require.NoError(t, NewLinearSyncService(q, integrationSvc).closeLinearIssue(ctx, integration, "token", webhooks.IssueEventPayload{Issue: webhooks.IssuePayload{ID: 40}}))
	require.NoError(t, NewLinearSyncService(q, integrationSvc).reopenLinearIssue(ctx, integration, "token", webhooks.IssueEventPayload{Issue: webhooks.IssuePayload{ID: 40}}))

	for _, tc := range []struct {
		name string
		call func(*LinearSyncService) error
	}{
		{"close state", func(s *LinearSyncService) error {
			return s.closeLinearIssue(ctx, integration, "token", webhooks.IssueEventPayload{Issue: webhooks.IssuePayload{ID: 40}})
		}},
		{"reopen state", func(s *LinearSyncService) error {
			return s.reopenLinearIssue(ctx, integration, "token", webhooks.IssueEventPayload{Issue: webhooks.IssuePayload{ID: 40}})
		}},
	} {
		t.Run(tc.name+" lookup error", func(t *testing.T) {
			q := &linearSyncCovQuerier{integration: integration, issueMap: issueMap}
			svc := NewLinearSyncService(q, integrationSvc)
			svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
				return http.StatusOK, `{"data":{"workflowStates":{"nodes":"bad"}}}`, nil
			})
			require.Error(t, tc.call(svc))
		})
	}

	q = &linearSyncCovQuerier{integration: integration, issueMap: issueMap}
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(body string) (int, string, error) {
		if strings.Contains(body, "WorkflowStates") {
			return http.StatusOK, `{"data":{"workflowStates":{"nodes":[{"id":"done-state","name":"Done","type":"completed"},{"id":"todo-state","name":"Todo","type":"unstarted"}]}}}`, nil
		}
		return http.StatusOK, `{"data":{"issueUpdate":{"success":true}}}`, nil
	})
	require.NoError(t, svc.syncIssueToLinear(ctx, integration, webhooks.IssueEventPayload{Action: "edited", Issue: webhooks.IssuePayload{ID: 40}}))
	require.NoError(t, svc.syncIssueToLinear(ctx, integration, webhooks.IssueEventPayload{Action: "closed", Issue: webhooks.IssuePayload{ID: 40}}))
	require.NoError(t, svc.syncIssueToLinear(ctx, integration, webhooks.IssueEventPayload{Action: "reopened", Issue: webhooks.IssuePayload{ID: 40}}))

	q = &linearSyncCovQuerier{integration: integration, issueMap: issueMap, commentMapBySmithersErr: pgx.ErrNoRows}
	svc = NewLinearSyncService(q, integrationSvc)
	require.NoError(t, svc.updateLinearComment(ctx, integration, "token", issueMap, webhooks.IssueCommentEventPayload{Comment: webhooks.IssueCommentPayload{ID: 50}}))

	q = &linearSyncCovQuerier{integration: integration, issueMap: issueMap}
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusOK, `{"data":{"commentCreate":{"success":true}}}`, nil
	})
	err = svc.createLinearComment(ctx, integration, "token", issueMap, webhooks.IssueCommentEventPayload{Comment: webhooks.IssueCommentPayload{ID: 51}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no comment")

	qErr := &linearSyncHCommentMapErrQuerier{
		linearSyncCovQuerier: &linearSyncCovQuerier{integration: integration, issueMap: issueMap},
		err:                  errors.New("comment map failed"),
	}
	svc = NewLinearSyncService(qErr, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusOK, `{"data":{"commentCreate":{"comment":{"id":"lin-comment"}}}}`, nil
	})
	err = svc.createLinearComment(ctx, integration, "token", issueMap, webhooks.IssueCommentEventPayload{Comment: webhooks.IssueCommentPayload{ID: 52}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to create comment map")

	q = &linearSyncCovQuerier{integration: integration, issueMap: issueMap, commentMap: db.LinearCommentMap{ID: 5, IssueMapID: issueMap.ID, JjhubCommentID: 53, LinearCommentID: "mapped"}}
	require.NoError(t, NewLinearSyncService(q, integrationSvc).createLinearComment(ctx, integration, "token", issueMap, webhooks.IssueCommentEventPayload{Comment: webhooks.IssueCommentPayload{ID: 53}}))

	q = &linearSyncCovQuerier{integration: integration, issueMap: issueMap, commentMapBySmithersErr: pgx.ErrNoRows}
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusInternalServerError, "comment create down", nil
	})
	err = svc.createLinearComment(ctx, integration, "token", issueMap, webhooks.IssueCommentEventPayload{Comment: webhooks.IssueCommentPayload{ID: 54}})
	require.Error(t, err)
	assert.Equal(t, "failed", q.logs[0].Status)

	q = &linearSyncCovQuerier{integration: integration, issueMap: issueMap, commentMapBySmithersErr: pgx.ErrNoRows}
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusOK, `{"data":{"commentCreate":"bad"}}`, nil
	})
	err = svc.createLinearComment(ctx, integration, "token", issueMap, webhooks.IssueCommentEventPayload{Comment: webhooks.IssueCommentPayload{ID: 55}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unexpected commentCreate")

	q = &linearSyncCovQuerier{integration: integration, issueMap: issueMap, commentMap: db.LinearCommentMap{ID: 6, IssueMapID: issueMap.ID, JjhubCommentID: 56, LinearCommentID: "lin-comment"}}
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusInternalServerError, "comment update down", nil
	})
	err = svc.updateLinearComment(ctx, integration, "token", issueMap, webhooks.IssueCommentEventPayload{Comment: webhooks.IssueCommentPayload{ID: 56}})
	require.Error(t, err)
	assert.Equal(t, "failed", q.logs[0].Status)

	q = &linearSyncCovQuerier{integration: integration, issueMap: issueMap, commentMap: db.LinearCommentMap{ID: 7, IssueMapID: issueMap.ID, JjhubCommentID: 57, LinearCommentID: "lin-comment"}}
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusInternalServerError, "comment delete down", nil
	})
	err = svc.deleteLinearComment(ctx, integration, "token", issueMap, webhooks.IssueCommentEventPayload{Comment: webhooks.IssueCommentPayload{ID: 57}})
	require.Error(t, err)
	assert.Equal(t, "failed", q.logs[0].Status)

	q = &linearSyncCovQuerier{integration: expiredBadRefresh, issueMap: issueMap}
	svc = NewLinearSyncService(q, integrationSvc)
	err = svc.syncCommentToLinear(ctx, expiredBadRefresh, webhooks.IssueCommentEventPayload{Action: "created", Issue: webhooks.IssuePayload{ID: issueMap.JjhubIssueID}, Comment: webhooks.IssueCommentPayload{ID: 58}})
	require.Error(t, err)

	q = &linearSyncCovQuerier{integration: integration, issueMap: issueMap, recentExists: true}
	require.NoError(t, NewLinearSyncService(q, integrationSvc).syncCommentToLinear(ctx, integration, webhooks.IssueCommentEventPayload{Action: "created", Comment: webhooks.IssueCommentPayload{ID: 59}}))
	q = &linearSyncCovQuerier{integration: integration, issueMap: issueMap}
	require.NoError(t, NewLinearSyncService(q, integrationSvc).syncCommentToLinear(ctx, integration, webhooks.IssueCommentEventPayload{Action: "noop", Issue: webhooks.IssuePayload{ID: issueMap.JjhubIssueID}, Comment: webhooks.IssueCommentPayload{ID: 60}}))
}

func TestLinearSync_H_InboundCommentAndGraphQLBranches(t *testing.T) {
	ctx := context.Background()
	integration, integrationSvc := linearSyncCovIntegration(t)
	issueMap := db.LinearIssueMap{ID: 3, IntegrationID: integration.ID, JjhubIssueID: 60, LinearIssueID: "lin-60"}
	commentMap := db.LinearCommentMap{ID: 4, IssueMapID: issueMap.ID, JjhubCommentID: 70, LinearCommentID: "lin-comment-70"}

	q := &linearSyncCovQuerier{integration: integration, issueMapByLinear: issueMap, commentMap: commentMap, updateIssueCommentErr: errors.New("update failed")}
	svc := NewLinearSyncService(q, integrationSvc)
	err := svc.handleLinearCommentWebhook(ctx, integration, "update", []byte(`{"id":"lin-comment-70","body":"body","issueId":"lin-60"}`))
	require.Error(t, err)
	require.Len(t, q.logs, 1)
	assert.Equal(t, "failed", q.logs[0].Status)

	q = &linearSyncCovQuerier{integration: integration, issueMapByLinear: issueMap, commentMap: commentMap, getIssueCommentErr: pgx.ErrNoRows}
	svc = NewLinearSyncService(q, integrationSvc)
	require.NoError(t, svc.handleLinearCommentWebhook(ctx, integration, "remove", []byte(`{"id":"lin-comment-70","body":"body","issueId":"lin-60"}`)))
	assert.Empty(t, q.deletedIssueCommentIDs)

	q = &linearSyncCovQuerier{integration: integration, issueMapByLinear: issueMap, commentMap: commentMap, deleteIssueCommentErr: errors.New("delete failed")}
	svc = NewLinearSyncService(q, integrationSvc)
	err = svc.handleLinearCommentWebhook(ctx, integration, "remove", []byte(`{"id":"lin-comment-70","body":"body","issueId":"lin-60"}`))
	require.Error(t, err)
	assert.Equal(t, "failed", q.logs[0].Status)

	require.NoError(t, svc.handleLinearCommentWebhook(ctx, integration, "create", []byte(`{"id":"lin-comment-70","body":"body","issueId":"lin-60"}`)))

	q = &linearSyncCovQuerier{integration: integration, issueMapByLinear: issueMap, commentMapByLinearErr: pgx.ErrNoRows}
	svc = NewLinearSyncService(q, integrationSvc)
	require.NoError(t, svc.handleLinearCommentWebhook(ctx, integration, "remove", []byte(`{"id":"lin-comment-missing","body":"body","issueId":"lin-60"}`)))

	q = &linearSyncCovQuerier{integration: integration, recentExists: true}
	svc = NewLinearSyncService(q, integrationSvc)
	require.NoError(t, svc.handleLinearIssueWebhook(ctx, integration, "update", []byte(`{"id":"lin-issue","identifier":"PLT","title":"Title","description":"Body"}`)))
	require.NoError(t, svc.handleLinearCommentWebhook(ctx, integration, "update", []byte(`{"id":"lin-comment","body":"Body","issueId":"lin-issue"}`)))

	svc = NewLinearSyncService(&linearSyncCovQuerier{}, nil)
	oldURL := linearGraphQLURL
	linearGraphQLURL = "://bad-url"
	_, err = svc.linearGraphQLMutation(ctx, "token", "query", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create graphql request")
	linearGraphQLURL = oldURL

	svc.httpClient = &http.Client{Transport: linearSyncRoundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: linearSyncHBadReader{}}, nil
	})}
	_, err = svc.linearGraphQLMutation(ctx, "token", "query", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "read graphql response")

	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusOK, `{"data":{"workflowStates":{"nodes":[123,{"id":"done-by-name","name":"Done","type":"completed"}]}}}`, nil
	})
	id, err := svc.getLinearWorkflowStateID(ctx, "token", "team", "Done")
	require.NoError(t, err)
	assert.Equal(t, "done-by-name", id)

	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusOK, `{"data":{"workflowStates":{"nodes":[123,{"id":"todo-by-type","name":"Other","type":"unstarted"}]}}}`, nil
	})
	id, err = svc.getLinearWorkflowStateID(ctx, "token", "team", "Todo")
	require.NoError(t, err)
	assert.Equal(t, "todo-by-type", id)

	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusInternalServerError, "states down", nil
	})
	_, err = svc.getLinearWorkflowStateID(ctx, "token", "team", "Done")
	require.Error(t, err)

	_ = io.EOF
}

func TestLinearSync_H_RunInitialSyncBranches(t *testing.T) {
	ctx := context.Background()
	integration, integrationSvc := linearSyncCovIntegration(t)

	badSvc := NewLinearIntegrationService(nil, nil, "wrong-secret")
	svc := NewLinearSyncService(&linearSyncCovQuerier{integration: integration}, badSvc)
	svc.RunInitialSync(ctx, integration)

	expiredBadRefresh := integration
	expiredBadRefresh.TokenExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-time.Hour), Valid: true}
	expiredBadRefresh.RefreshTokenEncrypted = []byte("bad-refresh")
	svc = NewLinearSyncService(&linearSyncCovQuerier{integration: expiredBadRefresh}, integrationSvc)
	svc.RunInitialSync(ctx, expiredBadRefresh)

	q := &linearSyncCovQuerier{integration: integration}
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusInternalServerError, "down", nil
	})
	svc.RunInitialSync(ctx, integration)
	assert.Empty(t, q.lastSyncIDs)

	for _, body := range []string{
		`{"data":{"issues":"bad"}}`,
		`{"data":{"issues":{"nodes":"bad"}}}`,
	} {
		q = &linearSyncCovQuerier{integration: integration}
		svc = NewLinearSyncService(q, integrationSvc)
		svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
			return http.StatusOK, body, nil
		})
		svc.RunInitialSync(ctx, integration)
		assert.Empty(t, q.lastSyncIDs)
	}

	q = &linearSyncCovQuerier{integration: integration, issueMapByLinear: db.LinearIssueMap{ID: 9, LinearIssueID: "already"}}
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusOK, `{"data":{"issues":{"nodes":[123,{"id":"already","identifier":"PLT-1","title":"Already","description":"Body"}],"pageInfo":{"hasNextPage":false}}}}`, nil
	})
	svc.RunInitialSync(ctx, integration)
	assert.Equal(t, []int64{integration.ID}, q.lastSyncIDs)

	q = &linearSyncCovQuerier{integration: integration, createIssueErr: errors.New("create failed")}
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusOK, `{"data":{"issues":{"nodes":[{"id":"new","identifier":"PLT-2","title":"New","description":"Body"}],"pageInfo":{"hasNextPage":false}}}}`, nil
	})
	svc.RunInitialSync(ctx, integration)
	require.Len(t, q.logs, 1)
	assert.Equal(t, "failed", q.logs[0].Status)
	assert.Equal(t, []int64{integration.ID}, q.lastSyncIDs)
}
