package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// mockRepoHostSnapshotter implements RepoHostSnapshotter for unit tests.
type mockRepoHostSnapshotter struct {
	createSnapshotFn func(ctx context.Context, repoID int64) (string, error)
}

func (m *mockRepoHostSnapshotter) CreateSnapshot(ctx context.Context, repoID int64) (string, error) {
	if m.createSnapshotFn != nil {
		return m.createSnapshotFn(ctx, repoID)
	}
	return "", nil
}

type mockAgentSecretReader struct {
	listDecryptedSecretsForRepoFn func(ctx context.Context, repositoryID int64) (map[string]string, error)
}

func (m *mockAgentSecretReader) ListDecryptedSecretsForRepo(ctx context.Context, repositoryID int64) (map[string]string, error) {
	if m.listDecryptedSecretsForRepoFn != nil {
		return m.listDecryptedSecretsForRepoFn(ctx, repositoryID)
	}
	return map[string]string{}, nil
}

// mockAgentQuerier implements AgentQuerier for unit tests.
type mockAgentQuerier struct {
	createAgentSessionFn                      func(ctx context.Context, arg db.CreateAgentSessionParams) (db.AgentSession, error)
	getAgentSessionFn                         func(ctx context.Context, id string) (db.AgentSession, error)
	getAgentSessionWithMessageCountFn         func(ctx context.Context, id string) (db.GetAgentSessionWithMessageCountRow, error)
	listAgentSessionsByRepoFn                 func(ctx context.Context, arg db.ListAgentSessionsByRepoParams) ([]db.AgentSession, error)
	listAgentSessionsByRepoWithMessageCountFn func(ctx context.Context, arg db.ListAgentSessionsByRepoWithMessageCountParams) ([]db.ListAgentSessionsByRepoWithMessageCountRow, error)
	countAgentSessionsByRepoFn                func(ctx context.Context, repositoryID int64) (int64, error)
	countAgentMessagesBySessionFn             func(ctx context.Context, sessionID string) (int64, error)
	deleteAgentSessionFn                      func(ctx context.Context, arg db.DeleteAgentSessionParams) error
	createAgentMessageFn                      func(ctx context.Context, arg db.CreateAgentMessageParams) (db.AgentMessage, error)
	getNextAgentMessageSequenceFn             func(ctx context.Context, sessionID string) (int32, error)
	createAgentPartFn                         func(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error)
	listAgentMessagesFn                       func(ctx context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error)
	listAgentMessagePartsFn                   func(ctx context.Context, messageID int64) ([]db.AgentPart, error)
	notifyAgentMessageFn                      func(ctx context.Context, arg db.NotifyAgentMessageParams) error
	notifyAgentSessionFn                      func(ctx context.Context, arg db.NotifyAgentSessionParams) error
	getAgentSessionWorkflowRunIDFn            func(ctx context.Context, id string) (pgtype.Int8, error)
	prepareAgentSessionForTurnFn              func(ctx context.Context, sessionID string) (db.AgentSession, error)
}

func (m *mockAgentQuerier) CreateAgentSession(ctx context.Context, arg db.CreateAgentSessionParams) (db.AgentSession, error) {
	if m.createAgentSessionFn != nil {
		return m.createAgentSessionFn(ctx, arg)
	}
	return sampleDBAgentSession(arg.ID, arg.RepositoryID, arg.UserID, arg.Title), nil
}

func (m *mockAgentQuerier) GetAgentSession(ctx context.Context, id string) (db.AgentSession, error) {
	if m.getAgentSessionFn != nil {
		return m.getAgentSessionFn(ctx, id)
	}
	return sampleDBAgentSession(id, 101, 1, "default"), nil
}

func (m *mockAgentQuerier) PrepareAgentSessionForTurn(ctx context.Context, sessionID string) (db.AgentSession, error) {
	if m.prepareAgentSessionForTurnFn != nil {
		return m.prepareAgentSessionForTurnFn(ctx, sessionID)
	}
	return sampleDBAgentSession(sessionID, 101, 1, "default"), nil
}

func (m *mockAgentQuerier) GetAgentSessionWithMessageCount(ctx context.Context, id string) (db.GetAgentSessionWithMessageCountRow, error) {
	if m.getAgentSessionWithMessageCountFn != nil {
		return m.getAgentSessionWithMessageCountFn(ctx, id)
	}
	s := sampleDBAgentSession(id, 101, 1, "default")
	return db.GetAgentSessionWithMessageCountRow{
		ID:           s.ID,
		RepositoryID: s.RepositoryID,
		UserID:       s.UserID,
		Title:        s.Title,
		Status:       s.Status,
		CreatedAt:    s.CreatedAt,
		UpdatedAt:    s.UpdatedAt,
		MessageCount: 0,
	}, nil
}

func (m *mockAgentQuerier) ListAgentSessionsByRepo(ctx context.Context, arg db.ListAgentSessionsByRepoParams) ([]db.AgentSession, error) {
	if m.listAgentSessionsByRepoFn != nil {
		return m.listAgentSessionsByRepoFn(ctx, arg)
	}
	return []db.AgentSession{sampleDBAgentSession("s1", arg.RepositoryID, 1, "session one")}, nil
}

func (m *mockAgentQuerier) ListAgentSessionsByRepoWithMessageCount(ctx context.Context, arg db.ListAgentSessionsByRepoWithMessageCountParams) ([]db.ListAgentSessionsByRepoWithMessageCountRow, error) {
	if m.listAgentSessionsByRepoWithMessageCountFn != nil {
		return m.listAgentSessionsByRepoWithMessageCountFn(ctx, arg)
	}
	s := sampleDBAgentSession("s1", arg.RepositoryID, 1, "session one")
	return []db.ListAgentSessionsByRepoWithMessageCountRow{
		{
			ID:           s.ID,
			RepositoryID: s.RepositoryID,
			UserID:       s.UserID,
			Title:        s.Title,
			Status:       s.Status,
			CreatedAt:    s.CreatedAt,
			UpdatedAt:    s.UpdatedAt,
			MessageCount: 5,
		},
	}, nil
}

func (m *mockAgentQuerier) CountAgentSessionsByRepo(ctx context.Context, repositoryID int64) (int64, error) {
	if m.countAgentSessionsByRepoFn != nil {
		return m.countAgentSessionsByRepoFn(ctx, repositoryID)
	}
	return 1, nil
}

func (m *mockAgentQuerier) CountAgentMessagesBySession(ctx context.Context, sessionID string) (int64, error) {
	if m.countAgentMessagesBySessionFn != nil {
		return m.countAgentMessagesBySessionFn(ctx, sessionID)
	}
	return 0, nil
}

func (m *mockAgentQuerier) DeleteAgentSession(ctx context.Context, arg db.DeleteAgentSessionParams) error {
	if m.deleteAgentSessionFn != nil {
		return m.deleteAgentSessionFn(ctx, arg)
	}
	return nil
}

func (m *mockAgentQuerier) CreateAgentMessage(ctx context.Context, arg db.CreateAgentMessageParams) (db.AgentMessage, error) {
	if m.createAgentMessageFn != nil {
		return m.createAgentMessageFn(ctx, arg)
	}
	msg := sampleDBAgentMessage(1, arg.SessionID, arg.Role, arg.Sequence)
	msg.RepositoryID = arg.RepositoryID
	return msg, nil
}

func (m *mockAgentQuerier) GetNextAgentMessageSequence(ctx context.Context, sessionID string) (int32, error) {
	if m.getNextAgentMessageSequenceFn != nil {
		return m.getNextAgentMessageSequenceFn(ctx, sessionID)
	}
	return 0, nil
}

func (m *mockAgentQuerier) CreateAgentPart(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
	if m.createAgentPartFn != nil {
		return m.createAgentPartFn(ctx, arg)
	}
	return sampleDBAgentPart(1, arg.MessageID, arg.PartIndex, arg.PartType, arg.Content), nil
}

func (m *mockAgentQuerier) ListAgentMessages(ctx context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
	if m.listAgentMessagesFn != nil {
		return m.listAgentMessagesFn(ctx, arg)
	}
	return []db.AgentMessage{sampleDBAgentMessage(1, arg.SessionID, "user", 0)}, nil
}

func (m *mockAgentQuerier) ListAgentMessagesAfterID(_ context.Context, _ db.ListAgentMessagesAfterIDParams) ([]db.AgentMessage, error) {
	return nil, nil
}

func (m *mockAgentQuerier) ListAgentMessageParts(ctx context.Context, messageID int64) ([]db.AgentPart, error) {
	if m.listAgentMessagePartsFn != nil {
		return m.listAgentMessagePartsFn(ctx, messageID)
	}
	return []db.AgentPart{sampleDBAgentPart(1, messageID, 0, "text", json.RawMessage(`"test content"`))}, nil
}

func (m *mockAgentQuerier) NotifyAgentMessage(ctx context.Context, arg db.NotifyAgentMessageParams) error {
	if m.notifyAgentMessageFn != nil {
		return m.notifyAgentMessageFn(ctx, arg)
	}
	return nil
}

func (m *mockAgentQuerier) NotifyAgentSession(ctx context.Context, arg db.NotifyAgentSessionParams) error {
	if m.notifyAgentSessionFn != nil {
		return m.notifyAgentSessionFn(ctx, arg)
	}
	return nil
}

func (m *mockAgentQuerier) GetAgentSessionWorkflowRunID(ctx context.Context, id string) (pgtype.Int8, error) {
	if m.getAgentSessionWorkflowRunIDFn != nil {
		return m.getAgentSessionWorkflowRunIDFn(ctx, id)
	}
	return pgtype.Int8{Valid: false}, nil
}

// sample DB-level helpers

func sampleDBAgentSession(id string, repoID, userID int64, title string) db.AgentSession {
	now := time.Now().UTC().Truncate(time.Second)
	return db.AgentSession{
		ID:           id,
		RepositoryID: repoID,
		UserID:       userID,
		Title:        title,
		Status:       "active",
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}

func sampleDBAgentMessage(id int64, sessionID, role string, seq int64) db.AgentMessage {
	return db.AgentMessage{
		ID:        id,
		SessionID: sessionID,
		Role:      role,
		Sequence:  seq,
		CreatedAt: time.Now().UTC().Truncate(time.Second),
	}
}

func sampleDBAgentPart(id, messageID, partIndex int64, partType string, content json.RawMessage) db.AgentPart {
	return db.AgentPart{
		ID:        id,
		MessageID: messageID,
		PartIndex: partIndex,
		PartType:  partType,
		Content:   content,
		CreatedAt: time.Now().UTC().Truncate(time.Second),
	}
}

// ---- CreateSession ----

func TestAgentService_CreateSession_Success(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		createAgentSessionFn: func(ctx context.Context, arg db.CreateAgentSessionParams) (db.AgentSession, error) {
			assert.Equal(t, int64(101), arg.RepositoryID)
			assert.Equal(t, int64(1), arg.UserID)
			assert.Equal(t, "Test session", arg.Title)
			assert.Equal(t, "active", arg.Status)
			// ID should be a valid UUID (non-empty)
			assert.NotEmpty(t, arg.ID)
			return sampleDBAgentSession(arg.ID, arg.RepositoryID, arg.UserID, arg.Title), nil
		},
	})

	result, err := svc.CreateSession(context.Background(), CreateAgentSessionInput{
		RepositoryID: 101,
		UserID:       1,
		Title:        "Test session",
	})
	require.NoError(t, err)
	assert.NotEmpty(t, result.ID)
	assert.Equal(t, int64(101), result.RepositoryID)
	assert.Equal(t, int64(1), result.UserID)
	assert.Equal(t, "Test session", result.Title)
	assert.Equal(t, "active", result.Status)
}

func TestAgentService_CreateSession_DBError(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		createAgentSessionFn: func(ctx context.Context, arg db.CreateAgentSessionParams) (db.AgentSession, error) {
			return db.AgentSession{}, errors.New("db error")
		},
	})

	_, err := svc.CreateSession(context.Background(), CreateAgentSessionInput{
		RepositoryID: 101,
		UserID:       1,
		Title:        "Test",
	})
	require.Error(t, err)
}

func TestAgentService_CreateSessionPersistsMetadataAndMapsFindingRace(t *testing.T) {
	t.Parallel()

	metadata := json.RawMessage(`{"finding_id":12}`)
	svc := NewAgentService(&mockAgentQuerier{createAgentSessionFn: func(_ context.Context, arg db.CreateAgentSessionParams) (db.AgentSession, error) {
		assert.JSONEq(t, string(metadata), string(arg.Metadata))
		session := sampleDBAgentSession(arg.ID, arg.RepositoryID, arg.UserID, arg.Title)
		session.Metadata = metadata
		return session, nil
	}})
	response, err := svc.CreateSession(context.Background(), CreateAgentSessionInput{
		RepositoryID: 101, UserID: 1, Title: "Fix finding #12", Metadata: metadata,
	})
	require.NoError(t, err)
	assert.JSONEq(t, string(metadata), string(response.Metadata))

	racingService := NewAgentService(&mockAgentQuerier{createAgentSessionFn: func(context.Context, db.CreateAgentSessionParams) (db.AgentSession, error) {
		return db.AgentSession{}, &pgconn.PgError{Code: "23505", ConstraintName: "uq_agent_sessions_active_finding_dispatch"}
	}})
	_, err = racingService.CreateSession(context.Background(), CreateAgentSessionInput{
		RepositoryID: 101, UserID: 1, Title: "Fix finding #12", Metadata: metadata,
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusConflict, apiErr.Status)
}

func TestAgentService_CreateSession_NilQuerier(t *testing.T) {
	t.Parallel()
	svc := NewAgentService(nil)
	_, err := svc.CreateSession(context.Background(), CreateAgentSessionInput{
		RepositoryID: 1,
		UserID:       1,
		Title:        "test",
	})
	require.Error(t, err)
}

// ---- GetSession ----

func TestAgentService_GetSession_Success(t *testing.T) {
	t.Parallel()

	sessionID := "session-abc-123"
	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionWithMessageCountFn: func(ctx context.Context, id string) (db.GetAgentSessionWithMessageCountRow, error) {
			assert.Equal(t, sessionID, id)
			s := sampleDBAgentSession(id, 101, 1, "My session")
			return db.GetAgentSessionWithMessageCountRow{
				ID:           s.ID,
				RepositoryID: s.RepositoryID,
				UserID:       s.UserID,
				Title:        s.Title,
				Status:       s.Status,
				CreatedAt:    s.CreatedAt,
				UpdatedAt:    s.UpdatedAt,
				MessageCount: 5,
			}, nil
		},
	})

	result, err := svc.GetSession(context.Background(), sessionID)
	require.NoError(t, err)
	assert.Equal(t, sessionID, result.ID)
	assert.Equal(t, "My session", result.Title)
	assert.Equal(t, "active", result.Status)
	assert.Equal(t, int64(5), result.MessageCount)
}

func TestAgentService_GetSession_NotFound(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionWithMessageCountFn: func(ctx context.Context, id string) (db.GetAgentSessionWithMessageCountRow, error) {
			return db.GetAgentSessionWithMessageCountRow{}, errors.New("no rows")
		},
	})

	_, err := svc.GetSession(context.Background(), "nonexistent-id")
	require.Error(t, err)
}

// ---- ListSessions ----

