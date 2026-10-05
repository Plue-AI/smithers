// Package runtimebridge implements the authenticated, versioned JSON adapter
// to the canonical TypeScript Flow/Control host.
package runtimebridge

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
)

const maxResponseBytes = 4 << 20

type Config struct {
	Endpoint   string
	Credential string
	HTTPClient *http.Client
}

// Error is a sanitized bridge refusal. It never includes request headers,
// payload bytes, or the bearer credential.
type Error struct {
	Code       string
	Message    string
	Retryable  bool
	HTTPStatus int
}

func (e *Error) Error() string {
	if e.Message == "" {
		return "flow runtime bridge: " + e.Code
	}
	return "flow runtime bridge: " + e.Code + ": " + e.Message
}

func (e *Error) FlowRuntimeHTTPStatus() int { return e.HTTPStatus }
func (e *Error) FlowRuntimeCode() string    { return e.Code }
func (e *Error) FlowRuntimeRetryable() bool { return e.Retryable }

type Client struct {
	endpoint   string
	credential string
	http       *http.Client
}

// gatewayProcedures are the gateway's own procedures (GatewayRpcs), served on
// /projections; every other procedure is a Control procedure on /rpc.
var gatewayProcedures = map[string]bool{
	"Projection.Snapshot": true, "Approval.Submit": true, "Run.Fork": true, "Run.Verify": true,
}

func rpcPath(procedure string) string {
	if gatewayProcedures[procedure] {
		return "/projections"
	}
	return "/rpc"
}

// CallRPC speaks the canonical Control/Gateway NDJSON protocol on the same
// identity-verified host used by Flow runtime commands. The product relay owns
// the procedure allowlist; this method never exposes the host credential.
func (c *Client) CallRPC(ctx context.Context, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	path := rpcPath(procedure)
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	frame, err := json.Marshal(struct {
		Tag     string          `json:"_tag"`
		ID      int             `json:"id"`
		Method  string          `json:"tag"`
		Payload json.RawMessage `json:"payload"`
		Headers []any           `json:"headers"`
	}{Tag: "Request", ID: 1, Method: procedure, Payload: payload, Headers: []any{}})
	if err != nil {
		return nil, &Error{Code: "invalid_request", Message: "RPC request could not be encoded"}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+path, bytes.NewReader(append(frame, '\n')))
	if err != nil {
		return nil, &Error{Code: "invalid_endpoint", Message: "runtime endpoint could not be addressed"}
	}
	request.Header.Set("Authorization", "Bearer "+c.credential)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, &Error{Code: "transport", Message: "runtime host could not be reached", Retryable: true}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes || response.StatusCode != http.StatusOK {
		return nil, &Error{Code: "invalid_response", Message: "runtime RPC response was unavailable", HTTPStatus: response.StatusCode}
	}
	line, _, _ := bytes.Cut(bytes.TrimSpace(body), []byte{'\n'})
	var exit struct {
		Tag       string `json:"_tag"`
		RequestID int    `json:"requestId"`
		Exit      struct {
			Tag   string          `json:"_tag"`
			Value json.RawMessage `json:"value"`
			Cause json.RawMessage `json:"cause"`
		} `json:"exit"`
	}
	if json.Unmarshal(line, &exit) != nil || exit.Tag != "Exit" || exit.RequestID != 1 {
		return nil, &Error{Code: "invalid_response", Message: "runtime RPC response was not a gateway outcome"}
	}
	if exit.Exit.Tag == "Success" {
		return json.Marshal(struct {
			OK      bool            `json:"ok"`
			Payload json.RawMessage `json:"payload"`
		}{true, exit.Exit.Value})
	}
	if exit.Exit.Tag == "Failure" {
		return json.Marshal(struct {
			OK    bool `json:"ok"`
			Error struct {
				Message string          `json:"message"`
				Detail  json.RawMessage `json:"detail"`
			} `json:"error"`
		}{false, struct {
			Message string          `json:"message"`
			Detail  json.RawMessage `json:"detail"`
		}{rpcFailureMessage(exit.Exit.Cause), exit.Exit.Cause}})
	}
	return nil, &Error{Code: "invalid_response", Message: "runtime RPC response was not a gateway outcome"}
}

