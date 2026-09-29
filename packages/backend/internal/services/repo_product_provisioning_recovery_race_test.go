package services

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

// Only the host boundary is recorded: reservations, compensation, locks and
// publication use the real product PostgreSQL schema and production methods.
type recoveryRaceHost struct {
	rolloutProvisioningHost
	calls       []string
	executeErr  error
	publishErr  error
	finalizeErr error
	abortErr    error
}

func (h *recoveryRaceHost) ExecuteStagedProvision(ctx context.Context, s repohost.StagedProvision) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	h.calls = append(h.calls, "execute:"+s.Token)
	return h.executeErr
}
func (h *recoveryRaceHost) PublishStagedProvision(_ context.Context, s repohost.StagedProvision) error {
	h.calls = append(h.calls, "publish:"+s.Token)
	return h.publishErr
}
func (h *recoveryRaceHost) FinalizeStagedProvision(_ context.Context, s repohost.StagedProvision) error {
	h.calls = append(h.calls, "finalize:"+s.Token)
	return h.finalizeErr
}
func (h *recoveryRaceHost) AbortStagedProvision(_ context.Context, s repohost.StagedProvision) error {
	h.calls = append(h.calls, "abort:"+s.Token)
	return h.abortErr
}

type recoveryReadKey struct{}
type recoveryReadPause struct {
	read, resume chan struct{}
	once         sync.Once
}

func (p *recoveryReadPause) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, recoveryReadKey{}, strings.Contains(d.SQL, "FROM public.repository_creation_jobs ORDER BY updated_at LIMIT 100"))
}
func (p *recoveryReadPause) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if pending, _ := ctx.Value(recoveryReadKey{}).(bool); pending {
		p.once.Do(func() {
			close(p.read)
			select {
			case <-p.resume:
			case <-ctx.Done():
			}
		})
	}
}

