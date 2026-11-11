// Package obs provides logging, metrics and HTTP middleware shared by the Go hot-path services.
// Metrics are exposed in the Prometheus text format without pulling a client library into
// the hot path (see DECISIONS.md D-012).
package obs

import (
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

type Registry struct {
	mu       sync.RWMutex
	counters map[string]*Counter
	gauges   map[string]*Gauge
	hists    map[string]*Histogram
	help     map[string]string
}

func NewRegistry() *Registry {
	return &Registry{counters: map[string]*Counter{}, gauges: map[string]*Gauge{}, hists: map[string]*Histogram{}, help: map[string]string{}}
}

type Counter struct{ v atomic.Uint64 }

func (c *Counter) Inc()          { c.v.Add(1) }
func (c *Counter) Add(n uint64)  { c.v.Add(n) }
func (c *Counter) Value() uint64 { return c.v.Load() }

type Gauge struct{ v atomic.Int64 }

func (g *Gauge) Set(n int64)  { g.v.Store(n) }
func (g *Gauge) Add(n int64)  { g.v.Add(n) }
func (g *Gauge) Value() int64 { return g.v.Load() }

var defaultBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

type Histogram struct {
	mu     sync.Mutex
	counts []uint64
	sum    float64
	total  uint64
}

func (h *Histogram) Observe(v float64) {
	h.mu.Lock()
	for i, b := range defaultBuckets {
		if v <= b {
			h.counts[i]++
		}
	}
	h.sum += v
	h.total++
	h.mu.Unlock()
}

func key(name string, labels []string) string {
	if len(labels) == 0 {
		return name
	}
	parts := make([]string, 0, len(labels)/2)
	for i := 0; i+1 < len(labels); i += 2 {
		parts = append(parts, fmt.Sprintf(`%s=%q`, labels[i], labels[i+1]))
	}
	return name + "{" + strings.Join(parts, ",") + "}"
}

// Counter returns the counter for name and label pairs ("k1","v1","k2","v2").
func (r *Registry) Counter(name string, labels ...string) *Counter {
	k := key(name, labels)
	r.mu.RLock()
	c, ok := r.counters[k]
	r.mu.RUnlock()
	if ok {
		return c
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if c, ok = r.counters[k]; !ok {
		c = &Counter{}
		r.counters[k] = c
	}
	return c
}

func (r *Registry) Gauge(name string, labels ...string) *Gauge {
	k := key(name, labels)
	r.mu.Lock()
	defer r.mu.Unlock()
	g, ok := r.gauges[k]
	if !ok {
		g = &Gauge{}
		r.gauges[k] = g
	}
	return g
}

func (r *Registry) Histogram(name string, labels ...string) *Histogram {
	k := key(name, labels)
	r.mu.RLock()
	h, ok := r.hists[k]
	r.mu.RUnlock()
	if ok {
		return h
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if h, ok = r.hists[k]; !ok {
		h = &Histogram{counts: make([]uint64, len(defaultBuckets))}
		r.hists[k] = h
	}
	return h
}

// WriteText writes all metrics in Prometheus exposition format.
func (r *Registry) WriteText(w io.Writer) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	keys := make([]string, 0, len(r.counters))
	for k := range r.counters {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(w, "%s %d\n", k, r.counters[k].Value())
	}
	keys = keys[:0]
	for k := range r.gauges {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(w, "%s %d\n", k, r.gauges[k].Value())
	}
	keys = keys[:0]
	for k := range r.hists {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		h := r.hists[k]
		name, labels := k, ""
		if i := strings.IndexByte(k, '{'); i >= 0 {
			name, labels = k[:i], strings.TrimSuffix(k[i+1:], "}")+","
		}
		h.mu.Lock()
		for i, b := range defaultBuckets {
			fmt.Fprintf(w, "%s_bucket{%sle=\"%g\"} %d\n", name, labels, b, h.counts[i])
		}
		fmt.Fprintf(w, "%s_bucket{%sle=\"+Inf\"} %d\n", name, labels, h.total)
		sum := h.sum
		if math.IsNaN(sum) {
			sum = 0
		}
		fmt.Fprintf(w, "%s_sum{%s} %g\n%s_count{%s} %d\n", name, strings.TrimSuffix(labels, ","), sum, name, strings.TrimSuffix(labels, ","), h.total)
		h.mu.Unlock()
	}
}
