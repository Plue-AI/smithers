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

// Fable round 1, F3: owner TODO admission stays dark because no production
// code supplies the todo flow provider. The joint change that enables it
// (T-FLW-11 with T-FLW-01, T-MCH-14, T-STK-12, T-GH-09, T-SEC-01 and
// T-FLW-03/04) must change this test, so wiring it is never a silent
// convention. The scan covers every non-test Go file of the module; the
// composition's own stack wiring is its positive control.
func TestProductionCompositionLeavesTodoAdmissionDark(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	require.NoError(t, err)
	_, err = os.Stat(filepath.Join(root, "go.mod"))
	require.NoError(t, err, "the scan starts at the module root")
	calls := map[string][]string{}
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
		if !bytes.Contains(body, []byte("SetTodoFlow")) && !bytes.Contains(body, []byte("SetLauncher")) {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, body, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(node ast.Node) bool {
			if call, ok := node.(*ast.CallExpr); ok {
				if selector, ok := call.Fun.(*ast.SelectorExpr); ok {
					relative, _ := filepath.Rel(root, path)
					calls[selector.Sel.Name] = append(calls[selector.Sel.Name], filepath.ToSlash(relative))
				}
			}
			return true
		})
		return nil
	})
	require.NoError(t, err)
	require.Contains(t, calls["SetLauncher"], "packages/backend/internal/compose/main.go", "the scan sees the composition's stack wiring")
	require.Empty(t, calls["SetTodoFlow"], "no production code may open owner TODO admission before the joint change")
}
