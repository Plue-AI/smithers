package services

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/productstore"
	"github.com/smithersai/smithers/packages/backend/runtimeports"
)

// A deployment supplies the stores in ports.RuntimeStores by embedding
// productstore.Product and adding private operations; it never passes
// *db.Queries. Services detect optional store capabilities with type
// assertions and skip the feature when the store lacks one, so a capability
// that *db.Queries has and Product omits is a feature that silently does
// nothing in a hosted deployment (smithers#3112, smithers#3390).
type hostedProductStore struct{ productstore.Product }

func storeImplements[T any](store any) bool {
	_, ok := store.(T)
	return ok
}

// productStoreCapabilities lists every optional interface a service asserts on
// a store it received through ports.RuntimeStores and that product SQL
// implements. Product must carry each one. The key is the asserted type as the
// source spells it; an anonymous interface is keyed by its method names.
var productStoreCapabilities = map[string]func(any) bool{
	"branchMachineOwnerStore":              storeImplements[branchMachineOwnerStore],
	"boxHostQuerier":                       storeImplements[boxHostQuerier],
	"neverStartedAgentQuerier":             storeImplements[neverStartedAgentQuerier],
	"providerPoolTokenLister":              storeImplements[providerPoolTokenLister],
	"repositoryDefaultBookmarkResolver":    storeImplements[repositoryDefaultBookmarkResolver],
	"sandboxUsageQuerier":                  storeImplements[sandboxUsageQuerier],
	"gitHubDestinationStore":               storeImplements[gitHubDestinationStore],
	"workflowRunCheckRunUpdater":           storeImplements[workflowRunCheckRunUpdater],
	"workflowRunCredentialRevoker":         storeImplements[workflowRunCredentialRevoker],
	"workflowRunSupersedeQuerier":          storeImplements[workflowRunSupersedeQuerier],
	"workflowRunTerminalQuerier":           storeImplements[workflowRunTerminalQuerier],
	"workspaceChildrenTokenStore":          storeImplements[workspaceChildrenTokenStore],
	"workspaceCloneDepthStore":             storeImplements[workspaceCloneDepthStore],
	"workspaceCodingProvenance":            storeImplements[workspaceCodingProvenance],
	"workspaceEnvironmentImageRecorder":    storeImplements[workspaceEnvironmentImageRecorder],
	"workspaceHeadStore":                   storeImplements[workspaceHeadStore],
	"workspaceHeadSwapStore":               storeImplements[workspaceHeadSwapStore],
	"workspaceLeaseStore":                  storeImplements[workspaceLeaseStore],
	"workspaceMythicalStackReader":         storeImplements[workspaceMythicalStackReader],
	"workspacePreviewAuthorizationQuerier": storeImplements[workspacePreviewAuthorizationQuerier],
	"workspaceProvisioningFailureQuerier":  storeImplements[workspaceProvisioningFailureQuerier],
	"workspaceProvisioningStageQuerier":    storeImplements[workspaceProvisioningStageQuerier],
	"workspaceRecoveryQueries":             storeImplements[workspaceRecoveryQueries],
	"workspaceReprovisionResetter":         storeImplements[workspaceReprovisionResetter],
	"workspaceRepositoryIdentityStore":     storeImplements[workspaceRepositoryIdentityStore],
	"workspaceUnchangedFailureQuerier":     storeImplements[workspaceUnchangedFailureQuerier],
	"workspaceVMRegistrar":                 storeImplements[workspaceVMRegistrar],
	"workspaceVisibilityQuerier":           storeImplements[workspaceVisibilityQuerier],
	"interface{GetRepoByID}": storeImplements[interface {
		GetRepoByID(context.Context, int64) (db.Repository, error)
	}],
	"interface{GetMythicalLane}": storeImplements[interface {
		GetMythicalLane(context.Context, string) (db.MythicalLane, error)
	}],
	"interface{GetWorkspaceIncludingDeleted}": storeImplements[interface {
		GetWorkspaceIncludingDeleted(context.Context, string) (db.Workspace, error)
	}],
	"interface{RevokeWorkflowRunGuestTokens}": storeImplements[interface {
		RevokeWorkflowRunGuestTokens(context.Context, int64) error
	}],
	"interface{SetWorkspaceIdleTimeout}": storeImplements[interface {
		SetWorkspaceIdleTimeout(context.Context, db.SetWorkspaceIdleTimeoutParams) (db.Workspace, error)
	}],
	"interface{StopWorkspaceRetainingRow}": storeImplements[interface {
		StopWorkspaceRetainingRow(context.Context, string) (db.StopWorkspaceRetainingRowRow, error)
	}],
}

