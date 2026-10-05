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

// The install's composition admits an owner's TODOs and pins each attempt to
// the Active todo flow (spec §11.4.1): compose/main.go calls
// EnableTodoAdmission and SetTodoFlow under the single-owner branch, beside
// the install App's TODO publication.
func TestInstallCompositionAdmitsOwnerTodos(t *testing.T) {
	calls := scanTodoAdmissionCalls(t)
	install := []todoAdmissionCall{{file: "packages/backend/internal/compose/main.go", singleOwner: true}}
	require.Equal(t, install, calls["EnableTodoAdmission"])
	require.Equal(t, install, calls["SetTodoFlow"], "every install TODO runs its pinned todo composition")
}

// Hosted composition (Plue) leaves TODO admission off: no production call
// of EnableTodoAdmission or SetTodoFlow is reachable outside the
// single-owner branch.
func TestHostedCompositionLeavesOwnerTodosOff(t *testing.T) {
	calls := scanTodoAdmissionCalls(t)
	for _, name := range []string{"EnableTodoAdmission", "SetTodoFlow"} {
		for _, call := range calls[name] {
			require.True(t, call.singleOwner, "%s calls %s outside the single-owner composition", call.file, name)
		}
	}
}
