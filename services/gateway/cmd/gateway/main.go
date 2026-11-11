package main

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/xen-studio/xen-studio/packages/go/platform/httpx"
	"github.com/xen-studio/xen-studio/packages/go/platform/obs"
	"github.com/xen-studio/xen-studio/services/gateway/internal/gateway"
)

func main() {
	log := obs.NewLogger("gateway")
	reg := obs.NewRegistry()

	opt, err := redis.ParseURL(httpx.Env("REDIS_URL", "redis://localhost:6379"))
	if err != nil {
		log.Error("REDIS_URL", "err", err)
		os.Exit(1)
	}
	rdb := redis.NewClient(opt)
	limiter := &gateway.FallbackLimiter{
		Primary:   &gateway.RedisLimiter{Client: rdb},
		Secondary: gateway.NewMemLimiter(),
		OnDegrade: func(err error) { reg.Counter("gateway_ratelimit_degraded_total").Inc() },
	}
	maxInflight, _ := strconv.ParseInt(httpx.Env("GATEWAY_MAX_INFLIGHT", "4000"), 10, 64)

	gw, err := gateway.New(gateway.Config{
		JWTSecret:    []byte(os.Getenv("JWT_SECRET")),
		GatewayToken: os.Getenv("INTERNAL_SERVICE_TOKEN"),
		Upstreams: map[string]string{
			"identity": httpx.Env("IDENTITY_URL", "http://localhost:8101"),
			"ledger":   httpx.Env("LEDGER_URL", "http://localhost:8102"),
		},
		Routes:      gateway.DefaultRoutes(),
		MaxInflight: maxInflight,
		Limiter:     limiter,
		Log:         log,
		Reg:         reg,
		// Redis being down degrades rate limiting but must not take the gateway out of rotation.
		Ready: func() error { _ = rdb.Ping(context.Background()).Err(); return nil },
	})
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(1)
	}
	srv := &http.Server{Addr: httpx.Env("GATEWAY_ADDR", ":8080"), Handler: gw.Handler(),
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 120 * time.Second}
	log.Info("gateway listening", "addr", srv.Addr)
	if err := httpx.Serve(srv); err != nil && err != http.ErrServerClosed {
		log.Error("server", "err", err)
		os.Exit(1)
	}
}
