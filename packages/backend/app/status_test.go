package app

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type configCanarySource struct{}

func (*configCanarySource) LatestCanaryRuns(context.Context) ([]services.CanaryRun, error) {
	return nil, nil
}

func TestPublicStatusSourceForwardedToCompose(t *testing.T) {
	source := &configCanarySource{}
	assert.Same(t, source, (Config{CanaryRuns: source}).options().CanaryRuns)
}
