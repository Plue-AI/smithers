package blobsconformance_test

import (
	"bytes"
	"testing"

	"github.com/smithersai/smithers/packages/backend/blobs"
	"github.com/smithersai/smithers/packages/backend/blobs/blobsconformance"
)

func TestFilesystemStoreConformance(t *testing.T) {
	blobsconformance.RunStore(t, func(t *testing.T) blobs.Store {
		store, err := blobs.NewFilesystemStore(blobs.FilesystemConfig{
			Root: t.TempDir(), PublicBaseURL: "https://smithers.test",
			SigningKey: bytes.Repeat([]byte{0x42}, 32),
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := store.Close(); err != nil {
				t.Error(err)
			}
		})
		return store
	})
}
