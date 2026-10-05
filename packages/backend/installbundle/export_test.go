package installbundle

// SetVolumeFlags makes every protected walk see flags for each directory.
func SetVolumeFlags(flags uint32) (restore func()) {
	previous := volumeFlags
	volumeFlags = func(int) (uint32, error) { return flags, nil }
	return func() { volumeFlags = previous }
}
