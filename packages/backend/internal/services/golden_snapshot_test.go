package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// fakeGoldenRow satisfies pgx.Row for the golden-snapshot SQL fakes.
type fakeGoldenRow struct {
	err  error
	scan func(dest ...any)
}

func (r fakeGoldenRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if r.scan != nil {
		r.scan(dest...)
	}
	return nil
}

type fakeGoldenDB struct {
	readyID        string
	readyCreatedAt time.Time
	claimGranted   bool
	// reclaimStaleID, when set, is returned by the stale-baking reclaim query;
	// reclaimCalledBeforeClaim records whether the reclaim ran before the claim.
	reclaimStaleID           string
	reclaimCalls             int
	claimCalls               int
	reclaimCalledBeforeClaim bool
	finished                 []struct {
		status     string
		snapshotID string
	}
	// finishErr, when set, fails the finishGoldenSnapshotSQL write.
	finishErr error
	// GC (superseded) tracking.
	expiredSuperseded []goldenGCRow // returned by listExpiredSupersededSQL
	supersedeCalls    int           // phase-1 Exec calls
	deletedRowIDs     []string      // phase-2 row deletes
	markedBadIDs      []string      // snapshot ids passed to markBadGoldenSnapshotSQL
}

type goldenGCRow struct {
	id         string
	snapshotID string
}

func (d *fakeGoldenDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	switch sql {
	case supersedeGoldenSnapshotsSQL:
		d.supersedeCalls++
	case deleteGoldenSnapshotRowSQL:
		d.deletedRowIDs = append(d.deletedRowIDs, args[0].(string))
	case markBadGoldenSnapshotSQL:
		d.markedBadIDs = append(d.markedBadIDs, args[1].(string))
	}
	return pgconn.CommandTag{}, nil
}

func (d *fakeGoldenDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	if sql == listExpiredSupersededSQL {
		return &fakeGoldenRows{rows: d.expiredSuperseded}, nil
	}
	return &fakeGoldenRows{}, nil
}

// fakeGoldenRows is a minimal pgx.Rows over a slice of goldenGCRow. Only
// Next/Scan/Close/Err are exercised by gcSupersededSnapshots.
type fakeGoldenRows struct {
	rows []goldenGCRow
	idx  int
}

func (r *fakeGoldenRows) Next() bool {
	if r.idx >= len(r.rows) {
		return false
	}
	r.idx++
	return true
}

func (r *fakeGoldenRows) Scan(dest ...any) error {
	row := r.rows[r.idx-1]
	*(dest[0].(*string)) = row.id
	*(dest[1].(*string)) = row.snapshotID
	return nil
}

func (r *fakeGoldenRows) Close()                                       {}
func (r *fakeGoldenRows) Err() error                                   { return nil }
func (r *fakeGoldenRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeGoldenRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeGoldenRows) Values() ([]any, error)                       { return nil, nil }
func (r *fakeGoldenRows) RawValues() [][]byte                          { return nil }
func (r *fakeGoldenRows) Conn() *pgx.Conn                              { return nil }

func (d *fakeGoldenDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	switch sql {
	case latestReadyGoldenSnapshotSQL:
		if d.readyID == "" {
			return fakeGoldenRow{err: pgx.ErrNoRows}
		}
		return fakeGoldenRow{scan: func(dest ...any) {
			*(dest[0].(*string)) = d.readyID
			*(dest[1].(*time.Time)) = d.readyCreatedAt
		}}
	case reclaimStaleBakingSQL:
		d.reclaimCalls++
		if d.claimCalls == 0 {
			d.reclaimCalledBeforeClaim = true
		}
		if d.reclaimStaleID == "" {
			return fakeGoldenRow{err: pgx.ErrNoRows}
		}
		return fakeGoldenRow{scan: func(dest ...any) { *(dest[0].(*string)) = d.reclaimStaleID }}
	case insertGoldenSnapshotBakingSQL:
		d.claimCalls++
		if !d.claimGranted {
			return fakeGoldenRow{err: pgx.ErrNoRows}
		}
		return fakeGoldenRow{scan: func(dest ...any) { *(dest[0].(*string)) = "row-1" }}
	case finishGoldenSnapshotSQL:
		if d.finishErr != nil {
			return fakeGoldenRow{err: d.finishErr}
		}
		d.finished = append(d.finished, struct {
			status     string
			snapshotID string
		}{args[1].(string), args[2].(string)})
		return fakeGoldenRow{scan: func(dest ...any) { *(dest[0].(*string)) = "row-1" }}
	}
	return fakeGoldenRow{err: pgx.ErrNoRows}
}

type fakeGoldenVMClient struct {
	execAttemptsUntilReady int
	execCalls              int
	snapshotID             string
	deletedVMs             []string
	deletedSnapshots       []string
	deleteSnapshotErr      error
	createdReqs            []sandbox.CreateRequest
}

func (f *fakeGoldenVMClient) DeleteSnapshot(_ context.Context, snapshotID string) error {
	if f.deleteSnapshotErr != nil {
		return f.deleteSnapshotErr
	}
	f.deletedSnapshots = append(f.deletedSnapshots, snapshotID)
	return nil
}

