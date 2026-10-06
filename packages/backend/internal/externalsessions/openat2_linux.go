package externalsessions

import (
	"errors"

	"golang.org/x/sys/unix"
)

// errNoOpenat2 is a kernel without openat2 (before Linux 5.6, or a seccomp
// filter that refuses it); openBeneath then takes openChain.
var errNoOpenat2 = errors.New("openat2 unavailable")

// openat2Beneath opens rel beneath dir in one call: RESOLVE_BENEATH keeps
// every component under dir and RESOLVE_NO_SYMLINKS refuses a link at any
// component with ELOOP.
func openat2Beneath(dir int, rel string) (int, error) {
	fd, err := unix.Openat2(dir, rel, &unix.OpenHow{Flags: uint64(openFlags), Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS})
	if errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EPERM) {
		return -1, errNoOpenat2
	}
	return fd, err
}