// deploymentStoreCapabilities are asserted on the same stores but are not a
// product query a hosted store inherits: a deployment adds them on purpose,
// and each reason says what their absence means.
var deploymentStoreCapabilities = map[string]struct {
	implemented func(any) bool
	reason      string
}{
	"runtimeports.WorkspaceSandboxAdoption": {storeImplements[runtimeports.WorkspaceSandboxAdoption],
		"the sandbox inventory is the fleet's; without it a sandbox the provider accepted before vm_id was recorded is not adopted"},
	"lfsStorageDeletionAllocationQuerier": {storeImplements[lfsStorageDeletionAllocationQuerier],
		"only a hosted blob deletion queue holds tombstoned allocations; local storage charges a fresh reservation"},
	"purgedStorageDeletionClearer": {storeImplements[purgedStorageDeletionClearer],
		"only a hosted blob deletion queue has purge fences to clear; local storage has none"},
	"alertRemediationRunBinder": {storeImplements[alertRemediationRunBinder],
		"alert remediation is a deployment workflow; a run that asks for binding without it fails loudly"},
	"WorkflowRunQueryRebinder": {storeImplements[WorkflowRunQueryRebinder],
		"a wrapper rebinds itself to a transaction; Product is already bound to one connection"},
	"workflowQueryTxStarter": {storeImplements[workflowQueryTxStarter],
		"a wrapper that begins transactions must also rebind; BeginWorkflowQueryTx refuses one without WorkflowRunQueryRebinder"},
}

func TestHostedProductStoreKeepsEveryProductCapability(t *testing.T) {
	hosted := hostedProductStore{Product: productstore.New(nil)}
	product := db.New(nil)
	for name, implemented := range productStoreCapabilities {
		if !implemented(product) {
			t.Errorf("*db.Queries does not implement %s; it is not a product capability", name)
		}
		if !implemented(hosted) {
			t.Errorf("productstore.Product lacks %s: a hosted deployment silently loses the feature behind it", name)
		}
	}
	for name, capability := range deploymentStoreCapabilities {
		if capability.reason == "" {
			t.Errorf("deployment capability %s needs a reason", name)
		}
		if capability.implemented(hosted) {
			t.Errorf("productstore.Product implements %s; list it as a product capability", name)
		}
	}
}

// Every capability a service asserts on a runtime store is classified, so a new
// assertion cannot ship without either joining Product or stating why a hosted
// store may lack it.
func TestRuntimeStoreAssertionsAreClassified(t *testing.T) {
	found := runtimeStoreAssertions(t)
	for _, name := range storeMapKeys(found) {
		_, product := productStoreCapabilities[name]
		_, deployment := deploymentStoreCapabilities[name]
		if !product && !deployment {
			t.Errorf("%s asserts %s on a runtime store: add the methods to productstore.Product and list it in productStoreCapabilities, or list it in deploymentStoreCapabilities with a reason",
				strings.Join(found[name], ", "), name)
		}
	}
	for name := range productStoreCapabilities {
		if _, ok := found[name]; !ok {
			t.Errorf("productStoreCapabilities lists %s, which no service asserts on a runtime store", name)
		}
	}
	for name := range deploymentStoreCapabilities {
		if _, ok := found[name]; !ok {
			t.Errorf("deploymentStoreCapabilities lists %s, which no service asserts on a runtime store", name)
		}
	}
}

// runtimeStoreFields names the field through which each service holds a store
// that ports.RuntimeStores may supply.
var runtimeStoreFields = map[string]string{
	"WorkspaceService":        "q",         // Workspaces
	"workflowRunService":      "queries",   // WorkflowRuns
	"AgentService":            "dispatchQ", // AgentDispatch
	"LFSService":              "queries",   // LFS
	"workflowCacheService":    "queries",   // WorkflowCache
	"workflowArtifactService": "queries",   // WorkflowArtifacts
}

// runtimeStoreTypes are the store interfaces in ports.RuntimeStores. A
// parameter of one of these types may hold a hosted store, including the
// transaction-bound copy a store rebinds itself to.
var runtimeStoreTypes = map[string]bool{
	"WorkspaceQuerier": true, "WorkflowRunQuerier": true, "AgentDispatchQuerier": true,
	"LFSQuerier": true, "WorkflowCacheQuerier": true, "WorkflowArtifactQuerier": true,
}

