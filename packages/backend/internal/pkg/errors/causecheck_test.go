package errors

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// causecheck is the guard that keeps a 500 debuggable.
//
// A service that fails on a driver, sandbox, git or crypto call and answers
//
//	if err != nil {
//		return pkgerrors.Internal("failed to set secret")
//	}
//
// hands the operator a log line with a sentence and no reason: the SQLSTATE,
// the refused dial, the expired key are gone. writeRouteError logs Cause(), so
// the fix at every such site is one call:
//
//	return pkgerrors.Internal("failed to set secret").WithCause(err)
//
// This test parses non-test .go files in the module outside archived reviews
// and fails on an Internal("literal") that sits directly in the body of
// `if <err> != nil`
// without attaching <err>.
//
// SCOPE, and why it is drawn here:
//
//   - Only a string-literal message. Internal("...: "+err.Error()) already
//     carries the text; moving those to WithCause is separate work because it
//     changes Error() and the tests that read it.
//   - Only an error-named condition: err, e, ee, or a name ending in err/Err.
//     `if r := recover(); r != nil` holds a panic value, not an error, and those
//     sites log the panic themselves. `if s.q == nil` guards have no cause.
//   - Only the nearest enclosing if, and only its body. In an else branch the
//     error is nil; under an inner `if errors.Is(err, x)` the site is a
//     classified answer, not a dropped failure.
type causecheckFinding struct {
	pos    string
	ident  string
	reason string
}

func TestInternalErrorsAttachTheErrorTheyStandOn(t *testing.T) {
	root := errcodecheckModuleRoot(t)
	fset := token.NewFileSet()
	var findings []causecheckFinding
	inspected := 0

	require.NoError(t, filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			// Review captures are historical evidence, not product Go sources.
			if path == filepath.Join(root, "docs", "reviews") {
				return fs.SkipDir
			}
			switch entry.Name() {
			case ".git", ".jj", "node_modules", "vendor", "testdata", "zig-out", ".zig-cache", "target":
				return fs.SkipDir
			}
			if path != root {
				if _, statErr := os.Stat(filepath.Join(path, "go.mod")); statErr == nil {
					return fs.SkipDir
				}
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, parseErr := parser.ParseFile(fset, path, nil, 0)
		if parseErr != nil {
			return nil
		}
		fileFindings, fileInspected := causecheckFile(fset, file)
		inspected += fileInspected
		for _, finding := range fileFindings {
			finding.pos = strings.TrimPrefix(finding.pos, root+string(os.PathSeparator))
			findings = append(findings, finding)
		}
		return nil
	}))

	// A guard that inspects nothing passes forever. The module holds over a
	// thousand of these sites; if the count collapses, the walk stopped seeing
	// them (the package moved, the alias convention changed).
	require.Greater(t, inspected, 500,
		"causecheck inspected only %d Internal(literal) sites under `if err != nil`; "+
			"it is no longer reading the code it claims to guard", inspected)

	sort.Slice(findings, func(i, j int) bool { return findings[i].pos < findings[j].pos })
	for _, finding := range findings {
		t.Errorf("%s: %s", finding.pos, finding.reason)
	}
}

func TestCausecheckFlagsOnlyTheDroppedCause(t *testing.T) {
	const src = `package demo

import pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"

func dropped() error {
	if err := run(); err != nil {
		return pkgerrors.Internal("failed to run")
	}
	return nil
}

func kept() error {
	if createErr := run(); createErr != nil {
		return pkgerrors.Internal("failed to run").WithCause(createErr)
	}
	return nil
}

func attachedTheWrongOne(other error) error {
	if err := run(); err != nil {
		return pkgerrors.Internal("failed to run").WithCause(other)
	}
	return nil
}

func conjunct() error {
	if err := run(); err != nil && !isGone(err) {
		return pkgerrors.Internal("failed to run")
	}
	return nil
}

func unconfigured(s *svc) error {
	if s.q == nil {
		return pkgerrors.Internal("not configured")
	}
	return nil
}

func elseBranch() error {
	if err := run(); err != nil {
		return err
	} else {
		return pkgerrors.Internal("impossible")
	}
}

func classified() error {
	if err := run(); err != nil {
		if isGone(err) {
			return pkgerrors.Internal("gone")
		}
		return pkgerrors.Internal("failed").WithCause(err)
	}
	return nil
}

func panicked() (out error) {
	defer func() {
		if r := recover(); r != nil {
			out = pkgerrors.Internal("panicked")
		}
	}()
	return nil
}
`
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "demo.go", src, 0)
	require.NoError(t, err)

	findings, inspected := causecheckFile(fset, file)

	var lines []string
	for _, finding := range findings {
		lines = append(lines, finding.ident+"@"+finding.pos)
	}
	require.Equal(t, []string{"err@demo.go:7:10", "err@demo.go:21:10", "err@demo.go:28:10"}, lines)
	// dropped, kept, wrong one, conjunct, and the attached site in classified.
	require.Equal(t, 5, inspected)
}

