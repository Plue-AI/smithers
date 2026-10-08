package microsandbox

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// Derive the host vocabulary from command-building call sites, rather than
// maintaining a second operation list that can outlive a deleted dispatch arm.
// Forwarding wrappers are followed at their callers; append prefixes cover the
// managed-artifact commands, and the direct bridge argv is checked separately.
func hostHelperOperations(t *testing.T) map[string]bool {
	t.Helper()
	operations := map[string]bool{}
	files, err := parser.ParseDir(token.NewFileSet(), ".", func(info os.FileInfo) bool {
		return strings.HasSuffix(info.Name(), ".go") && !strings.HasSuffix(info.Name(), "_test.go")
	}, 0)
	require.NoError(t, err)
	literal := func(expr ast.Expr) string {
		value, ok := expr.(*ast.BasicLit)
		if !ok || value.Kind != token.STRING {
			return ""
		}
		result, err := strconv.Unquote(value.Value)
		require.NoError(t, err)
		return result
	}
	for _, pkg := range files {
		for _, file := range pkg.Files {
			ast.Inspect(file, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				name := ""
				switch fn := call.Fun.(type) {
				case *ast.Ident:
					name = fn.Name
				case *ast.SelectorExpr:
					name = fn.Sel.Name
				}
				index := -1
				switch name {
				case "guest", "runPreparation":
					index = 3
				case "guestArgs":
					index = 3
				case "fileOperation":
					index = 4
				}
				if index >= 0 && len(call.Args) > index {
					op := literal(call.Args[index])
					// A dynamic command must forward its variadic operands or prepend a
					// literal command. Fail closed if a new construction escapes this audit.
					if op == "" {
						switch arg := call.Args[index].(type) {
						case *ast.Ident:
							require.True(t, call.Ellipsis.IsValid() && (arg.Name == "subcommand" || arg.Name == "operation"), "untracked helper command %s", arg.Name)
						case *ast.CallExpr:
							fn, ok := arg.Fun.(*ast.Ident)
							require.True(t, ok && fn.Name == "append" && len(arg.Args) > 0)
							prefix, ok := arg.Args[0].(*ast.CompositeLit)
							require.True(t, ok && len(prefix.Elts) > 0, "untracked helper prefix")
							op = literal(prefix.Elts[0])
							// fileOperation prepends fs/user/operation to the actual operands.
							if name == "guestArgs" && op == "fs" {
								return true
							}
							require.NotEmpty(t, op, "untracked helper prefix")
						default:
							t.Fatalf("untracked helper command expression %T", arg)
						}
					}
					if op != "" {
						if name == "fileOperation" {
							op = "fs/" + op
						}
						operations[op] = true
					}
				}
				return true
			})
			ast.Inspect(file, func(node ast.Node) bool {
				argv, ok := node.(*ast.CompositeLit)
				if !ok || len(argv.Elts) < 3 {
					return true
				}
				helper, ok := argv.Elts[1].(*ast.Ident)
				if ok && helper.Name == "guestHelperPath" {
					op := literal(argv.Elts[2])
					require.NotEmpty(t, op, "untracked direct helper command")
					operations[op] = true
				}
				return true
			})
		}
	}
	require.NotEmpty(t, operations)
	return operations
}

func TestHostHelperOperationParity(t *testing.T) {
	python, err := exec.LookPath("python3")
	require.NoError(t, err, "Linux fast gate requires Python to verify the shipped helper")
	operations := hostHelperOperations(t)
	// These were the real-VM regression; ensure neither call site vanishes from
	// the source audit accidentally.
	require.True(t, operations["fs/state-read"])
	require.True(t, operations["fs/state-write"])
	for operation := range operations {
		t.Run(operation, func(t *testing.T) {
			body, err := json.Marshal(operation)
			require.NoError(t, err)
			cmd := exec.Command(python, "-I", "-S", "-B", "-c", helperDispatchParity, "guest/smithers-guest.py")
			cmd.Stdin = strings.NewReader(string(body))
			output, err := cmd.CombinedOutput()
			require.NoError(t, err, "%s", output)
			require.Equal(t, "accepted\n", string(output))
		})
	}
}

// Execute the real dispatch predicates with their operation bodies replaced by
// an acceptance sentinel. This is deliberately a parser/dispatcher check, not
// a security-policy or execution test: it never forks, drops credentials,
// opens guest paths, installs binaries, or changes the helper. In particular,
// preserve run_fs's if/elif chain, so deleting a single arm reaches its real
// unknown-operation failure instead of a hand-copied accepted-operation list.
const helperDispatchParity = `
import ast, json, re, sys
source = ast.parse(open(sys.argv[1]).read())
class Accepted(Exception): pass
def accepted(): raise Accepted()
def fail(code, message): raise RuntimeError(message)
def projects(test, name):
    return any(isinstance(n, ast.Name) and n.id == name for n in ast.walk(test))
class Project(ast.NodeTransformer):
    def __init__(self, name): self.name = name
    def visit_If(self, node):
        if projects(node.test, self.name):
            node.body = [ast.Expr(ast.Call(ast.Name('accepted', ast.Load()), [], []))]
            node.orelse = [self.visit(n) for n in node.orelse]
            return node
        return self.generic_visit(node)
functions = []
for node in source.body:
    if isinstance(node, ast.FunctionDef) and node.name in ('main', 'run_fs'):
        functions.append(Project('command' if node.name == 'main' else 'operation').visit(node))
functions.extend(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'valid_id')
module = ast.fix_missing_locations(ast.Module(body=functions, type_ignores=[]))
namespace = dict(accepted=accepted, fail=fail, re=re)
exec(compile(module, sys.argv[1], 'exec'), namespace)
# Negative controls ensure the projection retains the unknown fallthroughs.
for dispatcher, args in ((namespace['main'], ['parity-unknown']),
                         (namespace['run_fs'], ['fs', 'agent', 'parity-unknown', '/', 'file'])):
    try: dispatcher(args)
    except RuntimeError as error:
        if 'unknown' not in str(error): raise
    else: raise RuntimeError('unknown operation incorrectly accepted')
operation = json.load(sys.stdin)
if operation.startswith('fs/'):
    args = ['fs', 'agent', operation[3:], '/var/lib/smithers/state', 'egress-ca.pem']
    # Require both the outer fs admission and the specific operation arm.
    try: namespace['main'](args)
    except Accepted: pass
    else: raise RuntimeError('fs dispatch not accepted')
    try: namespace['run_fs'](args)
    except Accepted: print('accepted')
else:
    for count in range(1, 9):
        args = [operation] + ['a' * 32, '19999', '/workspace', 'binding', 'digest', 'path', 'mode'][:count-1]
        try: namespace['main'](args)
        except Accepted:
            print('accepted')
            break
        except RuntimeError: continue
    else: raise RuntimeError('unknown helper operation: ' + operation)
`
