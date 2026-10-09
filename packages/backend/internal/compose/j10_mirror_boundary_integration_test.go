package compose

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A frozen stack deliberately retains its fold checkpoint while the ordinary
// GitHub sync updates mirrored main. The journey must observe that actual
// bookmark through the person-facing API, rather than the stale checkpoint.
func TestJ10MirrorBeforeStackFold(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J10_REHEARSAL", "C-J10", "mirror-before-fold-")
	if !r.setupSource() || !r.setupMachine() {
		return
	}
	require.NoError(t, r.waitStackActive())
	before, err := r.landedMain()
	require.NoError(t, err)
	_, err = r.pool.Exec(r.ctx, `UPDATE mythical_stacks SET state='frozen'`)
	require.NoError(t, err)
	main, err := r.pushMain("MIRROR.md", "Person's new main\n", "Move main before fold")
	require.NoError(t, err)
	require.NotEqual(t, before, main)
	_, err = r.expect("POST", "/api/github/sync", "", 202)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		observed, err := r.mirroredMain()
		return err == nil && observed == main
	}, 30*time.Second, 100*time.Millisecond)
	folded, err := r.landedMain()
	require.NoError(t, err)
	require.Equal(t, before, folded, "the mirror reader must not depend on a completed stack fold")
}
