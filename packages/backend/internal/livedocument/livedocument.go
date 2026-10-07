// Package livedocument owns persistent native Yrs handles for the host document
// service. It never claims a disk/database save; the caller owns durability.
// The handles need cgo (native.go); a build without it gets unavailable.go,
// whose Load refuses.
package livedocument

import "errors"

var ErrRefused = errors.New("live document update refused")
var ErrClosed = errors.New("live document closed")

// ErrUnavailable is Load's refusal in a build without cgo (#3753).
var ErrUnavailable = errors.New("live documents need a cgo build")

type Kind uint32

const (
	Code Kind = iota
	Wiki
)
