//go:build !darwin

package hostbackup

type APFSCloner = RefusingCloner

// Non-APFS hosts refuse maintenance before acquiring a freeze.
func CheckAPFSVolume(string) error {
	return &Error{Code: CloneUnavailable, Path: "APFS volume required"}
}