func (f *fakeGoldenVMClient) CreateSandbox(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	f.createdReqs = append(f.createdReqs, req)
	return sandbox.CreateResult{ID: "vm-builder"}, nil
}

func (f *fakeGoldenVMClient) Execute(_ context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
	f.execCalls++
	code := int32(1)
	if f.execCalls >= f.execAttemptsUntilReady {
		code = 0
	}
	return sandbox.ExecResult{StatusCode: &code}, nil
}

func (f *fakeGoldenVMClient) SnapshotSandbox(_ context.Context, _ string, _ sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
	return sandbox.SnapshotResult{SnapshotID: f.snapshotID}, nil
}

func (f *fakeGoldenVMClient) DeleteSandbox(_ context.Context, vmID string) error {
	f.deletedVMs = append(f.deletedVMs, vmID)
	return nil
}

func TestGoldenSnapshotService_RefreshBakesWhenMissing(t *testing.T) {
	t.Parallel()

	db := &fakeGoldenDB{claimGranted: true}
	vm := &fakeGoldenVMClient{execAttemptsUntilReady: 1, snapshotID: "snap-golden-1"}
	svc := NewGoldenSnapshotService(db, vm, func() sandbox.CreateRequest {
		return sandbox.CreateRequest{Workdir: defaultWorkspaceHome}
	})

	svc.refresh(context.Background())

	require.Len(t, db.finished, 1)
	assert.Equal(t, "ready", db.finished[0].status)
	assert.Equal(t, "snap-golden-1", db.finished[0].snapshotID)
	// The builder VM never outlives the bake.
	assert.Equal(t, []string{"vm-builder"}, vm.deletedVMs)
	// The bake boots the exact injected workspace request.
	require.Len(t, vm.createdReqs, 1)
	assert.Equal(t, defaultWorkspaceHome, vm.createdReqs[0].Workdir)
	// The freshly baked id is served without another DB read.
	assert.Equal(t, "snap-golden-1", svc.Current(context.Background()))
}

// A successful bake whose finish write fails must delete the freshly created
// Microsandbox snapshot — the id never reached a durable row, so no later refresh
// or GC pass could ever discover it — and must not cache or GC on top of it.
func TestGoldenSnapshotService_RefreshFinishWriteFailureReapsSnapshot(t *testing.T) {
	t.Parallel()

	db := &fakeGoldenDB{claimGranted: true, finishErr: errors.New("db connection lost")}
	vm := &fakeGoldenVMClient{execAttemptsUntilReady: 1, snapshotID: "snap-orphan"}
	svc := NewGoldenSnapshotService(db, vm, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })

	svc.refresh(context.Background())

	assert.Equal(t, []string{"snap-orphan"}, vm.deletedSnapshots, "the undurable snapshot must be reaped")
	assert.Equal(t, []string{"vm-builder"}, vm.deletedVMs, "the builder VM never outlives the bake")
	assert.Empty(t, svc.Current(context.Background()), "an unpersisted snapshot id must never be cached or announced")
	assert.Zero(t, db.supersedeCalls, "GC must not run without a durable finished row")
}

func TestGoldenSnapshotService_RefreshSkipsWhenFresh(t *testing.T) {
	t.Parallel()

	db := &fakeGoldenDB{readyID: "snap-live", readyCreatedAt: time.Now(), claimGranted: true}
	vm := &fakeGoldenVMClient{execAttemptsUntilReady: 1, snapshotID: "snap-unwanted"}
	svc := NewGoldenSnapshotService(db, vm, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })

	svc.refresh(context.Background())

	assert.Empty(t, db.finished, "a fresh snapshot must not trigger a bake")
	assert.Empty(t, vm.createdReqs)
}

func TestGoldenSnapshotService_RefreshLosesClaimRace(t *testing.T) {
	t.Parallel()

	db := &fakeGoldenDB{claimGranted: false}
	vm := &fakeGoldenVMClient{execAttemptsUntilReady: 1, snapshotID: "snap"}
	svc := NewGoldenSnapshotService(db, vm, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })

	svc.refresh(context.Background())

	assert.Empty(t, vm.createdReqs, "losing the baking-slot race must not create a builder VM")
}

func TestGoldenSnapshotService_RefreshReclaimsStaleBakingBeforeClaim(t *testing.T) {
	t.Parallel()

	// A prior baker died and left a stale 'baking' row; the reclaim frees the
	// slot and must run BEFORE this pod tries to claim it, or the claim can never
	// succeed and every VM falls back to the slow bare-image path forever.
	db := &fakeGoldenDB{claimGranted: true, reclaimStaleID: "wedged-row"}
	vm := &fakeGoldenVMClient{execAttemptsUntilReady: 1, snapshotID: "snap-after-reclaim"}
	svc := NewGoldenSnapshotService(db, vm, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })

	svc.refresh(context.Background())

	assert.Equal(t, 1, db.reclaimCalls, "refresh must attempt to reclaim a stale baking slot")
	assert.True(t, db.reclaimCalledBeforeClaim, "reclaim must run before the baking-slot claim")
	require.Len(t, db.finished, 1)
	assert.Equal(t, "ready", db.finished[0].status)
	assert.Equal(t, "snap-after-reclaim", db.finished[0].snapshotID)
}

