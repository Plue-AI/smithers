//go:build !darwin && !linux

package postgres

import (
	"errors"
	"os"
)

func acquireLock(string) (*os.File, error) {
	return nil, errors.New("packaged postgres lifecycle is supported on macOS and Linux")
}

func lockHeld(string) (bool, error) {
	return false, errors.New("packaged postgres lifecycle is supported on macOS and Linux")
}
