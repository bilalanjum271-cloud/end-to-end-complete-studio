package main

import (
	"database/sql"
	"net/http"
	"os"
	"time"

	_ "github.com/lib/pq"

	"github.com/xen-studio/xen-studio/packages/go/platform/httpx"
	"github.com/xen-studio/xen-studio/packages/go/platform/obs"
	"github.com/xen-studio/xen-studio/services/ledger/internal/ledger"
)

func main() {
	log := obs.NewLogger("ledger")
	db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Error("db open", "err", err)
		os.Exit(1)
	}
	db.SetMaxOpenConns(40)
	db.SetMaxIdleConns(20)
	db.SetConnMaxLifetime(30 * time.Minute)

	token := os.Getenv("INTERNAL_SERVICE_TOKEN")
	if token == "" {
		log.Error("INTERNAL_SERVICE_TOKEN is required")
		os.Exit(1)
	}
	api := &ledger.API{Store: ledger.NewStore(db), Log: log, Reg: obs.NewRegistry(), InternalToken: token, GatewayToken: token}
	srv := &http.Server{Addr: httpx.Env("LEDGER_ADDR", ":8102"), Handler: api.Handler(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second}
	log.Info("ledger listening", "addr", srv.Addr)
	if err := httpx.Serve(srv); err != nil && err != http.ErrServerClosed {
		log.Error("server", "err", err)
		os.Exit(1)
	}
}