func recoveryRaceFixture(t *testing.T) (*pgxpool.Pool, *productRepositoryProvisioner, *recoveryRaceHost, productCreationSpec) {
	t.Helper()
	pool := newProductTestPool(t)
	ctx := context.Background()
	var userID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO public.users(username,lower_username) VALUES ('recovery-owner','recovery-owner') RETURNING id`).Scan(&userID))
	host := &recoveryRaceHost{}
	p := &productRepositoryProvisioner{pool: pool, host: host}
	wanted := productCreationSpec{Token: strings.Repeat("a", 64), OperationType: repositoryProvisionInit, ActorID: userID,
		UserID: pgtype.Int8{Int64: userID, Valid: true}, OwnerName: "recovery-owner", Name: "project", LowerName: "project", DefaultBookmark: "main", AutoInit: true}
	var reserved productCreationSpec
	require.NoError(t, p.withNamespaceLock(ctx, wanted, false, func(conn *pgxpool.Conn) error {
		var err error
		reserved, err = p.reserve(ctx, conn, wanted)
		return err
	}))
	return pool, p, host, reserved
}

func TestProductRecoveryPrefetchedReservationAbortedBeforeNamespaceLock(t *testing.T) {
	for _, replacement := range []string{"none", "new-reservation", "same-id-new-token"} {
		t.Run(replacement, func(t *testing.T) {
			pool, p, host, reserved := recoveryRaceFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			pause := &recoveryReadPause{read: make(chan struct{}), resume: make(chan struct{})}
			var release sync.Once
			resume := func() { release.Do(func() { close(pause.resume) }) }
			defer resume()
			cfg := pool.Config()
			cfg.ConnConfig.Tracer = pause
			recoveryPool, err := pgxpool.NewWithConfig(ctx, cfg)
			require.NoError(t, err)
			defer recoveryPool.Close()
			// Release a blocked reader before closing its pool even if an assertion fails.
			defer resume()
			service := &RepoService{productOnly: true, productProvisioning: &productRepositoryProvisioner{pool: recoveryPool, host: host}}
			done := make(chan error, 1)
			go func() { done <- service.ReconcileProductRepositoryCreates(ctx) }()
			select {
			case <-pause.read:
			case <-ctx.Done():
				t.Fatal("pending SELECT never closed:", ctx.Err())
			}
			require.NoError(t, p.withNamespaceLock(ctx, reserved, false, func(conn *pgxpool.Conn) error {
				cause := &repohost.StatusError{StatusCode: 409, Code: "destination_occupied"}
				require.ErrorIs(t, p.abortDefinitiveConflict(ctx, conn, reserved, cause), errRepositoryProvisionConflict)
				var count int
				require.NoError(t, conn.QueryRow(ctx, `SELECT count(*) FROM public.repository_creation_jobs WHERE repository_id=$1`, reserved.RepositoryID).Scan(&count))
				require.Zero(t, count, "successful compensation must delete the actual reservation")
				if replacement != "none" {
					wanted := reserved
					wanted.Token = strings.Repeat("b", 64)
					fresh, err := p.reserve(ctx, conn, wanted)
					if err != nil {
						return err
					}
					require.NotEqual(t, reserved.RepositoryID, fresh.RepositoryID)
					if replacement == "same-id-new-token" {
						_, err = conn.Exec(ctx, `UPDATE public.repository_creation_jobs SET repository_id=$1 WHERE token=$2`, reserved.RepositoryID, wanted.Token)
						return err
					}
				}
				return nil
			}))
			require.Equal(t, []string{"abort:" + reserved.Token}, host.calls)
			resume()
			select {
			case err := <-done:
				require.Equal(t, []string{"abort:" + reserved.Token}, host.calls, "prefetched aborted token must never reach the host")
				require.NoError(t, err)
			case <-ctx.Done():
				t.Fatal("recovery did not finish:", ctx.Err())
			}
			require.Equal(t, []string{"abort:" + reserved.Token}, host.calls, "prefetched aborted token must never reach the host")
			var repositories, jobs int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM public.repositories`).Scan(&repositories))
			require.Zero(t, repositories)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM public.repository_creation_jobs`).Scan(&jobs))
			if replacement == "none" {
				require.Zero(t, jobs)
			} else {
				require.Equal(t, 1, jobs)
			}
		})
	}
}

func TestProductRecoveryCurrentReservationAndFinalizeRetry(t *testing.T) {
	pool, p, host, reserved := recoveryRaceFixture(t)
	ctx := context.Background()
	service := &RepoService{productOnly: true, productProvisioning: p}
	host.finalizeErr = errors.New("lost finalize response")
	require.NoError(t, service.ReconcileProductRepositoryCreates(ctx))
	require.Equal(t, []string{"execute:" + reserved.Token, "publish:" + reserved.Token, "finalize:" + reserved.Token}, host.calls)
	var id int64
	var attempts int
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM public.repositories`).Scan(&id))
	require.Equal(t, reserved.RepositoryID, id)
	require.NoError(t, pool.QueryRow(ctx, `SELECT attempts FROM public.repository_creation_jobs`).Scan(&attempts))
	require.Equal(t, 1, attempts)
	host.finalizeErr = nil
	// A fresh service simulates restart; a published repository needs cleanup only.
	service = &RepoService{productOnly: true, productProvisioning: &productRepositoryProvisioner{pool: pool, host: host}}
	require.NoError(t, service.ReconcileProductRepositoryCreates(ctx))
	require.Equal(t, []string{"execute:" + reserved.Token, "publish:" + reserved.Token, "finalize:" + reserved.Token, "finalize:" + reserved.Token}, host.calls)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM public.repository_creation_jobs`).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, service.ReconcileProductRepositoryCreates(ctx))
	require.Len(t, host.calls, 4)
}

func TestProductRecoveryTransientStageFailureRetainsReservation(t *testing.T) {
	pool, p, host, reserved := recoveryRaceFixture(t)
	ctx := context.Background()
	service := &RepoService{productOnly: true, productProvisioning: p}
	host.executeErr = errors.New("temporary stage failure")
	require.ErrorContains(t, service.ReconcileProductRepositoryCreates(ctx), "temporary stage failure")
	require.Equal(t, []string{"execute:" + reserved.Token}, host.calls)
	var attempts int
	var lastError string
	var token string
	require.NoError(t, pool.QueryRow(ctx, `SELECT token,attempts,last_error FROM public.repository_creation_jobs WHERE repository_id=$1`, reserved.RepositoryID).Scan(&token, &attempts, &lastError))
	require.Equal(t, reserved.Token, token)
	require.Equal(t, 1, attempts)
	require.Contains(t, lastError, "temporary stage failure")
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM public.repositories`).Scan(&count))
	require.Zero(t, count)
	host.executeErr = nil
	require.NoError(t, service.ReconcileProductRepositoryCreates(ctx))
	require.Equal(t, []string{"execute:" + reserved.Token, "execute:" + reserved.Token, "publish:" + reserved.Token, "finalize:" + reserved.Token}, host.calls)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM public.repository_creation_jobs`).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM public.repositories WHERE id=$1`, reserved.RepositoryID).Scan(&count))
	require.Equal(t, 1, count)
}

