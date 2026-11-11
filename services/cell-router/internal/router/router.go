// Package router maps a workspace to the cell that serves it.
//
// A workspace is pinned to exactly one cell. The first lookup assigns one with weighted
// rendezvous hashing over the active cells and persists the choice; later lookups read
// the pin. Adding capacity means registering a new cell: new workspaces start landing
// on it immediately, existing workspaces stay put until explicitly moved.
package router

import (
	"context"
	"database/sql"
	"errors"
	"hash/fnv"
	"math"
	"sync"
	"time"
)

var (
	ErrNoCells  = errors.New("no active cells")
	ErrNotFound = errors.New("cell not found")
)

type Cell struct {
	ID       string `json:"id"`
	Region   string `json:"region"`
	Endpoint string `json:"endpoint"`
	Status   string `json:"status"`
	Weight   int    `json:"weight"`
}

type Store interface {
	Cells(ctx context.Context) ([]Cell, error)
	UpsertCell(ctx context.Context, c Cell) error
	Assignment(ctx context.Context, ws string) (string, error) // "" when unassigned
	Assign(ctx context.Context, ws, cell string) (string, error)
	Move(ctx context.Context, ws, cell string) error
	Ping(ctx context.Context) error
}

// Pick chooses a cell for ws by weighted rendezvous (highest random weight) hashing.
// It is deterministic, and removing one cell only remaps that cell's share.
func Pick(ws string, cells []Cell) (Cell, error) {
	var best Cell
	bestScore := math.Inf(-1)
	for _, c := range cells {
		if c.Status != "active" || c.Weight <= 0 {
			continue
		}
		h := fnv.New64a()
		h.Write([]byte(ws))
		h.Write([]byte{0})
		h.Write([]byte(c.ID))
		// map hash to (0,1), then score = -weight / ln(u)
		u := (float64(mix64(h.Sum64())>>11) + 0.5) / float64(1<<53)
		score := -float64(c.Weight) / math.Log(u)
		if score > bestScore {
			best, bestScore = c, score
		}
	}
	if best.ID == "" {
		return Cell{}, ErrNoCells
	}
	return best, nil
}

// mix64 is the splitmix64 finalizer. FNV alone avalanches poorly on the trailing bytes
// (cell ids often differ only in their last character), which skews the distribution.
func mix64(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	x ^= x >> 31
	return x
}

type cached struct {
	cell Cell
	at   time.Time
}

// Router resolves routes with a small bounded in-process cache. The cache holds only
// derived routing data (never session state), so any replica can serve any request.
type Router struct {
	store Store
	ttl   time.Duration
	max   int

	mu     sync.Mutex
	routes map[string]cached
	cells  []Cell
	cellAt time.Time
}

func New(store Store, ttl time.Duration) *Router {
	return &Router{store: store, ttl: ttl, max: 200_000, routes: map[string]cached{}}
}

func (r *Router) activeCells(ctx context.Context) ([]Cell, error) {
	r.mu.Lock()
	if r.cells != nil && time.Since(r.cellAt) < r.ttl {
		c := r.cells
		r.mu.Unlock()
		return c, nil
	}
	r.mu.Unlock()
	cells, err := r.store.Cells(ctx)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	r.cells, r.cellAt = cells, time.Now()
	r.mu.Unlock()
	return cells, nil
}

func (r *Router) Invalidate() {
	r.mu.Lock()
	r.routes, r.cells = map[string]cached{}, nil
	r.mu.Unlock()
}

