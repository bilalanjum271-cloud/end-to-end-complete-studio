package main

import (
	"database/sql"
	"net/http"
	"os"
	"time"

	_ "github.com/lib/pq"

	"github.com/xen-studio/xen-studio/packages/go/platform/httpx"
	"github.com/xen-studio/xen-studio/packages/go/platform/obs"
	"github.com/xen-studio/xen-studio/services/cell-router/internal/router"
)

func main() {
	log := obs.NewLogger("cell-router")
	db, err := sql.Open("postgres", httpx.Env("GLOBAL_DATABASE_URL", os.Getenv("DATABASE_URL")))
	if err != nil {
		log.Error("db open", "err", err)
		os.Exit(1)
	}
	db.SetMaxOpenConns(20)
	token := os.Getenv("INTERNAL_SERVICE_TOKEN")
	if token == "" {
		log.Error("INTERNAL_SERVICE_TOKEN is required")
		os.Exit(1)
	}
	store := &router.SQLStore{DB: db}
	api := &router.API{Router: router.New(store, 30*time.Second), Store: store, Log: log, Reg: obs.NewRegistry(), InternalToken: token}
	srv := &http.Server{Addr: httpx.Env("ROUTER_ADDR", ":8103"), Handler: api.Handler(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	log.Info("cell-router listening", "addr", srv.Addr)
	if err := httpx.Serve(srv); err != nil && err != http.ErrServerClosed {
		log.Error("server", "err", err)
		os.Exit(1)
	}
}
