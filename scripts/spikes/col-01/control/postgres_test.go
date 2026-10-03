package control

import (
	"context"
	"errors"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestControlPostgresFixtureEnforcesServiceAuthorizationAndCleansUp(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	id := uuid.NewString()
	f, err := newFixture(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	dir := f.dir
	t.Cleanup(func() {
		if err := f.close(); err != nil {
			t.Error(err)
		}
	})
	var fsync string
	if err := f.pool.QueryRow(ctx, "SHOW fsync").Scan(&fsync); err != nil || fsync != "on" {
		t.Fatalf("postgres fsync=%q err=%v", fsync, err)
	}
	row, err := db.New(f.pool).GetWorkspaceByRepo(ctx, db.GetWorkspaceByRepoParams{ID: id, RepositoryID: 1})
	if err != nil {
		t.Fatal(err)
	}
	if row.ID != id || row.UserID != 1 || row.Status != "running" {
		t.Fatalf("bad real fixture row: %+v", row)
	}
	svc := services.NewWorkspaceService(db.New(f.pool), services.WithWorkspaceTransactions(f.pool))
	_, err = svc.WriteWorkspaceFile(ctx, id, 1, 2, "file.txt", "refused")
	var apiErr *pkgerrors.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusForbidden {
		t.Fatalf("unshared writer should be refused before runtime: %v", err)
	}
	_, err = svc.WriteWorkspaceFile(ctx, id, 1, 1, "../outside", "refused")
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusBadRequest {
		t.Fatalf("invalid path should be refused: %v", err)
	}
	if err := f.close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("owned postgres state remains: %v", err)
	}
}
