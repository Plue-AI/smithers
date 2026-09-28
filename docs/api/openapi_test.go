package api_test

import (
	"os"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestOpenAPIOperationIDsAreUnique(t *testing.T) {
	data, err := os.ReadFile("openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Paths map[string]map[string]struct {
			OperationID string `yaml:"operationId"`
		} `yaml:"paths"`
	}
	if err := yaml.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Paths) == 0 {
		t.Fatal("OpenAPI document has no paths")
	}
	seen := map[string]string{}
	for path, item := range document.Paths {
		for _, method := range []string{"get", "post", "put", "patch", "delete", "head", "options", "trace"} {
			op, ok := item[method]
			if !ok {
				continue
			}
			location := method + " " + path
			if op.OperationID == "" {
				t.Errorf("%s has no operationId", location)
				continue
			}
			if previous, exists := seen[op.OperationID]; exists {
				t.Errorf("operationId %q shared by %s and %s", op.OperationID, previous, location)
			}
			seen[op.OperationID] = location
		}
	}
}
