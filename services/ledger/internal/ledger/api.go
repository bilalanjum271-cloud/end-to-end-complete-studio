package ledger

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/xen-studio/xen-studio/packages/go/platform/httpx"
	"github.com/xen-studio/xen-studio/packages/go/platform/obs"
)

type API struct {
	Store         *Store
	Log           *slog.Logger
	Reg           *obs.Registry
	InternalToken string // service-to-service writes
	GatewayToken  string // proves a request came through the gateway (tenant headers trusted)
}

func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	obs.MountOps(mux, a.Reg, a.Store.Ping)

	internal := func(h http.HandlerFunc) http.Handler {
		return httpx.RequireToken("X-Internal-Token", a.InternalToken, h)
	}
	mux.Handle("POST /internal/v1/workspaces/{ws}/credits/grant", internal(a.grant))
	mux.Handle("POST /internal/v1/workspaces/{ws}/credits/reserve", internal(a.reserve))
	mux.Handle("POST /internal/v1/workspaces/{ws}/reservations/{id}/commit", internal(a.commit))
	mux.Handle("POST /internal/v1/workspaces/{ws}/reservations/{id}/release", internal(a.release))
	mux.Handle("GET /internal/v1/workspaces/{ws}/credits", internal(a.balanceInternal))

	// Tenant-facing reads. The gateway verifies the JWT and injects X-Workspace-Id.
	viaGateway := func(h http.HandlerFunc) http.Handler {
		return httpx.RequireToken("X-Gateway-Token", a.GatewayToken, h)
	}
	mux.Handle("GET /v1/credits", viaGateway(a.balance))
	mux.Handle("GET /v1/credits/ledger", viaGateway(a.entries))
	return obs.Middleware("ledger", a.Log, a.Reg, mux)
}

func (a *API) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrInsufficient):
		httpx.Error(w, http.StatusPaymentRequired, "insufficient_credits", "not enough credits for this operation")
	case errors.Is(err, ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, ErrAlreadySettled), errors.Is(err, ErrKeyConflict):
		httpx.Error(w, http.StatusConflict, "conflict", err.Error())
	case errors.Is(err, ErrInvalid):
		httpx.Error(w, http.StatusBadRequest, "invalid_argument", err.Error())
	default:
		a.Log.Error("ledger error", "request_id", obs.RequestID(r.Context()), "err", err)
		httpx.Error(w, http.StatusInternalServerError, "internal", "internal error")
	}
}

func (a *API) ws(w http.ResponseWriter, r *http.Request) (string, bool) {
	ws := r.PathValue("ws")
	if !httpx.IsUUID(ws) {
		httpx.Error(w, http.StatusBadRequest, "invalid_argument", "workspace id must be a UUID")
		return "", false
	}
	return ws, true
}

func (a *API) done(w http.ResponseWriter, e *Entry) {
	a.Reg.Counter("ledger_writes_total", "type", e.Type, "replayed", strconv.FormatBool(e.Replayed)).Inc()
	status := http.StatusCreated
	if e.Replayed {
		status = http.StatusOK
	}
	httpx.JSON(w, status, e)
}

func (a *API) grant(w http.ResponseWriter, r *http.Request) {
	ws, ok := a.ws(w, r)
	if !ok {
		return
	}
	var in struct {
		Amount int64  `json:"amount"`
		Reason string `json:"reason"`
	}
	if err := httpx.Decode(w, r, &in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_argument", err.Error())
		return
	}
	e, err := a.Store.Grant(r.Context(), ws, r.Header.Get("Idempotency-Key"), in.Amount, in.Reason)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.done(w, e)
}

func (a *API) reserve(w http.ResponseWriter, r *http.Request) {
	ws, ok := a.ws(w, r)
	if !ok {
		return
	}
	var in struct {
		Amount int64  `json:"amount"`
		JobID  string `json:"job_id"`
	}
	if err := httpx.Decode(w, r, &in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_argument", err.Error())
		return
	}
	e, err := a.Store.Reserve(r.Context(), ws, r.Header.Get("Idempotency-Key"), in.Amount, in.JobID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.done(w, e)
}

func (a *API) commit(w http.ResponseWriter, r *http.Request) {
	ws, ok := a.ws(w, r)
	if !ok {
		return
	}
	var in struct {
		Amount int64 `json:"amount"`
	}
	if r.ContentLength != 0 {
		if err := httpx.Decode(w, r, &in); err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_argument", err.Error())
			return
		}
	}
	id := r.PathValue("id")
	if !httpx.IsUUID(id) {
		httpx.Error(w, http.StatusBadRequest, "invalid_argument", "reservation id must be a UUID")
		return
	}
	e, err := a.Store.Commit(r.Context(), ws, r.Header.Get("Idempotency-Key"), id, in.Amount)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.done(w, e)
}

func (a *API) release(w http.ResponseWriter, r *http.Request) {
	ws, ok := a.ws(w, r)
	if !ok {
		return
	}
	var in struct {
		Reason string `json:"reason"`
	}
	if r.ContentLength != 0 {
		if err := httpx.Decode(w, r, &in); err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_argument", err.Error())
			return
		}
	}
	id := r.PathValue("id")
	if !httpx.IsUUID(id) {
		httpx.Error(w, http.StatusBadRequest, "invalid_argument", "reservation id must be a UUID")
		return
	}
	e, err := a.Store.Release(r.Context(), ws, r.Header.Get("Idempotency-Key"), id, in.Reason)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.done(w, e)
}

func (a *API) balanceInternal(w http.ResponseWriter, r *http.Request) {
	ws, ok := a.ws(w, r)
	if !ok {
		return
	}
	b, err := a.Store.Balance(r.Context(), ws)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, b)
}

func (a *API) tenant(w http.ResponseWriter, r *http.Request) (string, bool) {
	ws := r.Header.Get("X-Workspace-Id")
	if !httpx.IsUUID(ws) {
		httpx.Error(w, http.StatusForbidden, "forbidden", "no workspace selected")
		return "", false
	}
	return ws, true
}

func (a *API) balance(w http.ResponseWriter, r *http.Request) {
	ws, ok := a.tenant(w, r)
	if !ok {
		return
	}
	b, err := a.Store.Balance(r.Context(), ws)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, b)
}

func (a *API) entries(w http.ResponseWriter, r *http.Request) {
	ws, ok := a.tenant(w, r)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	es, err := a.Store.Entries(r.Context(), ws, limit)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"entries": es})
}
