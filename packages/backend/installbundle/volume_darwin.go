package installbundle

import "golang.org/x/sys/unix"

// platformVolumeFlags reports the volume of the open directory fd.
func platformVolumeFlags(fd int) (uint32, error) {
	var stat unix.Statfs_t
	if err := unix.Fstatfs(fd, &stat); err != nil {
		return 0, err
	}
	var flags uint32
	if stat.Flags&unix.MNT_LOCAL != 0 {
		flags |= VolumeLocal
	}
	if stat.Flags&unix.MNT_IGNORE_OWNERSHIP != 0 {
		flags |= VolumeIgnoresOwnership
	}
	return flags, nil
}
