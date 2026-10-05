package installbundle

import "fmt"

// Volume flags, as volumeFlags reports a directory's volume.
const (
	// VolumeLocal is a volume on this machine.
	VolumeLocal uint32 = 1 << iota
	// VolumeIgnoresOwnership is a volume whose files all report the
	// accessing user as owner (macOS "ignore ownership").
	VolumeIgnoresOwnership
)

// volumeFlags reports the volume of an open directory; tests replace it
// (export_test.go).
var volumeFlags = platformVolumeFlags

// VolumeTrusted is the trust rule for the volume a protected path is on:
// ownership is meaningful only on a local volume that records it.
func VolumeTrusted(flags uint32, path string) error {
	if flags&VolumeLocal == 0 {
		return fmt.Errorf("%s is not on a local volume", path)
	}
	if flags&VolumeIgnoresOwnership != 0 {
		return fmt.Errorf("%s is on a volume that ignores ownership", path)
	}
	return nil
}