func TestAgentService_ListSessions_Success(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC().Truncate(time.Second)
	svc := NewAgentService(&mockAgentQuerier{
		listAgentSessionsByRepoWithMessageCountFn: func(ctx context.Context, arg db.ListAgentSessionsByRepoWithMessageCountParams) ([]db.ListAgentSessionsByRepoWithMessageCountRow, error) {
			assert.Equal(t, int64(101), arg.RepositoryID)
			// page=2, perPage=10 → offset=10
			assert.Equal(t, int32(10), arg.PageOffset)
			assert.Equal(t, int32(10), arg.PageSize)
			return []db.ListAgentSessionsByRepoWithMessageCountRow{
				{ID: "s1", RepositoryID: 101, UserID: 1, Title: "first", Status: "active", MessageCount: 3, CreatedAt: now, UpdatedAt: now},
				{ID: "s2", RepositoryID: 101, UserID: 1, Title: "second", Status: "completed", MessageCount: 7, CreatedAt: now, UpdatedAt: now},
			}, nil
		},
		countAgentSessionsByRepoFn: func(ctx context.Context, repositoryID int64) (int64, error) {
			assert.Equal(t, int64(101), repositoryID)
			return 22, nil
		},
	})

	sessions, total, err := svc.ListSessions(context.Background(), 101, 2, 10)
	require.NoError(t, err)
	assert.Equal(t, int64(22), total)
	assert.Len(t, sessions, 2)
	assert.Equal(t, "first", sessions[0].Title)
	assert.Equal(t, "second", sessions[1].Title)
	assert.Equal(t, int64(3), sessions[0].MessageCount)
	assert.Equal(t, int64(7), sessions[1].MessageCount)
}

func TestAgentService_ListSessions_DefaultPagination(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		listAgentSessionsByRepoWithMessageCountFn: func(ctx context.Context, arg db.ListAgentSessionsByRepoWithMessageCountParams) ([]db.ListAgentSessionsByRepoWithMessageCountRow, error) {
			// page=0 defaults to page=1, perPage=0 defaults to 30
			assert.Equal(t, int32(0), arg.PageOffset)
			assert.Equal(t, int32(30), arg.PageSize)
			return nil, nil
		},
		countAgentSessionsByRepoFn: func(ctx context.Context, repositoryID int64) (int64, error) {
			return 0, nil
		},
	})

	sessions, total, err := svc.ListSessions(context.Background(), 101, 0, 0)
	require.NoError(t, err)
	assert.Equal(t, int64(0), total)
	assert.Empty(t, sessions)
}

func TestAgentService_ListSessions_PerPageExceedingMaxResetsToDefault(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		listAgentSessionsByRepoWithMessageCountFn: func(ctx context.Context, arg db.ListAgentSessionsByRepoWithMessageCountParams) ([]db.ListAgentSessionsByRepoWithMessageCountRow, error) {
			// perPage=200 > 100, service resets to default of 30
			assert.Equal(t, int32(30), arg.PageSize)
			return nil, nil
		},
		countAgentSessionsByRepoFn: func(ctx context.Context, repositoryID int64) (int64, error) {
			return 0, nil
		},
	})

	_, _, err := svc.ListSessions(context.Background(), 101, 1, 200)
	require.NoError(t, err)
}

// ---- AppendMessage ----

func TestAgentService_AppendMessage_Success(t *testing.T) {
	t.Parallel()

	sessionID := "session-xyz"
	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(ctx context.Context, id string) (db.AgentSession, error) {
			assert.Equal(t, sessionID, id)
			return sampleDBAgentSession(id, 101, 1, "session"), nil
		},
		getNextAgentMessageSequenceFn: func(ctx context.Context, sid string) (int32, error) {
			assert.Equal(t, sessionID, sid)
			return 3, nil
		},
		createAgentMessageFn: func(ctx context.Context, arg db.CreateAgentMessageParams) (db.AgentMessage, error) {
			assert.Equal(t, sessionID, arg.SessionID)
			assert.Equal(t, int64(101), arg.RepositoryID)
			assert.Equal(t, "user", arg.Role)
			assert.Equal(t, int64(3), arg.Sequence)
			msg := sampleDBAgentMessage(100, arg.SessionID, arg.Role, arg.Sequence)
			msg.RepositoryID = arg.RepositoryID
			return msg, nil
		},
		createAgentPartFn: func(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
			assert.Equal(t, int64(100), arg.MessageID)
			assert.Equal(t, int64(101), arg.RepositoryID)
			assert.Equal(t, sessionID, arg.SessionID)
			assert.Equal(t, "text", arg.PartType)
			return sampleDBAgentPart(1, arg.MessageID, arg.PartIndex, arg.PartType, arg.Content), nil
		},
	})

	parts := []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`"hello world"`)},
	}
	msg, err := svc.AppendMessage(context.Background(), sessionID, "user", parts)
	require.NoError(t, err)
	assert.Equal(t, sessionID, msg.SessionID)
	assert.Equal(t, "user", msg.Role)
	assert.Equal(t, int64(3), msg.Sequence)
	assert.Len(t, msg.Parts, 1)
	assert.Equal(t, "text", msg.Parts[0].Type)
}

func TestAgentService_AppendMessage_MultipleParts(t *testing.T) {
	t.Parallel()

	partCount := 0
	svc := NewAgentService(&mockAgentQuerier{
		createAgentPartFn: func(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
			partCount++
			assert.Equal(t, int64(partCount-1), arg.PartIndex)
			return sampleDBAgentPart(int64(partCount), 1, arg.PartIndex, arg.PartType, arg.Content), nil
		},
	})

	parts := []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`"part one"`)},
		{PartType: "tool_call", Content: json.RawMessage(`{"name":"read_file","input":{"path":"main.go"}}`)},
	}
	msg, err := svc.AppendMessage(context.Background(), "sess1", "assistant", parts)
	require.NoError(t, err)
	assert.Len(t, msg.Parts, 2)
	assert.Equal(t, 2, partCount)
}

func TestAgentService_AppendMessage_SequenceError(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		getNextAgentMessageSequenceFn: func(ctx context.Context, sessionID string) (int32, error) {
			return 0, errors.New("sequence error")
		},
	})

	_, err := svc.AppendMessage(context.Background(), "sess1", "user", nil)
	require.Error(t, err)
}

func TestAgentService_AppendMessage_CreateMessageError(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		createAgentMessageFn: func(ctx context.Context, arg db.CreateAgentMessageParams) (db.AgentMessage, error) {
			return db.AgentMessage{}, errors.New("create message error")
		},
	})

	_, err := svc.AppendMessage(context.Background(), "sess1", "user", nil)
	require.Error(t, err)
}

func TestAgentService_AppendMessage_NilQuerier(t *testing.T) {
	t.Parallel()
	svc := NewAgentService(nil)
	_, err := svc.AppendMessage(context.Background(), "sess1", "user", nil)
	require.Error(t, err)
}

// ---- ListMessages ----

func TestAgentService_ListMessages_Success(t *testing.T) {
	t.Parallel()

	sessionID := "session-list-test"
	svc := NewAgentService(&mockAgentQuerier{
		listAgentMessagesFn: func(ctx context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			assert.Equal(t, sessionID, arg.SessionID)
			// page=1, perPage=10 → offset=0
			assert.Equal(t, int32(0), arg.PageOffset)
			assert.Equal(t, int32(10), arg.PageSize)
			return []db.AgentMessage{
				sampleDBAgentMessage(1, sessionID, "user", 0),
				sampleDBAgentMessage(2, sessionID, "assistant", 1),
			}, nil
		},
		listAgentMessagePartsFn: func(ctx context.Context, messageID int64) ([]db.AgentPart, error) {
			return []db.AgentPart{
				sampleDBAgentPart(1, messageID, 0, "text", json.RawMessage(`"content"`)),
			}, nil
		},
	})

	messages, err := svc.ListMessages(context.Background(), sessionID, 1, 10)
	require.NoError(t, err)
	assert.Len(t, messages, 2)
	assert.Equal(t, "user", messages[0].Role)
	assert.Equal(t, "assistant", messages[1].Role)
	// Parts should be included for each message
	assert.Len(t, messages[0].Parts, 1)
	assert.Len(t, messages[1].Parts, 1)
}

func TestAgentService_ListMessages_PerPageExceedingMaxResetsToDefault(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		listAgentMessagesFn: func(ctx context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			// perPage=300 > 200, service resets to default of 50
			assert.Equal(t, int32(50), arg.PageSize)
			return nil, nil
		},
	})

	_, err := svc.ListMessages(context.Background(), "sess1", 1, 300)
	require.NoError(t, err)
}

func TestAgentService_ListMessages_PartsError(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		listAgentMessagesFn: func(ctx context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			return []db.AgentMessage{sampleDBAgentMessage(1, arg.SessionID, "user", 0)}, nil
		},
		listAgentMessagePartsFn: func(ctx context.Context, messageID int64) ([]db.AgentPart, error) {
			return nil, errors.New("parts error")
		},
	})

	_, err := svc.ListMessages(context.Background(), "sess1", 1, 10)
	require.Error(t, err)
}

func TestAgentService_ListMessages_NilQuerier(t *testing.T) {
	t.Parallel()
	svc := NewAgentService(nil)
	_, err := svc.ListMessages(context.Background(), "sess1", 1, 10)
	require.Error(t, err)
}

func TestAgentService_AppendMessage_CallsNotify(t *testing.T) {
	t.Parallel()

	notifyCalled := false
	var capturedSessionID string
	var capturedPayload string

	svc := NewAgentService(&mockAgentQuerier{
		notifyAgentMessageFn: func(ctx context.Context, arg db.NotifyAgentMessageParams) error {
			notifyCalled = true
			capturedSessionID = arg.SessionID
			capturedPayload = arg.Payload
			return nil
		},
	})

	sessionID := "550e8400-e29b-41d4-a716-446655440000"
	parts := []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`"hello notify"`)},
	}
	msg, err := svc.AppendMessage(context.Background(), sessionID, "user", parts)
	require.NoError(t, err)
	assert.True(t, notifyCalled, "NotifyAgentMessage should be called after AppendMessage")
	// Channel ID should be UUID without dashes
	assert.Equal(t, "550e8400e29b41d4a716446655440000", capturedSessionID)
	var payload AgentSessionEvent
	require.NoError(t, json.Unmarshal([]byte(capturedPayload), &payload))
	assert.Equal(t, sessionID, payload.SessionID)
	assert.Equal(t, "message", payload.Action)
	require.NotNil(t, payload.Message)
	assert.Equal(t, sessionID, payload.Message.SessionID)
	assert.Equal(t, "user", payload.Message.Role)
	assert.Equal(t, sessionID, msg.SessionID)
}

func TestAgentService_AppendMessage_NotifyErrorIsSilenced(t *testing.T) {
	t.Parallel()

	// Even if NotifyAgentMessage returns an error, AppendMessage should still succeed.
	svc := NewAgentService(&mockAgentQuerier{
		notifyAgentMessageFn: func(ctx context.Context, arg db.NotifyAgentMessageParams) error {
			return errors.New("pg_notify failed")
		},
	})

	parts := []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`"test"`)},
	}
	_, err := svc.AppendMessage(context.Background(), "some-session-id", "user", parts)
	// Should succeed even though notify failed — SSE is best-effort
	require.NoError(t, err)
}

// ---- Transaction Lifecycle Tests ----

// mockAgentAppendTx implements agentAppendTx for unit tests
type mockAgentAppendTx struct {
	lockAgentSessionForAppendFn          func(ctx context.Context, sessionID string) (db.LockAgentSessionForAppendRow, error)
	createAgentMessageWithNextSequenceFn func(ctx context.Context, arg db.CreateAgentMessageWithNextSequenceParams) (db.AgentMessage, error)
	createAgentPartFn                    func(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error)
	commitFn                             func(ctx context.Context) error
	rollbackFn                           func(ctx context.Context) error
}

func (m *mockAgentAppendTx) LockAgentSessionForAppend(ctx context.Context, sessionID string) (db.LockAgentSessionForAppendRow, error) {
	if m.lockAgentSessionForAppendFn != nil {
		return m.lockAgentSessionForAppendFn(ctx, sessionID)
	}
	// Default: return a benign row echoing the session id with repo_id=0.
	// Tests that care about repository_id denorm set lockAgentSessionForAppendFn.
	return db.LockAgentSessionForAppendRow{ID: sessionID}, nil
}

func (m *mockAgentAppendTx) CreateAgentMessageWithNextSequence(ctx context.Context, arg db.CreateAgentMessageWithNextSequenceParams) (db.AgentMessage, error) {
	if m.createAgentMessageWithNextSequenceFn != nil {
		return m.createAgentMessageWithNextSequenceFn(ctx, arg)
	}
	return db.AgentMessage{}, nil
}

func (m *mockAgentAppendTx) CreateAgentPart(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
	if m.createAgentPartFn != nil {
		return m.createAgentPartFn(ctx, arg)
	}
	return db.AgentPart{}, nil
}

func (m *mockAgentAppendTx) Commit(ctx context.Context) error {
	if m.commitFn != nil {
		return m.commitFn(ctx)
	}
	return nil
}

func (m *mockAgentAppendTx) Rollback(ctx context.Context) error {
	if m.rollbackFn != nil {
		return m.rollbackFn(ctx)
	}
	return nil
}

// mockAgentAppendTxManager implements agentAppendTxManager for unit tests
type mockAgentAppendTxManager struct {
	beginFn func(ctx context.Context) (agentAppendTx, error)
}

func (m *mockAgentAppendTxManager) BeginAppendTx(ctx context.Context) (agentAppendTx, error) {
	if m.beginFn != nil {
		return m.beginFn(ctx)
	}
	return &mockAgentAppendTx{}, nil
}

func TestAgentService_AppendMessage_BeginsAndCommitsTx(t *testing.T) {
	t.Parallel()

	beginCalled := false
	commitCalled := false
	messageCreated := false
	partCreated := false

	txManager := &mockAgentAppendTxManager{
		beginFn: func(ctx context.Context) (agentAppendTx, error) {
			beginCalled = true
			return &mockAgentAppendTx{
				lockAgentSessionForAppendFn: func(_ context.Context, id string) (db.LockAgentSessionForAppendRow, error) {
					return db.LockAgentSessionForAppendRow{ID: id, RepositoryID: 101}, nil
				},
				createAgentMessageWithNextSequenceFn: func(ctx context.Context, arg db.CreateAgentMessageWithNextSequenceParams) (db.AgentMessage, error) {
					messageCreated = true
					msg := sampleDBAgentMessage(1, arg.SessionID, arg.Role, 0)
					msg.RepositoryID = 101
					return msg, nil
				},
				createAgentPartFn: func(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
					partCreated = true
					assert.Equal(t, int64(101), arg.RepositoryID)
					assert.Equal(t, "session-1", arg.SessionID)
					return sampleDBAgentPart(1, arg.MessageID, arg.PartIndex, arg.PartType, arg.Content), nil
				},
				commitFn: func(ctx context.Context) error {
					commitCalled = true
					return nil
				},
			}, nil
		},
	}

	svc := &AgentService{
		q:               &mockAgentQuerier{},
		appendTxManager: txManager,
	}

	parts := []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`"test"`)},
	}
	_, err := svc.AppendMessage(context.Background(), "session-1", "user", parts)

	require.NoError(t, err)
	assert.True(t, beginCalled, "BeginAppendTx should be called")
	assert.True(t, messageCreated, "CreateAgentMessageWithNextSequence should be called")
	assert.True(t, partCreated, "CreateAgentPart should be called")
	assert.True(t, commitCalled, "Commit should be called")
}

func TestAgentService_AppendMessage_BeginTxError(t *testing.T) {
	t.Parallel()

	txManager := &mockAgentAppendTxManager{
		beginFn: func(ctx context.Context) (agentAppendTx, error) {
			return nil, errors.New("begin tx error")
		},
	}

	svc := &AgentService{
		q:               &mockAgentQuerier{},
		appendTxManager: txManager,
	}

	parts := []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`"test"`)},
	}
	_, err := svc.AppendMessage(context.Background(), "session-1", "user", parts)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "begin")
}

