package repohostserver

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

type appError struct {
	StatusCode int
	Code       string
	Message    string
	Cause      error
	// RetryAfter, when > 0, is written as the Retry-After header, in seconds.
	RetryAfter int
}

type errorEnvelope struct {
	Code    string   `json:"code,omitempty"`
	Message string   `json:"message"`
	Errors  []string `json:"errors,omitempty"`
}

func (e *appError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Cause)
	}
	return e.Message
}

func badRequest(message string) *appError {
	return &appError{StatusCode: http.StatusBadRequest, Message: message}
}

func unauthorized(message string) *appError {
	return &appError{StatusCode: http.StatusUnauthorized, Message: message}
}

func forbidden(message string) *appError {
	return &appError{StatusCode: http.StatusForbidden, Message: message}
}

func notFound(message string) *appError {
	return &appError{StatusCode: http.StatusNotFound, Message: message}
}

func conflict(message string) *appError {
	return &appError{StatusCode: http.StatusConflict, Message: message}
}

func unprocessableEntity(message string) *appError {
	return &appError{StatusCode: http.StatusUnprocessableEntity, Message: message}
}

func conflictCode(code, message string) *appError {
	return &appError{StatusCode: http.StatusConflict, Code: code, Message: message}
}

func internalError(message string, cause error) *appError {
	return &appError{StatusCode: http.StatusInternalServerError, Message: message, Cause: cause}
}

func mapFFIError(err error) *appError {
	if err == nil {
		return nil
	}
	if appErr, ok := err.(*appError); ok {
		return appErr
	}
	if ffiErr, ok := err.(*repohostffi.Error); ok {
		switch ffiErr.StatusCode() {
		case http.StatusBadRequest:
			return badRequest(ffiErr.Message)
		case http.StatusNotFound:
			return notFound(ffiErr.Message)
		case http.StatusConflict:
			return conflict(ffiErr.Message)
		case http.StatusUnprocessableEntity:
			return unprocessableEntity(ffiErr.Message)
		default:
			return internalError("internal server error", ffiErr)
		}
	}
	return internalError("internal server error", err)
}

func writeJSON(w http.ResponseWriter, statusCode int, value any) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	return json.NewEncoder(w).Encode(value)
}

func writeAppError(w http.ResponseWriter, err error, logger *slog.Logger) {
	appErr := mapFFIError(err)
	if appErr == nil {
		return
	}
	if appErr.StatusCode >= http.StatusInternalServerError && logger != nil && appErr.Cause != nil {
		logger.Error("repo-host handler failed", "error", appErr.Cause)
	}
	setErrorHeaders(w, appErr)
	_ = writeJSON(w, appErr.StatusCode, errorEnvelope{Code: appErr.Code, Message: appErr.Message})
}

// writeGitAppError answers a git smart-HTTP request with err as plain text,
// which git shows the user ("remote: ..."); its code is in
// X-Smithers-Error-Code.
func writeGitAppError(w http.ResponseWriter, err error, logger *slog.Logger) {
	appErr := mapFFIError(err)
	if appErr == nil {
		return
	}
	if appErr.StatusCode >= http.StatusInternalServerError && logger != nil && appErr.Cause != nil {
		logger.Error("repo-host handler failed", "error", appErr.Cause)
	}
	setErrorHeaders(w, appErr)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(appErr.StatusCode)
	_, _ = io.WriteString(w, appErr.Message+"\n")
}

func setErrorHeaders(w http.ResponseWriter, appErr *appError) {
	if appErr.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(appErr.RetryAfter))
	}
	if appErr.Code != "" {
		w.Header().Set("X-Smithers-Error-Code", appErr.Code)
	}
}
