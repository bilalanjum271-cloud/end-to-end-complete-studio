package router

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/xen-studio/xen-studio/packages/go/platform/httpx"
	"github.com/xen-studio/xen-studio/packages/go/platform/obs"
)

type API struct {
	Router        *Router
	Store         Store
	Log           *slog.Logger
	Reg           *obs.Registry
	InternalToken string
}

func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	obs.MountOps(mux, a.Reg, a.Store.Ping)
	guard := func(h http.HandlerFunc) http.Handler {
		return httpx.RequireToken("X-Internal-Token", a.InternalToken, h)
	}

	// Called by the global edge and by gateways. Returns the cell that owns the workspace.
	mux.Handle("GET /internal/v1/route/{ws}", guard(a.route))
	mux.Handle("GET /internal/v1/cells", guard(a.listCells))
	mux.Handle("PUT /internal/v1/cells/{id}", guard(a.putCell))
	mux.Handle("POST /internal/v1/workspaces/{ws}/move", guard(a.move))
	return obs.Middleware("cell-router", a.Log, a.Reg, mux)
}

func (a *API) route(w http.ResponseWriter, r *http.Request) {
	ws := r.PathValue("ws")
	if !httpx.IsUUID(ws) {
		httpx.Error(w, http.StatusBadRequest, "invalid_argument", "workspace id must be a UUID")
		return
	}
	cell, err := a.Router.Route(r.Context(), ws)
	switch {
	case errors.Is(err, ErrNoCells):
		httpx.Error(w, http.StatusServiceUnavailable, "no_capacity", "no active cells")
	case err != nil:
		a.Log.Error("route", "err", err, "request_id", obs.RequestID(r.Context()))
		httpx.Error(w, http.StatusInternalServerError, "internal", "internal error")
	default:
		a.Reg.Counter("router_routes_total", "cell", cell.ID).Inc()
		w.Header().Set("Cache-Control", "private, max-age=30")
		httpx.JSON(w, http.StatusOK, map[string]any{"workspace_id": ws, "cell": cell})
	}
}

func (a *API) listCells(w http.ResponseWriter, r *http.Request) {
	cells, err := a.Store.Cells(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"cells": cells})
}

func (a *API) putCell(w http.ResponseWriter, r *http.Request) {
	var c Cell
	if err := httpx.Decode(w, r, &c); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_argument", err.Error())
		return
	}
	c.ID = r.PathValue("id")
	if c.Status == "" {
		c.Status = "active"
	}
	if c.ID == "" || c.Region == "" || c.Endpoint == "" || c.Weight < 0 ||
		(c.Status != "active" && c.Status != "draining" && c.Status != "offline") {
		httpx.Error(w, http.StatusBadRequest, "invalid_argument", "region, endpoint, weight>=0 and a valid status are required")
		return
	}
	if err := a.Store.UpsertCell(r.Context(), c); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	a.Router.Invalidate()
	httpx.JSON(w, http.StatusOK, c)
}

func (a *API) move(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CellID string `json:"cell_id"`
	}
	ws := r.PathValue("ws")
	if err := httpx.Decode(w, r, &in); err != nil || !httpx.IsUUID(ws) || in.CellID == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_argument", "workspace UUID and cell_id are required")
		return
	}
	if err := a.Store.Move(r.Context(), ws, in.CellID); err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "cell not found")
		return
	}
	a.Router.Invalidate()
	httpx.JSON(w, http.StatusOK, map[string]string{"workspace_id": ws, "cell_id": in.CellID})
}
