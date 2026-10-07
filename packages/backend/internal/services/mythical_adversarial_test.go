package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// adversarialIssueEvent includes the fields GitHub sends to the issue webhook.
// The trust fields are added by GitHubTextStamper at ingress in production.
func adversarialIssueEvent(t *testing.T, number int64, action, label, sender string, labels []string, stamped bool) []byte {
	t.Helper()
	names := make([]map[string]string, 0, len(labels))
	for _, name := range labels {
		names = append(names, map[string]string{"name": name})
	}
	data, err := json.Marshal(map[string]any{
		"action":       action,
		"installation": map[string]any{"id": 777},
		"issue": map[string]any{
			"number": number, "title": fmt.Sprintf("TODO %d", number), "body": "add the file",
			"html_url": fmt.Sprintf("https://github.com/smithersai/smithers/issues/%d", number),
			"state":    "open", "user": map[string]any{"login": "fucory", "type": "User"},
			"labels": names, "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
			issueTextByMaintainerField: stamped,
		},
		"label":      map[string]any{"name": label, labelAppliedByMaintainerField: stamped},
		"sender":     map[string]any{"login": sender, "type": "User"},
		"repository": map[string]any{"id": 9001, "name": "smithers", "owner": map[string]any{"login": "smithersai"}},
	})
	require.NoError(t, err)
	return data
}

type adversarialLiveLabels struct {
	*fakeMythicalGitHub
	automergePresent bool
}

type adversarialStampedMythical struct {
	service *MythicalService
	stamps  [][]byte
}

func (m *adversarialStampedMythical) ObserveGitHubEvent(ctx context.Context, eventType string, payload []byte) error {
	m.stamps = append(m.stamps, append([]byte(nil), payload...))
	return m.service.ObserveGitHubEvent(ctx, eventType, payload)
}

func adversarialGitHubSource(o *mythicalOrchestration) {
	o.t.Helper()
	_, err := o.pool.Exec(context.Background(),
		`UPDATE repositories SET mirror_destination = 'https://github.com/smithersai/smithers' WHERE id = $1`, o.repoID)
	require.NoError(o.t, err)
}

func (g *adversarialLiveLabels) LabelApplier(ctx context.Context, repo mythicalGitHubRepo, number int64, label string) (*mythicalLabelApplier, error) {
	if label == automergeLabel && !g.automergePresent {
		return nil, nil
	}
	return g.fakeMythicalGitHub.LabelApplier(ctx, repo, number, label)
}

func TestMythicalAdversarialOtherWriterLabelsThroughStamper(t *testing.T) {
	o := newMythicalOrchestration(t)
	adversarialGitHubSource(o)
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/graphql":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"repository": map[string]any{
				"issueOrPullRequest": map[string]any{"title": "TODO 602", "body": "add the file",
					"author":           map[string]string{"__typename": "User", "login": "fucory"},
					"userContentEdits": map[string]any{"nodes": []any{}},
					"timelineItems":    map[string]any{"nodes": []any{}},
				},
			}}})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/permission"):
			_ = json.NewEncoder(w).Encode(map[string]string{"permission": "write"})
		case r.Method == http.MethodGet && r.URL.Path == "/repos/smithersai/smithers/issues/events":
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"id": 2, "issue": map[string]int{"number": 602}, "event": "labeled", "actor": map[string]string{"login": "other-writer"},
					"label": map[string]string{"name": "todo"}, "created_at": "2026-01-01T00:00:00Z"},
				{"id": 1, "issue": map[string]int{"number": 602}, "event": "labeled", "actor": map[string]string{"login": "other-writer"},
					"label": map[string]string{"name": "automerge"}, "created_at": "2026-01-01T00:00:00Z"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	stamper := &GitHubTextStamper{tokens: fakeIssueTextTokens{}, api: &gitHubIssueTextAPI{
		api: &landingGitHubAPI{client: server.Client(), baseURL: func() string { return server.URL }},
	}}
	worker := NewGitHubWebhookEventWorker(&mockGitHubWebhookEventWorkerQuerier{}, &mockGitHubWebhookEventRunDispatcher{})
	worker.SetTextStamper(stamper)
	observed := &adversarialStampedMythical{service: o.service}
	worker.SetMythical(observed)
	for i, label := range []string{"todo", "automerge"} {
		labels := []string{"todo"}
		if label == "automerge" {
			labels = append(labels, "automerge")
		}
		payload := adversarialIssueEvent(t, 602, "labeled", label, "other-writer", labels, false)
		require.ErrorContains(t, worker.processJob(ctx, db.GithubWebhookJob{
			ID: int64(602 + i), EventType: "issues", Action: "labeled", Payload: payload,
		}), "Issue TODO admission is not configured")
	}
	require.Len(t, observed.stamps, 2)
	for _, payload := range observed.stamps {
		var stamp struct {
			Issue struct {
				TextByMaintainer bool `json:"smithers_text_by_maintainer"`
			} `json:"issue"`
			Label struct {
				ByMaintainer bool `json:"smithers_applied_by_maintainer"`
			} `json:"label"`
		}
		require.NoError(t, json.Unmarshal(payload, &stamp))
		assert.True(t, stamp.Issue.TextByMaintainer)
		assert.True(t, stamp.Label.ByMaintainer)
	}
	var items int
	require.NoError(t, o.pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, o.repoID).Scan(&items))
	require.Zero(t, items)
	assert.Empty(t, o.github.removed)
	assert.Empty(t, o.github.merges)
}

func TestMythicalBudgetCountsPendingCallsAtTheirBound(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	q := db.New(o.pool)
	day := time.Now().UTC().Truncate(24 * time.Hour)
	o.spend("", 40)
	_, err := o.pool.Exec(ctx, `UPDATE model_usage SET outcome = 'pending', settled_at = NULL, bound_tokens = 700 WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	spent, err := q.MythicalRepositoryTokensSince(ctx, o.repoID, day)
	require.NoError(t, err)
	assert.EqualValues(t, 700, spent, "a pending call counts its bound")
	_, err = o.pool.Exec(ctx, `UPDATE model_usage SET outcome = 'succeeded', settled_at = now() WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	spent, err = q.MythicalRepositoryTokensSince(ctx, o.repoID, day)
	require.NoError(t, err)
	assert.EqualValues(t, 40, spent, "a settled call counts what it reported")
	_, err = o.pool.Exec(ctx, `UPDATE model_usage SET outcome = 'unknown', bound_tokens = 10 WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	spent, err = q.MythicalRepositoryTokensSince(ctx, o.repoID, day)
	require.NoError(t, err)
	assert.EqualValues(t, 40, spent, "never less than what was recorded")
}