func TestAgentService_AppendMessage_RejectsTerminalSessionWithTx(t *testing.T) {
	t.Parallel()

	rollbackCalled := false
	svc := &AgentService{
		q: &mockAgentQuerier{},
		appendTxManager: &mockAgentAppendTxManager{beginFn: func(context.Context) (agentAppendTx, error) {
			return &mockAgentAppendTx{
				lockAgentSessionForAppendFn: func(context.Context, string) (db.LockAgentSessionForAppendRow, error) {
					return db.LockAgentSessionForAppendRow{}, pgx.ErrNoRows
				},
				rollbackFn: func(context.Context) error {
					rollbackCalled = true
					return nil
				},
			}, nil
		}},
	}

	_, err := svc.AppendMessage(context.Background(), "terminal-session", "assistant", nil)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusConflict, apiErr.Status)
	assert.True(t, rollbackCalled)
}

func TestAgentService_AppendMessage_RejectsTerminalSessionWithoutTx(t *testing.T) {
	t.Parallel()

	sequenceRead := false
	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(context.Context, string) (db.AgentSession, error) {
			session := sampleDBAgentSession("terminal-session", 101, 1, "terminal")
			session.Status = "completed"
			return session, nil
		},
		getNextAgentMessageSequenceFn: func(context.Context, string) (int32, error) {
			sequenceRead = true
			return 0, nil
		},
	})

	_, err := svc.AppendMessage(context.Background(), "terminal-session", "assistant", nil)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusConflict, apiErr.Status)
	assert.False(t, sequenceRead)
}

func TestAgentService_AppendMessage_CreateMessageInTxError(t *testing.T) {
	t.Parallel()

	rollbackCalled := false

	txManager := &mockAgentAppendTxManager{
		beginFn: func(ctx context.Context) (agentAppendTx, error) {
			return &mockAgentAppendTx{
				createAgentMessageWithNextSequenceFn: func(ctx context.Context, arg db.CreateAgentMessageWithNextSequenceParams) (db.AgentMessage, error) {
					return db.AgentMessage{}, errors.New("create message error")
				},
				rollbackFn: func(ctx context.Context) error {
					rollbackCalled = true
					return nil
				},
			}, nil
		},
	}

	svc := &AgentService{
		q:               &mockAgentQuerier{},
		appendTxManager: txManager,
	}

	parts := []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`"test"`)},
	}
	_, err := svc.AppendMessage(context.Background(), "session-1", "user", parts)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "create agent message")
	assert.True(t, rollbackCalled, "Rollback should be called on error")
}

func TestAgentService_AppendMessage_CommitError(t *testing.T) {
	t.Parallel()

	rollbackCalled := false

	txManager := &mockAgentAppendTxManager{
		beginFn: func(ctx context.Context) (agentAppendTx, error) {
			return &mockAgentAppendTx{
				createAgentMessageWithNextSequenceFn: func(ctx context.Context, arg db.CreateAgentMessageWithNextSequenceParams) (db.AgentMessage, error) {
					return sampleDBAgentMessage(1, arg.SessionID, arg.Role, 0), nil
				},
				createAgentPartFn: func(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
					return sampleDBAgentPart(1, arg.MessageID, arg.PartIndex, arg.PartType, arg.Content), nil
				},
				commitFn: func(ctx context.Context) error {
					return errors.New("commit error")
				},
				rollbackFn: func(ctx context.Context) error {
					rollbackCalled = true
					return nil
				},
			}, nil
		},
	}

	svc := &AgentService{
		q:               &mockAgentQuerier{},
		appendTxManager: txManager,
	}

	parts := []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`"test"`)},
	}
	_, err := svc.AppendMessage(context.Background(), "session-1", "user", parts)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "commit")
	assert.True(t, rollbackCalled, "Rollback should be called on commit error")
}

func TestAgentService_AppendMessage_NotifyErrorIsSilenced_WithTx(t *testing.T) {
	t.Parallel()

	// Verify that notify errors are still silenced when using transaction path
	svc := &AgentService{
		q: &mockAgentQuerier{
			notifyAgentMessageFn: func(ctx context.Context, arg db.NotifyAgentMessageParams) error {
				return errors.New("pg_notify failed")
			},
		},
		appendTxManager: &mockAgentAppendTxManager{
			beginFn: func(ctx context.Context) (agentAppendTx, error) {
				return &mockAgentAppendTx{
					createAgentMessageWithNextSequenceFn: func(ctx context.Context, arg db.CreateAgentMessageWithNextSequenceParams) (db.AgentMessage, error) {
						return sampleDBAgentMessage(1, arg.SessionID, arg.Role, 0), nil
					},
					createAgentPartFn: func(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
						return sampleDBAgentPart(1, arg.MessageID, arg.PartIndex, arg.PartType, arg.Content), nil
					},
					commitFn: func(ctx context.Context) error {
						return nil
					},
				}, nil
			},
		},
	}

	parts := []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`"test"`)},
	}
	_, err := svc.AppendMessage(context.Background(), "session-1", "user", parts)

	// Should succeed even though notify failed — SSE is best-effort
	require.NoError(t, err)
}

func TestAgentService_AppendMessage_PartCreationError_RollsBack(t *testing.T) {
	t.Parallel()

	rollbackCalled := false

	txManager := &mockAgentAppendTxManager{
		beginFn: func(ctx context.Context) (agentAppendTx, error) {
			return &mockAgentAppendTx{
				createAgentMessageWithNextSequenceFn: func(ctx context.Context, arg db.CreateAgentMessageWithNextSequenceParams) (db.AgentMessage, error) {
					return sampleDBAgentMessage(1, arg.SessionID, arg.Role, 0), nil
				},
				createAgentPartFn: func(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
					return db.AgentPart{}, errors.New("part creation error")
				},
				rollbackFn: func(ctx context.Context) error {
					rollbackCalled = true
					return nil
				},
			}, nil
		},
	}

	svc := &AgentService{
		q:               &mockAgentQuerier{},
		appendTxManager: txManager,
	}

	parts := []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`"test"`)},
	}
	_, err := svc.AppendMessage(context.Background(), "session-1", "user", parts)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "create agent part")
	assert.True(t, rollbackCalled, "Rollback should be called on part creation error")
}

// ---- toAgentSessionResponse ----

func TestToAgentSessionResponse(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC().Truncate(time.Second)
	dbSession := db.AgentSession{
		ID:           "uuid-abc",
		RepositoryID: 42,
		UserID:       7,
		Title:        "Agent test",
		Status:       "completed",
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	resp := toAgentSessionResponse(dbSession)
	assert.Equal(t, "uuid-abc", resp.ID)
	assert.Equal(t, int64(42), resp.RepositoryID)
	assert.Equal(t, int64(7), resp.UserID)
	assert.Equal(t, "Agent test", resp.Title)
	assert.Equal(t, "completed", resp.Status)
	assert.Equal(t, now, resp.CreatedAt)
	assert.Equal(t, now, resp.UpdatedAt)
}

// ---- Agent Dispatch Mocks ----

// mockAgentDispatchQuerier implements AgentDispatchQuerier for unit tests.
type mockAgentDispatchQuerier struct {
	sandboxUsageRecorder
	upsertAgentWorkflowDefinitionFn       func(ctx context.Context, repositoryID int64) (db.WorkflowDefinition, error)
	createWorkflowRunFn                   func(ctx context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error)
	createWorkflowStepFn                  func(ctx context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error)
	createWorkflowTaskFn                  func(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error)
	codingHost                            db.WorkflowRunCodingHost
	codingHostErr                         error
	createAccessTokenFn                   func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error)
	deleteAccessTokenFn                   func(ctx context.Context, arg db.DeleteAccessTokenParams) error
	markWorkflowTaskVMRunningFn           func(ctx context.Context, arg db.MarkWorkflowTaskVMRunningParams) (int64, error)
	markWorkflowTaskTerminalByIDFn        func(ctx context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error)
	failWorkflowRunFn                     func(ctx context.Context, id int64) error
	getWorkflowTaskByRunIDFn              func(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error)
	getWorkflowRunByRunIDFn               func(ctx context.Context, workflowRunID int64) (db.WorkflowRun, error)
	listStaleActiveSessionsFn             func(ctx context.Context, startedBefore pgtype.Timestamptz) ([]db.AgentSession, error)
	updateWorkflowStepStatusRunningFn     func(ctx context.Context, stepID int64) (int64, error)
	updateWorkflowStepStatusTerminalFn    func(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error)
	updateWorkflowRunStatusBasedOnTasksFn func(ctx context.Context, workflowRunID int64) (string, error)
	notifyWorkflowRunEventFn              func(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error
	claimAgentSessionForDispatchFn        func(ctx context.Context, sessionID string, workflowRunID int64) (bool, error)
	updateAgentSessionStartedAtFn         func(ctx context.Context, arg db.UpdateAgentSessionStartedAtParams) (db.AgentSession, error)
	updateWorkflowRunAgentTokenFn         func(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error)
	updateWorkflowRunJJHubTokenIDFn       func(ctx context.Context, arg db.UpdateWorkflowRunJJHubTokenIDParams) error
	getWorkflowRunJJHubTokenIDFn          func(ctx context.Context, id int64) (pgtype.Int8, error)
	clearWorkflowRunJJHubTokenIDFn        func(ctx context.Context, id int64) error
	updateAgentSessionStatusFn            func(ctx context.Context, arg db.UpdateAgentSessionStatusParams) (db.AgentSession, error)
	updateAgentSessionTerminalStatusFn    func(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error)
	getAgentSessionForFlowProjectionFn    func(ctx context.Context, arg db.GetAgentSessionForFlowProjectionParams) (db.AgentSession, error)
	updateAgentSessionTerminalForFlowFn   func(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusForFlowParams) (db.AgentSession, error)
	updateAgentSessionTimedOutFn          func(ctx context.Context, arg db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error)
}

func (m *mockAgentDispatchQuerier) UpsertAgentWorkflowDefinition(ctx context.Context, repositoryID int64) (db.WorkflowDefinition, error) {
	if m.upsertAgentWorkflowDefinitionFn != nil {
		return m.upsertAgentWorkflowDefinitionFn(ctx, repositoryID)
	}
	return db.WorkflowDefinition{
		ID:           1,
		RepositoryID: repositoryID,
		Name:         "Agent",
		Path:         ".smithers/agent",
		Config:       json.RawMessage(`{"agent": true}`),
		IsActive:     true,
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}, nil
}

func (m *mockAgentDispatchQuerier) CreateWorkflowRun(ctx context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
	if m.createWorkflowRunFn != nil {
		return m.createWorkflowRunFn(ctx, arg)
	}
	return db.WorkflowRun{
		ID:                   10,
		RepositoryID:         arg.RepositoryID,
		WorkflowDefinitionID: arg.WorkflowDefinitionID,
		Status:               arg.Status,
		TriggerEvent:         arg.TriggerEvent,
		CreatedAt:            time.Now().UTC(),
		UpdatedAt:            time.Now().UTC(),
	}, nil
}

func (m *mockAgentDispatchQuerier) CreateWorkflowStep(ctx context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
	if m.createWorkflowStepFn != nil {
		return m.createWorkflowStepFn(ctx, arg)
	}
	return db.WorkflowStep{
		ID:            20,
		WorkflowRunID: arg.WorkflowRunID,
		Name:          arg.Name,
		Position:      arg.Position,
		Status:        arg.Status,
		CreatedAt:     time.Now().UTC(),
		UpdatedAt:     time.Now().UTC(),
	}, nil
}

// The dispatched turn's host identity. Recorded per run, read back by the
// poller; the mock keeps the last write so a test can assert the handle a
// dispatch published rather than only that it published one.
func (m *mockAgentDispatchQuerier) RecordWorkflowRunCodingHost(_ context.Context, arg db.RecordWorkflowRunCodingHostParams) (db.WorkflowRunCodingHost, error) {
	m.codingHost = db.WorkflowRunCodingHost{WorkflowRunID: arg.WorkflowRunID, WorkspaceID: arg.WorkspaceID,
		HostRunID: arg.HostRunID, FlowID: arg.FlowID, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	return m.codingHost, m.codingHostErr
}

func (m *mockAgentDispatchQuerier) GetWorkflowRunCodingHost(_ context.Context, workflowRunID int64) (db.WorkflowRunCodingHost, error) {
	if m.codingHost.WorkflowRunID != workflowRunID {
		return db.WorkflowRunCodingHost{}, pgx.ErrNoRows
	}
	return m.codingHost, nil
}

func (m *mockAgentDispatchQuerier) CreateWorkflowTask(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
	if m.createWorkflowTaskFn != nil {
		return m.createWorkflowTaskFn(ctx, arg)
	}
	return db.WorkflowTask{
		ID:             30,
		WorkflowRunID:  arg.WorkflowRunID,
		WorkflowStepID: arg.WorkflowStepID,
		RepositoryID:   arg.RepositoryID,
		Status:         arg.Status,
		Priority:       arg.Priority,
		Payload:        arg.Payload,
		AvailableAt:    arg.AvailableAt,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}, nil
}

func (m *mockAgentDispatchQuerier) CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
	if m.createAccessTokenFn != nil {
		return m.createAccessTokenFn(ctx, arg)
	}
	return db.AccessToken{ID: 41, UserID: arg.UserID, Name: arg.Name}, nil
}

func (m *mockAgentDispatchQuerier) DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error {
	if m.deleteAccessTokenFn != nil {
		return m.deleteAccessTokenFn(ctx, arg)
	}
	return nil
}

func (m *mockAgentDispatchQuerier) MarkWorkflowTaskVMRunning(ctx context.Context, arg db.MarkWorkflowTaskVMRunningParams) (int64, error) {
	if m.markWorkflowTaskVMRunningFn != nil {
		return m.markWorkflowTaskVMRunningFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockAgentDispatchQuerier) MarkWorkflowTaskTerminalByID(ctx context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error) {
	if m.markWorkflowTaskTerminalByIDFn != nil {
		return m.markWorkflowTaskTerminalByIDFn(ctx, arg)
	}
	return 10, nil
}

func (m *mockAgentDispatchQuerier) FailWorkflowRun(ctx context.Context, id int64) error {
	if m.failWorkflowRunFn != nil {
		return m.failWorkflowRunFn(ctx, id)
	}
	return nil
}

func (m *mockAgentDispatchQuerier) GetWorkflowTaskByRunID(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error) {
	if m.getWorkflowTaskByRunIDFn != nil {
		return m.getWorkflowTaskByRunIDFn(ctx, workflowRunID)
	}
	return db.WorkflowTask{
		ID:             30,
		WorkflowRunID:  workflowRunID,
		WorkflowStepID: 20,
		Status:         "running",
	}, nil
}

func (m *mockAgentDispatchQuerier) GetWorkflowRunByRunID(ctx context.Context, workflowRunID int64) (db.WorkflowRun, error) {
	if m.getWorkflowRunByRunIDFn != nil {
		return m.getWorkflowRunByRunIDFn(ctx, workflowRunID)
	}
	return db.WorkflowRun{
		ID:        workflowRunID,
		Status:    "running",
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}, nil
}

func (m *mockAgentDispatchQuerier) ListStaleActiveSessions(ctx context.Context, startedBefore pgtype.Timestamptz) ([]db.AgentSession, error) {
	if m.listStaleActiveSessionsFn != nil {
		return m.listStaleActiveSessionsFn(ctx, startedBefore)
	}
	return nil, nil
}

func (m *mockAgentDispatchQuerier) UpdateWorkflowStepStatusRunning(ctx context.Context, stepID int64) (int64, error) {
	if m.updateWorkflowStepStatusRunningFn != nil {
		return m.updateWorkflowStepStatusRunningFn(ctx, stepID)
	}
	return 1, nil
}

func (m *mockAgentDispatchQuerier) UpdateWorkflowStepStatusTerminal(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error) {
	if m.updateWorkflowStepStatusTerminalFn != nil {
		return m.updateWorkflowStepStatusTerminalFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockAgentDispatchQuerier) UpdateWorkflowRunStatusBasedOnTasks(ctx context.Context, workflowRunID int64) (string, error) {
	if m.updateWorkflowRunStatusBasedOnTasksFn != nil {
		return m.updateWorkflowRunStatusBasedOnTasksFn(ctx, workflowRunID)
	}
	return "running", nil
}

func (m *mockAgentDispatchQuerier) NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error {
	if m.notifyWorkflowRunEventFn != nil {
		return m.notifyWorkflowRunEventFn(ctx, arg)
	}
	return nil
}

func (m *mockAgentDispatchQuerier) ClaimAgentSessionForDispatch(ctx context.Context, sessionID string, workflowRunID int64) (bool, error) {
	if m.claimAgentSessionForDispatchFn != nil {
		return m.claimAgentSessionForDispatchFn(ctx, sessionID, workflowRunID)
	}
	return true, nil
}

func (m *mockAgentDispatchQuerier) UpdateAgentSessionStartedAt(ctx context.Context, arg db.UpdateAgentSessionStartedAtParams) (db.AgentSession, error) {
	if m.updateAgentSessionStartedAtFn != nil {
		return m.updateAgentSessionStartedAtFn(ctx, arg)
	}
	s := sampleDBAgentSession(arg.ID, 101, 1, "default")
	s.StartedAt = arg.StartedAt
	return s, nil
}

func (m *mockAgentDispatchQuerier) UpdateWorkflowRunAgentToken(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
	if m.updateWorkflowRunAgentTokenFn != nil {
		return m.updateWorkflowRunAgentTokenFn(ctx, arg)
	}
	return db.WorkflowRun{
		ID:             arg.ID,
		AgentTokenHash: arg.AgentTokenHash,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}, nil
}

func (m *mockAgentDispatchQuerier) UpdateWorkflowRunJJHubTokenID(ctx context.Context, arg db.UpdateWorkflowRunJJHubTokenIDParams) error {
	if m.updateWorkflowRunJJHubTokenIDFn != nil {
		return m.updateWorkflowRunJJHubTokenIDFn(ctx, arg)
	}
	return nil
}

func (m *mockAgentDispatchQuerier) GetWorkflowRunJJHubTokenID(ctx context.Context, id int64) (pgtype.Int8, error) {
	if m.getWorkflowRunJJHubTokenIDFn != nil {
		return m.getWorkflowRunJJHubTokenIDFn(ctx, id)
	}
	return pgtype.Int8{}, nil
}

func (m *mockAgentDispatchQuerier) ClearWorkflowRunJJHubTokenID(ctx context.Context, id int64) error {
	if m.clearWorkflowRunJJHubTokenIDFn != nil {
		return m.clearWorkflowRunJJHubTokenIDFn(ctx, id)
	}
	return nil
}

func (m *mockAgentDispatchQuerier) UpdateAgentSessionStatus(ctx context.Context, arg db.UpdateAgentSessionStatusParams) (db.AgentSession, error) {
	if m.updateAgentSessionStatusFn != nil {
		return m.updateAgentSessionStatusFn(ctx, arg)
	}
	s := sampleDBAgentSession(arg.ID, 101, 1, "default")
	s.Status = arg.Status
	return s, nil
}

func (m *mockAgentDispatchQuerier) UpdateAgentSessionTerminalStatus(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
	if m.updateAgentSessionTerminalStatusFn != nil {
		return m.updateAgentSessionTerminalStatusFn(ctx, arg)
	}
	s := sampleDBAgentSession(arg.ID, 101, 1, "default")
	s.Status = arg.Status
	s.FinishedAt = arg.FinishedAt
	return s, nil
}

func (m *mockAgentDispatchQuerier) GetAgentSessionForFlowProjection(ctx context.Context, arg db.GetAgentSessionForFlowProjectionParams) (db.AgentSession, error) {
	if m.getAgentSessionForFlowProjectionFn != nil {
		return m.getAgentSessionForFlowProjectionFn(ctx, arg)
	}
	return db.AgentSession{}, pgx.ErrNoRows
}

func (m *mockAgentDispatchQuerier) UpdateAgentSessionTerminalStatusForFlow(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusForFlowParams) (db.AgentSession, error) {
	if m.updateAgentSessionTerminalForFlowFn != nil {
		return m.updateAgentSessionTerminalForFlowFn(ctx, arg)
	}
	return db.AgentSession{}, pgx.ErrNoRows
}

func (m *mockAgentDispatchQuerier) UpdateAgentSessionTimedOut(ctx context.Context, arg db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error) {
	if m.updateAgentSessionTimedOutFn != nil {
		return m.updateAgentSessionTimedOutFn(ctx, arg)
	}
	s := sampleDBAgentSession(arg.ID, 101, 1, "default")
	s.Status = "timed_out"
	s.FinishedAt = arg.FinishedAt
	return s, nil
}

// mockAgentLogStore implements AgentLogStore for unit tests.
type mockAgentLogStore struct {
	putSessionLogFn func(ctx context.Context, repositoryID int64, sessionID string, payload []byte) error
}

func (m *mockAgentLogStore) PutSessionLog(ctx context.Context, repositoryID int64, sessionID string, payload []byte) error {
	if m.putSessionLogFn != nil {
		return m.putSessionLogFn(ctx, repositoryID, sessionID, payload)
	}
	return nil
}

type mockSandboxVMClient struct {
	createVMFn             func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error)
	forkVMFn               func(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error)
	createSystemdServiceFn func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error)
	getVMFn                func(ctx context.Context, vmID string) (sandbox.Sandbox, error)
	deleteVMFn             func(ctx context.Context, vmID string) error
	startVMFn              func(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error)
	suspendVMFn            func(ctx context.Context, vmID string) (sandbox.SuspendResult, error)
	snapshotVMFn           func(ctx context.Context, vmID string, req sandbox.SnapshotRequest) (sandbox.SnapshotResult, error)
	deleteSnapshotFn       func(ctx context.Context, snapshotID string) error
}

type mockAgentSessionMetricsObserver struct {
	completions []string
	timeouts    int
}

func (m *mockAgentSessionMetricsObserver) ObserveAgentSessionCompletion(status string) {
	m.completions = append(m.completions, status)
}

func (m *mockAgentSessionMetricsObserver) ObserveAgentSessionTimeout() {
	m.timeouts++
}

func (m *mockSandboxVMClient) CreateSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	if m.createVMFn != nil {
		return m.createVMFn(ctx, req)
	}
	return sandbox.CreateResult{ID: "vm-test-123"}, nil
}

