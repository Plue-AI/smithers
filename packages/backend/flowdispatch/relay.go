package flowdispatch

import (
	"bytes"
	"context"
	"encoding/json"
	"io"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
)

// RelayPlans keeps the plans the browser relay made, by caller and box, and
// answers which flow a saved plan is of. Production keeps them in PostgreSQL
// so every backend replica answers alike (compose).
type RelayPlans interface {
	SaveRelayPlan(ctx context.Context, target flowruntime.Target, planID, flowID string) error
	// RelayPlanFlow answers ok false for a plan the relay did not save for
	// this caller and box.
	RelayPlanFlow(ctx context.Context, target flowruntime.Target, planID string) (flowID string, ok bool, err error)
}

// relayCall is a browser relay call as the relay classified it.
type relayCall struct {
	// runID names the run a Run of a resume, a Resume or a Run.Fork acts
	// on; the run's host says which flow it belongs to (refuseTodoRun).
	runID string
}

// RefuseRelay classifies a browser relay call before any host is resolved
// or box woken (Fable rounds 2 and 3, Astra round 3): its payload is read
// by its exact, case-sensitive keys, and a duplicate key or an unreadable
// payload is refused. A Plan naming the todo composition in any spelling is
// refused, and a Run or approval of a plan acts only on a plan this relay
// saved for the same caller and box, and never on a todo plan. A call on a
// run is classified by that run's host before it is forwarded (CallRPC).
func (service *Service) RefuseRelay(ctx context.Context, target flowruntime.Target, procedure string, payload json.RawMessage) error {
	_, err := service.classifyRelay(ctx, target, procedure, payload)
	return err
}

func (service *Service) classifyRelay(ctx context.Context, target flowruntime.Target, procedure string, payload json.RawMessage) (relayCall, error) {
	var call relayCall
	switch procedure {
	case "Plan", "Run", "Resume", "Run.Fork", "Approval.Submit":
	default:
		return call, nil
	}
	fields, err := exactObject(payload)
	if err != nil {
		return call, ErrRelayPayload
	}
	switch procedure {
	case "Plan":
		flowID, ok := exactText(fields, "flowId")
		if !ok {
			return call, ErrRelayPayload
		}
		if IsTodoFlow(flowID) {
			return call, ErrTodoOutsideStack
		}
		return call, nil
	case "Approval.Submit":
		decided, err := exactObject(fields["target"])
		if err != nil {
			return call, ErrRelayPayload
		}
		if tag, _ := exactText(decided, "_tag"); tag != "Plan" {
			return call, nil
		}
		return call, service.refuseRelayPlan(ctx, target, decided)
	case "Run":
		switch tag, _ := exactText(fields, "_tag"); tag {
		case "Plan":
			return call, service.refuseRelayPlan(ctx, target, fields)
		case "Resume":
		default:
			return call, ErrRelayPayload
		}
	}
	runID, ok := exactText(fields, "runId")
	if !ok {
		return call, ErrRelayPayload
	}
	call.runID = runID
	return call, nil
}

// refuseRelayPlan refuses a run or approval of a plan the relay did not save
// for the caller and box, or of a todo plan.
func (service *Service) refuseRelayPlan(ctx context.Context, target flowruntime.Target, fields map[string]json.RawMessage) error {
	planID, ok := exactText(fields, "planId")
	if !ok {
		return ErrRelayPayload
	}
	if service.relayPlans == nil {
		return ErrRelayPlanUnknown
	}
	flowID, saved, err := service.relayPlans.RelayPlanFlow(ctx, target, planID)
	switch {
	case err != nil:
		return err
	case !saved:
		return ErrRelayPlanUnknown
	case IsTodoFlow(flowID):
		return ErrTodoOutsideStack
	}
	return nil
}

// savePlan records the plan a relayed Plan answered with. A plan that cannot
// be recorded cannot be run through the relay, so the Plan fails.
func (service *Service) savePlan(ctx context.Context, target flowruntime.Target, answer json.RawMessage) error {
	var card struct {
		PlanID string `json:"planId"`
		FlowID string `json:"flowId"`
	}
	if json.Unmarshal(answer, &card) != nil || card.PlanID == "" || service.relayPlans == nil {
		return nil
	}
	return service.relayPlans.SaveRelayPlan(ctx, target, card.PlanID, card.FlowID)
}

// refuseTodoRun refuses a relayed run, resume or fork of a run of the todo
// composition: those runs belong to the stack's pinned launch alone. The run
// is read from the same host before anything is mutated; a run the host
// cannot answer for is refused.
func (service *Service) refuseTodoRun(ctx context.Context, runtime flowruntime.Runtime, call relayCall) error {
	if call.runID == "" {
		return nil
	}
	callContext, cancel := context.WithTimeout(ctx, service.runtimeCallTimeout)
	defer cancel()
	observation, err := runtime.Observe(callContext, call.runID, "", 1)
	if err != nil {
		return err
	}
	if IsTodoFlow(observation.Run.FlowID) {
		return ErrTodoOutsideStack
	}
	return nil
}

// exactText answers a non-empty string member of an exact object.
func exactText(fields map[string]json.RawMessage, key string) (string, bool) {
	var value string
	raw, ok := fields[key]
	return value, ok && json.Unmarshal(raw, &value) == nil && value != ""
}

// exactObject decodes one JSON object into its members by their exact keys,
// refusing a duplicate key and anything after the object.
func exactObject(payload json.RawMessage) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, ErrRelayPayload
	}
	fields := map[string]json.RawMessage{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, ErrRelayPayload
		}
		if _, duplicate := fields[key]; duplicate {
			return nil, ErrRelayPayload
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, ErrRelayPayload
	}
	return fields, nil
}
