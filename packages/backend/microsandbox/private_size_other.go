//go:build !darwin

package microsandbox

// filePrivateBytes reports no clone accounting where the host file system
// offers none; privateBytes then counts allocated blocks.
func filePrivateBytes(int) (int64, bool) { return 0, false }