func (m *mockSandboxVMClient) ForkSandbox(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
	if m.forkVMFn != nil {
		return m.forkVMFn(ctx, sourceVMID, req)
	}
	return sandbox.CreateResult{ID: "vm-fork-123"}, nil
}

func (m *mockSandboxVMClient) CreateService(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
	if m.createSystemdServiceFn != nil {
		return m.createSystemdServiceFn(ctx, vmID, req)
	}
	return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
}

func (m *mockSandboxVMClient) InspectSandbox(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
	if m.getVMFn != nil {
		return m.getVMFn(ctx, vmID)
	}
	return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
}

func (m *mockSandboxVMClient) DeleteSandbox(ctx context.Context, vmID string) error {
	if m.deleteVMFn != nil {
		return m.deleteVMFn(ctx, vmID)
	}
	return nil
}

func (m *mockSandboxVMClient) StartSandbox(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
	if m.startVMFn != nil {
		return m.startVMFn(ctx, vmID, req)
	}
	return sandbox.StartResult{ID: vmID}, nil
}

func (m *mockSandboxVMClient) SuspendSandbox(ctx context.Context, vmID string) (sandbox.SuspendResult, error) {
	if m.suspendVMFn != nil {
		return m.suspendVMFn(ctx, vmID)
	}
	return sandbox.SuspendResult{ID: vmID}, nil
}

func (m *mockSandboxVMClient) SnapshotSandbox(ctx context.Context, vmID string, req sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
	if m.snapshotVMFn != nil {
		return m.snapshotVMFn(ctx, vmID, req)
	}
	return sandbox.SnapshotResult{SnapshotID: "snap-123", SourceSandboxID: vmID}, nil
}

func (m *mockSandboxVMClient) DeleteSnapshot(ctx context.Context, snapshotID string) error {
	if m.deleteSnapshotFn != nil {
		return m.deleteSnapshotFn(ctx, snapshotID)
	}
	return nil
}

func (m *mockSandboxVMClient) CreateIdentity(ctx context.Context) (sandbox.Identity, error) {
	return sandbox.Identity{ID: "identity-test-123"}, nil
}

func (m *mockSandboxVMClient) GrantAccess(ctx context.Context, identityID, vmID string, req sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
	return sandbox.AccessGrant{ID: "perm-test-123"}, nil
}

func (m *mockSandboxVMClient) CreateIdentityToken(ctx context.Context, identityID string) (sandbox.CreatedToken, error) {
	return sandbox.CreatedToken{ID: "token-test-123", Token: "test-token"}, nil
}

// helper to build an AgentService with dispatch dependencies for tests
func newTestDispatchService(dq AgentDispatchQuerier, logStore AgentLogStore) *AgentService {
	return &AgentService{
		// These fixtures exercise the dispatch steps that run after
		// refuseRetiredAgentLoop, so they must get past it.
		guestEntrypointAssumed: true,

		q:          &mockAgentQuerier{},
		dispatchQ:  dq,
		logStore:   logStore,
		apiBaseURL: "https://api.smithers.test",
		gitBaseURL: "https://smithers.test",
		sandbox:    &mockSandboxVMClient{},
		// A dispatch with no usable AI-provider credential is refused before
		// the VM is created (requireProviderCredential). These fixtures test
		// the rest of the pipeline, so give them a credential.
		sandboxConfig: AgentSandboxConfig{
			ModelSeats: []modelproxy.Seat{modelproxy.Seats[2]},
		},
	}
}

// ---- DispatchAgentRun Tests ----

func TestAgentService_DispatchLandingAuthorTurn_AppendsFeedbackBeforeDispatch(t *testing.T) {
	svc, input := newBoundaryMessageSession(t)
	err := svc.DispatchLandingAuthorTurn(t.Context(), LandingAgentTurnDispatchInput{
		SessionID: input.SessionID, RepositoryID: input.RepositoryID, UserID: input.UserID,
		RepoOwner: input.RepoOwner, RepoName: input.RepoName,
		Number: 12, Feedback: "please add the boundary test",
	})
	require.NoError(t, err)

	var messageID int64
	require.NoError(t, svc.messagePool.QueryRow(t.Context(), `SELECT id FROM agent_messages WHERE session_id=$1 AND role='user'`, input.SessionID).Scan(&messageID))
	parts, err := db.New(svc.messagePool).ListAgentMessageParts(t.Context(), messageID)
	require.NoError(t, err)
	require.Len(t, parts, 1)
	require.Equal(t, "text", parts[0].PartType)
	var content struct {
		Value string `json:"value"`
	}
	require.NoError(t, json.Unmarshal(parts[0].Content, &content))
	prompt := content.Value
	require.Contains(t, prompt, "landing request #12")
	require.Contains(t, prompt, "all open review comments")
	require.Contains(t, prompt, "please add the boundary test")

	store, err := jobs.NewStore(svc.messagePool)
	require.NoError(t, err)
	operation, err := store.GetByRequest(t.Context(), repositoryJobFlowScope(input.RepositoryID, input.UserID), agentMessageDispatchOperation, "agent-message:"+strconv.FormatInt(messageID, 10))
	require.NoError(t, err)
	require.Equal(t, jobs.StateAccepted, operation.State)
	var admitted DispatchAgentRunInput
	require.NoError(t, json.Unmarshal(operation.Payload, &admitted))
	require.Equal(t, input.SessionID, admitted.SessionID)
	require.Equal(t, messageID, admitted.TriggerMessageID)
	var runs int
	require.NoError(t, svc.messagePool.QueryRow(t.Context(), `SELECT count(*) FROM workflow_runs WHERE repository_id=$1`, input.RepositoryID).Scan(&runs))
	require.Zero(t, runs, "admission must not execute before a worker claims it")
}

func TestAgentService_DispatchAgentRun_CreatesRunStepTaskAndLinksSession(t *testing.T) {
	t.Parallel()

	upsertCalled := false
	createRunCalled := false
	createStepCalled := false
	createTaskCalled := false
	linkSessionCalled := false
	updateTokenCalled := false

	dq := &mockAgentDispatchQuerier{
		upsertAgentWorkflowDefinitionFn: func(ctx context.Context, repositoryID int64) (db.WorkflowDefinition, error) {
			upsertCalled = true
			assert.Equal(t, int64(101), repositoryID)
			return db.WorkflowDefinition{ID: 1, RepositoryID: repositoryID}, nil
		},
		createWorkflowRunFn: func(ctx context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
			createRunCalled = true
			assert.Equal(t, int64(101), arg.RepositoryID)
			assert.Equal(t, int64(1), arg.WorkflowDefinitionID)
			assert.Equal(t, "queued", arg.Status)
			assert.Equal(t, "agent_message", arg.TriggerEvent)
			return db.WorkflowRun{ID: 10, RepositoryID: arg.RepositoryID, WorkflowDefinitionID: arg.WorkflowDefinitionID}, nil
		},
		createWorkflowStepFn: func(ctx context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
			createStepCalled = true
			assert.Equal(t, int64(10), arg.WorkflowRunID)
			assert.Equal(t, "agent", arg.Name)
			assert.Equal(t, int64(0), arg.Position)
			return db.WorkflowStep{ID: 20, WorkflowRunID: arg.WorkflowRunID}, nil
		},
		createWorkflowTaskFn: func(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			createTaskCalled = true
			assert.Equal(t, int64(10), arg.WorkflowRunID)
			assert.Equal(t, int64(20), arg.WorkflowStepID)
			assert.Equal(t, int64(101), arg.RepositoryID)
			assert.Equal(t, "pending", arg.Status)
			assert.Equal(t, int16(3), arg.Priority)

			var payload map[string]any
			require.NoError(t, json.Unmarshal(arg.Payload, &payload))
			assert.Equal(t, "agent", payload["kind"])
			assert.Equal(t, "session-abc", payload["session_id"])
			assert.Equal(t, float64(101), payload["repository_id"])
			assert.Equal(t, float64(10), payload["workflow_run_id"])
			assert.Equal(t, "https://api.smithers.test", payload["api_base_url"])
			assert.Equal(t, "alice", payload["repo_owner"])
			assert.Equal(t, "myrepo", payload["repo_name"])
			// agent_token must NOT be persisted in the DB task payload.
			// Credentials are injected into the Microsandbox VM systemd environment at
			// dispatch time — they never appear in durable storage.
			_, hasToken := payload["agent_token"]
			assert.False(t, hasToken, "agent_token must not be stored in the task payload")

			return db.WorkflowTask{ID: 30, WorkflowRunID: arg.WorkflowRunID, WorkflowStepID: arg.WorkflowStepID}, nil
		},
		claimAgentSessionForDispatchFn: func(ctx context.Context, sessionID string, workflowRunID int64) (bool, error) {
			linkSessionCalled = true
			assert.Equal(t, "session-abc", sessionID)
			assert.Equal(t, int64(10), workflowRunID)
			return true, nil
		},
		updateWorkflowRunAgentTokenFn: func(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
			updateTokenCalled = true
			assert.Equal(t, int64(10), arg.ID)
			assert.True(t, arg.AgentTokenHash.Valid)
			assert.NotEmpty(t, arg.AgentTokenHash.String)
			assert.True(t, arg.AgentTokenExpiresAt.Valid)
			return db.WorkflowRun{ID: arg.ID}, nil
		},
	}

	svc := newTestDispatchService(dq, nil)

	result, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:        "session-abc",
		RepositoryID:     101,
		UserID:           1,
		TriggerMessageID: 42,
		RepoOwner:        "alice",
		RepoName:         "myrepo",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(10), result.WorkflowRunID)
	assert.Equal(t, int64(30), result.WorkflowTaskID)
	assert.True(t, strings.HasPrefix(result.AgentToken, "smithers_agent_"))
	assert.Len(t, strings.TrimPrefix(result.AgentToken, "smithers_agent_"), 40)

	assert.True(t, upsertCalled, "UpsertAgentWorkflowDefinition should be called")
	assert.True(t, createRunCalled, "CreateWorkflowRun should be called")
	assert.True(t, createStepCalled, "CreateWorkflowStep should be called")
	assert.True(t, createTaskCalled, "CreateWorkflowTask should be called")
	assert.True(t, linkSessionCalled, "ClaimAgentSessionForDispatch should be called")
	assert.True(t, updateTokenCalled, "UpdateWorkflowRunAgentToken should be called")
}

