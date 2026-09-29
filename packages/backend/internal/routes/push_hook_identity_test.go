package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A durable callback can arrive after the original repository is deleted and
// its former owner/name belongs to a new repository. The stable ID must win.
func TestPostPushEvent_RecreatedRepositoryDoesNotInheritOldPush(t *testing.T) {
	store := &memPushEvents{}
	var nameLookups int
	resolver := &mockPushHookRepoResolver{
		getRepoFn: func(_ context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
			nameLookups++
			require.Equal(t, "alice", arg.Owner)
			require.Equal(t, "demo", arg.Name)
			return db.GetRepoByOwnerAndNameRow{ID: 2, Name: "demo"}, nil
		},
		getRepoOwnerSlugAndNameByIDFn: func(_ context.Context, id int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
			require.Equal(t, int64(1), id)
			return db.GetRepoOwnerSlugAndNameByIDRow{}, pgx.ErrNoRows
		},
	}
	h := &InternalPushHookHandler{RepoResolver: resolver, Events: store}
	res := postPushEvent(h, `{"delivery_id":"old-push","repository_id":1,"owner":"alice","repo":"demo","ref_name":"refs/heads/main","commit_sha":"abc"}`)

	require.Equal(t, http.StatusNotFound, res.Code)
	var body struct {
		Code string `json:"code"`
	}
	require.NoError(t, json.Unmarshal(res.Body.Bytes(), &body))
	require.Equal(t, "not_found", body.Code)
	require.Zero(t, nameLookups, "ID-bearing callback must not resolve a reused name")
	require.Empty(t, store.snapshot(), "an old push must never be stored under repository 2")
}

func TestPostPushEvent_StableRepositoryIdentity(t *testing.T) {
	for _, tc := range []struct {
		name, payload, currentOwner, currentName, wantOwner, wantName string
	}{
		{"unchanged", `{"delivery_id":"same","repository_id":1,"owner":"alice","repo":"demo"}`, "alice", "demo", "alice", "demo"},
		{"transferred_and_renamed", `{"delivery_id":"moved","repository_id":1,"owner":"alice","repo":"demo"}`, "bob", "renamed", "bob", "renamed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &memPushEvents{}
			resolver := &mockPushHookRepoResolver{
				getRepoFn: func(_ context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
					t.Fatalf("ID-bearing callback must not resolve old coordinates %s/%s", arg.Owner, arg.Name)
					return db.GetRepoByOwnerAndNameRow{}, nil
				},
				getRepoOwnerSlugAndNameByIDFn: func(_ context.Context, id int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
					require.Equal(t, int64(1), id)
					return db.GetRepoOwnerSlugAndNameByIDRow{OwnerSlug: tc.currentOwner, RepoName: tc.currentName}, nil
				},
			}
			h := &InternalPushHookHandler{RepoResolver: resolver, Events: store}
			res := postPushEvent(h, tc.payload)
			require.Equal(t, http.StatusNoContent, res.Code)
			rows := store.snapshot()
			require.Len(t, rows, 1)
			require.Equal(t, int64(1), rows[0].RepositoryID)
			require.Equal(t, tc.wantOwner, rows[0].Owner)
			require.Equal(t, tc.wantName, rows[0].Repo)
		})
	}
}

func TestPostPushEvent_IdentityLookupErrorDoesNotRecord(t *testing.T) {
	store := &memPushEvents{}
	resolver := &mockPushHookRepoResolver{
		getRepoOwnerSlugAndNameByIDFn: func(_ context.Context, id int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
			require.Equal(t, int64(1), id)
			return db.GetRepoOwnerSlugAndNameByIDRow{}, errors.New("database unavailable")
		},
	}
	h := &InternalPushHookHandler{RepoResolver: resolver, Events: store}
	res := postPushEvent(h, `{"delivery_id":"retry","repository_id":1,"owner":"alice","repo":"demo"}`)
	require.Equal(t, http.StatusInternalServerError, res.Code)
	require.Empty(t, store.snapshot())
}

func TestPostPushEvent_DeletedRepositoryDoesNotRecord(t *testing.T) {
	store := &memPushEvents{}
	resolver := &mockPushHookRepoResolver{
		getRepoOwnerSlugAndNameByIDFn: func(_ context.Context, id int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
			require.Equal(t, int64(1), id)
			return db.GetRepoOwnerSlugAndNameByIDRow{}, pgx.ErrNoRows
		},
	}
	h := &InternalPushHookHandler{RepoResolver: resolver, Events: store}
	res := postPushEvent(h, `{"delivery_id":"deleted","repository_id":1,"owner":"alice","repo":"demo"}`)
	require.Equal(t, http.StatusNotFound, res.Code)
	require.Empty(t, store.snapshot())
}

func TestPostPushEvent_NegativeRepositoryIDIsInvalid(t *testing.T) {
	store := &memPushEvents{}
	resolver := &mockPushHookRepoResolver{
		getRepoFn: func(_ context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
			t.Fatalf("negative ID must not use name lookup: %s/%s", arg.Owner, arg.Name)
			return db.GetRepoByOwnerAndNameRow{}, nil
		},
		getRepoOwnerSlugAndNameByIDFn: func(_ context.Context, id int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
			t.Fatalf("negative ID must not use ID lookup: %d", id)
			return db.GetRepoOwnerSlugAndNameByIDRow{}, nil
		},
	}
	h := &InternalPushHookHandler{RepoResolver: resolver, Events: store}
	res := postPushEvent(h, `{"delivery_id":"invalid","repository_id":-1,"owner":"alice","repo":"demo"}`)
	require.Equal(t, http.StatusBadRequest, res.Code)
	require.Empty(t, store.snapshot())
}

func TestPostPushEvent_LegacyWithoutIDRequiresReconciliation(t *testing.T) {
	store := &memPushEvents{}
	resolver := &mockPushHookRepoResolver{
		getRepoFn: func(_ context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
			t.Fatalf("ID-less callback must not use name lookup: %s/%s", arg.Owner, arg.Name)
			return db.GetRepoByOwnerAndNameRow{}, nil
		},
		getRepoOwnerSlugAndNameByIDFn: func(_ context.Context, id int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
			t.Fatalf("legacy callback must not use ID lookup: %d", id)
			return db.GetRepoOwnerSlugAndNameByIDRow{}, nil
		},
	}
	h := &InternalPushHookHandler{RepoResolver: resolver, Events: store}
	res := postPushEvent(h, `{"delivery_id":"legacy","owner":"alice","repo":"demo"}`)
	require.Equal(t, http.StatusConflict, res.Code)
	var body struct {
		Code string `json:"code"`
	}
	require.NoError(t, json.Unmarshal(res.Body.Bytes(), &body))
	require.NotEmpty(t, body.Code)
	require.Empty(t, store.snapshot())
}
