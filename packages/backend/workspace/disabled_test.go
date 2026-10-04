package workspace

import (
	"reflect"
	"testing"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestDisabledRuntimeRefusesEveryOperation(t *testing.T) {
	runtime := NewDisabled()
	if runtime.Isolation() != IsolationDisabled || runtime.Capabilities() != (WorkspaceCapabilities{}) {
		t.Fatal("disabled runtime advertises execution")
	}
	contract := reflect.TypeOf((*WorkspaceRuntime)(nil)).Elem()
	value := reflect.ValueOf(runtime)
	for i := 0; i < contract.NumMethod(); i++ {
		method := contract.Method(i)
		if method.Name == "Isolation" || method.Name == "Capabilities" {
			continue
		}
		t.Run(method.Name, func(t *testing.T) {
			fn := value.MethodByName(method.Name)
			args := make([]reflect.Value, fn.Type().NumIn())
			for j := range args {
				args[j] = reflect.Zero(fn.Type().In(j))
			}
			results := fn.Call(args)
			err, ok := results[len(results)-1].Interface().(error)
			api, typed := err.(*apierrors.APIError)
			if !ok || !typed || api.Code != apierrors.CodeMachinesDisabled || api.Status != 503 || api.Fault != apierrors.FaultInfra || api.RetryAfter != 0 || err.Error() != "Machines are off in this preview." {
				t.Fatalf("operation returned %v", results)
			}
		})
	}
}
