package compose

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// todoAdmissionCall is one production call of a MythicalService admission
// setter: the file and whether it sits under `if config.IsSingleOwner(...)`.
type todoAdmissionCall struct {
	file        string
	singleOwner bool
}

// scanTodoAdmissionCalls parses every non-test Go file of the module that
// names one of the setters and records each call by selector name.
func scanTodoAdmissionCalls(t *testing.T) map[string][]todoAdmissionCall {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	require.NoError(t, err)
	_, err = os.Stat(filepath.Join(root, "go.mod"))
	require.NoError(t, err, "the scan starts at the module root")
	names := []string{"EnableTodoAdmission", "SetTodoFlow", "SetLauncher"}
	calls := map[string][]todoAdmissionCall{}
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			switch entry.Name() {
			case "node_modules", ".git", "testdata", "vendor", ".artifacts":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		named := false
		for _, name := range names {
			named = named || bytes.Contains(body, []byte(name))
		}
		if !named {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, body, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(root, path)
		var guards []bool
		var visit func(node ast.Node) bool
		visit = func(node ast.Node) bool {
			switch n := node.(type) {
			case *ast.IfStmt:
				if n.Init != nil {
					ast.Inspect(n.Init, visit)
				}
				ast.Inspect(n.Cond, visit)
				guards = append(guards, isSingleOwnerCondition(n.Cond))
				ast.Inspect(n.Body, visit)
				guards = guards[:len(guards)-1]
				if n.Else != nil {
					// The else branch is the other topology.
					guards = append(guards, false)
					ast.Inspect(n.Else, visit)
					guards = guards[:len(guards)-1]
				}
				return false
			case *ast.CallExpr:
				if selector, ok := n.Fun.(*ast.SelectorExpr); ok {
					guarded := false
					for _, guard := range guards {
						guarded = guarded || guard
					}
					calls[selector.Sel.Name] = append(calls[selector.Sel.Name], todoAdmissionCall{file: filepath.ToSlash(relative), singleOwner: guarded})
				}
			}
			return true
		}
		ast.Inspect(file, visit)
		return nil
	})
	require.NoError(t, err)
	require.NotEmpty(t, calls["SetLauncher"], "the scan sees the composition's stack wiring")
	return calls
}

func isSingleOwnerCondition(condition ast.Expr) bool {
	call, ok := condition.(*ast.CallExpr)
	if !ok {
		return false
	}
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	pkg, ok := selector.X.(*ast.Ident)
	return ok && pkg.Name == "config" && selector.Sel.Name == "IsSingleOwner"
}

// The install's composition admits an owner's TODOs into the existing coding
// path: compose/main.go calls EnableTodoAdmission under the single-owner
// branch, beside the install App's TODO publication.
func TestInstallCompositionAdmitsOwnerTodos(t *testing.T) {
	calls := scanTodoAdmissionCalls(t)
	require.Equal(t, []todoAdmissionCall{{file: "packages/backend/internal/compose/main.go", singleOwner: true}}, calls["EnableTodoAdmission"])
}

// Hosted composition (Plue) leaves TODO admission off: no production call
// of EnableTodoAdmission is reachable outside the single-owner branch. The
// pinned todo composition stays the unreached destination: nothing in
// production supplies its flow digest (SetTodoFlow) until pinned-source
// loading (T-FLW-03/04) and stopping a machine whose host ignores a cancel
// exist (flowdispatch refusePin).
func TestHostedCompositionLeavesOwnerTodosOff(t *testing.T) {
	calls := scanTodoAdmissionCalls(t)
	for _, call := range calls["EnableTodoAdmission"] {
		require.True(t, call.singleOwner, "%s admits owner TODOs outside the single-owner composition", call.file)
	}
	require.Empty(t, calls["SetTodoFlow"], "no production code pins TODO attempts to the todo composition yet")
}
