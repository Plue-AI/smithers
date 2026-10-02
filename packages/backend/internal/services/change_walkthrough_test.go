package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestChangeServiceGetWalkthroughReturnsRevisionArtifact(t *testing.T) {
	t.Parallel()
	diagram := "graph TD; A-->B"
	queries := &changeTestQueries{walkthrough: db.ChangeWalkthrough{
		Sections: json.RawMessage(`[{"title":"Data flow","markdown":"Read **this** first.","diagram":"graph TD; A-->B"}]`),
		Quiz:     json.RawMessage(`[{"question":"What is cached?","options":["A","B"],"correctIndex":1}]`),
	}}

	got, err := NewChangeService(queries, nil, nil).GetWalkthrough(context.Background(), 42, "change-1", 3)
	require.NoError(t, err)
	assert.Equal(t, db.GetChangeWalkthroughParams{RepositoryID: 42, ChangeID: "change-1", RevisionSeq: 3}, queries.walkthroughGet)
	require.Len(t, got.Sections, 1)
	assert.Equal(t, ChangeWalkthroughSection{Title: "Data flow", Markdown: "Read **this** first.", Diagram: &diagram}, got.Sections[0])
	encoded, err := json.Marshal(got)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "quiz")
}

func TestChangeServiceGetWalkthroughDefaultsToLatestAndReturnsNotFound(t *testing.T) {
	t.Parallel()
	queries := &changeTestQueries{walkthroughErr: pgx.ErrNoRows}

	_, err := NewChangeService(queries, nil, nil).GetWalkthrough(context.Background(), 7, "missing", 0)
	assertAPIStatus(t, err, http.StatusNotFound)
	assert.Zero(t, queries.walkthroughGet.RevisionSeq)
}

func TestChangeServiceGetWalkthroughRejectsCorruptArtifact(t *testing.T) {
	t.Parallel()
	queries := &changeTestQueries{walkthrough: db.ChangeWalkthrough{
		Sections: json.RawMessage(`{"not":"an array"}`),
		Quiz:     json.RawMessage(`[]`),
	}}

	_, err := NewChangeService(queries, nil, nil).GetWalkthrough(context.Background(), 1, "change-1", 1)
	assertAPIStatus(t, err, http.StatusInternalServerError)
}

func TestChangeServiceStoreWalkthroughPersistsAndNotifiesExactRevision(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	queries := &changeTestQueries{
		walkthroughRevision: db.ChangeRevision{ID: 91, Seq: 5},
		walkthrough:         db.ChangeWalkthrough{ID: 14, UpdatedAt: now},
	}
	diagram := "sequenceDiagram\nA->>B: review"
	input := ChangeWalkthroughResponse{
		Sections: []ChangeWalkthroughSection{{Title: "Review", Markdown: "Narrative", Diagram: &diagram}},
	}

	got, err := NewChangeService(queries, nil, nil).StoreWalkthrough(context.Background(), 42, "change-1", 5, input)
	require.NoError(t, err)
	assert.Equal(t, input.Sections, got.Sections)
	assert.JSONEq(t, `[]`, string(queries.walkthroughUpserts[0].Quiz))
	require.Len(t, queries.walkthroughUpserts, 1)
	assert.Equal(t, int64(91), queries.walkthroughUpserts[0].ChangeRevisionID)
	assert.JSONEq(t, `[{"title":"Review","markdown":"Narrative","diagram":"sequenceDiagram\nA->>B: review"}]`, string(queries.walkthroughUpserts[0].Sections))
	require.Len(t, queries.changeNotifications, 1)
	assert.Equal(t, int64(42), queries.changeNotifications[0].RepositoryID)
	assert.JSONEq(t, `{"event_id":"14-1788350400000000000","action":"walkthrough_available","change_id":"change-1","revision_seq":5}`, queries.changeNotifications[0].Payload)
}

func TestChangeServiceStoreWalkthroughDefaultsToLatestRevision(t *testing.T) {
	t.Parallel()
	queries := &changeTestQueries{walkthroughRevision: db.ChangeRevision{ID: 11, Seq: 8}}

	_, err := NewChangeService(queries, nil, nil).StoreWalkthrough(context.Background(), 2, "change-2", 0, ChangeWalkthroughResponse{})
	require.NoError(t, err)
	assert.Zero(t, queries.walkthroughRevisionGet.RevisionSeq)
	assert.JSONEq(t, `[]`, string(queries.walkthroughUpserts[0].Sections))
	assert.JSONEq(t, `[]`, string(queries.walkthroughUpserts[0].Quiz))
	assert.Contains(t, queries.changeNotifications[0].Payload, `"revision_seq":8`)
}

func TestChangeServiceStoreWalkthroughRejectsMissingRevisionAndNotifyFailure(t *testing.T) {
	t.Parallel()

	t.Run("missing revision", func(t *testing.T) {
		queries := &changeTestQueries{walkthroughRevisionErr: pgx.ErrNoRows}
		_, err := NewChangeService(queries, nil, nil).StoreWalkthrough(context.Background(), 1, "missing", 2, ChangeWalkthroughResponse{})
		assertAPIStatus(t, err, http.StatusNotFound)
		assert.Empty(t, queries.walkthroughUpserts)
	})

	t.Run("notification failure", func(t *testing.T) {
		queries := &changeTestQueries{
			walkthroughRevision:   db.ChangeRevision{ID: 2, Seq: 1},
			changeNotificationErr: stdErrors.New("notify unavailable"),
		}
		_, err := NewChangeService(queries, nil, nil).StoreWalkthrough(context.Background(), 1, "change-1", 1, ChangeWalkthroughResponse{})
		assertAPIStatus(t, err, http.StatusInternalServerError)
	})
}

func assertAPIStatus(t *testing.T, err error, status int) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, status, apiErr.Status)
}

func TestChangeWalkthroughHistoricalQuizDoesNotAffectSections(t *testing.T) {
	t.Parallel()
	for _, legacy := range []json.RawMessage{json.RawMessage(`[{"question":"old"}]`), json.RawMessage(`null`), json.RawMessage(`{"retired":"shape"}`)} {
		got, err := decodeChangeWalkthrough(db.ChangeWalkthrough{Sections: json.RawMessage(`[{"title":"Kept","markdown":"Narrative"}]`), Quiz: legacy})
		require.NoError(t, err)
		require.Len(t, got.Sections, 1)
		assert.Equal(t, "Kept", got.Sections[0].Title)
	}
}
