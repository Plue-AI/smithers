package services

import (
	"context"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type activeVMDelta struct {
	vmType string
	delta  float64
}

type fakeSandboxMetrics struct{ activeVMs []activeVMDelta }

func (m *fakeSandboxMetrics) ObserveSandboxVMCreate(string, string, float64) {}
func (m *fakeSandboxMetrics) ObserveSandboxVMSuspend(float64)                {}
func (m *fakeSandboxMetrics) AddSandboxActiveVMs(vmType string, delta float64) {
	m.activeVMs = append(m.activeVMs, activeVMDelta{vmType: vmType, delta: delta})
}

type orphanReaperQuerier struct {
	rows   []runtimeports.ListOrphanedSandboxInstancesRow
	err    error
	params []runtimeports.ListOrphanedSandboxInstancesParams
}

func (q *orphanReaperQuerier) ListOrphanedSandboxInstances(_ context.Context, arg runtimeports.ListOrphanedSandboxInstancesParams) ([]runtimeports.ListOrphanedSandboxInstancesRow, error) {
	q.params = append(q.params, arg)
	if q.err != nil {
		return nil, q.err
	}
	return q.rows, nil
}

type orphanReaperVM struct {
	deleted  []string
	deleteFn func(string) error
}

func (v *orphanReaperVM) DeleteSandbox(_ context.Context, vmID string) error {
	v.deleted = append(v.deleted, vmID)
	if v.deleteFn != nil {
		return v.deleteFn(vmID)
	}
	return nil
}

func orphanRow(id, kind, resourceID, observed string) runtimeports.ListOrphanedSandboxInstancesRow {
	return runtimeports.ListOrphanedSandboxInstancesRow{
		ID:            id,
		ResourceKind:  pgtype.Text{String: kind, Valid: true},
		ResourceID:    pgtype.Text{String: resourceID, Valid: true},
		ObservedState: observed,
		CreatedAt:     time.Now().UTC().Add(-2 * time.Hour),
	}
}

// The leak this exists for: `DELETE /api/repos/{owner}/{repo}` hard-deletes the
// repository, its workspaces cascade away with it, and the existing sweeps
// iterate those very rows — so the micro-VM survives with its
// worker reservation held, invisible to every other reaper. Two such orphans
// had to be reclaimed by hand through the controller API on 2026-08-06.
func TestSandboxOrphanReaperDiscardsOrphans(t *testing.T) {
	q := &orphanReaperQuerier{rows: []runtimeports.ListOrphanedSandboxInstancesRow{
		orphanRow("msb_running", "workspace", "11111111-1111-1111-1111-111111111111", "running"),
		orphanRow("msb_workspace", "workspace", "22222222-2222-2222-2222-222222222222", "stopped"),
	}}
	vm := &orphanReaperVM{}
	metrics := &fakeSandboxMetrics{}

	discarded := NewSandboxOrphanReaper(q, vm, metrics).Sweep(context.Background())

	assert.Equal(t, 2, discarded)
	assert.Equal(t, []string{"msb_running", "msb_workspace"}, vm.deleted)
	// Only the VM that had reached 'running' was ever counted in the gauge.
	assert.Equal(t, []activeVMDelta{{vmType: "workspace", delta: -1}}, metrics.activeVMs)

	require.Len(t, q.params, 1)
	assert.Zero(t, q.params[0].MinAgeSeconds,
		"a committed repository delete must be reclaimed within one sweep interval")
	assert.Equal(t, int32(sandboxOrphanBatch), q.params[0].MaxRows)
}

// A provider that already reclaimed the VM answers 404. The row is gone either
// way, so that is success, not a reason to retry forever.
func TestSandboxOrphanReaperTreatsAnAlreadyGoneVMAsReclaimed(t *testing.T) {
	q := &orphanReaperQuerier{rows: []runtimeports.ListOrphanedSandboxInstancesRow{
		orphanRow("msb_gone", "workspace", "33333333-3333-3333-3333-333333333333", "running"),
	}}
	vm := &orphanReaperVM{deleteFn: func(string) error {
		return &sandbox.StatusError{StatusCode: 404}
	}}

	assert.Equal(t, 1, NewSandboxOrphanReaper(q, vm, nil).Sweep(context.Background()))
}

// A failing delete must not be counted as reclaimed, and must not stop the rest
// of the batch: one wedged VM cannot block the pool from being cleaned up.
func TestSandboxOrphanReaperKeepsSweepingPastAFailedDelete(t *testing.T) {
	q := &orphanReaperQuerier{rows: []runtimeports.ListOrphanedSandboxInstancesRow{
		orphanRow("msb_wedged", "workspace", "44444444-4444-4444-4444-444444444444", "running"),
		orphanRow("msb_ok", "workspace", "55555555-5555-5555-5555-555555555555", "running"),
	}}
	vm := &orphanReaperVM{deleteFn: func(id string) error {
		if id == "msb_wedged" {
			return &sandbox.StatusError{StatusCode: 500}
		}
		return nil
	}}
	metrics := &fakeSandboxMetrics{}

	assert.Equal(t, 1, NewSandboxOrphanReaper(q, vm, metrics).Sweep(context.Background()))
	assert.Equal(t, []string{"msb_wedged", "msb_ok"}, vm.deleted)
	assert.Equal(t, []activeVMDelta{{vmType: "workspace", delta: -1}}, metrics.activeVMs)
}

func TestSandboxOrphanReaperDegradesWithoutASandboxProvider(t *testing.T) {
	q := &orphanReaperQuerier{rows: []runtimeports.ListOrphanedSandboxInstancesRow{
		orphanRow("msb_running", "workspace", "66666666-6666-6666-6666-666666666666", "running"),
	}}

	assert.Zero(t, NewSandboxOrphanReaper(q, nil, nil).Sweep(context.Background()))
	assert.Empty(t, q.params, "no provider means no sweep at all")
}

func TestSandboxOrphanReaperSurvivesAListFailure(t *testing.T) {
	q := &orphanReaperQuerier{err: assert.AnError}
	vm := &orphanReaperVM{}

	assert.Zero(t, NewSandboxOrphanReaper(q, vm, nil).Sweep(context.Background()))
	assert.Empty(t, vm.deleted)
}
