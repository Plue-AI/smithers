package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type workflowArtifactCovBilling struct {
	storageCalls []struct {
		repositoryID int64
		bytes        int64
	}
	storageErr error
}

func (b *workflowArtifactCovBilling) AuthorizePrivateRepo(context.Context, string, int64) error {
	return nil
}

func (b *workflowArtifactCovBilling) AuthorizeWorkflowDispatch(context.Context, int64) error {
	return nil
}

func (b *workflowArtifactCovBilling) AuthorizeAgentRunCommitted(ctx context.Context, _ int64, commit func(context.Context, db.DBTX) error) error {
	return commit(ctx, nil)
}

func (b *workflowArtifactCovBilling) AuthorizeStorageIncrease(_ context.Context, repositoryID int64, additionalBytes int64) error {
	b.storageCalls = append(b.storageCalls, struct {
		repositoryID int64
		bytes        int64
	}{repositoryID: repositoryID, bytes: additionalBytes})
	return b.storageErr
}

func (b *workflowArtifactCovBilling) AuthorizePairing(context.Context, int64) error {
	return nil
}

func TestWorkflowArtifact_Cov_BillingAndConstructorOptions(t *testing.T) {
	ctx := context.Background()

	t.Run("option wires billing and default signed URL expiry", func(t *testing.T) {
		billing := &workflowArtifactCovBilling{}
		svc := NewWorkflowArtifactService(nil, nil, 0, WithWorkflowArtifactBillingPolicy(billing)).(*workflowArtifactService)
		assert.Same(t, billing, svc.billing)
		assert.Equal(t, blob.DefaultSignedURLExpiry, svc.signedURLExpiry)

		var seenExpiry time.Duration
		queries := &mockWorkflowArtifactQuerier{}
		svc = NewWorkflowArtifactService(queries, &mockBlobStore{
			signedUploadURLFn: func(_ context.Context, key string, contentType string, _ int64, expiry time.Duration) (string, error) {
				seenExpiry = expiry
				return "https://upload.example/" + key, nil
			},
		}, 0).(*workflowArtifactService)

		result, err := svc.IssueUploadURL(ctx, workflowArtifactRun(), WorkflowArtifactUploadInput{Name: "logs.txt", Size: 1})
		require.NoError(t, err)
		assert.Equal(t, blob.DefaultSignedURLExpiry, seenExpiry)
		assert.Contains(t, result.UploadURL, "logs.txt")
	})

	t.Run("confirmation does not recharge an admitted reservation", func(t *testing.T) {
		denied := errors.New("storage quota exceeded")
		billing := &workflowArtifactCovBilling{storageErr: denied}
		confirmCalled := false
		queries := &mockWorkflowArtifactQuerier{
			getWorkflowArtifactByNameFn: func(_ context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				return db.WorkflowArtifact{
					ID:            1,
					RepositoryID:  workflowArtifactRun().RepositoryID,
					WorkflowRunID: arg.WorkflowRunID,
					Name:          arg.Name,
					Size:          128,
					Status:        "pending",
					GcsKey:        "key/logs.txt",
				}, nil
			},
			confirmWorkflowArtifactUploadFn: func(context.Context, db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
				confirmCalled = true
				return db.WorkflowArtifact{}, nil
			},
		}
		svc := NewWorkflowArtifactService(queries, &mockBlobStore{
			statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
				return blob.ObjectAttrs{Size: 128}, nil
			},
		}, time.Minute, WithWorkflowArtifactBillingPolicy(billing))

		_, err := svc.ConfirmUpload(ctx, workflowArtifactRun(), "logs.txt", "")
		require.NoError(t, err)
		assert.True(t, confirmCalled)
		assert.Empty(t, billing.storageCalls)
	})
}