// TestAgentService_DispatchAgentRun_PersistsAgentTokenHash verifies that the agent token
// is stored only as a hash in workflow_runs.agent_token_hash and is never written to
// the DB task payload. The plaintext token is returned to the caller and injected into
// the Microsandbox VM environment at dispatch time.
func TestAgentService_DispatchAgentRun_PersistsAgentTokenHash(t *testing.T) {
	t.Parallel()

	var capturedHash string

	dq := &mockAgentDispatchQuerier{
		updateWorkflowRunAgentTokenFn: func(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
			capturedHash = arg.AgentTokenHash.String
			return db.WorkflowRun{ID: arg.ID}, nil
		},
		createWorkflowTaskFn: func(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			// Verify the task payload does not contain the plaintext token.
			var payload map[string]any
			_ = json.Unmarshal(arg.Payload, &payload)
			_, hasToken := payload["agent_token"]
			assert.False(t, hasToken, "plaintext agent_token must not be persisted in the task payload")
			return db.WorkflowTask{ID: 30}, nil
		},
	}

	svc := newTestDispatchService(dq, nil)

	result, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "session-token-test",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)

	// The hash stored in the DB must match SHA-256 of the returned plaintext token.
	expectedHash := sha256.Sum256([]byte(result.AgentToken))
	expectedHashHex := hex.EncodeToString(expectedHash[:])
	assert.Equal(t, expectedHashHex, capturedHash)
	// The plaintext token is returned to the caller for injection into the VM environment.
	assert.True(t, strings.HasPrefix(result.AgentToken, "smithers_agent_"))
}

func TestDispatchAgentRun_IncludesRepoOwnerAndNameInPayload(t *testing.T) {
	t.Parallel()

	var capturedPayload json.RawMessage
	dq := &mockAgentDispatchQuerier{
		createWorkflowTaskFn: func(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			capturedPayload = arg.Payload
			return db.WorkflowTask{ID: 30}, nil
		},
	}

	svc := newTestDispatchService(dq, nil)

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "session-owner-test",
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "alice",
		RepoName:     "myrepo",
	})
	require.NoError(t, err)

	var payload map[string]any
	require.NoError(t, json.Unmarshal(capturedPayload, &payload))
	assert.Equal(t, "alice", payload["repo_owner"], "payload should contain repo_owner")
	assert.Equal(t, "myrepo", payload["repo_name"], "payload should contain repo_name")
}

func TestDispatchAgentRun_EmptyRepoOwnerAndNameWhenNotProvided(t *testing.T) {
	t.Parallel()

	var capturedPayload json.RawMessage
	dq := &mockAgentDispatchQuerier{
		createWorkflowTaskFn: func(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			capturedPayload = arg.Payload
			return db.WorkflowTask{ID: 30}, nil
		},
	}

	svc := newTestDispatchService(dq, nil)

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "session-no-owner",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)

	var payload map[string]any
	require.NoError(t, json.Unmarshal(capturedPayload, &payload))
	assert.Equal(t, "", payload["repo_owner"], "repo_owner should be empty string when not provided")
	assert.Equal(t, "", payload["repo_name"], "repo_name should be empty string when not provided")
}

func TestAgentService_DispatchAgentRun_NilDispatchQuerier(t *testing.T) {
	t.Parallel()

	svc := &AgentService{
		q:         &mockAgentQuerier{},
		dispatchQ: nil,
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "session-nil-dispatch",
		RepositoryID: 101,
		UserID:       1,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "agent dispatch querier unavailable")
}

// ---- IngestRunnerEvent Tests ----

func TestAgentService_IngestRunnerEvent_AppendsExpectedPart(t *testing.T) {
	t.Parallel()

	var capturedRole string
	var capturedParts []db.CreateAgentPartParams

	q := &mockAgentQuerier{
		createAgentMessageFn: func(ctx context.Context, arg db.CreateAgentMessageParams) (db.AgentMessage, error) {
			capturedRole = arg.Role
			return sampleDBAgentMessage(1, arg.SessionID, arg.Role, arg.Sequence), nil
		},
		createAgentPartFn: func(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
			capturedParts = append(capturedParts, arg)
			return sampleDBAgentPart(1, arg.MessageID, arg.PartIndex, arg.PartType, arg.Content), nil
		},
	}

	svc := NewAgentService(q)

	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: "sess-ingest",
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, "assistant", capturedRole)
	require.Len(t, capturedParts, 1)
	assert.Equal(t, "text", capturedParts[0].PartType)
}

func TestAgentService_IngestRunnerEvent_ToolCall(t *testing.T) {
	t.Parallel()

	var capturedParts []db.CreateAgentPartParams
	q := &mockAgentQuerier{
		createAgentPartFn: func(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
			capturedParts = append(capturedParts, arg)
			return sampleDBAgentPart(1, arg.MessageID, arg.PartIndex, arg.PartType, arg.Content), nil
		},
	}

	svc := NewAgentService(q)
	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: "sess-ingest",
		EventType: "tool_call",
		Content:   json.RawMessage(`{"name":"read_file"}`),
	})
	require.NoError(t, err)
	require.Len(t, capturedParts, 1)
	assert.Equal(t, "tool_call", capturedParts[0].PartType)
}

func TestAgentService_IngestRunnerEvent_ToolResult(t *testing.T) {
	t.Parallel()

	var capturedParts []db.CreateAgentPartParams
	q := &mockAgentQuerier{
		createAgentPartFn: func(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
			capturedParts = append(capturedParts, arg)
			return sampleDBAgentPart(1, arg.MessageID, arg.PartIndex, arg.PartType, arg.Content), nil
		},
	}

	svc := NewAgentService(q)
	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: "sess-ingest",
		EventType: "tool_result",
		Content:   json.RawMessage(`{"result":"ok"}`),
	})
	require.NoError(t, err)
	require.Len(t, capturedParts, 1)
	assert.Equal(t, "tool_result", capturedParts[0].PartType)
}

func TestAgentService_IngestRunnerEvent_InvalidEventType(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{})
	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: "sess-ingest",
		EventType: "invalid",
		Content:   json.RawMessage(`{}`),
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid event type")
}

