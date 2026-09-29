package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// retryingCursorLister makes the first cursor read fail transiently, then
// gates the real SQL read. This reproduces a database that becomes available
// after the server has begun assembling its routes.
type retryingCursorLister struct {
	revocation.Lister
	entered chan struct{}
	release chan struct{}
	calls   atomic.Int32
}

type revocationListenReceipt struct {
	listener   net.Listener
	positioned bool
}

type revocationReadyReceipt struct {
	handler    http.Handler
	positioned bool
}

func (l *retryingCursorLister) LatestRevocationEventID(ctx context.Context) (int64, error) {
	if l.calls.Add(1) == 1 {
		return 0, errors.New("temporary cursor read failure")
	}
	if l.calls.Load() == 2 {
		close(l.entered)
	}
	select {
	case <-l.release:
		return l.Lister.LatestRevocationEventID(ctx)
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

func TestRunWaitsForRevocationCursorBeforeAdmittingConsumers(t *testing.T) {
	for _, external := range []bool{false, true} {
		name := "owned listener"
		if external {
			name = "external listener"
		}
		t.Run(name, func(t *testing.T) {
			applyEnv(t, baseRunEnv(t))
			preserveSlog(t)
			stubSSEBroker(t)

			// A second pool stands in for another process deleting credentials.
			writerPool, err := postgresfixture.Open(context.Background(), testDatabaseURL(t), 0)
			require.NoError(t, err)
			t.Cleanup(writerPool.Close)
			writer := db.New(writerPool)
			publisher := revocation.NewDBPublisher(writer, nil)
			userName := "cursor-owned"
			if external {
				userName = "cursor-external"
			}
			user, err := writer.CreateUser(context.Background(), db.CreateUserParams{
				Username: userName, LowerUsername: userName, DisplayName: userName,
			})
			require.NoError(t, err)
			_, err = writerPool.Exec(context.Background(),
				`INSERT INTO self_host_owners (singleton, user_id) VALUES (TRUE, $1)`, user.ID)
			require.NoError(t, err)
			t.Cleanup(func() {
				_, _ = writerPool.Exec(context.Background(),
					`DELETE FROM self_host_owners WHERE user_id = $1`, user.ID)
			})
			makeCredential := func(name string) (string, int64, string) {
				t.Helper()
				secret := sha256.Sum256([]byte(name + ":" + userName))
				plaintext := "smithers_" + hex.EncodeToString(secret[:])[:40]
				sum := sha256.Sum256([]byte(plaintext))
				hash := hex.EncodeToString(sum[:])
				credential, err := writer.CreateAccessToken(context.Background(), db.CreateAccessTokenParams{
					UserID: user.ID, Name: name, TokenHash: hash,
					TokenLastEight: hash[len(hash)-8:], Scopes: "read:user",
					ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
				})
				require.NoError(t, err)
				return plaintext, credential.ID, hash
			}
			oldToken, oldID, _ := makeCredential("deleted_during_startup")
			lateToken, lateID, lateHash := makeCredential("deleted_after_listen")
			auth := services.NewAuthService(writer, config.AuthConfig{}, nil, nil,
				services.WithAuthRevocationPublisher(publisher))

			gate := &retryingCursorLister{entered: make(chan struct{}), release: make(chan struct{})}
			busCh := make(chan *revocation.Bus, 1)
			var busPool *pgxpool.Pool
			var constructed atomic.Pointer[revocation.Bus]
			swapVar(t, &newRevocationBus, func(pool *pgxpool.Pool, lister revocation.Lister) *revocation.Bus {
				gate.Lister = lister
				busPool = pool
				bus := revocation.NewBus(pool, gate)
				constructed.Store(bus)
				busCh <- bus
				return bus
			})

			listened := make(chan revocationListenReceipt, 1)
			ready := make(chan revocationReadyReceipt, 1)
			swapVar(t, &onListen, func(ln net.Listener) {
				listened <- revocationListenReceipt{listener: ln, positioned: constructed.Load().Positioned()}
			})
			ctx, cancel := context.WithCancel(context.Background())
			var releaseOnce sync.Once
			releaseCursor := func() { releaseOnce.Do(func() { close(gate.release) }) }
			logs := &syncBuffer{}
			finished := make(chan error, 1)
			finishedObserved := false
			go func() {
				if external {
					finished <- Start(ctx, nil, io.Discard, logs, func(h http.Handler) {
						ready <- revocationReadyReceipt{handler: h, positioned: constructed.Load().Positioned()}
					})
				} else {
					finished <- run(ctx, nil, io.Discard, logs)
				}
			}()
			defer func() {
				releaseCursor()
				cancel()
				if !finishedObserved {
					select {
					case <-finished:
					case <-time.After(20 * time.Second):
						t.Error("composition did not stop after cancellation")
					}
				}
			}()

			var bus *revocation.Bus
			select {
			case bus = <-busCh:
			case err := <-finished:
				finishedObserved = true
				t.Fatalf("composition stopped before creating bus: %v\n%s", err, logs.String())
			case <-time.After(15 * time.Second):
				t.Fatalf("composition did not create bus\n%s", logs.String())
			}
			select {
			case <-gate.entered:
			case <-time.After(15 * time.Second):
				t.Fatalf("cursor read never retried\n%s", logs.String())
			}
			require.False(t, bus.Positioned())

			require.NoError(t, auth.DeleteToken(context.Background(), user.ID, oldID))
			var remaining int
			require.NoError(t, writerPool.QueryRow(context.Background(),
				"SELECT count(*) FROM access_tokens WHERE id = $1", oldID).Scan(&remaining))
			require.Zero(t, remaining, "credential deletion must commit before readiness")
			// Reaching either callback admits a live consumer while the cursor is
			// still unknown. The old implementation reaches these callbacks here.
			select {
			case <-listened:
				t.Fatal("owned server listened before the revocation cursor was positioned")
			case <-ready:
				t.Fatal("external server became ready before the revocation cursor was positioned")
			case err := <-finished:
				finishedObserved = true
				t.Fatalf("composition exited during transient cursor failure: %v\n%s", err, logs.String())
			case <-time.After(200 * time.Millisecond):
			}

			releaseCursor()
			var servingListener net.Listener
			var servingHandler http.Handler
			select {
			case receipt := <-listened:
				if external {
					t.Fatal("external server unexpectedly opened the owned listener")
				}
				require.True(t, receipt.positioned, "owned listener callback ran before cursor positioning")
				servingListener = receipt.listener
			case receipt := <-ready:
				if !external || receipt.handler == nil {
					t.Fatal("unexpected external readiness callback")
				}
				require.True(t, receipt.positioned, "external ready callback ran before cursor positioning")
				servingHandler = receipt.handler
			case err := <-finished:
				finishedObserved = true
				t.Fatalf("composition stopped before readiness: %v\n%s", err, logs.String())
			case <-time.After(20 * time.Second):
				t.Fatalf("composition did not become ready after cursor read\n%s", logs.String())
			}
			require.True(t, bus.Positioned(), "readiness must follow successful cursor positioning")
			require.True(t, listenerHoldsConnection(capturedRevocationBus{bus: bus, pool: busPool}, 10*time.Second),
				"revocation listener did not hold its connection")
			require.Eventually(t, func() bool {
				var count int
				err := writerPool.QueryRow(context.Background(), `
					SELECT count(*) FROM pg_stat_activity
					WHERE datname = current_database() AND query = 'LISTEN revocations' AND state = 'idle'
				`).Scan(&count)
				return err == nil && count > 0
			}, 10*time.Second, 25*time.Millisecond, "revocation bus did not establish PostgreSQL LISTEN")
			requestStatus := func(token string) int {
				t.Helper()
				request := httptest.NewRequest(http.MethodGet, "/api/user", nil)
				request.Header.Set("Authorization", "Bearer "+token)
				if external {
					recorder := httptest.NewRecorder()
					servingHandler.ServeHTTP(recorder, request)
					return recorder.Code
				}
				request.URL.Scheme = "http"
				request.URL.Host = servingListener.Addr().String()
				request.RequestURI = ""
				response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
				require.NoError(t, err)
				defer response.Body.Close()
				return response.StatusCode
			}
			require.Equal(t, http.StatusUnauthorized, requestStatus(oldToken), "deleted credential was admitted after readiness")
			require.Equal(t, http.StatusOK, requestStatus(lateToken), "a valid credential must reach /api/user")

			// The startup deletion is history for this process. An event from
			// another process after LISTEN must still reach its live watchers.
			watchCtx, stopWatch := context.WithCancel(ctx)
			defer stopWatch()
			watch := bus.Watch(watchCtx, revocation.Principal{TokenHash: lateHash})
			require.NoError(t, auth.DeleteToken(context.Background(), user.ID, lateID))
			select {
			case event := <-watch:
				require.Equal(t, lateHash, event.TokenHash)
			case <-time.After(10 * time.Second):
				t.Fatal("event published after readiness did not reach a live watcher")
			}
			require.Equal(t, http.StatusUnauthorized, requestStatus(lateToken), "deleted late credential was admitted")
		})
	}
}

func TestRunCancellationDuringRevocationCursorReadNeverListens(t *testing.T) {
	applyEnv(t, baseRunEnv(t))
	preserveSlog(t)
	stubSSEBroker(t)
	gate := &retryingCursorLister{entered: make(chan struct{}), release: make(chan struct{})}
	swapVar(t, &newRevocationBus, func(pool *pgxpool.Pool, lister revocation.Lister) *revocation.Bus {
		gate.Lister = lister
		return revocation.NewBus(pool, gate)
	})
	listened := make(chan net.Listener, 1)
	swapVar(t, &onListen, func(ln net.Listener) { listened <- ln })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	logs := &syncBuffer{}
	finished := make(chan error, 1)
	go func() { finished <- run(ctx, nil, io.Discard, logs) }()
	select {
	case <-gate.entered:
	case err := <-finished:
		t.Fatalf("composition stopped before retrying cursor read: %v\n%s", err, logs.String())
	case <-time.After(15 * time.Second):
		t.Fatalf("cursor read never retried\n%s", logs.String())
	}
	cancel()
	select {
	case <-listened:
		t.Fatal("composition listened while its initial cursor read was blocked")
	case err := <-finished:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(10 * time.Second):
		t.Fatalf("cancellation did not terminate startup\n%s", logs.String())
	}
	select {
	case <-listened:
		t.Fatal("composition listened after cancellation")
	default:
	}
}