// runtimeStoreAssertions finds, in this package's sources, every type assertion
// and type switch case on a runtime store: a runtimeStoreFields field or a
// parameter of a runtimeStoreTypes type. It follows the store into variables
// bound from it and into package functions and same-type methods that receive
// it as an argument. It returns asserted type -> sites.
func runtimeStoreAssertions(t *testing.T) map[string][]string {
	t.Helper()
	fset := token.NewFileSet()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	funcs := map[string]*ast.FuncDecl{}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range file.Decls {
			if fn, ok := decl.(*ast.FuncDecl); ok && fn.Body != nil {
				funcs[funcKey(receiverType(fn), fn.Name.Name)] = fn
			}
		}
	}
	found := map[string][]string{}
	record := func(typ ast.Expr) {
		if _, pointer := typ.(*ast.StarExpr); pointer {
			return // a concrete type, not a capability
		}
		position := fset.Position(typ.Pos())
		site := position.Filename + ":" + strconv.Itoa(position.Line)
		found[typeKey(typ)] = append(found[typeKey(typ)], site)
	}
	visited := map[string]bool{}
	var visit func(fn *ast.FuncDecl, stores map[string]bool)
	visit = func(fn *ast.FuncDecl, stores map[string]bool) {
		key := funcKey(receiverType(fn), fn.Name.Name) + "(" + strings.Join(storeMapKeys(stores), ",") + ")"
		if visited[key] {
			return
		}
		visited[key] = true
		receiver := receiverName(fn)
		isStore := func(expr ast.Expr) bool { return stores[exprKey(expr)] }
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			switch node := node.(type) {
			case *ast.FuncLit:
				for name := range storeParams(node.Type) {
					stores[name] = true
				}
			case *ast.AssignStmt:
				if len(node.Rhs) != 1 || len(node.Lhs) == 0 {
					break
				}
				value := node.Rhs[0]
				if assertion, ok := value.(*ast.TypeAssertExpr); ok {
					value = assertion.X
				}
				if ident, ok := node.Lhs[0].(*ast.Ident); ok && ident.Name != "_" && isStore(value) {
					stores[ident.Name] = true
				}
			case *ast.TypeAssertExpr:
				if node.Type != nil && isStore(node.X) {
					record(node.Type)
				}
			case *ast.TypeSwitchStmt:
				var subject ast.Expr
				switch assign := node.Assign.(type) {
				case *ast.ExprStmt:
					subject = assign.X
				case *ast.AssignStmt:
					subject = assign.Rhs[0]
				}
				if assertion, ok := subject.(*ast.TypeAssertExpr); ok && isStore(assertion.X) {
					for _, clause := range node.Body.List {
						for _, typ := range clause.(*ast.CaseClause).List {
							record(typ)
						}
					}
				}
			case *ast.CallExpr:
				callee := calledFunc(funcs, node, receiverType(fn), receiver)
				if callee == nil {
					break
				}
				params := paramNames(callee)
				next := map[string]bool{}
				if calleeReceiver := receiverName(callee); calleeReceiver != "" {
					for store := range stores {
						if rest, ok := strings.CutPrefix(store, receiver+"."); ok {
							next[calleeReceiver+"."+rest] = true
						}
					}
				}
				for index, arg := range node.Args {
					if index < len(params) && params[index] != "_" && isStore(arg) {
						next[params[index]] = true
					}
				}
				if len(next) > 0 {
					visit(callee, next)
				}
			}
			return true
		})
	}
	for _, fn := range funcs {
		stores := storeParams(fn.Type)
		if field, ok := runtimeStoreFields[receiverType(fn)]; ok && receiverName(fn) != "" {
			stores[receiverName(fn)+"."+field] = true
		}
		if len(stores) > 0 {
			visit(fn, stores)
		}
	}
	return found
}

func calledFunc(funcs map[string]*ast.FuncDecl, call *ast.CallExpr, receiverType, receiver string) *ast.FuncDecl {
	switch fun := call.Fun.(type) {
	case *ast.Ident:
		return funcs[funcKey("", fun.Name)]
	case *ast.SelectorExpr:
		if ident, ok := fun.X.(*ast.Ident); ok && receiver != "" && ident.Name == receiver {
			return funcs[funcKey(receiverType, fun.Sel.Name)]
		}
	}
	return nil
}

func funcKey(receiverType, name string) string {
	if receiverType == "" {
		return name
	}
	return receiverType + "." + name
}

func receiverType(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 {
		return ""
	}
	typ := fn.Recv.List[0].Type
	if star, ok := typ.(*ast.StarExpr); ok {
		typ = star.X
	}
	if ident, ok := typ.(*ast.Ident); ok {
		return ident.Name
	}
	return ""
}

func receiverName(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 || len(fn.Recv.List[0].Names) == 0 {
		return ""
	}
	return fn.Recv.List[0].Names[0].Name
}

func storeParams(fn *ast.FuncType) map[string]bool {
	stores := map[string]bool{}
	for _, field := range fn.Params.List {
		if ident, ok := field.Type.(*ast.Ident); ok && runtimeStoreTypes[ident.Name] {
			for _, name := range field.Names {
				stores[name.Name] = true
			}
		}
	}
	return stores
}

func paramNames(fn *ast.FuncDecl) []string {
	var names []string
	for _, field := range fn.Type.Params.List {
		if len(field.Names) == 0 {
			names = append(names, "_")
		}
		for _, name := range field.Names {
			names = append(names, name.Name)
		}
	}
	return names
}

func exprKey(expr ast.Expr) string {
	switch expr := expr.(type) {
	case *ast.Ident:
		return expr.Name
	case *ast.SelectorExpr:
		if prefix := exprKey(expr.X); prefix != "" {
			return prefix + "." + expr.Sel.Name
		}
	case *ast.ParenExpr:
		return exprKey(expr.X)
	}
	return ""
}

func typeKey(typ ast.Expr) string {
	if iface, ok := typ.(*ast.InterfaceType); ok {
		var methods []string
		for _, method := range iface.Methods.List {
			for _, name := range method.Names {
				methods = append(methods, name.Name)
			}
		}
		sort.Strings(methods)
		return "interface{" + strings.Join(methods, ",") + "}"
	}
	return exprKey(typ)
}

func storeMapKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
