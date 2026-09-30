//go:build darwin

package microsandbox

import (
	"encoding/binary"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	// attrCmnExtPrivateSize is ATTR_CMNEXT_PRIVATESIZE: the bytes of a file
	// that no APFS clone shares.
	attrCmnExtPrivateSize = 0x00000008
	// fsOptNoFollow and fsOptAttrCmnExtended are FSOPT_NOFOLLOW and
	// FSOPT_ATTR_CMN_EXTENDED, which selects the extended common attributes.
	fsOptNoFollow        = 0x00000001
	fsOptAttrCmnExtended = 0x00000020
)

type attrList struct {
	bitmapCount   uint16
	reserved      uint16
	commonAttr    uint32
	volumeAttr    uint32
	directoryAttr uint32
	fileAttr      uint32
	commonExtAttr uint32
}

// filePrivateBytes is the part of one file that no clone shares, which is
// what deleting it frees.
func filePrivateBytes(path string) (int64, bool) {
	name, err := unix.BytePtrFromString(path)
	if err != nil {
		return 0, false
	}
	list := attrList{bitmapCount: unix.ATTR_BIT_MAP_COUNT, commonExtAttr: attrCmnExtPrivateSize}
	// The kernel packs the reply: a uint32 length, then the off_t at byte 4.
	var buffer [16]byte
	_, _, errno := unix.Syscall6(unix.SYS_GETATTRLIST, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&list)),
		uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), fsOptNoFollow|fsOptAttrCmnExtended, 0)
	if errno != 0 || binary.NativeEndian.Uint32(buffer[:4]) < 12 {
		return 0, false
	}
	return int64(binary.NativeEndian.Uint64(buffer[4:12])), true
}
