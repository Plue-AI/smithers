package services

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestMythicalItemView_CreatedAt(t *testing.T) {
	t.Parallel()
	created := time.Date(2026, 9, 1, 12, 0, 0, 0, time.FixedZone("x", 3600))
	row := mythicalItemView(db.MythicalItem{State: "queued", CreatedAt: pgtype.Timestamptz{Time: created, Valid: true}})
	require.Equal(t, "2026-09-01T11:00:00Z", row.CreatedAt)
	body, err := json.Marshal(mythicalItemView(db.MythicalItem{State: "queued"}))
	require.NoError(t, err)
	require.NotContains(t, string(body), "createdAt")
}
