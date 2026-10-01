package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type AdminGrantRouteService interface {
	Grant(context.Context, *db.User, services.AdminGrantRequest) (services.AdminGrantResult, error)
}

type AdminGrantHandler struct{ Service AdminGrantRouteService }

func (h *AdminGrantHandler) Grant(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("credit ledger unavailable"))
		return
	}
	var body struct {
		Login        string          `json:"login"`
		AmountUSD    json.RawMessage `json:"amountUsd"`
		OperationKey string          `json:"operationKey"`
	}
	if !decodeStrictJSONBody(w, r, &body) {
		return
	}
	raw := bytes.TrimSpace(body.AmountUSD)
	var amount json.Number
	if len(raw) == 0 || len(raw) > 64 || raw[0] == '"' || string(raw) == "null" || json.Unmarshal(raw, &amount) != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("amountUsd must be a number"))
		return
	}
	result, err := h.Service.Grant(adminUserAuditContext(r), middleware.UserFromContext(r.Context()), services.AdminGrantRequest{
		Login: body.Login, AmountUSD: amount, OperationKey: body.OperationKey,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}