func TestAgentService_IngestRunnerEvent_DoneUpdatesSessionStatus(t *testing.T) {
	t.Parallel()

	var capturedStatus string
	dq := &mockAgentDispatchQuerier{
		updateAgentSessionTerminalStatusFn: func(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			capturedStatus = arg.Status
			s := sampleDBAgentSession(arg.ID, 101, 1, "default")
			s.Status = arg.Status
			s.FinishedAt = arg.FinishedAt
			return s, nil
		},
	}

	svc := &AgentService{
		q:         &mockAgentQuerier{},
		dispatchQ: dq,
	}

	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: "sess-done",
		EventType: "done",
		Content:   json.RawMessage(`{"status":"completed"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, "completed", capturedStatus)
}

func TestAgentService_IngestRunnerEvent_DoneWithErrorMarksFailed(t *testing.T) {
	t.Parallel()

	var capturedStatus string
	dq := &mockAgentDispatchQuerier{
		updateAgentSessionTerminalStatusFn: func(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			capturedStatus = arg.Status
			s := sampleDBAgentSession(arg.ID, 101, 1, "default")
			s.Status = arg.Status
			s.FinishedAt = arg.FinishedAt
			return s, nil
		},
	}

	svc := &AgentService{
		q:         &mockAgentQuerier{},
		dispatchQ: dq,
	}

	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: "sess-fail",
		EventType: "done",
		Content:   json.RawMessage(`{"error":"out of memory"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, "failed", capturedStatus)
}

func TestAgentService_IngestRunnerEvent_DoneArchivesLogs(t *testing.T) {
	t.Parallel()

	var archivedRepoID int64
	var archivedSessionID string
	logStore := &mockAgentLogStore{
		putSessionLogFn: func(ctx context.Context, repositoryID int64, sessionID string, payload []byte) error {
			archivedRepoID = repositoryID
			archivedSessionID = sessionID
			return nil
		},
	}

	dq := &mockAgentDispatchQuerier{
		updateAgentSessionTerminalStatusFn: func(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			s := sampleDBAgentSession(arg.ID, 202, 1, "default")
			s.Status = arg.Status
			s.FinishedAt = arg.FinishedAt
			return s, nil
		},
	}

	svc := &AgentService{
		q:         &mockAgentQuerier{},
		dispatchQ: dq,
		logStore:  logStore,
	}

	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: "sess-archive",
		EventType: "done",
		Content:   json.RawMessage(`{"status":"completed"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, int64(202), archivedRepoID)
	assert.Equal(t, "sess-archive", archivedSessionID)
}

func TestAgentService_IngestRunnerEvent_DoneArchiveErrorIsBestEffort(t *testing.T) {
	t.Parallel()

	logStore := &mockAgentLogStore{
		putSessionLogFn: func(ctx context.Context, repositoryID int64, sessionID string, payload []byte) error {
			return errors.New("GCS failure")
		},
	}

	dq := &mockAgentDispatchQuerier{}

	svc := &AgentService{
		q:         &mockAgentQuerier{},
		dispatchQ: dq,
		logStore:  logStore,
	}

	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: "sess-archive-fail",
		EventType: "done",
		Content:   json.RawMessage(`{"status":"completed"}`),
	})
	require.NoError(t, err, "GCS archive failure should not propagate")
}

// ---- generateAgentToken Tests ----

func TestGenerateAgentToken_Format(t *testing.T) {
	t.Parallel()

	plaintext, hash, err := generateAgentToken()
	require.NoError(t, err)

	assert.True(t, strings.HasPrefix(plaintext, "smithers_agent_"))
	hexPart := strings.TrimPrefix(plaintext, "smithers_agent_")
	assert.Len(t, hexPart, 40, "hex part should be 40 characters (20 bytes)")

	expectedHash := sha256.Sum256([]byte(plaintext))
	expectedHashHex := hex.EncodeToString(expectedHash[:])
	assert.Equal(t, expectedHashHex, hash)
}

func TestGenerateAgentToken_Unique(t *testing.T) {
	t.Parallel()

	const iterations = 100
	tokens := make(map[string]bool, iterations)

	for i := 0; i < iterations; i++ {
		plaintext, _, err := generateAgentToken()
		require.NoError(t, err)
		assert.False(t, tokens[plaintext], "Token should be unique on iteration %d", i)
		tokens[plaintext] = true
	}
}

// ---- AgentServiceOption Tests ----

func TestNewAgentServiceWithPool_WithOptions(t *testing.T) {
	t.Parallel()

	dq := &mockAgentDispatchQuerier{}
	logStore := &mockAgentLogStore{}

	svc := NewAgentServiceWithPool(
		&mockAgentQuerier{},
		nil,
		WithAgentDispatchQuerier(dq),
		WithAgentLogStore(logStore),
		WithAgentAPIBaseURL("https://api.smithers.sh"),
	)

	assert.NotNil(t, svc.q, "Querier should be set")
	assert.Nil(t, svc.appendTxManager, "TX manager should be nil when pool is nil")
	assert.Equal(t, dq, svc.dispatchQ, "DispatchQuerier should be set")
	assert.Equal(t, logStore, svc.logStore, "LogStore should be set")
	assert.Equal(t, "https://api.smithers.sh", svc.apiBaseURL, "API base URL should be set")
}

// ---- isDoneWithError Tests ----

func TestIsDoneWithError(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content json.RawMessage
		want    bool
	}{
		{
			name:    "success status",
			content: json.RawMessage(`{"status":"success"}`),
			want:    false,
		},
		{
			name:    "error field present",
			content: json.RawMessage(`{"error":"something went wrong"}`),
			want:    true,
		},
		{
			name:    "error field with additional fields",
			content: json.RawMessage(`{"error":"crash","details":"OOM"}`),
			want:    true,
		},
		{
			name:    "empty content",
			content: json.RawMessage(``),
			want:    false,
		},
		{
			name:    "invalid json",
			content: json.RawMessage(`not json`),
			want:    false,
		},
		{
			name:    "null content",
			content: nil,
			want:    false,
		},
		{
			name:    "string content",
			content: json.RawMessage(`"just a string"`),
			want:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := isDoneWithError(tt.content)
			assert.Equal(t, tt.want, got)
		})
	}
}

// ---- DispatchAgentRun Error Path Tests ----

func TestAgentService_DispatchAgentRun_UpsertDefinitionError(t *testing.T) {
	t.Parallel()

	dq := &mockAgentDispatchQuerier{
		upsertAgentWorkflowDefinitionFn: func(ctx context.Context, repositoryID int64) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{}, errors.New("upsert failed")
		},
	}

	svc := newTestDispatchService(dq, nil)

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "session-err",
		RepositoryID: 101,
		UserID:       1,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "upsert agent workflow definition")
}

func TestAgentService_DispatchAgentRun_CreateRunError(t *testing.T) {
	t.Parallel()

	dq := &mockAgentDispatchQuerier{
		createWorkflowRunFn: func(ctx context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, errors.New("create run failed")
		},
	}

	svc := newTestDispatchService(dq, nil)

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "session-err",
		RepositoryID: 101,
		UserID:       1,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create workflow run")
}

func TestAgentService_DispatchAgentRun_LinkSessionError(t *testing.T) {
	t.Parallel()

	dq := &mockAgentDispatchQuerier{
		claimAgentSessionForDispatchFn: func(ctx context.Context, sessionID string, workflowRunID int64) (bool, error) {
			return false, errors.New("link failed")
		},
	}

	svc := newTestDispatchService(dq, nil)

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "session-err",
		RepositoryID: 101,
		UserID:       1,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "link session to workflow run")
}

// ---- DispatchAgentRun payload verification ----

func TestAgentService_DispatchAgentRun_PayloadContainsAPIBaseURL(t *testing.T) {
	t.Parallel()

	var capturedPayload json.RawMessage

	dq := &mockAgentDispatchQuerier{
		createWorkflowTaskFn: func(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			capturedPayload = arg.Payload
			return db.WorkflowTask{ID: 30}, nil
		},
	}

	svc := newTestDispatchService(dq, nil)
	svc.apiBaseURL = "https://custom.api.smithers.sh"

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "session-url",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)

	var payload map[string]any
	require.NoError(t, json.Unmarshal(capturedPayload, &payload))
	assert.Equal(t, "https://custom.api.smithers.sh", payload["api_base_url"])
}

// ---- Verify UpdateWorkflowRunAgentToken expiry ----

func TestAgentService_DispatchAgentRun_TokenExpiryIsSetTo24Hours(t *testing.T) {
	t.Parallel()

	var capturedExpiry pgtype.Timestamptz

	dq := &mockAgentDispatchQuerier{
		updateWorkflowRunAgentTokenFn: func(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
			capturedExpiry = arg.AgentTokenExpiresAt
			return db.WorkflowRun{ID: arg.ID}, nil
		},
	}

	svc := newTestDispatchService(dq, nil)
	before := time.Now()

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "session-expiry",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)

	assert.True(t, capturedExpiry.Valid, "Expiry should be set")
	expectedExpiry := before.Add(24 * time.Hour)
	assert.WithinDuration(t, expectedExpiry, capturedExpiry.Time, 5*time.Second)
}

// ---- Phase 1.1: Message History in Task Payload ----

func TestDispatchAgentRun_IncludesMessageHistoryInPayload(t *testing.T) {
	t.Parallel()

	sessionID := "550e8400-e29b-41d4-a716-446655440001"

	q := &mockAgentQuerier{
		listAgentMessagesFn: func(ctx context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			if arg.SessionID == sessionID {
				return []db.AgentMessage{
					sampleDBAgentMessage(1, sessionID, "user", 0),
					sampleDBAgentMessage(2, sessionID, "assistant", 1),
				}, nil
			}
			return nil, nil
		},
		listAgentMessagePartsFn: func(ctx context.Context, messageID int64) ([]db.AgentPart, error) {
			switch messageID {
			case 1:
				return []db.AgentPart{
					sampleDBAgentPart(1, 1, 0, "text", json.RawMessage(`"Hello, fix the bug"`)),
				}, nil
			case 2:
				return []db.AgentPart{
					sampleDBAgentPart(2, 2, 0, "text", json.RawMessage(`"Sure, I can help"`)),
				}, nil
			}
			return nil, nil
		},
	}

	var capturedPayload json.RawMessage
	dq := &mockAgentDispatchQuerier{
		createWorkflowTaskFn: func(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			capturedPayload = arg.Payload
			return db.WorkflowTask{ID: 30}, nil
		},
	}

	svc := newTestDispatchService(dq, nil)
	svc.q = q

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    sessionID,
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)

	var payload map[string]any
	require.NoError(t, json.Unmarshal(capturedPayload, &payload))

	history, ok := payload["message_history"].([]any)
	require.True(t, ok, "payload should contain 'message_history' array")
	assert.Len(t, history, 2, "message_history should contain 2 messages")

	firstMsg, ok := history[0].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "user", firstMsg["role"])
	assert.Equal(t, "Hello, fix the bug", firstMsg["content"])

	secondMsg, ok := history[1].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "assistant", secondMsg["role"])
	assert.Equal(t, "Sure, I can help", secondMsg["content"])
}

func TestDispatchAgentRun_MessageHistoryEmptyWhenNoMessages(t *testing.T) {
	t.Parallel()

	q := &mockAgentQuerier{
		listAgentMessagesFn: func(ctx context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			return []db.AgentMessage{}, nil
		},
	}

	var capturedPayload json.RawMessage
	dq := &mockAgentDispatchQuerier{
		createWorkflowTaskFn: func(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			capturedPayload = arg.Payload
			return db.WorkflowTask{ID: 30}, nil
		},
	}

	svc := newTestDispatchService(dq, nil)
	svc.q = q

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-empty",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)

	var payload map[string]any
	require.NoError(t, json.Unmarshal(capturedPayload, &payload))

	history, ok := payload["message_history"]
	require.True(t, ok, "payload should contain 'message_history' field")
	historySlice, ok := history.([]any)
	require.True(t, ok, "message_history should be a JSON array")
	assert.Empty(t, historySlice, "message_history should be empty when no messages exist")
}

// ---- Microsandbox VM repository clone configuration ----

func TestDispatchAgentRun_CreatesMicrosandboxVMWithRepositoryClone(t *testing.T) {
	t.Parallel()

	var (
		capturedCreateToken db.CreateAccessTokenParams
		capturedDeleteToken db.DeleteAccessTokenParams
		capturedVMRequest   sandbox.CreateRequest
		capturedService     sandbox.ServiceSpec
		deleteTokenCalls    int
	)

	dq := &mockAgentDispatchQuerier{
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			// Capture the clone token (read:repository); the per-run API token
			// (write:repository) is a separate id that survives the happy path.
			if arg.Scopes == "read:repository" {
				capturedCreateToken = arg
				return db.AccessToken{ID: 88, UserID: arg.UserID, Name: arg.Name}, nil
			}
			return db.AccessToken{ID: 89, UserID: arg.UserID, Name: arg.Name}, nil
		},
		deleteAccessTokenFn: func(ctx context.Context, arg db.DeleteAccessTokenParams) error {
			deleteTokenCalls++
			capturedDeleteToken = arg
			return nil
		},
	}

	svc := newTestDispatchService(dq, nil)
	svc.agentSnapshotID = "agent-snapshot-123"
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			capturedVMRequest = req
			return sandbox.CreateResult{ID: "vm-test-123"}, nil
		},
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			assert.Equal(t, "vm-test-123", vmID)
			capturedService = req
			return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-clone",
		RepositoryID: 101,
		UserID:       7,
		RepoOwner:    "alice",
		RepoName:     "demo",
	})
	require.NoError(t, err)

	assert.Equal(t, int64(7), capturedCreateToken.UserID)
	assert.Equal(t, "sandbox-agent-clone", capturedCreateToken.Name)
	assert.Equal(t, "read:repository", capturedCreateToken.Scopes)
	assert.NotEmpty(t, capturedCreateToken.TokenHash)

	require.Len(t, capturedVMRequest.GitRepos, 1)
	assert.Equal(t, "agent-snapshot-123", capturedVMRequest.SnapshotID)
	assert.Equal(t, "/workspace", capturedVMRequest.GitRepos[0].Path)
	assert.Equal(t, "/workspace", capturedVMRequest.Workdir)

	cloneURL, err := url.Parse(capturedVMRequest.GitRepos[0].Repo)
	require.NoError(t, err)
	assert.Equal(t, "/alice/demo.git", cloneURL.Path)
	assert.Equal(t, "x-access-token", cloneURL.User.Username())
	password, ok := cloneURL.User.Password()
	require.True(t, ok)
	assert.True(t, strings.HasPrefix(password, "smithers_"))

	assert.Nil(t, capturedVMRequest.Init)
	assert.Equal(t, "smithers-agent", capturedService.Name)
	// The unit still has no command: the 0.x loop that used to be exec'd here
	// is deleted and Smithers 1.0 has no per-task entrypoint to name.
	assert.Empty(t, capturedService.Exec)
	env := capturedService.Env
	assert.Equal(t, "/root", env["HOME"])
	assert.Equal(t, "sess-clone", env["SMITHERS_AGENT_SESSION_ID"])
	assert.Equal(t, "/usr/local/bin:/root/.bun/bin:/usr/bin:/bin", env["PATH"])
	assert.Equal(t, "/workspace", env["SMITHERS_REPOSITORY_PATH"])
	// SMITHERS_TASK_PAYLOAD went with the loop that read it.
	assert.Empty(t, env["SMITHERS_TASK_PAYLOAD"])
	assert.Equal(t, "/workspace", capturedService.Workdir)

	assert.Equal(t, 1, deleteTokenCalls)
	assert.Equal(t, int64(88), capturedDeleteToken.ID)
	assert.Equal(t, int64(7), capturedDeleteToken.UserID)
}

func TestDispatchAgentRun_UsesGoCodexHTTPAgentService(t *testing.T) {
	t.Parallel()

	var (
		capturedPayload json.RawMessage
		capturedService sandbox.ServiceSpec
	)

	dq := &mockAgentDispatchQuerier{
		createWorkflowTaskFn: func(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			capturedPayload = arg.Payload
			return db.WorkflowTask{ID: 30}, nil
		},
	}

	svc := newTestDispatchService(dq, nil)
	svc.sandbox = &mockSandboxVMClient{
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			capturedService = req
			return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:      "sess-codex-http",
		RepositoryID:   101,
		UserID:         7,
		AgentProvider:  "codex",
		AgentTransport: "http",
	})
	require.NoError(t, err)

	// The codex-only Go stand-in is deleted with the loop it shadowed; the
	// provider and transport still reach the box for a 1.0 entrypoint to read.
	assert.Empty(t, capturedService.Exec)
	assert.Equal(t, "codex", capturedService.Env["SMITHERS_AGENT_PROVIDER"])
	assert.Equal(t, "http", capturedService.Env["SMITHERS_AGENT_TRANSPORT"])

	var payload map[string]any
	require.NoError(t, json.Unmarshal(capturedPayload, &payload))
	assert.Equal(t, "codex", payload["agent_provider"])
	assert.Equal(t, "http", payload["agent_transport"])
}

func TestDispatchAgentRun_CreateVMErrorRevokesCloneTokenOnce(t *testing.T) {
	t.Parallel()

	var revokedIDs []int64
	dq := &mockAgentDispatchQuerier{
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			// Clone token → 91, per-run API token → 92.
			if strings.HasPrefix(arg.Scopes, "write:repository") {
				return db.AccessToken{ID: 92, UserID: arg.UserID, Name: arg.Name}, nil
			}
			return db.AccessToken{ID: 91, UserID: arg.UserID, Name: arg.Name}, nil
		},
		deleteAccessTokenFn: func(ctx context.Context, arg db.DeleteAccessTokenParams) error {
			revokedIDs = append(revokedIDs, arg.ID)
			assert.Equal(t, int64(7), arg.UserID)
			return nil
		},
	}

	svc := newTestDispatchService(dq, nil)
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{}, errors.New("microsandbox unavailable")
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-clone-error",
		RepositoryID: 101,
		UserID:       7,
		RepoOwner:    "alice",
		RepoName:     "demo",
	})
	require.Error(t, err)
	// Both the clone token (91) and the per-run API token (92) are revoked on the
	// VM-creation failure cleanup path; neither is revoked more than once.
	assert.ElementsMatch(t, []int64{91, 92}, revokedIDs)
}

func TestDispatchAgentRun_InjectsRepoSecretsIntoSystemdEnv(t *testing.T) {
	t.Parallel()

	var capturedEnv map[string]string

	svc := newTestDispatchService(&mockAgentDispatchQuerier{}, nil)
	svc.secretService = &mockAgentSecretReader{
		listDecryptedSecretsForRepoFn: func(ctx context.Context, repositoryID int64) (map[string]string, error) {
			assert.Equal(t, int64(101), repositoryID)
			return map[string]string{
				"ANTHROPIC_API_KEY":    "sk-ant-test",
				"SMITHERS_AGENT_TOKEN": "should-not-overwrite",
			}, nil
		},
	}
	svc.sandbox = &mockSandboxVMClient{
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			capturedEnv = req.Env
			return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-secrets",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)
	require.NotNil(t, capturedEnv)
	assert.Equal(t, "sk-ant-test", capturedEnv["ANTHROPIC_API_KEY"])
	assert.Equal(t, "SMITHERS_AGENT_TOKEN", capturedEnv["SMITHERS_AGENT_TOKEN"], "the callback token is a proxy placeholder")
}

func TestDispatchAgentRun_RepositoryKeyReplacesThePlatformSeat(t *testing.T) {
	t.Parallel()

	var capturedEnv map[string]string
	svc := newTestDispatchService(&mockAgentDispatchQuerier{}, nil)
	svc.sandboxConfig.ModelSeats = []modelproxy.Seat{modelproxy.Seats[0], modelproxy.Seats[1], modelproxy.Seats[3]}
	svc.secretInjector = NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(_ context.Context, repositoryID int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{
				{Name: "OPENROUTER_API_KEY", ValueEncrypted: []byte("repo-openrouter-attack")},
				{Name: "ANTHROPIC_API_KEY", ValueEncrypted: []byte("repo-anthropic-attack")},
				{Name: "OPENAI_API_KEY", ValueEncrypted: []byte("repo-openai-attack")},
			}, nil
		},
	}, webhook.NoopSecretCodec{})
	svc.sandbox = &mockSandboxVMClient{
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			capturedEnv = req.Env
			return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-platform-provider-env",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)
	// A repository that supplies its own provider key runs on it; the
	// platform seat (and its credit) is not offered for that provider.
	assert.Equal(t, "repo-anthropic-attack", capturedEnv["ANTHROPIC_API_KEY"])
	assert.Equal(t, "repo-openai-attack", capturedEnv["OPENAI_API_KEY"])
	assert.Equal(t, "repo-openrouter-attack", capturedEnv["OPENROUTER_API_KEY"])
	for _, name := range []string{"ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENROUTER_BASE_URL", "SMITHERS_MODEL_PROXY_URL"} {
		assert.NotContains(t, capturedEnv, name, "a repository key keeps its provider origin")
	}
}

func TestDispatchAgentRun_UsesConfiguredMicrosandboxResourceLimits(t *testing.T) {
	t.Parallel()

	var capturedVMRequest sandbox.CreateRequest

	svc := newTestDispatchService(&mockAgentDispatchQuerier{}, nil)
	svc.sandboxConfig = AgentSandboxConfig{
		MemoryMB:     4096,
		VCPUCount:    2,
		RootfsSizeMB: 10240,
		ModelSeats:   []modelproxy.Seat{modelproxy.Seats[2]},
	}
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			capturedVMRequest = req
			return sandbox.CreateResult{ID: "vm-resource-test"}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-resources",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)
	require.NotNil(t, capturedVMRequest.MemSizeMB)
	require.NotNil(t, capturedVMRequest.VCPUCount)
	require.NotNil(t, capturedVMRequest.RootfsSizeMB)
	assert.Equal(t, int32(4096), *capturedVMRequest.MemSizeMB)
	assert.Equal(t, int32(2), *capturedVMRequest.VCPUCount)
	assert.Equal(t, int64(10240), *capturedVMRequest.RootfsSizeMB)
}

func TestDispatchAgentRun_UsesConfiguredIdleTimeout(t *testing.T) {
	t.Parallel()

	var capturedVMRequest sandbox.CreateRequest

	svc := newTestDispatchService(&mockAgentDispatchQuerier{}, nil)
	svc.sandboxConfig = AgentSandboxConfig{
		IdleTimeout: 15 * time.Minute,
		ModelSeats:  []modelproxy.Seat{modelproxy.Seats[2]},
	}
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			capturedVMRequest = req
			return sandbox.CreateResult{ID: "vm-idle-timeout-test"}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-idle-timeout",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)
	require.NotNil(t, capturedVMRequest.IdleTimeoutSeconds)
	assert.Equal(t, int64(15*60), *capturedVMRequest.IdleTimeoutSeconds)
}

func TestDispatchAgentRun_OmitsRepositoryCloneWhenRepositoryNotProvided(t *testing.T) {
	t.Parallel()

	var (
		capturedVMRequest sandbox.CreateRequest
		capturedService   sandbox.ServiceSpec
	)
	svc := newTestDispatchService(&mockAgentDispatchQuerier{}, nil)
	svc.apiBaseURL = "https://public.smithers.test/api"
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			capturedVMRequest = req
			return sandbox.CreateResult{ID: "vm-test-123"}, nil
		},
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			assert.Equal(t, "vm-test-123", vmID)
			capturedService = req
			return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-no-repo",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)

	assert.Empty(t, capturedVMRequest.GitRepos)
	assert.Equal(t, "", capturedVMRequest.Workdir)
	assert.Nil(t, capturedVMRequest.Init)
	assert.Equal(t, "smithers-agent", capturedService.Name)
	assert.Empty(t, capturedService.Exec)
	assert.Equal(t, "/root", capturedService.Env["HOME"])
	assert.Equal(t, "https://public.smithers.test", capturedService.Env["SMITHERS_API_BASE_URL"])
	assert.Equal(t, "", capturedService.Env["SMITHERS_REPOSITORY_PATH"])
	assert.Equal(t, "/usr/local/bin:/root/.bun/bin:/usr/bin:/bin", capturedService.Env["PATH"])
	// No repository means no checkout, so the unit has no workdir either.
	assert.Equal(t, "", capturedService.Workdir)
}

func TestDispatchAgentRun_InjectsRepositorySecretsIntoMicrosandboxEnv(t *testing.T) {
	t.Parallel()

	var capturedService sandbox.ServiceSpec

	svc := newTestDispatchService(&mockAgentDispatchQuerier{}, nil)
	svc.secretInjector = NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(_ context.Context, repositoryID int64) ([]db.ListSecretValuesRow, error) {
			assert.Equal(t, int64(101), repositoryID)
			return []db.ListSecretValuesRow{
				{Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: []byte("smithers_secret_token")},
			}, nil
		},
	}, webhook.NoopSecretCodec{})
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-test-123"}, nil
		},
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			capturedService = req
			return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-secret-env",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)
	assert.Equal(t, "smithers_secret_token", capturedService.Env["ANTHROPIC_AUTH_TOKEN"])
}

func TestDispatchAgentRun_RejectsMicrosandboxSystemdInternalError(t *testing.T) {
	t.Parallel()

	var (
		capturedVMRequest sandbox.CreateRequest
		vmDeleted         bool
		taskMarkedRunning bool
	)

	svc := newTestDispatchService(&mockAgentDispatchQuerier{
		markWorkflowTaskVMRunningFn: func(context.Context, db.MarkWorkflowTaskVMRunningParams) (int64, error) {
			taskMarkedRunning = true
			return 1, nil
		},
	}, nil)
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			capturedVMRequest = req
			return sandbox.CreateResult{ID: "vm-test-123"}, nil
		},
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			assert.Equal(t, "vm-test-123", vmID)
			assert.Equal(t, "smithers-agent", req.Name)
			return sandbox.CreateServiceResult{}, &sandbox.StatusError{
				StatusCode: 500,
				ErrorCode:  "INTERNAL_ERROR",
				Message:    "Internal server error",
			}
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			vmDeleted = true
			return nil
		},
	}

	// Run through InjectLogger so the regression also verifies the systemd
	// failure is emitted as a structured error with dispatch correlation IDs.
	var logBuf bytes.Buffer
	logger := middleware.NewServerLogger(&logBuf, "info")
	var dispatchErr error
	middleware.InjectLogger(logger)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, dispatchErr = svc.DispatchAgentRun(r.Context(), DispatchAgentRunInput{
			SessionID:    "sess-systemd-500",
			RepositoryID: 101,
			UserID:       1,
		})
	})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/dispatch", nil))

	require.Error(t, dispatchErr)
	assert.Contains(t, dispatchErr.Error(), "create microsandbox systemd service")
	assert.Contains(t, dispatchErr.Error(), "Internal server error")
	assert.True(t, vmDeleted, "VM should be cleaned up after systemd failure")
	assert.False(t, taskMarkedRunning, "dispatch must not report success after systemd failure")
	assert.Contains(t, logBuf.String(), `"severity":"ERROR"`)
	assert.Contains(t, logBuf.String(), "failed to create microsandbox systemd service")
	assert.Contains(t, logBuf.String(), "sess-systemd-500")
	assert.Equal(t, "", capturedVMRequest.Workdir)
}

// ---- Phase 4.1: Full Transcript Archival ----

func TestIngestRunnerEvent_DoneArchivesFullTranscript(t *testing.T) {
	t.Parallel()

	sessionID := "sess-transcript"

	var archivedPayload []byte
	logStore := &mockAgentLogStore{
		putSessionLogFn: func(ctx context.Context, repositoryID int64, sid string, payload []byte) error {
			archivedPayload = payload
			return nil
		},
	}

	q := &mockAgentQuerier{
		getAgentSessionFn: func(ctx context.Context, id string) (db.AgentSession, error) {
			return sampleDBAgentSession(id, 202, 1, "default"), nil
		},
		listAgentMessagesFn: func(ctx context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			if arg.SessionID == sessionID {
				return []db.AgentMessage{
					sampleDBAgentMessage(1, sessionID, "user", 0),
					sampleDBAgentMessage(2, sessionID, "assistant", 1),
					sampleDBAgentMessage(3, sessionID, "assistant", 2),
				}, nil
			}
			return nil, nil
		},
		listAgentMessagePartsFn: func(ctx context.Context, messageID int64) ([]db.AgentPart, error) {
			return []db.AgentPart{
				sampleDBAgentPart(messageID, messageID, 0, "text", json.RawMessage(`"part content"`)),
			}, nil
		},
	}

	dq := &mockAgentDispatchQuerier{
		updateAgentSessionTerminalStatusFn: func(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			s := sampleDBAgentSession(arg.ID, 202, 1, "default")
			s.Status = arg.Status
			s.FinishedAt = arg.FinishedAt
			return s, nil
		},
	}
	svc := &AgentService{
		q:         q,
		dispatchQ: dq,
		logStore:  logStore,
	}

	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: sessionID,
		EventType: "done",
		Content:   json.RawMessage(`{"status":"completed"}`),
	})
	require.NoError(t, err)
	require.NotNil(t, archivedPayload, "log store should have been called with transcript")

	var transcript map[string]any
	require.NoError(t, json.Unmarshal(archivedPayload, &transcript))

	assert.Equal(t, sessionID, transcript["session_id"])
	assert.Equal(t, float64(202), transcript["repository_id"])
	assert.Equal(t, "completed", transcript["status"])
	assert.Contains(t, transcript, "archived_at", "transcript should include archived_at timestamp")

	messages, ok := transcript["messages"].([]any)
	require.True(t, ok, "transcript should contain 'messages' array")
	// Note: message_history includes the done message too (appended before archival)
	assert.GreaterOrEqual(t, len(messages), 3, "transcript should include all messages")
}

// ---- Phase 5.1: Agent Token Revocation ----

func TestIngestRunnerEvent_DoneRevokesAgentToken(t *testing.T) {
	t.Parallel()

	sessionID := "sess-revoke"
	workflowRunID := int64(99)

	var capturedTokenHash pgtype.Text
	var capturedExpiry pgtype.Timestamptz
	var capturedRunID int64

	dq := &mockAgentDispatchQuerier{
		updateAgentSessionTerminalStatusFn: func(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			s := sampleDBAgentSession(arg.ID, 101, 1, "default")
			s.Status = arg.Status
			s.WorkflowRunID = pgtype.Int8{Int64: workflowRunID, Valid: true}
			s.FinishedAt = arg.FinishedAt
			return s, nil
		},
		updateWorkflowRunAgentTokenFn: func(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
			capturedTokenHash = arg.AgentTokenHash
			capturedExpiry = arg.AgentTokenExpiresAt
			capturedRunID = arg.ID
			return db.WorkflowRun{ID: arg.ID}, nil
		},
	}

	svc := &AgentService{
		q:         &mockAgentQuerier{},
		dispatchQ: dq,
	}

	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: sessionID,
		EventType: "done",
		Content:   json.RawMessage(`{"status":"completed"}`),
	})
	require.NoError(t, err)

	assert.Equal(t, workflowRunID, capturedRunID, "should revoke token on correct workflow run")
	assert.False(t, capturedTokenHash.Valid, "agent token hash should be cleared (invalid/null)")
	assert.True(t, capturedExpiry.Valid, "expiry should be set")
	assert.True(t, capturedExpiry.Time.Before(time.Now()), "expiry should be in the past")
}

func TestIngestRunnerEvent_DoneTokenRevocationBestEffort(t *testing.T) {
	t.Parallel()

	q := &mockAgentQuerier{
		getAgentSessionWorkflowRunIDFn: func(ctx context.Context, id string) (pgtype.Int8, error) {
			return pgtype.Int8{Valid: false}, nil
		},
	}

	dq := &mockAgentDispatchQuerier{}
	svc := &AgentService{
		q:         q,
		dispatchQ: dq,
	}

	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: "sess-no-run",
		EventType: "done",
		Content:   json.RawMessage(`{"status":"completed"}`),
	})
	require.NoError(t, err)
}

func TestAgentService_StartAgentRuntimeWatchdog_DeletesVMAtMaxRuntime(t *testing.T) {
	t.Parallel()

	deletedVM := make(chan string, 1)
	svc := &AgentService{
		sandboxConfig: AgentSandboxConfig{MaxRuntime: 20 * time.Millisecond},
		sandbox: &mockSandboxVMClient{
			deleteVMFn: func(ctx context.Context, vmID string) error {
				deletedVM <- vmID
				return nil
			},
		},
	}

	svc.startAgentRuntimeWatchdog("sess-watchdog", "vm-watchdog", 77, 0)

	select {
	case vmID := <-deletedVM:
		assert.Equal(t, "vm-watchdog", vmID)
	case <-time.After(time.Second):
		t.Fatal("expected watchdog to delete the VM")
	}
}

func TestIngestRunnerEvent_DoneCancelsRuntimeWatchdog(t *testing.T) {
	t.Parallel()

	deletedVM := make(chan string, 1)
	dq := &mockAgentDispatchQuerier{
		updateAgentSessionTerminalStatusFn: func(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			s := sampleDBAgentSession(arg.ID, 101, 1, "default")
			s.Status = arg.Status
			s.FinishedAt = arg.FinishedAt
			s.WorkflowRunID = pgtype.Int8{Valid: false}
			return s, nil
		},
	}
	svc := &AgentService{
		q:             &mockAgentQuerier{},
		dispatchQ:     dq,
		sandboxConfig: AgentSandboxConfig{MaxRuntime: 25 * time.Millisecond},
		sandbox: &mockSandboxVMClient{
			deleteVMFn: func(ctx context.Context, vmID string) error {
				deletedVM <- vmID
				return nil
			},
		},
	}

	svc.startAgentRuntimeWatchdog("sess-watchdog-done", "vm-done", 88, 0)

	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: "sess-watchdog-done",
		EventType: "done",
		Content:   json.RawMessage(`{"status":"completed"}`),
	})
	require.NoError(t, err)

	select {
	case vmID := <-deletedVM:
		t.Fatalf("watchdog should have been canceled before deleting %s", vmID)
	case <-time.After(100 * time.Millisecond):
	}
}

// ---- Phase 2.3: WithRepoHostSnapshotter option ----

func TestWithRepoHostSnapshotter_SetsSnapshotter(t *testing.T) {
	t.Parallel()

	snap := &mockRepoHostSnapshotter{}
	svc := NewAgentServiceWithPool(
		&mockAgentQuerier{},
		nil,
		WithRepoHostSnapshotter(snap),
	)
	assert.Equal(t, snap, svc.snapshotter, "snapshotter should be set via option")
}

// ---- DeleteSession ----

func TestAgentService_DeleteSession_Success(t *testing.T) {
	t.Parallel()

	var deletedID string
	var deletedUserID int64
	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(_ context.Context, id string) (db.AgentSession, error) {
			return sampleDBAgentSession(id, 101, 7, "my session"), nil
		},
		deleteAgentSessionFn: func(_ context.Context, arg db.DeleteAgentSessionParams) error {
			deletedID = arg.ID
			deletedUserID = arg.UserID
			return nil
		},
	})

	err := svc.DeleteSession(context.Background(), "sess-123", 7)
	require.NoError(t, err)
	assert.Equal(t, "sess-123", deletedID)
	assert.Equal(t, int64(7), deletedUserID)
}

// Regression (issue #111): DeleteSession used to only tombstone the row. A
// tombstoned session is invisible to the reaper (ListStaleActiveSessions
// filters deleted_at IS NULL) and to runner callbacks, so an in-flight run's
// VM, workflow task, and tokens escaped every cleanup path. Deleting an active
// session must cancel + finalize the run BEFORE tombstoning.
func TestAgentService_DeleteSession_ActiveRunIsFinalizedBeforeTombstone(t *testing.T) {
	t.Parallel()

	const runID = int64(88)

	var (
		callOrder      []string
		terminalStatus string
		taskStatus     string
		vmDeleted      string
		tokenRevoked   bool
	)

	dq := &mockAgentDispatchQuerier{
		updateAgentSessionTerminalStatusFn: func(_ context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			callOrder = append(callOrder, "terminal_status")
			terminalStatus = arg.Status
			s := sampleDBAgentSession(arg.ID, 101, 7, "active session")
			s.Status = arg.Status
			s.WorkflowRunID = pgtype.Int8{Int64: runID, Valid: true}
			return s, nil
		},
		getWorkflowTaskByRunIDFn: func(_ context.Context, workflowRunID int64) (db.WorkflowTask, error) {
			assert.Equal(t, runID, workflowRunID)
			return db.WorkflowTask{
				ID:             30,
				WorkflowRunID:  workflowRunID,
				WorkflowStepID: 20,
				Status:         "running",
				VmID:           pgtype.Text{String: "vm-delete-me", Valid: true},
			}, nil
		},
		markWorkflowTaskTerminalByIDFn: func(_ context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error) {
			taskStatus = arg.Status
			return 1, nil
		},
		updateWorkflowRunAgentTokenFn: func(_ context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
			tokenRevoked = !arg.AgentTokenHash.Valid
			return db.WorkflowRun{ID: arg.ID}, nil
		},
	}
	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(_ context.Context, id string) (db.AgentSession, error) {
			s := sampleDBAgentSession(id, 101, 7, "active session")
			s.WorkflowRunID = pgtype.Int8{Int64: runID, Valid: true}
			return s, nil
		},
		deleteAgentSessionFn: func(_ context.Context, _ db.DeleteAgentSessionParams) error {
			callOrder = append(callOrder, "tombstone")
			return nil
		},
	})
	svc.dispatchQ = dq
	svc.sandbox = &mockSandboxVMClient{
		deleteVMFn: func(_ context.Context, vmID string) error {
			vmDeleted = vmID
			return nil
		},
	}

	err := svc.DeleteSession(context.Background(), "sess-live", 7)
	require.NoError(t, err)
	assert.Equal(t, []string{"terminal_status", "tombstone"}, callOrder,
		"the run must be terminalized before the row is tombstoned")
	assert.Equal(t, "cancelled", terminalStatus)
	assert.Equal(t, "cancelled", taskStatus)
	assert.Equal(t, "vm-delete-me", vmDeleted, "the sandbox VM must be torn down on delete")
	assert.True(t, tokenRevoked, "the run's agent callback token must be revoked on delete")
}

// Deleting an already-terminal session must NOT re-run finalize (the terminal
// transition matched zero rows), only tombstone.
func TestAgentService_DeleteSession_TerminalSessionSkipsFinalize(t *testing.T) {
	t.Parallel()

	tombstoned := false
	finalizeTouched := false
	dq := &mockAgentDispatchQuerier{
		updateAgentSessionTerminalStatusFn: func(_ context.Context, _ db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			// The UPDATE matches only status='active' rows.
			return db.AgentSession{}, pgx.ErrNoRows
		},
		getWorkflowTaskByRunIDFn: func(_ context.Context, workflowRunID int64) (db.WorkflowTask, error) {
			finalizeTouched = true
			return db.WorkflowTask{}, pgx.ErrNoRows
		},
	}
	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(_ context.Context, id string) (db.AgentSession, error) {
			s := sampleDBAgentSession(id, 101, 7, "done session")
			s.Status = "completed"
			return s, nil
		},
		deleteAgentSessionFn: func(_ context.Context, _ db.DeleteAgentSessionParams) error {
			tombstoned = true
			return nil
		},
	})
	svc.dispatchQ = dq

	err := svc.DeleteSession(context.Background(), "sess-done", 7)
	require.NoError(t, err)
	assert.True(t, tombstoned)
	assert.False(t, finalizeTouched, "finalize must not re-run for an already-terminal session")
}

func TestAgentService_DeleteSession_NotFound(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(_ context.Context, _ string) (db.AgentSession, error) {
			return db.AgentSession{}, errors.New("not found")
		},
	})

	err := svc.DeleteSession(context.Background(), "nonexistent", 7)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestAgentService_DeleteSession_WrongOwner(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(_ context.Context, id string) (db.AgentSession, error) {
			return sampleDBAgentSession(id, 101, 7, "my session"), nil
		},
	})

	err := svc.DeleteSession(context.Background(), "sess-123", 999)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "do not own")
}

func TestAgentService_DeleteSession_NilQuerier(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(nil)
	err := svc.DeleteSession(context.Background(), "sess-123", 7)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unavailable")
}

// ---- Ticket 0114: tombstone-aware session read paths ----

// TestAgentService_GetSession_TombstonedReturnsNotFound documents that once
// the underlying DB query filters deleted_at IS NULL, GetSession's public
// surface is not-found for tombstoned rows — clients never observe the
// tombstone body.
func TestAgentService_GetSession_TombstonedReturnsNotFound(t *testing.T) {
	t.Parallel()

	// Simulate the sqlc-generated query behavior: `WHERE id = $1 AND
	// deleted_at IS NULL` returns ErrNoRows for a tombstoned session.
	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionWithMessageCountFn: func(_ context.Context, _ string) (db.GetAgentSessionWithMessageCountRow, error) {
			return db.GetAgentSessionWithMessageCountRow{}, errors.New("no rows")
		},
	})

	_, err := svc.GetSession(context.Background(), "tombstoned-id")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not found",
		"tombstoned sessions must surface as NotFound, never leak deleted_at to the public API")
}

