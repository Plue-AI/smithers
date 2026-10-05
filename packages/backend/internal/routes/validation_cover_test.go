package routes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestValidation_Cov_RefEdges(t *testing.T) {
	t.Parallel()

	assert.Nil(t, validateRef(""))
	assert.Nil(t, validateRef("feature/main"))
	assert.Equal(t, "ref is too long", validateRef(strings.Repeat("x", maxRefLen+1)).Message)
	assert.Equal(t, "ref contains invalid characters", validateRef("main\x7f").Message)
	assert.Equal(t, "ref contains invalid characters", validateRef("main\nnext").Message)
}