func TestWorkflowArtifact_Cov_DownloadURLAndReleaseAttachment(t *testing.T) {
	ctx := context.Background()
	readyArtifact := db.WorkflowArtifact{
		ID:            7,
		RepositoryID:  workflowArtifactRun().RepositoryID,
		WorkflowRunID: workflowArtifactRun().ID,
		Name:          "build.tar.gz",
		Size:          64,
		ContentType:   "application/gzip",
		Status:        "ready",
		GcsKey:        "repos/101/runs/55/artifacts/7/build.tar.gz",
	}
	baseQueries := func(artifact db.WorkflowArtifact) *mockWorkflowArtifactQuerier {
		return &mockWorkflowArtifactQuerier{
			getWorkflowRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
				return workflowArtifactRun(), nil
			},
			getWorkflowArtifactByNameFn: func(_ context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				assert.Equal(t, "build.tar.gz", arg.Name)
				return artifact, nil
			},
		}
	}

	t.Run("returns signed download URL after run and blob checks", func(t *testing.T) {
		var checkedKey, signedKey string
		svc := NewWorkflowArtifactService(baseQueries(readyArtifact), &mockBlobStore{
			existsFn: func(_ context.Context, key string) (bool, error) {
				checkedKey = key
				return true, nil
			},
			signedDownloadURLFn: func(_ context.Context, key string, expiry time.Duration) (string, error) {
				signedKey = key
				assert.Equal(t, time.Minute, expiry)
				return "https://download.example/build", nil
			},
		}, time.Minute)

		result, err := svc.GetDownloadURL(ctx, 101, 55, "build.tar.gz")
		require.NoError(t, err)
		assert.Equal(t, readyArtifact.ID, result.Artifact.ID)
		assert.Equal(t, "https://download.example/build", result.DownloadURL)
		assert.Equal(t, readyArtifact.GcsKey, checkedKey)
		assert.Equal(t, readyArtifact.GcsKey, signedKey)
	})

	t.Run("maps download readiness and blob failures", func(t *testing.T) {
		pending := readyArtifact
		pending.Status = "pending"
		_, err := NewWorkflowArtifactService(baseQueries(pending), &mockBlobStore{}, time.Minute).
			GetDownloadURL(ctx, 101, 55, "build.tar.gz")
		assert.Equal(t, 404, apiStatus(t, err))

		_, err = NewWorkflowArtifactService(baseQueries(readyArtifact), &mockBlobStore{
			existsFn: func(context.Context, string) (bool, error) { return false, nil },
		}, time.Minute).GetDownloadURL(ctx, 101, 55, "build.tar.gz")
		assert.Equal(t, 404, apiStatus(t, err))

		_, err = NewWorkflowArtifactService(baseQueries(readyArtifact), &mockBlobStore{
			existsFn: func(context.Context, string) (bool, error) { return false, errors.New("stat failed") },
		}, time.Minute).GetDownloadURL(ctx, 101, 55, "build.tar.gz")
		assert.Equal(t, 500, apiStatus(t, err))

		_, err = NewWorkflowArtifactService(baseQueries(readyArtifact), &mockBlobStore{
			signedDownloadURLFn: func(context.Context, string, time.Duration) (string, error) {
				return "", errors.New("sign failed")
			},
		}, time.Minute).GetDownloadURL(ctx, 101, 55, "build.tar.gz")
		assert.Equal(t, 500, apiStatus(t, err))
	})

	t.Run("attaches ready artifact with default asset name", func(t *testing.T) {
		var captured db.AttachWorkflowArtifactToReleaseParams
		queries := baseQueries(readyArtifact)
		queries.attachWorkflowArtifactToReleaseFn = func(_ context.Context, arg db.AttachWorkflowArtifactToReleaseParams) (db.WorkflowArtifact, error) {
			captured = arg
			attached := readyArtifact
			attached.ReleaseTag = arg.ReleaseTag
			attached.ReleaseAssetName = arg.ReleaseAssetName
			attached.ReleaseAttachedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
			return attached, nil
		}

		attached, err := NewWorkflowArtifactService(queries, &mockBlobStore{}, time.Minute).
			AttachToRelease(ctx, 101, 55, "build.tar.gz", " v1.0.0 ", "")
		require.NoError(t, err)
		assert.Equal(t, "v1.0.0", captured.ReleaseTag.String)
		assert.True(t, captured.ReleaseTag.Valid)
		assert.Equal(t, "build.tar.gz", captured.ReleaseAssetName.String)
		assert.Equal(t, "v1.0.0", attached.ReleaseTag.String)
	})

	t.Run("maps release attachment validation and query failures", func(t *testing.T) {
		_, err := NewWorkflowArtifactService(baseQueries(readyArtifact), &mockBlobStore{}, time.Minute).
			AttachToRelease(ctx, 101, 55, "build.tar.gz", " ", "")
		assert.Equal(t, 422, apiStatus(t, err))

		pending := readyArtifact
		pending.Status = "pending"
		_, err = NewWorkflowArtifactService(baseQueries(pending), &mockBlobStore{}, time.Minute).
			AttachToRelease(ctx, 101, 55, "build.tar.gz", "v1", "")
		assert.Equal(t, 409, apiStatus(t, err))

		queries := baseQueries(readyArtifact)
		queries.attachWorkflowArtifactToReleaseFn = func(context.Context, db.AttachWorkflowArtifactToReleaseParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{}, pgx.ErrNoRows
		}
		_, err = NewWorkflowArtifactService(queries, &mockBlobStore{}, time.Minute).
			AttachToRelease(ctx, 101, 55, "build.tar.gz", "v1", "")
		assert.Equal(t, 404, apiStatus(t, err))

		queries = baseQueries(readyArtifact)
		queries.attachWorkflowArtifactToReleaseFn = func(context.Context, db.AttachWorkflowArtifactToReleaseParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{}, errors.New("attach failed")
		}
		_, err = NewWorkflowArtifactService(queries, &mockBlobStore{}, time.Minute).
			AttachToRelease(ctx, 101, 55, "build.tar.gz", "v1", "")
		assert.Equal(t, 500, apiStatus(t, err))
	})
}

