package app

import (
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestFastGatewayDeploymentComposition(t *testing.T) {
	gateway := &modelproxy.FastGateway{}
	require.Same(t, gateway, (Config{FastGateway: gateway}).options().FastGateway)
	require.Nil(t, (Config{}).options().FastGateway)
}
