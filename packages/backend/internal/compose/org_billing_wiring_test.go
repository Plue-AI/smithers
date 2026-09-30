package compose

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"

	"github.com/stretchr/testify/require"
)

// The organization cap lives in the billing policy; an OrgService built
// without it admits every create. Pin that the composed service receives the
// same policy as the repository service.
func TestComposedOrgServiceReceivesBillingPolicy(t *testing.T) {
	t.Parallel()

	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	require.NoError(t, err)

	constructors, wired := 0, 0
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || !isServicesCall(call, "NewOrgServiceWithPool") {
			return true
		}
		constructors++
		for _, arg := range call.Args {
			option, ok := arg.(*ast.CallExpr)
			if !ok || !isServicesCall(option, "WithOrgBillingPolicy") || len(option.Args) != 1 {
				continue
			}
			if ident, ok := option.Args[0].(*ast.Ident); ok && ident.Name == "billingPolicy" {
				wired++
			}
		}
		return true
	})
	require.Equal(t, 1, constructors, "main.go should build one OrgService")
	require.Equal(t, 1, wired, "the OrgService must receive services.WithOrgBillingPolicy(billingPolicy)")
}

func isServicesCall(call *ast.CallExpr, name string) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != name {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	return ok && pkg.Name == "services"
}

// smithersai/plue#593: the repo-host client meters every attributed push
// against the same billing policy.
func TestComposedRepoHostClientMetersPushes(t *testing.T) {
	t.Parallel()

	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	require.NoError(t, err)

	wired := 0
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "SetPushMeter" || len(call.Args) != 1 {
			return true
		}
		if receiver, ok := sel.X.(*ast.Ident); !ok || receiver.Name != "repoHostClient" {
			return true
		}
		meter, ok := call.Args[0].(*ast.CallExpr)
		if !ok || !isServicesCall(meter, "NewGitStorageMeter") || len(meter.Args) != 2 {
			return true
		}
		if policy, ok := meter.Args[0].(*ast.Ident); ok && policy.Name == "billingPolicy" {
			wired++
		}
		return true
	})
	require.Equal(t, 1, wired, "main.go must call repoHostClient.SetPushMeter(services.NewGitStorageMeter(billingPolicy, ...))")
}