func TestProductRecoveryCompletedAbortReleasesSurvivingReservation(t *testing.T) {
	pool, p, host, reserved := recoveryRaceFixture(t)
	ctx := context.Background()
	// The host durably completed abort, but the API crashed before deleting its
	// reservation. Leave the real row intact to reproduce that crash window.
	require.NoError(t, p.withNamespaceLock(ctx, reserved, false, func(_ *pgxpool.Conn) error {
		return host.AbortStagedProvision(ctx, reserved.staged())
	}))
	var token string
	require.NoError(t, pool.QueryRow(ctx, `SELECT token FROM public.repository_creation_jobs WHERE repository_id=$1`, reserved.RepositoryID).Scan(&token))
	require.Equal(t, reserved.Token, token)
	host.executeErr = &repohost.StatusError{StatusCode: 409, Code: "provision_completed"}
	// Restart recovery with the old token. Re-abort must confirm the host's
	// terminal action before the surviving reservation can be compensated.
	service := &RepoService{productOnly: true, productProvisioning: &productRepositoryProvisioner{pool: pool, host: host}}
	require.ErrorIs(t, service.ReconcileProductRepositoryCreates(ctx), errRepositoryProvisionConflict)
	require.Equal(t, []string{"abort:" + reserved.Token, "execute:" + reserved.Token, "abort:" + reserved.Token}, host.calls)
	var jobs, repositories int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM public.repository_creation_jobs`).Scan(&jobs))
	require.Zero(t, jobs, "completed abort must release the surviving reservation")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM public.repositories`).Scan(&repositories))
	require.Zero(t, repositories)
	require.NoError(t, service.ReconcileProductRepositoryCreates(ctx))
	require.Len(t, host.calls, 3, "settled abort must never execute or publish again")
}