// causecheckFile returns the dropped-cause findings in one file and how many
// Internal(literal)-under-`if err != nil` sites it looked at.
func causecheckFile(fset *token.FileSet, file *ast.File) ([]causecheckFinding, int) {
	aliases := errcodecheckAliases(file)
	if len(aliases) == 0 {
		return nil, 0
	}
	var findings []causecheckFinding
	inspected := 0
	var stack []ast.Node
	ast.Inspect(file, func(node ast.Node) bool {
		if node == nil {
			stack = stack[:len(stack)-1]
			return true
		}
		stack = append(stack, node)
		call, ok := node.(*ast.CallExpr)
		if !ok || !causecheckIsInternalLiteral(call, aliases) {
			return true
		}
		ident := causecheckEnclosingErr(stack, call)
		if ident == "" {
			return true
		}
		inspected++
		if attached := causecheckAttached(stack, call); attached == ident {
			return true
		}
		findings = append(findings, causecheckFinding{
			pos:   fset.Position(call.Pos()).String(),
			ident: ident,
			reason: "drops the error it is standing on (" + ident + "); attach it: " +
				"errors.Internal(msg).WithCause(" + ident + ")",
		})
		return true
	})
	return findings, inspected
}

func causecheckIsInternalLiteral(call *ast.CallExpr, aliases map[string]bool) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Internal" || len(call.Args) != 1 {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	if !ok || !aliases[pkg.Name] {
		return false
	}
	lit, ok := call.Args[0].(*ast.BasicLit)
	return ok && lit.Kind == token.STRING
}

// causecheckEnclosingErr returns the error name of the nearest enclosing
// `if <name> != nil` when call sits in that if's body, or "".
func causecheckEnclosingErr(stack []ast.Node, call *ast.CallExpr) string {
	for i := len(stack) - 2; i >= 0; i-- {
		ifStmt, ok := stack[i].(*ast.IfStmt)
		if !ok {
			continue
		}
		if call.Pos() < ifStmt.Body.Pos() || call.End() > ifStmt.Body.End() {
			return ""
		}
		return causecheckNilCheckedErr(ifStmt.Cond)
	}
	return ""
}

func causecheckNilCheckedErr(cond ast.Expr) string {
	bin, ok := cond.(*ast.BinaryExpr)
	if !ok {
		return ""
	}
	if bin.Op == token.LAND {
		if name := causecheckNilCheckedErr(bin.X); name != "" {
			return name
		}
		return causecheckNilCheckedErr(bin.Y)
	}
	if bin.Op != token.NEQ {
		return ""
	}
	id, ok := bin.X.(*ast.Ident)
	if !ok {
		return ""
	}
	if y, ok := bin.Y.(*ast.Ident); !ok || y.Name != "nil" {
		return ""
	}
	if !causecheckErrorName(id.Name) {
		return ""
	}
	return id.Name
}

func causecheckErrorName(name string) bool {
	return name == "e" || name == "ee" || strings.HasSuffix(strings.ToLower(name), "err")
}

// causecheckAttached returns the identifier passed to .WithCause when call is
// its receiver, or "".
func causecheckAttached(stack []ast.Node, call *ast.CallExpr) string {
	if len(stack) < 3 {
		return ""
	}
	sel, ok := stack[len(stack)-2].(*ast.SelectorExpr)
	if !ok || sel.X != call || sel.Sel.Name != "WithCause" {
		return ""
	}
	outer, ok := stack[len(stack)-3].(*ast.CallExpr)
	if !ok || outer.Fun != sel || len(outer.Args) != 1 {
		return ""
	}
	id, ok := outer.Args[0].(*ast.Ident)
	if !ok {
		return ""
	}
	return id.Name
}
