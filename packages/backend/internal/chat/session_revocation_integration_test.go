package chat

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// sessionTurnStream is one accepted /api/agent/turn delivery opened with a
// browser session cookie.
type sessionTurnStream struct {
	reader *bufio.Reader
	grant  ProducerGrant
	runID  string
	body   []byte
}

func TestTurnStreamStopsAfterBrowserSessionRevocation(t *testing.T) {
	for _, operation := range []string{"logout", "session_deleted"} {
		t.Run(operation, func(t *testing.T) {
			pool, _ := postgresfixture.NewProductDatabase(t)
			ctx := context.Background()
			store, err := NewStore(pool)
			require.NoError(t, err)
			queries := db.New(pool)

			username := "chatsess_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
			var userID int64
			require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, lower_username, email, lower_email, display_name)
				VALUES ($1, $1, $2, $2, $1) RETURNING id`, username, username+"@example.com").Scan(&userID))

			busContext, stopBus := context.WithCancel(ctx)
			bus := revocation.NewBus(pool, queries)
			require.NoError(t, bus.Start(busContext))
			t.Cleanup(func() { stopBus(); <-bus.Done() })
			publisher := revocation.NewDBPublisher(queries, bus)
			auth := services.NewAuthService(queries, config.AuthConfig{}, nil, nil, services.WithAuthRevocationPublisher(publisher))

			// Two live browser sessions for one user: only the revoked one may lose deliveries.
			newSession := func() (string, string) {
				raw := uuid.NewString()
				sum := sha256.Sum256([]byte(raw))
				stored := hex.EncodeToString(sum[:])
				_, createErr := queries.CreateAuthSession(ctx, db.CreateAuthSessionParams{
					SessionKey: stored, UserID: userID, Username: username, ExpiresAt: time.Now().Add(time.Hour),
				})
				require.NoError(t, createErr)
				return raw, stored
			}
			revokedCookie, revokedStored := newSession()
			liveCookie, _ := newSession()

			dispatcher, err := NewDispatcher(store, failingHost{err: fmt.Errorf("unused")}, 1, time.Minute)
			require.NoError(t, err)
			handler := &Handler{Store: store, Dispatcher: dispatcher, Revocations: bus}
			authRoutes := &routes.AuthHandler{Service: auth}
			router := chi.NewRouter()
			router.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
			router.Use(middleware.RevocationGuard(bus))
			router.Post("/api/auth/logout", authRoutes.PostLogout)
			router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post(TurnPath, handler.Turn)
			router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post(ReplayPath, handler.Replay)
			server := httptest.NewServer(router)
			t.Cleanup(server.Close)

			streamContext, cancelStreams := context.WithTimeout(ctx, 10*time.Second)
			defer cancelStreams()
			withCookie := func(request *http.Request, cookie string) {
				request.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
				request.Header.Set("Content-Type", "application/json")
			}
			scope := Scope{UserID: userID, Owner: username}
			openTurn := func(cookie, label string) *sessionTurnStream {
				runID, journal := label+"-"+uuid.NewString(), testJournal()
				body := turnBody(runID, journal)
				request, requestErr := http.NewRequestWithContext(streamContext, http.MethodPost, server.URL+TurnPath, bytes.NewReader(body))
				require.NoError(t, requestErr)
				withCookie(request, cookie)
				response, callErr := server.Client().Do(request)
				require.NoError(t, callErr)
				t.Cleanup(func() { response.Body.Close() })
				require.Equal(t, http.StatusOK, response.StatusCode)
				reader := bufio.NewReader(response.Body)
				acceptedLine, readErr := reader.ReadBytes('\n')
				require.NoError(t, readErr)
				require.Contains(t, string(acceptedLine), `"type":"accepted"`)
				var turnID string
				require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM chat_turns WHERE user_id=$1 AND run_id=$2 AND leg_id=$3`, userID, runID, journal.LegID).Scan(&turnID))
				grant, claimErr := store.Claim(ctx, scope, turnID, time.Minute)
				require.NoError(t, claimErr)
				require.NoError(t, store.MarkProviderStarted(ctx, grant))
				control := label + "-before-revocation"
				committed, commitErr := store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token,
					Expected: grant.Cursor, Frames: []json.RawMessage{frame(runID, control)}})
				require.NoError(t, commitErr)
				line, readErr := reader.ReadBytes('\n')
				require.NoError(t, readErr)
				require.Contains(t, string(line), control)
				grant.Cursor = committed.Cursor
				replayBody, marshalErr := json.Marshal(replayRequest{RunID: runID, Journal: journal})
				require.NoError(t, marshalErr)
				return &sessionTurnStream{reader: reader, grant: grant, runID: runID, body: replayBody}
			}
			revokedStream := openTurn(revokedCookie, "revoked")
			liveStream := openTurn(liveCookie, "live")

			switch operation {
			case "logout":
				request, requestErr := http.NewRequest(http.MethodPost, server.URL+"/api/auth/logout", nil)
				require.NoError(t, requestErr)
				withCookie(request, revokedCookie)
				response, callErr := server.Client().Do(request)
				require.NoError(t, callErr)
				response.Body.Close()
				require.Equal(t, http.StatusNoContent, response.StatusCode)
			case "session_deleted":
				require.NoError(t, auth.RevokeUserSession(ctx, userID, services.SessionPublicID(revokedStored)))
			}
			require.True(t, bus.IsBrowserSessionRevoked(revokedStored))

			replay := func(stream *sessionTurnStream, cookie string) (int, string) {
				request, requestErr := http.NewRequest(http.MethodPost, server.URL+ReplayPath, bytes.NewReader(stream.body))
				require.NoError(t, requestErr)
				withCookie(request, cookie)
				response, callErr := server.Client().Do(request)
				require.NoError(t, callErr)
				defer response.Body.Close()
				body, readErr := io.ReadAll(response.Body)
				require.NoError(t, readErr)
				return response.StatusCode, string(body)
			}
			status, _ := replay(revokedStream, revokedCookie)
			require.Equal(t, http.StatusUnauthorized, status, "a revoked session cookie must not authenticate a fresh request")

			commitPrivate := func(stream *sessionTurnStream, private string) {
				_, commitErr := store.Commit(ctx, CommitInput{TurnID: stream.grant.TurnID, Generation: stream.grant.Generation, Token: stream.grant.Token,
					Expected: stream.grant.Cursor, Frames: []json.RawMessage{frame(stream.runID, private), done(stream.runID, "stop")}})
				require.NoError(t, commitErr)
			}
			readTail := func(stream *sessionTurnStream) string {
				result := make(chan []byte, 1)
				go func() {
					tail, _ := io.ReadAll(stream.reader)
					result <- tail
				}()
				select {
				case tail := <-result:
					return string(tail)
				case <-time.After(5 * time.Second):
					t.Fatal("accepted stream stayed open")
					return ""
				}
			}
			revokedPrivate := "private-after-" + operation
			commitPrivate(revokedStream, revokedPrivate)
			require.Empty(t, readTail(revokedStream), "the revoked session's stream must emit no later batch or terminal receipt")

			livePrivate := "live-after-" + operation
			commitPrivate(liveStream, livePrivate)
			liveTail := readTail(liveStream)
			require.Contains(t, liveTail, livePrivate, "another session of the same user keeps its live delivery")
			require.Contains(t, liveTail, `"type":"caught-up"`)

			status, body := replay(revokedStream, liveCookie)
			require.Equal(t, http.StatusOK, status, body)
			require.Contains(t, body, revokedPrivate, "revocation must leave the saved result available to a valid session")
		})
	}
}
