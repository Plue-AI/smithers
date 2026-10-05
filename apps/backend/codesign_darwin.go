package main

import (
	"os"
	"syscall"
	"unsafe"
)

// processCodeSigningFlags answers this process's code-signing status as the
// kernel holds it: csops(2) with CS_OPS_STATUS on the process itself.
func processCodeSigningFlags() (uint32, error) {
	const csOpsStatus = 0
	var flags uint32
	if _, _, errno := syscall.Syscall6(syscall.SYS_CSOPS, uintptr(os.Getpid()), csOpsStatus, uintptr(unsafe.Pointer(&flags)), unsafe.Sizeof(flags), 0, 0); errno != 0 {
		return 0, errno
	}
	return flags, nil
}
