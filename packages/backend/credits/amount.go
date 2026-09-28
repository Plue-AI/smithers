package credits

import (
	"errors"
	"math"
)

// NanosFromCents converts a non-negative cent amount without losing precision
// or overflowing the ledger's int64 nanodollar amounts. Zero is valid.
func NanosFromCents(cents int64) (int64, error) {
	if cents < 0 || cents > math.MaxInt64/NanosPerCent {
		return 0, errors.New("credits: cents cannot be represented as non-negative nanos")
	}
	return cents * NanosPerCent, nil
}