func rpcFailureMessage(cause json.RawMessage) string {
	var reasons []struct {
		Tag    string          `json:"_tag"`
		Error  json.RawMessage `json:"error"`
		Defect json.RawMessage `json:"defect"`
	}
	if json.Unmarshal(cause, &reasons) == nil {
		for _, reason := range reasons {
			if reason.Tag != "Fail" {
				continue
			}
			var typed struct {
				Tag     string `json:"_tag"`
				Code    string `json:"code"`
				FlowID  string `json:"flowId"`
				Message string `json:"message"`
			}
			if json.Unmarshal(reason.Error, &typed) == nil {
				if (typed.Tag == "/control/FlowNotFound" || typed.Code == "flow_not_found") && typed.FlowID != "" {
					return fmt.Sprintf("No flow %q is registered on this workspace.", typed.FlowID)
				}
				if typed.Message != "" {
					return typed.Message
				}
				if typed.Tag != "" {
					return typed.Tag
				}
				if typed.Code != "" {
					return typed.Code
				}
			}
		}
		for _, reason := range reasons {
			switch reason.Tag {
			case "Interrupt":
				return "The workspace cancelled the call."
			case "Die":
				var defect struct {
					Message string `json:"message"`
				}
				if json.Unmarshal(reason.Defect, &defect) == nil && defect.Message != "" {
					return "The workspace crashed: " + defect.Message
				}
				return "The workspace crashed."
			}
		}
	}
	return "The workspace refused the call."
}

func New(config Config) (*Client, error) {
	parsed, err := url.Parse(config.Endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("flow runtime bridge endpoint must be an absolute HTTP(S) URL without credentials, query, or fragment")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopbackHost(parsed.Hostname())) {
		return nil, errors.New("flow runtime bridge requires HTTPS except on loopback")
	}
	if strings.TrimSpace(config.Credential) == "" {
		return nil, errors.New("flow runtime bridge credential is required")
	}
	base := config.HTTPClient
	if base == nil {
		base = &http.Client{Timeout: 30 * time.Second}
	}
	client := *base
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{
		endpoint:   strings.TrimRight(config.Endpoint, "/"),
		credential: config.Credential,
		http:       &client,
	}, nil
}

func loopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type commandEnvelope struct {
	Protocol string `json:"protocol"`
	OK       bool   `json:"ok"`
	Value    struct {
		Operation             string                         `json:"operation"`
		ApplicationRequestID  string                         `json:"applicationRequestId"`
		OwnerGeneration       int64                          `json:"ownerGeneration,omitempty"`
		RuntimeArtifactDigest string                         `json:"runtimeArtifactDigest,omitempty"`
		SourceRevision        string                         `json:"sourceRevision,omitempty"`
		PlanID                string                         `json:"planId,omitempty"`
		PlanDigest            string                         `json:"planDigest,omitempty"`
		ExecutionDigest       string                         `json:"executionDigest,omitempty"`
		Envelope              json.RawMessage                `json:"envelope,omitempty"`
		Approval              json.RawMessage                `json:"approval,omitempty"`
		Receipt               flowruntime.FlowRuntimeReceipt `json:"receipt"`
	} `json:"value"`
	Error wireError `json:"error"`
}

type observeEnvelope struct {
	Protocol string `json:"protocol"`
	OK       bool   `json:"ok"`
	Value    struct {
		Run        flowruntime.FlowRuntimeRun     `json:"run"`
		Events     []flowruntime.FlowRuntimeEvent `json:"events"`
		NextCursor string                         `json:"nextCursor"`
		HasMore    bool                           `json:"hasMore"`
		Terminal   bool                           `json:"terminal"`
	} `json:"value"`
	Error wireError `json:"error"`
}