// TestAgentService_GetSessionForRepo_TombstonedReturnsNotFound ensures that
// the repo-scope verification layer (used by every mutating route) also
// treats tombstoned sessions as not-found. This is what blocks a second
// DELETE or a follow-up PostMessage against a tombstoned id.
func TestAgentService_GetSessionForRepo_TombstonedReturnsNotFound(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(_ context.Context, _ string) (db.AgentSession, error) {
			return db.AgentSession{}, errors.New("no rows")
		},
	})

	err := svc.GetSessionForRepo(context.Background(), "tombstoned-id", 101)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

// TestAgentService_ListSessions_TombstonedRowsExcluded exercises the list
// query path. Because the sqlc query filters deleted_at IS NULL, a tombstoned
// session is simply absent from the row set — there is nothing for the
// service to do beyond passing the result through.
func TestAgentService_ListSessions_TombstonedRowsExcluded(t *testing.T) {
	t.Parallel()

	// Simulate two live rows returned from the DB layer (the tombstoned row
	// was filtered out by the query, so the service never sees it).
	svc := NewAgentService(&mockAgentQuerier{
		listAgentSessionsByRepoWithMessageCountFn: func(_ context.Context, arg db.ListAgentSessionsByRepoWithMessageCountParams) ([]db.ListAgentSessionsByRepoWithMessageCountRow, error) {
			return []db.ListAgentSessionsByRepoWithMessageCountRow{
				{ID: "live-a", RepositoryID: arg.RepositoryID, Status: "active", MessageCount: 3},
				{ID: "live-b", RepositoryID: arg.RepositoryID, Status: "completed", MessageCount: 7},
			}, nil
		},
		countAgentSessionsByRepoFn: func(_ context.Context, _ int64) (int64, error) {
			return 2, nil // the tombstoned row is not counted either
		},
	})

	sessions, total, err := svc.ListSessions(context.Background(), 101, 1, 30)
	require.NoError(t, err)
	assert.Equal(t, int64(2), total)
	require.Len(t, sessions, 2)
	assert.Equal(t, "live-a", sessions[0].ID)
	assert.Equal(t, "live-b", sessions[1].ID)
}

