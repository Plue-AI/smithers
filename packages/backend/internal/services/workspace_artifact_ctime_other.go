//go:build !linux && !darwin

package services

import "os"

// Without an inode change time a remembered digest cannot be trusted, so
// every start hashes its artifacts.
func workspaceArtifactChangeTime(os.FileInfo) (int64, bool) { return 0, false }
