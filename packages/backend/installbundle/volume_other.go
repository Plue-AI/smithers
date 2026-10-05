//go:build !darwin

package installbundle

// platformVolumeFlags reports every volume as local and recording ownership: the
// installed bundle is darwin-arm64 only, and Linux has no portable flag for
// either property.
func platformVolumeFlags(int) (uint32, error) { return VolumeLocal, nil }