func (r *Router) Route(ctx context.Context, ws string) (Cell, error) {
	r.mu.Lock()
	if c, ok := r.routes[ws]; ok && time.Since(c.at) < r.ttl {
		r.mu.Unlock()
		return c.cell, nil
	}
	r.mu.Unlock()

	cells, err := r.activeCells(ctx)
	if err != nil {
		return Cell{}, err
	}
	byID := map[string]Cell{}
	for _, c := range cells {
		byID[c.ID] = c
	}
	id, err := r.store.Assignment(ctx, ws)
	if err != nil {
		return Cell{}, err
	}
	if id == "" {
		pick, err := Pick(ws, cells)
		if err != nil {
			return Cell{}, err
		}
		// Assign is first-writer-wins, so concurrent routers agree on one cell.
		if id, err = r.store.Assign(ctx, ws, pick.ID); err != nil {
			return Cell{}, err
		}
	}
	cell, ok := byID[id]
	if !ok {
		return Cell{}, ErrNotFound
	}
	r.mu.Lock()
	if len(r.routes) >= r.max { // bounded: drop everything rather than grow without limit
		r.routes = map[string]cached{}
	}
	r.routes[ws] = cached{cell, time.Now()}
	r.mu.Unlock()
	return cell, nil
}

// ── PostgreSQL / distributed SQL store (global control-plane database) ──────────

type SQLStore struct{ DB *sql.DB }

func (s *SQLStore) Ping(ctx context.Context) error { return s.DB.PingContext(ctx) }

func (s *SQLStore) Cells(ctx context.Context) ([]Cell, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id, region, endpoint, status, weight FROM cells ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Cell{}
	for rows.Next() {
		var c Cell
		if err := rows.Scan(&c.ID, &c.Region, &c.Endpoint, &c.Status, &c.Weight); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *SQLStore) UpsertCell(ctx context.Context, c Cell) error {
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO cells (id, region, endpoint, status, weight) VALUES ($1,$2,$3,$4,$5)
		 ON CONFLICT (id) DO UPDATE SET region=excluded.region, endpoint=excluded.endpoint, status=excluded.status, weight=excluded.weight`,
		c.ID, c.Region, c.Endpoint, c.Status, c.Weight)
	return err
}

func (s *SQLStore) Assignment(ctx context.Context, ws string) (string, error) {
	var id string
	err := s.DB.QueryRowContext(ctx, `SELECT cell_id FROM workspace_cells WHERE workspace_id=$1`, ws).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

func (s *SQLStore) Assign(ctx context.Context, ws, cell string) (string, error) {
	if _, err := s.DB.ExecContext(ctx,
		`INSERT INTO workspace_cells (workspace_id, cell_id) VALUES ($1,$2) ON CONFLICT (workspace_id) DO NOTHING`, ws, cell); err != nil {
		return "", err
	}
	return s.Assignment(ctx, ws)
}

func (s *SQLStore) Move(ctx context.Context, ws, cell string) error {
	res, err := s.DB.ExecContext(ctx,
		`INSERT INTO workspace_cells (workspace_id, cell_id) VALUES ($1,$2)
		 ON CONFLICT (workspace_id) DO UPDATE SET cell_id=excluded.cell_id, assigned_at=now()`, ws, cell)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ── In-memory store for unit tests ───────────────────────────────────────────

type MemStore struct {
	mu     sync.Mutex
	cells  map[string]Cell
	assign map[string]string
}

func NewMemStore() *MemStore { return &MemStore{cells: map[string]Cell{}, assign: map[string]string{}} }

func (m *MemStore) Ping(context.Context) error { return nil }
func (m *MemStore) Cells(context.Context) ([]Cell, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Cell, 0, len(m.cells))
	for _, c := range m.cells {
		out = append(out, c)
	}
	return out, nil
}
func (m *MemStore) UpsertCell(_ context.Context, c Cell) error {
	m.mu.Lock()
	m.cells[c.ID] = c
	m.mu.Unlock()
	return nil
}
func (m *MemStore) Assignment(_ context.Context, ws string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.assign[ws], nil
}
func (m *MemStore) Assign(_ context.Context, ws, cell string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cur, ok := m.assign[ws]; ok {
		return cur, nil
	}
	m.assign[ws] = cell
	return cell, nil
}
func (m *MemStore) Move(_ context.Context, ws, cell string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.cells[cell]; !ok {
		return ErrNotFound
	}
	m.assign[ws] = cell
	return nil
}