func TestProductRecoveryFailedAbortRetainsReservationAndRetries(t *testing.T) {
	for _, tc := range []struct {
		name        string
		executeCode string
		abortErr    error
	}{
		{"destination-occupied-abort-unavailable", "destination_occupied", errors.New("host abort unavailable")},
		{"completed-finalize-abort-conflicts", "provision_completed", &repohost.StatusError{StatusCode: 409, Code: "provision_completed", Message: "token was finalized"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool, p, host, reserved := recoveryRaceFixture(t)
			ctx := context.Background()
			host.executeErr = &repohost.StatusError{StatusCode: 409, Code: tc.executeCode}
			host.abortErr = tc.abortErr
			service := &RepoService{productOnly: true, productProvisioning: p}
			for attempt := 1; attempt <= 2; attempt++ {
				require.ErrorIs(t, service.ReconcileProductRepositoryCreates(ctx), tc.abortErr)
				var token, lastError string
				var attempts int
				require.NoError(t, pool.QueryRow(ctx, `SELECT token,attempts,last_error FROM public.repository_creation_jobs WHERE repository_id=$1`, reserved.RepositoryID).Scan(&token, &attempts, &lastError))
				require.Equal(t, reserved.Token, token)
				require.Equal(t, attempt, attempts)
				require.Contains(t, lastError, host.executeErr.Error())
				require.Contains(t, lastError, tc.abortErr.Error())
				var repositories int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM public.repositories`).Scan(&repositories))
				require.Zero(t, repositories)
			}
			require.Equal(t, []string{"execute:" + reserved.Token, "abort:" + reserved.Token, "execute:" + reserved.Token, "abort:" + reserved.Token}, host.calls)
			if tc.executeCode == "destination_occupied" {
				host.abortErr = nil
				// A fresh service must retry the persisted job after the host recovers.
				service = &RepoService{productOnly: true, productProvisioning: &productRepositoryProvisioner{pool: pool, host: host}}
				require.ErrorIs(t, service.ReconcileProductRepositoryCreates(ctx), errRepositoryProvisionConflict)
				require.Equal(t, []string{"execute:" + reserved.Token, "abort:" + reserved.Token, "execute:" + reserved.Token, "abort:" + reserved.Token, "execute:" + reserved.Token, "abort:" + reserved.Token}, host.calls)
				var jobs, repositories int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM public.repository_creation_jobs`).Scan(&jobs))
				require.Zero(t, jobs)
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM public.repositories`).Scan(&repositories))
				require.Zero(t, repositories)
				require.NoError(t, service.ReconcileProductRepositoryCreates(ctx))
				require.Len(t, host.calls, 6)
			}
		})
	}
}

func TestDefinitiveProvisionConflictRequiresHTTP409(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"plain-error", errors.New("provision_completed"), false},
		{"occupied", &repohost.StatusError{StatusCode: 409, Code: "destination_occupied"}, true},
		{"completed", &repohost.StatusError{StatusCode: 409, Code: "provision_completed"}, true},
		{"completed-wrapped", errors.Join(errors.New("execute failed"), &repohost.StatusError{StatusCode: 409, Code: "provision_completed"}), true},
		{"completed-server-error", &repohost.StatusError{StatusCode: 500, Code: "provision_completed"}, false},
		{"completed-success", &repohost.StatusError{StatusCode: 204, Code: "provision_completed"}, false},
		{"occupied-server-error", &repohost.StatusError{StatusCode: 500, Code: "destination_occupied"}, false},
		{"uncoded-conflict", &repohost.StatusError{StatusCode: 409}, false},
		{"unrelated-conflict", &repohost.StatusError{StatusCode: 409, Code: "token_mismatch"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, isDefinitiveProvisionConflict(tc.err))
		})
	}
}

func TestProductRecoveryCompletedPublishCompensatesOrRetainsReservation(t *testing.T) {
	for _, failedAbort := range []bool{false, true} {
		t.Run(map[bool]string{false: "abort-confirmed", true: "abort-failed"}[failedAbort], func(t *testing.T) {
			pool, p, host, reserved := recoveryRaceFixture(t)
			ctx := context.Background()
			host.publishErr = &repohost.StatusError{StatusCode: 409, Code: "provision_completed"}
			if failedAbort {
				host.abortErr = &repohost.StatusError{StatusCode: 409, Code: "provision_completed", Message: "token was finalized"}
			}
			service := &RepoService{productOnly: true, productProvisioning: p}
			for attempt := 1; attempt <= 2; attempt++ {
				err := service.ReconcileProductRepositoryCreates(ctx)
				if failedAbort {
					require.ErrorIs(t, err, host.abortErr)
					var token, lastError string
					var attempts int
					require.NoError(t, pool.QueryRow(ctx, `SELECT token,attempts,last_error FROM public.repository_creation_jobs WHERE repository_id=$1`, reserved.RepositoryID).Scan(&token, &attempts, &lastError))
					require.Equal(t, reserved.Token, token)
					require.Equal(t, attempt, attempts)
					require.Contains(t, lastError, host.publishErr.Error())
					require.Contains(t, lastError, host.abortErr.Error())
				} else {
					if attempt == 1 {
						require.ErrorIs(t, err, errRepositoryProvisionConflict)
					} else {
						require.NoError(t, err)
					}
					var jobs int
					require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM public.repository_creation_jobs`).Scan(&jobs))
					require.Zero(t, jobs)
				}
				var repositories int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM public.repositories`).Scan(&repositories))
				require.Zero(t, repositories, "completed publish must not publish a database repository")
			}
			want := []string{"execute:" + reserved.Token, "publish:" + reserved.Token, "abort:" + reserved.Token}
			if failedAbort {
				want = append(want, want...)
			}
			require.Equal(t, want, host.calls, "compensation must precede release and must never finalize")
		})
	}
}
