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
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func TestTurnStreamStopsAfterProductCredentialRevocation(t *testing.T) {
	for _, operation := range []string{"token_deleted", "user_suspended", "scopes_narrowed", "unrevoked"} {
		t.Run(operation, func(t *testing.T) {
			pool, _ := postgresfixture.NewProductDatabase(t)
			ctx := context.Background()
			store, err := NewStore(pool)
			require.NoError(t, err)
			queries := db.New(pool)

			username := "chatrev_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
			var userID int64
			err = pool.QueryRow(ctx, `INSERT INTO users (username, lower_username, email, lower_email, display_name)
				VALUES ($1, $1, $2, $2, $1) RETURNING id`, username, username+"@example.com").Scan(&userID)
			require.NoError(t, err)

			busContext, stopBus := context.WithCancel(ctx)
			bus := revocation.NewBus(pool, queries)
			require.NoError(t, bus.Start(busContext))
			t.Cleanup(func() { stopBus(); <-bus.Done() })
			require.Eventually(t, bus.Positioned, 3*time.Second, 10*time.Millisecond)
			publisher := revocation.NewDBPublisher(queries, bus)
			auth := services.NewAuthService(queries, config.AuthConfig{}, nil, nil, services.WithAuthRevocationPublisher(publisher))
			pat, err := auth.CreateToken(ctx, userID, services.CreateTokenRequest{Name: "chat-stream-revocation", Scopes: []string{string(middleware.ScopeWriteUser)}})
			require.NoError(t, err)
			tokenHash := sha256.Sum256([]byte(pat.Token))
			hash := hex.EncodeToString(tokenHash[:])

			dispatcher, err := NewDispatcher(store, failingHost{err: fmt.Errorf("unused")}, 1, time.Minute)
			require.NoError(t, err)
			handler := &Handler{Store: store, Dispatcher: dispatcher, Revocations: bus}
			router := chi.NewRouter()
			router.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
			router.Use(middleware.RevocationGuard(bus))
			router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post(TurnPath, handler.Turn)
			router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post(ReplayPath, handler.Replay)
			lateEntered, lateRelease := make(chan struct{}), make(chan struct{})
			router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser), func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					close(lateEntered)
					select {
					case <-lateRelease:
						next.ServeHTTP(w, r)
					case <-r.Context().Done():
					}
				})
			}).Post("/test/late-turn", handler.Turn)
			server := httptest.NewServer(router)
			t.Cleanup(server.Close)

			runID, journal := "revoke-"+uuid.NewString(), testJournal()
			body := turnBody(runID, journal)
			streamContext, cancelStream := context.WithTimeout(ctx, 8*time.Second)
			defer cancelStream()
			request, err := http.NewRequestWithContext(streamContext, http.MethodPost, server.URL+TurnPath, bytes.NewReader(body))
			require.NoError(t, err)
			request.Header.Set("Authorization", "token "+pat.Token)
			request.Header.Set("Content-Type", "application/json")
			response, err := server.Client().Do(request)
			require.NoError(t, err)
			defer response.Body.Close()
			require.Equal(t, http.StatusOK, response.StatusCode)
			reader := bufio.NewReader(response.Body)
			acceptedLine, err := reader.ReadBytes('\n')
			require.NoError(t, err)
			var accepted Delivery
			require.NoError(t, json.Unmarshal(acceptedLine, &accepted))
			require.Equal(t, "accepted", accepted.Type)

			scope := Scope{UserID: userID, Owner: username}
			var turnID string
			require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM chat_turns WHERE user_id=$1 AND run_id=$2 AND leg_id=$3`, userID, runID, journal.LegID).Scan(&turnID))
			grant, err := store.Claim(ctx, scope, turnID, time.Minute)
			require.NoError(t, err)
			require.NoError(t, store.MarkProviderStarted(ctx, grant))
			// An unrelated bus event must leave this stream live. Deliver a
			// nonterminal frame before revoking its own principal.
			require.NoError(t, publisher.Publish(ctx, revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: strings.Repeat("f", 64), UserID: userID + 1000}))
			firstCommit, err := store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token,
				Expected: grant.Cursor, Frames: []json.RawMessage{frame(runID, "before-revocation-control")}})
			require.NoError(t, err)
			controlLine, err := reader.ReadBytes('\n')
			require.NoError(t, err)
			require.Contains(t, string(controlLine), "before-revocation-control")
			grant.Cursor = firstCommit.Cursor

			lateResult := make(chan int, 1)
			if operation != "unrevoked" {
				lateBody := turnBody("late-"+uuid.NewString(), testJournal())
				lateRequest, requestErr := http.NewRequestWithContext(streamContext, http.MethodPost, server.URL+"/test/late-turn", bytes.NewReader(lateBody))
				require.NoError(t, requestErr)
				lateRequest.Header.Set("Authorization", "token "+pat.Token)
				lateRequest.Header.Set("Content-Type", "application/json")
				go func() {
					lateResponse, callErr := server.Client().Do(lateRequest)
					if callErr != nil {
						lateResult <- 0
						return
					}
					io.Copy(io.Discard, lateResponse.Body)
					lateResponse.Body.Close()
					lateResult <- lateResponse.StatusCode
				}()
				select {
				case <-lateEntered:
				case <-time.After(5 * time.Second):
					t.Fatal("authorized late request did not reach attachment gate")
				}
			}

			switch operation {
			case "token_deleted":
				require.NoError(t, auth.DeleteToken(ctx, userID, pat.ID))
				require.True(t, bus.IsTokenRevoked(hash))
			case "user_suspended":
				_, err = services.NewAdminUserService(queries).SetSuspended(ctx, username, true)
				require.NoError(t, err)
				require.Eventually(t, func() bool { return bus.IsUserDisabled(userID) }, 3*time.Second, 10*time.Millisecond)
			case "scopes_narrowed":
				require.NoError(t, publisher.Publish(ctx, revocation.Event{Kind: revocation.KindTokenScopesNarrowed, TokenHash: hash, UserID: userID}))
				require.True(t, bus.IsTokenRevoked(hash))
			}
			if operation != "unrevoked" {
				close(lateRelease)
				select {
				case status := <-lateResult:
					require.Equal(t, http.StatusForbidden, status, "a request authenticated before revocation must fail when the stream attaches after it")
				case <-time.After(5 * time.Second):
					t.Fatal("late stream attachment did not finish after revocation")
				}
			}

			replayBody, err := json.Marshal(replayRequest{RunID: runID, Journal: journal})
			require.NoError(t, err)
			fresh, err := http.NewRequest(http.MethodPost, server.URL+ReplayPath, bytes.NewReader(replayBody))
			require.NoError(t, err)
			fresh.Header.Set("Authorization", "token "+pat.Token)
			fresh.Header.Set("Content-Type", "application/json")
			freshResponse, err := server.Client().Do(fresh)
			require.NoError(t, err)
			io.Copy(io.Discard, freshResponse.Body)
			freshResponse.Body.Close()
			if operation == "unrevoked" {
				require.Equal(t, http.StatusOK, freshResponse.StatusCode)
			} else {
				require.Equal(t, http.StatusUnauthorized, freshResponse.StatusCode)
			}

			private := "private-result-committed-after-" + operation
			_, err = store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token,
				Expected: grant.Cursor, Frames: []json.RawMessage{frame(runID, private), done(runID, "stop")}})
			require.NoError(t, err)
			type streamTail struct {
				body []byte
				err  error
			}
			result := make(chan streamTail, 1)
			go func() {
				tail, readErr := io.ReadAll(reader)
				result <- streamTail{body: tail, err: readErr}
			}()
			select {
			case tail := <-result:
				require.NoError(t, tail.err, "stream must end through the server, not request timeout")
				if operation == "unrevoked" {
					require.Contains(t, string(tail.body), private, "live stream must deliver committed frames")
					require.Contains(t, string(tail.body), `"type":"caught-up"`)
				} else {
					require.Empty(t, tail.body, "revoked stream must emit no later batch or terminal receipt")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("accepted stream stayed open after credential revocation")
			}
			if operation != "unrevoked" {
				persisted, replayErr := store.Replay(ctx, ReplayInput{Scope: scope, RunID: runID, Journal: journal})
				require.NoError(t, replayErr)
				require.Len(t, persisted.Batches, 2, "revocation must preserve the durable turn")
				require.Contains(t, string(persisted.Batches[1].Frames[0]), private)
			}
			if operation == "token_deleted" || operation == "scopes_narrowed" {
				reconnectPAT, createErr := auth.CreateToken(ctx, userID, services.CreateTokenRequest{Name: "chat-reconnect", Scopes: []string{string(middleware.ScopeWriteUser)}})
				require.NoError(t, createErr)
				reconnect, requestErr := http.NewRequest(http.MethodPost, server.URL+ReplayPath, bytes.NewReader(replayBody))
				require.NoError(t, requestErr)
				reconnect.Header.Set("Authorization", "token "+reconnectPAT.Token)
				reconnect.Header.Set("Content-Type", "application/json")
				reconnected, callErr := server.Client().Do(reconnect)
				require.NoError(t, callErr)
				defer reconnected.Body.Close()
				reconnectBody, readErr := io.ReadAll(reconnected.Body)
				require.NoError(t, readErr)
				require.Equal(t, http.StatusOK, reconnected.StatusCode, string(reconnectBody))
				require.Contains(t, string(reconnectBody), private, "revocation must leave the journal available to a valid later credential")
			}
		})
	}
}
