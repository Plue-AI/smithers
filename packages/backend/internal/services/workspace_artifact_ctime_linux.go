package services

import (
	"os"
	"syscall"
)

// workspaceArtifactChangeTime is the inode change time, which no caller can
// set back: a rewrite that restores size and modification time still moves it.
func workspaceArtifactChangeTime(info os.FileInfo) (int64, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return stat.Ctim.Nano(), true
}
