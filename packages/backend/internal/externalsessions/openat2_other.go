//go:build !linux

package externalsessions

import "errors"

// errNoOpenat2: openat2 is Linux's; openBeneath takes openChain here.
var errNoOpenat2 = errors.New("openat2 unavailable")

func openat2Beneath(int, string) (int, error) { return -1, errNoOpenat2 }