// TestAgentService_DeleteSession_ReDeletingTombstoneReturnsNotFound documents
// the idempotency behavior surfaced through the public service API: once a
// session is tombstoned, the first subsequent call to DeleteSession sees
// GetAgentSession return ErrNoRows (the row is hidden) and the service
// therefore returns NotFound. A route handler calling GetSessionForRepo
// before DeleteSession will already have bounced the caller at that earlier
// gate; this test covers the direct-service-call path.
func TestAgentService_DeleteSession_ReDeletingTombstoneReturnsNotFound(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(_ context.Context, _ string) (db.AgentSession, error) {
			// Query now filters deleted_at IS NULL — a tombstoned row is
			// invisible here.
			return db.AgentSession{}, errors.New("no rows")
		},
		deleteAgentSessionFn: func(_ context.Context, _ db.DeleteAgentSessionParams) error {
			t.Fatalf("delete should not be called after GetAgentSession returns not found")
			return nil
		},
	})

	err := svc.DeleteSession(context.Background(), "already-tombstoned", 7)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

// TestAgentService_DeleteSession_CallsTombstoneQuery documents that the
// service still invokes DeleteAgentSession on a live session — the DB layer
// is now a tombstone UPDATE under the hood, but from the service's
// perspective the contract is unchanged.
func TestAgentService_DeleteSession_CallsTombstoneQuery(t *testing.T) {
	t.Parallel()

	var called int
	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(_ context.Context, id string) (db.AgentSession, error) {
			return sampleDBAgentSession(id, 101, 7, "live"), nil
		},
		deleteAgentSessionFn: func(_ context.Context, arg db.DeleteAgentSessionParams) error {
			called++
			assert.Equal(t, "live-123", arg.ID)
			assert.Equal(t, int64(7), arg.UserID)
			return nil
		},
	})

	require.NoError(t, svc.DeleteSession(context.Background(), "live-123", 7))
	assert.Equal(t, 1, called)
}

// ---- GetSession with MessageCount ----

func TestAgentService_GetSession_IncludesMessageCount(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionWithMessageCountFn: func(_ context.Context, id string) (db.GetAgentSessionWithMessageCountRow, error) {
			return db.GetAgentSessionWithMessageCountRow{
				ID:           id,
				RepositoryID: 101,
				UserID:       1,
				Title:        "test session",
				Status:       "completed",
				MessageCount: 42,
			}, nil
		},
	})

	result, err := svc.GetSession(context.Background(), "sess-123")
	require.NoError(t, err)
	assert.Equal(t, "sess-123", result.ID)
	assert.Equal(t, int64(42), result.MessageCount)
	assert.Equal(t, "completed", result.Status)
}

// ---- ListSessions with MessageCount ----

func TestAgentService_ListSessions_IncludesMessageCount(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		listAgentSessionsByRepoWithMessageCountFn: func(_ context.Context, arg db.ListAgentSessionsByRepoWithMessageCountParams) ([]db.ListAgentSessionsByRepoWithMessageCountRow, error) {
			return []db.ListAgentSessionsByRepoWithMessageCountRow{
				{
					ID:           "s1",
					RepositoryID: arg.RepositoryID,
					UserID:       1,
					Title:        "session one",
					Status:       "active",
					MessageCount: 10,
				},
				{
					ID:           "s2",
					RepositoryID: arg.RepositoryID,
					UserID:       2,
					Title:        "session two",
					Status:       "completed",
					MessageCount: 25,
				},
			}, nil
		},
	})

	results, total, err := svc.ListSessions(context.Background(), 101, 1, 30)
	require.NoError(t, err)
	assert.Equal(t, int64(1), total) // from default mock CountAgentSessionsByRepo
	require.Len(t, results, 2)
	assert.Equal(t, int64(10), results[0].MessageCount)
	assert.Equal(t, int64(25), results[1].MessageCount)
}

// -----------------------------------------------------------------------------
// Tickets 0115 + 0118: denormalized repository_id / session_id on insert paths
// -----------------------------------------------------------------------------

// TestAgentService_AppendMessageWithTx_PopulatesDenormFields proves that the
// transactional append path (the production path) carries the session's
// repository_id through onto both the agent_messages insert (via the CTE in
// CreateAgentMessageWithNextSequence) and every agent_parts insert (via the
// CreateAgentPartParams we build). Ticket 0115 requires the message row and
// ticket 0118 requires the parts rows to both be populated on every insert.
func TestAgentService_AppendMessageWithTx_PopulatesDenormFields(t *testing.T) {
	t.Parallel()

	const (
		sessionID = "97a78a0b-1de1-4a8b-9f21-4e8b5f0a6d1a"
		repoID    = int64(4242)
	)

	var (
		lockedForAppend bool
		msgParams       db.CreateAgentMessageWithNextSequenceParams
		capturedParts   []db.CreateAgentPartParams
	)

	txManager := &mockAgentAppendTxManager{
		beginFn: func(_ context.Context) (agentAppendTx, error) {
			return &mockAgentAppendTx{
				lockAgentSessionForAppendFn: func(_ context.Context, id string) (db.LockAgentSessionForAppendRow, error) {
					assert.Equal(t, sessionID, id)
					lockedForAppend = true
					return db.LockAgentSessionForAppendRow{ID: id, RepositoryID: repoID}, nil
				},
				createAgentMessageWithNextSequenceFn: func(_ context.Context, arg db.CreateAgentMessageWithNextSequenceParams) (db.AgentMessage, error) {
					msgParams = arg
					// Assert the DB-layer CTE pattern: the query takes session_id
					// + role and derives repository_id from the locked row. We
					// echo that in the returned AgentMessage so downstream
					// assertions can see the value.
					return db.AgentMessage{
						ID:           42,
						SessionID:    arg.SessionID,
						RepositoryID: repoID,
						Role:         arg.Role,
						Sequence:     0,
					}, nil
				},
				createAgentPartFn: func(_ context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
					capturedParts = append(capturedParts, arg)
					return db.AgentPart{
						ID:           int64(len(capturedParts)),
						MessageID:    arg.MessageID,
						RepositoryID: arg.RepositoryID,
						SessionID:    arg.SessionID,
						PartIndex:    arg.PartIndex,
						PartType:     arg.PartType,
						Content:      arg.Content,
					}, nil
				},
			}, nil
		},
	}

	svc := &AgentService{
		q:               &mockAgentQuerier{},
		appendTxManager: txManager,
	}

	parts := []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`{"text":"hello"}`)},
		{PartType: "tool_call", Content: json.RawMessage(`{"name":"bash","args":{}}`)},
		{PartType: "tool_result", Content: json.RawMessage(`{"ok":true}`)},
	}

	resp, err := svc.AppendMessage(context.Background(), sessionID, "assistant", parts)
	require.NoError(t, err)

	// Lock acquired with session id.
	assert.True(t, lockedForAppend, "LockAgentSessionForAppend must run so the service sees repository_id")

	// Message insert: the CTE-based query takes session_id directly; the
	// denorm repository_id is derived from the locked session inside Postgres.
	assert.Equal(t, sessionID, msgParams.SessionID)
	assert.Equal(t, "assistant", msgParams.Role)

	// Parts: every row must carry the same repository_id + session_id as its
	// parent message. Ticket 0118.
	require.Len(t, capturedParts, 3, "every part must go through CreateAgentPart")
	for i, p := range capturedParts {
		assert.Equalf(t, repoID, p.RepositoryID,
			"part %d missing denormalized repository_id (ticket 0118)", i)
		assert.Equalf(t, sessionID, p.SessionID,
			"part %d missing denormalized session_id (ticket 0118)", i)
		assert.Equalf(t, int64(42), p.MessageID, "part %d must link to parent message.ID", i)
		assert.Equalf(t, int64(i), p.PartIndex, "part %d must use insertion order as part_index", i)
	}

	// Response carries the three part types through unchanged.
	require.Len(t, resp.Parts, 3)
	assert.Equal(t, "text", resp.Parts[0].Type)
	assert.Equal(t, "tool_call", resp.Parts[1].Type)
	assert.Equal(t, "tool_result", resp.Parts[2].Type)
}

// TestAgentService_AppendMessageWithoutTx_PopulatesDenormFields proves the
// non-transactional fallback path (used when no appendTxManager is
// configured) also populates the denormalized repository_id / session_id on
// every insert. The test substitutes a mock querier and asserts the params
// sent to CreateAgentMessage and CreateAgentPart.
func TestAgentService_AppendMessageWithoutTx_PopulatesDenormFields(t *testing.T) {
	t.Parallel()

	const (
		sessionID = "c0de5e55-1111-2222-3333-444455556666"
		repoID    = int64(909)
	)

	var (
		msgParams     db.CreateAgentMessageParams
		capturedParts []db.CreateAgentPartParams
	)

	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(_ context.Context, id string) (db.AgentSession, error) {
			assert.Equal(t, sessionID, id)
			return sampleDBAgentSession(id, repoID, 7, "demo"), nil
		},
		getNextAgentMessageSequenceFn: func(_ context.Context, _ string) (int32, error) {
			return 0, nil
		},
		createAgentMessageFn: func(_ context.Context, arg db.CreateAgentMessageParams) (db.AgentMessage, error) {
			msgParams = arg
			return sampleDBAgentMessage(1, arg.SessionID, arg.Role, arg.Sequence), nil
		},
		createAgentPartFn: func(_ context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
			capturedParts = append(capturedParts, arg)
			return sampleDBAgentPart(int64(len(capturedParts)), arg.MessageID, arg.PartIndex, arg.PartType, arg.Content), nil
		},
	})

	parts := []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`{"text":"hi"}`)},
	}
	_, err := svc.AppendMessage(context.Background(), sessionID, "user", parts)
	require.NoError(t, err)

	// Message insert: repository_id must be taken from the session lookup.
	assert.Equal(t, sessionID, msgParams.SessionID)
	assert.Equal(t, repoID, msgParams.RepositoryID, "ticket 0115: message insert must carry repository_id")

	// Parts: both denorm fields populated.
	require.Len(t, capturedParts, 1)
	assert.Equal(t, repoID, capturedParts[0].RepositoryID, "ticket 0118: part must carry repository_id")
	assert.Equal(t, sessionID, capturedParts[0].SessionID, "ticket 0118: part must carry session_id")
}

// TestAgentService_IngestRunnerEvent_PopulatesDenormFields exercises the
// runner-event ingestion path (the second major append-site per the ticket
// reference lines). The event goes through AppendMessage, so the denorm
// fields must land on the agent_messages + agent_parts rows it creates.
func TestAgentService_IngestRunnerEvent_PopulatesDenormFields(t *testing.T) {
	t.Parallel()

	const (
		sessionID = "deadbeef-1234-5678-9abc-def012345678"
		repoID    = int64(7777)
	)

	var (
		msgParams     db.CreateAgentMessageWithNextSequenceParams
		capturedParts []db.CreateAgentPartParams
	)

	txManager := &mockAgentAppendTxManager{
		beginFn: func(_ context.Context) (agentAppendTx, error) {
			return &mockAgentAppendTx{
				lockAgentSessionForAppendFn: func(_ context.Context, id string) (db.LockAgentSessionForAppendRow, error) {
					return db.LockAgentSessionForAppendRow{ID: id, RepositoryID: repoID}, nil
				},
				createAgentMessageWithNextSequenceFn: func(_ context.Context, arg db.CreateAgentMessageWithNextSequenceParams) (db.AgentMessage, error) {
					msgParams = arg
					return db.AgentMessage{
						ID: 1, SessionID: arg.SessionID, RepositoryID: repoID,
						Role: arg.Role, Sequence: 0,
					}, nil
				},
				createAgentPartFn: func(_ context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
					capturedParts = append(capturedParts, arg)
					return db.AgentPart{
						ID: int64(len(capturedParts)), MessageID: arg.MessageID,
						RepositoryID: arg.RepositoryID, SessionID: arg.SessionID,
						PartIndex: arg.PartIndex, PartType: arg.PartType, Content: arg.Content,
					}, nil
				},
			}, nil
		},
	}

	svc := &AgentService{
		q:               &mockAgentQuerier{},
		appendTxManager: txManager,
	}

	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: sessionID,
		EventType: "text",
		Content:   json.RawMessage(`{"text":"runner said hi"}`),
	})
	require.NoError(t, err)

	// Runner events always produce an "assistant" role message.
	assert.Equal(t, sessionID, msgParams.SessionID)
	assert.Equal(t, "assistant", msgParams.Role)

	// The part row — this is what carries the runner's payload — must
	// carry both denorm fields (ticket 0118).
	require.Len(t, capturedParts, 1)
	assert.Equal(t, repoID, capturedParts[0].RepositoryID,
		"IngestRunnerEvent must populate agent_parts.repository_id (ticket 0118)")
	assert.Equal(t, sessionID, capturedParts[0].SessionID,
		"IngestRunnerEvent must populate agent_parts.session_id (ticket 0118)")
	assert.Equal(t, "text", capturedParts[0].PartType)
}