func TestWorkflowArtifact_Cov_ErrorAndCleanupBranches(t *testing.T) {
	ctx := context.Background()

	t.Run("issue upload validates size and cleans row on signed URL failure", func(t *testing.T) {
		_, err := NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{}, &mockBlobStore{}, time.Minute).
			IssueUploadURL(ctx, workflowArtifactRun(), WorkflowArtifactUploadInput{Name: "bad.bin", Size: -1})
		assert.Equal(t, 422, apiStatus(t, err))

		_, err = NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
			createWorkflowArtifactFn: func(context.Context, db.CreateWorkflowArtifactParams) (db.WorkflowArtifact, error) {
				return db.WorkflowArtifact{}, errors.New("insert failed")
			},
		}, &mockBlobStore{}, time.Minute).IssueUploadURL(ctx, workflowArtifactRun(), WorkflowArtifactUploadInput{Name: "bad.bin", Size: 1})
		assert.Equal(t, 500, apiStatus(t, err))

		deletedID := int64(0)
		var cleared []runtimeports.ClearPurgedStorageDeletionByExactKeyParams
		reserved := false
		queries := &mockWorkflowArtifactQuerier{
			clearPurgedStorageDeletionFn: func(_ context.Context, arg runtimeports.ClearPurgedStorageDeletionByExactKeyParams) (int64, error) {
				cleared = append(cleared, arg)
				return 1, nil
			},
			getWorkflowArtifactByNameFn: func(_ context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				if !reserved {
					return db.WorkflowArtifact{}, pgx.ErrNoRows
				}
				return db.WorkflowArtifact{ID: 1, RepositoryID: 101, WorkflowRunID: arg.WorkflowRunID, Name: arg.Name, Size: 1, ContentType: "application/octet-stream", Status: "pending", GcsKey: "repos/101/runs/55/artifacts/1/bad.bin"}, nil
			},
			createWorkflowArtifactFn: func(_ context.Context, arg db.CreateWorkflowArtifactParams) (db.WorkflowArtifact, error) {
				reserved = true
				return db.WorkflowArtifact{ID: 1, RepositoryID: arg.RepositoryID, WorkflowRunID: arg.WorkflowRunID, Name: arg.Name, Size: arg.Size, ContentType: arg.ContentType, Status: "pending", GcsKey: "repos/101/runs/55/artifacts/1/bad.bin"}, nil
			},
			deleteClaimedWorkflowArtifactFn: func(_ context.Context, arg db.DeleteClaimedWorkflowArtifactParams) (db.WorkflowArtifact, error) {
				deletedID = arg.ID
				return db.WorkflowArtifact{ID: arg.ID}, nil
			},
		}
		_, err = NewWorkflowArtifactService(queries, &mockBlobStore{
			signedUploadURLFn: func(context.Context, string, string, int64, time.Duration) (string, error) {
				return "", errors.New("sign failed")
			},
		}, time.Minute).IssueUploadURL(ctx, workflowArtifactRun(), WorkflowArtifactUploadInput{Name: "bad.bin", Size: 1})
		assert.Equal(t, 500, apiStatus(t, err))
		assert.Equal(t, int64(1), deletedID)
		require.Len(t, cleared, 2)
		for _, call := range cleared {
			assert.Equal(t, int64(101), call.RepositoryID)
			assert.Equal(t, "workflow-artifact:1", call.AllocationKey)
		}
		assert.ElementsMatch(t, []string{
			"repos/101/runs/55/artifacts/1/bad.bin",
			"pending/workflow-artifacts/repos/101/runs/55/artifacts/1/bad.bin",
		}, []string{cleared[0].ObjectKey, cleared[1].ObjectKey})
	})

	t.Run("confirm upload maps blob and confirm failures", func(t *testing.T) {
		makeQueries := func(confirmErr error) *mockWorkflowArtifactQuerier {
			return &mockWorkflowArtifactQuerier{
				getWorkflowArtifactByNameFn: func(_ context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
					return db.WorkflowArtifact{ID: 1, RepositoryID: 101, WorkflowRunID: arg.WorkflowRunID, Name: arg.Name, Size: 64, Status: "pending", GcsKey: "key"}, nil
				},
				confirmWorkflowArtifactUploadFn: func(context.Context, db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error) {
					return db.WorkflowArtifact{}, confirmErr
				},
			}
		}

		_, err := NewWorkflowArtifactService(makeQueries(nil), &mockBlobStore{
			statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
				return blob.ObjectAttrs{}, errors.New("stat failed")
			},
		}, time.Minute).ConfirmUpload(ctx, workflowArtifactRun(), "build.tar.gz", "")
		assert.Equal(t, 500, apiStatus(t, err))

		_, err = NewWorkflowArtifactService(makeQueries(nil), &mockBlobStore{
			statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
				return blob.ObjectAttrs{Size: -2}, nil
			},
		}, time.Minute).ConfirmUpload(ctx, workflowArtifactRun(), "build.tar.gz", "")
		assert.Equal(t, 500, apiStatus(t, err))

		_, err = NewWorkflowArtifactService(makeQueries(pgx.ErrNoRows), &mockBlobStore{
			statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
				return blob.ObjectAttrs{Size: 64}, nil
			},
		}, time.Minute).ConfirmUpload(ctx, workflowArtifactRun(), "build.tar.gz", "")
		assert.Equal(t, 409, apiStatus(t, err))

		_, err = NewWorkflowArtifactService(makeQueries(errors.New("confirm failed")), &mockBlobStore{
			statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
				return blob.ObjectAttrs{Size: 64}, nil
			},
		}, time.Minute).ConfirmUpload(ctx, workflowArtifactRun(), "build.tar.gz", "")
		assert.Equal(t, 500, apiStatus(t, err))
	})

	t.Run("ready artifact confirmation returns before blob checks", func(t *testing.T) {
		statCalled := false
		ready := db.WorkflowArtifact{ID: 1, RepositoryID: 101, WorkflowRunID: 55, Name: "build.tar.gz", Status: "ready", GcsKey: "key"}
		artifact, err := NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
			getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				return ready, nil
			},
		}, &mockBlobStore{
			statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
				statCalled = true
				return blob.ObjectAttrs{}, nil
			},
		}, time.Minute).ConfirmUpload(ctx, workflowArtifactRun(), "build.tar.gz", "")
		require.NoError(t, err)
		assert.Equal(t, ready.ID, artifact.ID)
		assert.False(t, statCalled)
	})

	t.Run("prune uses default batch and surfaces query errors", func(t *testing.T) {
		calls := 0
		pruneRow := db.WorkflowArtifact{ID: 1, RepositoryID: 101, WorkflowRunID: 55, Name: "old", Status: "ready", GcsKey: "old"}
		queries := &mockWorkflowArtifactQuerier{
			listPrunableWorkflowArtifactsFn: func(_ context.Context, arg db.ListPrunableWorkflowArtifactsParams) ([]db.WorkflowArtifact, error) {
				calls++
				require.Equal(t, int32(defaultWorkflowArtifactPruneBatch), arg.LimitRows)
				return []db.WorkflowArtifact{pruneRow}, nil
			},
			getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				return pruneRow, nil
			},
		}
		deleted, err := NewWorkflowArtifactService(queries, &mockBlobStore{}, time.Minute).PruneExpired(ctx, 0)
		require.NoError(t, err)
		assert.Equal(t, 1, deleted)
		assert.Equal(t, 1, calls)

		_, err = NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
			listPrunableWorkflowArtifactsFn: func(context.Context, db.ListPrunableWorkflowArtifactsParams) ([]db.WorkflowArtifact, error) {
				return nil, errors.New("prune failed")
			},
		}, &mockBlobStore{}, time.Minute).PruneExpired(ctx, 10)
		assert.Equal(t, 500, apiStatus(t, err))
	})

	t.Run("private helpers map replacement and run lookup failures", func(t *testing.T) {
		svc := NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
			getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
				return db.WorkflowArtifact{ID: 1, WorkflowRunID: 55, Name: "old", GcsKey: "old-key"}, nil
			},
		}, &mockBlobStore{
			deleteFn: func(context.Context, string) error {
				return errors.New("delete blob failed")
			},
		}, time.Minute).(*workflowArtifactService)
		_, err := svc.deleteWorkflowArtifactReservation(ctx, db.WorkflowArtifact{ID: 1, RepositoryID: 101, WorkflowRunID: 55, Name: "old", Status: "ready", GcsKey: "old-key"})
		assert.Equal(t, 500, apiStatus(t, err))

		svc = NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
			getWorkflowRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
				return db.WorkflowRun{}, errors.New("run lookup failed")
			},
		}, &mockBlobStore{}, time.Minute).(*workflowArtifactService)
		_, err = svc.ListArtifacts(ctx, 101, 55)
		assert.Equal(t, 500, apiStatus(t, err))

		svc = NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
			getWorkflowDefinitionNameByRunIDFn: func(context.Context, int64) (string, error) {
				return "", errors.New("definition lookup failed")
			},
		}, &mockBlobStore{}, time.Minute).(*workflowArtifactService)
		assert.Empty(t, svc.resolveSourceWorkflowName(ctx, 55))
	})
}

func (*workflowArtifactCovBilling) AuthorizeSandboxStart(context.Context, int64) error {
	return nil
}
func (*workflowArtifactCovBilling) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}