type wireError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func (c *Client) post(ctx context.Context, path string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return &Error{Code: "invalid_request", Message: "request could not be encoded"}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+path, bytes.NewReader(body))
	if err != nil {
		return &Error{Code: "invalid_endpoint", Message: "runtime endpoint could not be addressed"}
	}
	request.Header.Set("Authorization", "Bearer "+c.credential)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := c.http.Do(request)
	if err != nil {
		return &Error{Code: "transport", Message: "runtime host could not be reached", Retryable: true}
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, maxResponseBytes+1)
	responseBody, err := io.ReadAll(limited)
	if err != nil {
		return &Error{Code: "transport", Message: "runtime response could not be read", Retryable: true, HTTPStatus: response.StatusCode}
	}
	if len(responseBody) > maxResponseBytes {
		return &Error{Code: "invalid_response", Message: "runtime response exceeded the size limit", HTTPStatus: response.StatusCode}
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		var envelope struct {
			Protocol string    `json:"protocol"`
			Error    wireError `json:"error"`
		}
		if json.Unmarshal(responseBody, &envelope) == nil && envelope.Protocol == flowruntime.FlowRuntimeProtocol && envelope.Error.Code != "" {
			return &Error{Code: envelope.Error.Code, Message: envelope.Error.Message, Retryable: envelope.Error.Retryable, HTTPStatus: response.StatusCode}
		}
		code := "http_refused"
		if response.StatusCode == http.StatusUnauthorized {
			code = "unauthorized"
		}
		return &Error{Code: code, Message: http.StatusText(response.StatusCode), Retryable: response.StatusCode >= 500, HTTPStatus: response.StatusCode}
	}
	if err := json.Unmarshal(responseBody, output); err != nil {
		return &Error{Code: "invalid_response", Message: "runtime response was not valid JSON", HTTPStatus: response.StatusCode}
	}
	return nil
}

func (c *Client) Identity(ctx context.Context) (flowruntime.FlowRuntimeIdentity, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint+"/health", nil)
	if err != nil {
		return flowruntime.FlowRuntimeIdentity{}, &Error{Code: "invalid_endpoint", Message: "runtime endpoint could not be addressed"}
	}
	// Health carries the executable fence used by every later command. Present
	// the same bearer as command/observe even when a deployment also exposes a
	// shallow unauthenticated liveness probe at this path.
	request.Header.Set("Authorization", "Bearer "+c.credential)
	request.Header.Set("Accept", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return flowruntime.FlowRuntimeIdentity{}, &Error{Code: "transport", Message: "runtime host could not be reached", Retryable: true}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return flowruntime.FlowRuntimeIdentity{}, &Error{Code: "health_refused", Message: http.StatusText(response.StatusCode),
			Retryable: response.StatusCode >= 500, HTTPStatus: response.StatusCode}
	}
	var health struct {
		RuntimeBridge flowruntime.FlowRuntimeIdentity `json:"runtimeBridge"`
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return flowruntime.FlowRuntimeIdentity{}, &Error{Code: "transport", Message: "runtime health could not be read", Retryable: true, HTTPStatus: response.StatusCode}
	}
	if len(body) > maxResponseBytes {
		return flowruntime.FlowRuntimeIdentity{}, &Error{Code: "invalid_response", Message: "runtime health exceeded the size limit", HTTPStatus: response.StatusCode}
	}
	if err := json.Unmarshal(body, &health); err != nil {
		return flowruntime.FlowRuntimeIdentity{}, &Error{Code: "invalid_response", Message: "runtime health was not valid JSON", HTTPStatus: response.StatusCode}
	}
	if health.RuntimeBridge.Protocol != flowruntime.FlowRuntimeProtocol {
		return flowruntime.FlowRuntimeIdentity{}, &Error{Code: "incompatible_protocol", Message: "runtime protocol version is incompatible", HTTPStatus: response.StatusCode}
	}
	if !hexString(health.RuntimeBridge.RuntimeArtifactDigest, 64) || !hexString(health.RuntimeBridge.SourceRevision, 40) || health.RuntimeBridge.OwnerGeneration <= 0 {
		return flowruntime.FlowRuntimeIdentity{}, &Error{Code: "invalid_response", Message: "runtime health identity is invalid", HTTPStatus: response.StatusCode}
	}
	return health.RuntimeBridge, nil
}