// After a successful bake, superseded snapshots that have aged past the cache
// grace window are GC'd: the Microsandbox snapshot is deleted and the row dropped.
func TestGoldenSnapshotService_RefreshGCsSupersededSnapshots(t *testing.T) {
	t.Parallel()

	db := &fakeGoldenDB{
		claimGranted: true,
		expiredSuperseded: []goldenGCRow{
			{id: "old-1", snapshotID: "snap-old-1"},
			{id: "old-2", snapshotID: "snap-old-2"},
		},
	}
	vm := &fakeGoldenVMClient{execAttemptsUntilReady: 1, snapshotID: "snap-new"}
	svc := NewGoldenSnapshotService(db, vm, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })

	svc.refresh(context.Background())

	// The just-baked snapshot is the current one and is never GC'd.
	assert.Equal(t, "snap-new", svc.Current(context.Background()))
	// Phase 1 ran (prior 'ready' rows marked superseded, excluding the newest).
	assert.Equal(t, 1, db.supersedeCalls)
	// Phase 2 deleted the aged Microsandbox snapshots and their rows.
	assert.ElementsMatch(t, []string{"snap-old-1", "snap-old-2"}, vm.deletedSnapshots)
	assert.ElementsMatch(t, []string{"old-1", "old-2"}, db.deletedRowIDs)
}

// A Microsandbox delete failure (non-404) must NOT drop the DB row — the row is
// kept so a later sweep retries, never orphaning the Microsandbox snapshot.
func TestGoldenSnapshotService_GCKeepsRowWhenSnapshotDeleteFails(t *testing.T) {
	t.Parallel()

	db := &fakeGoldenDB{
		claimGranted:      true,
		expiredSuperseded: []goldenGCRow{{id: "old-1", snapshotID: "snap-old-1"}},
	}
	vm := &fakeGoldenVMClient{
		execAttemptsUntilReady: 1,
		snapshotID:             "snap-new",
		deleteSnapshotErr:      errors.New("sandbox 500"),
	}
	svc := NewGoldenSnapshotService(db, vm, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })

	svc.refresh(context.Background())

	assert.Empty(t, db.deletedRowIDs, "row must be retained when its Microsandbox snapshot delete fails")
}

func TestGoldenSnapshotService_CurrentFallsBackToEmpty(t *testing.T) {
	t.Parallel()

	svc := NewGoldenSnapshotService(&fakeGoldenDB{}, &fakeGoldenVMClient{}, nil)
	assert.Equal(t, "", svc.Current(context.Background()))

	var nilSvc *GoldenSnapshotService
	assert.Equal(t, "", nilSvc.Current(context.Background()), "nil service must degrade to the bare image")
}

func TestGoldenSnapshotService_MarkBadSupersedesAndClearsCache(t *testing.T) {
	t.Parallel()

	// sandbox + buildRequest nil so MarkBad does not spawn a re-bake goroutine.
	db := &fakeGoldenDB{readyID: "snap-bad", readyCreatedAt: time.Now()}
	golden := NewGoldenSnapshotService(db, nil, nil)

	// Warm the cache with the (soon-to-be-bad) snapshot.
	require.Equal(t, "snap-bad", golden.Current(context.Background()))

	golden.MarkBad(context.Background(), "snap-bad")
	assert.Equal(t, []string{"snap-bad"}, db.markedBadIDs, "the ready snapshot must be superseded")
	// The in-memory cache was dropped, so Current no longer vends the dead id
	// even before the TTL elapses.
	assert.Equal(t, "", golden.Current(context.Background()), "cache must be cleared after MarkBad")

	// Nil-safe and empty-id no-ops.
	var nilSvc *GoldenSnapshotService
	nilSvc.MarkBad(context.Background(), "x")
	golden.MarkBad(context.Background(), "")
	assert.Equal(t, []string{"snap-bad"}, db.markedBadIDs, "empty id and nil service must not record a mark-bad")
}

func TestWorkspaceService_FreshVMRequestUsesGoldenSnapshot(t *testing.T) {
	t.Parallel()

	db := &fakeGoldenDB{readyID: "snap-golden-2", readyCreatedAt: time.Now()}
	golden := NewGoldenSnapshotService(db, &fakeGoldenVMClient{}, nil)
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceGoldenSnapshots(golden))

	req, err := svc.freshWorkspaceVMRequest(context.Background(), 0, "", "container")
	require.NoError(t, err)
	assert.Equal(t, "snap-golden-2", req.SnapshotID)
	assert.Empty(t, req.Packages, "snapshot boots must not re-run apt post-boot config")

	bare := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	bareReq, err := bare.freshWorkspaceVMRequest(context.Background(), 0, "", "container")
	require.NoError(t, err)
	assert.Empty(t, bareReq.SnapshotID)
	assert.NotEmpty(t, bareReq.Packages, "bare-image boots keep the apt bootstrap")
}
