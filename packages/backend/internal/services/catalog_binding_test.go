package services

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestOperationPolicyBindingCannotBeReplacedByCaller(t *testing.T) {
	first, ok := OperationPolicy("todo.new")
	require.True(t, ok)
	require.NotNil(t, first.HTTP)
	require.Equal(t, "POST", first.HTTP.Method)
	require.Equal(t, "/api/todos", first.HTTP.Path)
	first.HTTP.Method, first.HTTP.Path = "DELETE", "/api/members"
	second, ok := OperationPolicy("todo.new")
	require.True(t, ok)
	require.Equal(t, "POST", second.HTTP.Method)
	require.Equal(t, "/api/todos", second.HTTP.Path)
}