func hexString(value string, length int) bool {
	if len(value) != length {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}

func checkEnvelope(protocol string, ok bool, failure wireError) error {
	if protocol != flowruntime.FlowRuntimeProtocol {
		return &Error{Code: "incompatible_protocol", Message: "runtime protocol version is incompatible"}
	}
	if !ok {
		return &Error{Code: failure.Code, Message: failure.Message, Retryable: failure.Retryable}
	}
	return nil
}

func (c *Client) command(ctx context.Context, input any) (commandEnvelope, error) {
	var envelope commandEnvelope
	if err := c.post(ctx, "/runtime/v1/command", input, &envelope); err != nil {
		return envelope, err
	}
	if err := checkEnvelope(envelope.Protocol, envelope.OK, envelope.Error); err != nil {
		return envelope, err
	}
	return envelope, nil
}

func (c *Client) Launch(ctx context.Context, request flowruntime.FlowRuntimeLaunch) (flowruntime.FlowRuntimeLaunchResult, error) {
	input := struct {
		Protocol              string           `json:"protocol"`
		Operation             string           `json:"operation"`
		ApplicationRequestID  string           `json:"applicationRequestId"`
		Attempt               int64            `json:"attempt"`
		OwnerGeneration       int64            `json:"ownerGeneration"`
		RuntimeArtifactDigest string           `json:"runtimeArtifactDigest"`
		SourceRevision        string           `json:"sourceRevision"`
		FlowID                string           `json:"flowId"`
		Payload               json.RawMessage  `json:"payload"`
		Pin                   *flowruntime.Pin `json:"pin,omitempty"`
	}{flowruntime.FlowRuntimeProtocol, "launch", request.ApplicationRequestID, request.Attempt, request.OwnerGeneration,
		request.RuntimeArtifactDigest, request.SourceRevision, request.FlowID, request.Payload, request.Pin}
	envelope, err := c.command(ctx, input)
	if err != nil {
		return flowruntime.FlowRuntimeLaunchResult{}, err
	}
	return flowruntime.FlowRuntimeLaunchResult{
		ApplicationRequestID:  envelope.Value.ApplicationRequestID,
		OwnerGeneration:       envelope.Value.OwnerGeneration,
		RuntimeArtifactDigest: envelope.Value.RuntimeArtifactDigest,
		SourceRevision:        envelope.Value.SourceRevision,
		PlanID:                envelope.Value.PlanID,
		PlanDigest:            envelope.Value.PlanDigest,
		ExecutionDigest:       envelope.Value.ExecutionDigest,
		Envelope:              envelope.Value.Envelope,
		Approval:              envelope.Value.Approval,
		Receipt:               envelope.Value.Receipt,
	}, nil
}

func (c *Client) decision(ctx context.Context, operation string, request flowruntime.FlowRuntimeDecision) (flowruntime.FlowRuntimeMutationResult, error) {
	input := struct {
		Protocol             string          `json:"protocol"`
		Operation            string          `json:"operation"`
		ApplicationRequestID string          `json:"applicationRequestId"`
		OwnerGeneration      int64           `json:"ownerGeneration"`
		Approval             json.RawMessage `json:"approval"`
	}{flowruntime.FlowRuntimeProtocol, operation, request.ApplicationRequestID, request.OwnerGeneration, request.Approval}
	return c.mutate(ctx, input)
}

func (c *Client) Approve(ctx context.Context, request flowruntime.FlowRuntimeDecision) (flowruntime.FlowRuntimeMutationResult, error) {
	return c.decision(ctx, "approve", request)
}

func (c *Client) Deny(ctx context.Context, request flowruntime.FlowRuntimeDecision) (flowruntime.FlowRuntimeMutationResult, error) {
	return c.decision(ctx, "deny", request)
}

func (c *Client) Signal(ctx context.Context, request flowruntime.FlowRuntimeSignal) (flowruntime.FlowRuntimeMutationResult, error) {
	input := struct {
		Protocol             string `json:"protocol"`
		Operation            string `json:"operation"`
		ApplicationRequestID string `json:"applicationRequestId"`
		OwnerGeneration      int64  `json:"ownerGeneration"`
		RunID                string `json:"runId"`
		Signal               struct {
			Name    string          `json:"name"`
			Payload json.RawMessage `json:"payload"`
		} `json:"signal"`
	}{Protocol: flowruntime.FlowRuntimeProtocol, Operation: "signal", ApplicationRequestID: request.ApplicationRequestID,
		OwnerGeneration: request.OwnerGeneration, RunID: request.RunID}
	input.Signal.Name = request.Name
	input.Signal.Payload = request.Payload
	return c.mutate(ctx, input)
}

func (c *Client) Steer(ctx context.Context, request flowruntime.FlowRuntimeSteer) (flowruntime.FlowRuntimeMutationResult, error) {
	steer := map[string]any{"kind": request.Kind}
	switch request.Kind {
	case "Message":
		steer["body"] = request.Body
	case "Seat":
		steer["seat"] = request.Seat
	case "Thinking":
		steer["thinking"] = request.Thinking
	case "Tools":
		steer["toolNames"] = request.ToolNames
	default:
		return flowruntime.FlowRuntimeMutationResult{}, &Error{Code: "invalid_request", Message: "unsupported steer kind"}
	}
	input := map[string]any{
		"protocol": flowruntime.FlowRuntimeProtocol, "operation": "steer",
		"applicationRequestId": request.ApplicationRequestID, "ownerGeneration": request.OwnerGeneration,
		"runId": request.RunID, "messageId": request.MessageID, "createdAt": request.CreatedAt, "steer": steer,
	}
	return c.mutate(ctx, input)
}

func (c *Client) lifecycle(ctx context.Context, operation string, request flowruntime.FlowRuntimeLifecycle) (flowruntime.FlowRuntimeMutationResult, error) {
	input := map[string]any{
		"protocol": flowruntime.FlowRuntimeProtocol, "operation": operation,
		"applicationRequestId": request.ApplicationRequestID, "ownerGeneration": request.OwnerGeneration,
		"runId": request.RunID,
	}
	if request.Reason != "" {
		input["reason"] = request.Reason
	}
	return c.mutate(ctx, input)
}

func (c *Client) Cancel(ctx context.Context, request flowruntime.FlowRuntimeLifecycle) (flowruntime.FlowRuntimeMutationResult, error) {
	return c.lifecycle(ctx, "cancel", request)
}

func (c *Client) Resume(ctx context.Context, request flowruntime.FlowRuntimeLifecycle) (flowruntime.FlowRuntimeMutationResult, error) {
	return c.lifecycle(ctx, "resume", request)
}

func (c *Client) mutate(ctx context.Context, input any) (flowruntime.FlowRuntimeMutationResult, error) {
	envelope, err := c.command(ctx, input)
	if err != nil {
		return flowruntime.FlowRuntimeMutationResult{}, err
	}
	return flowruntime.FlowRuntimeMutationResult{
		Operation: envelope.Value.Operation, ApplicationRequestID: envelope.Value.ApplicationRequestID, Receipt: envelope.Value.Receipt,
	}, nil
}

func (c *Client) Observe(ctx context.Context, runID, afterCursor string, limit int) (flowruntime.FlowRuntimeObservation, error) {
	input := map[string]any{"protocol": flowruntime.FlowRuntimeProtocol, "runId": runID}
	if afterCursor != "" {
		input["afterCursor"] = afterCursor
	}
	if limit > 0 {
		input["limit"] = limit
	}
	var envelope observeEnvelope
	if err := c.post(ctx, "/runtime/v1/observe", input, &envelope); err != nil {
		return flowruntime.FlowRuntimeObservation{}, err
	}
	if err := checkEnvelope(envelope.Protocol, envelope.OK, envelope.Error); err != nil {
		return flowruntime.FlowRuntimeObservation{}, err
	}
	return flowruntime.FlowRuntimeObservation{
		Run: envelope.Value.Run, Events: envelope.Value.Events, NextCursor: envelope.Value.NextCursor,
		HasMore: envelope.Value.HasMore, Terminal: envelope.Value.Terminal,
	}, nil
}

var _ flowruntime.FlowRuntime = (*Client)(nil)

// IsRetryable reports whether reconciliation may safely repeat an operation.
func IsRetryable(err error) bool {
	var bridgeError *Error
	return errors.As(err, &bridgeError) && bridgeError.Retryable
}

// ErrorCode returns the stable bridge code without exposing transport details.
func ErrorCode(err error) string {
	var bridgeError *Error
	if errors.As(err, &bridgeError) {
		return bridgeError.Code
	}
	return fmt.Sprintf("%T", err)
}
