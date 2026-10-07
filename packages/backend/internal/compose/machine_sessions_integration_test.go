package compose

import (
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestInstallSessionBindingsSurviveLinkReplacement(t *testing.T) {
	f := presenceInstall(t)
	host := newMachineHost(f.pool, repository.NewRemoteClient(nil, "test"))
	boot := [16]byte{1}
	user := machined.SessionUser{Login: "alice", UID: 20001}
	_, err := host.Lookup(t.Context(), f.row.ID, boot, 2)
	require.ErrorIs(t, err, machined.ErrNotReady)
	require.NoError(t, host.Record(t.Context(), f.row.ID, boot, 2, user))
	// Reconstruct the composed host: the old network stream is absent.
	restored := newMachineHost(f.pool, repository.NewRemoteClient(nil, "test"))
	got, err := restored.Lookup(t.Context(), f.row.ID, boot, 2)
	require.NoError(t, err)
	require.Equal(t, user, got)
	_, err = restored.Lookup(t.Context(), f.row.ID, [16]byte{2}, 2)
	require.ErrorIs(t, err, machined.ErrNotReady)
	_, err = restored.Lookup(t.Context(), "11111111-1111-4111-8111-111111111111", boot, 2)
	require.ErrorIs(t, err, machined.ErrNotReady)
	_, err = restored.Lookup(t.Context(), f.row.ID, boot, 4)
	require.ErrorIs(t, err, machined.ErrNotReady)
	require.NoError(t, host.Record(t.Context(), f.row.ID, boot, 2, user))
	require.ErrorIs(t, host.Record(t.Context(), f.row.ID, boot, 2, machined.SessionUser{Login: "mallory", UID: 20002}), machined.ErrUnauthorized)
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE principal_id=$1 AND event_type='branch.session_opened'`, "branch:"+f.row.ID).Scan(&count))
	require.Equal(t, 1, count)
}
