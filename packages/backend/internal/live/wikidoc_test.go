package live

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestWikiCancelledFlushCannotPersistNextDirtyPeriod(t *testing.T) {
	// A callback that fired before Stop may wait on the update's mutex. Its
	// generation must be refused before reading or committing the new period.
	oldest := time.Now()
	page := &wikiDocument{oldest: oldest, timerGeneration: 2}
	page.flush(1)
	require.Equal(t, oldest, page.oldest)
	require.Equal(t, uint64(2), page.timerGeneration)
}
