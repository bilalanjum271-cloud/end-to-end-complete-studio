package router

import (
	"context"
	"fmt"
	"math"
	"sync"
	"testing"
	"time"
)

func cells(n int) []Cell {
	out := make([]Cell, n)
	for i := range out {
		out[i] = Cell{ID: fmt.Sprintf("cell-%d", i), Region: "r", Endpoint: "http://x", Status: "active", Weight: 100}
	}
	return out
}

func TestPickIsDeterministicAndBalanced(t *testing.T) {
	cs := cells(8)
	count := map[string]int{}
	for i := 0; i < 40000; i++ {
		ws := fmt.Sprintf("ws-%d", i)
		a, _ := Pick(ws, cs)
		b, _ := Pick(ws, cs)
		if a.ID != b.ID {
			t.Fatal("pick must be deterministic")
		}
		count[a.ID]++
	}
	for id, n := range count {
		if math.Abs(float64(n)-5000) > 400 {
			t.Fatalf("%s got %d of 40000, want about 5000", id, n)
		}
	}
}

func TestPickRespectsWeightAndStatus(t *testing.T) {
	cs := cells(3)
	cs[0].Weight = 300
	cs[2].Status = "draining"
	count := map[string]int{}
	for i := 0; i < 20000; i++ {
		c, _ := Pick(fmt.Sprintf("w%d", i), cs)
		count[c.ID]++
	}
	if count["cell-2"] != 0 {
		t.Fatal("draining cells must not receive new workspaces")
	}
	ratio := float64(count["cell-0"]) / float64(count["cell-1"])
	if ratio < 2.6 || ratio > 3.4 {
		t.Fatalf("weight 300 vs 100 gave ratio %.2f, want about 3", ratio)
	}
	if _, err := Pick("w", []Cell{cs[2]}); err != ErrNoCells {
		t.Fatalf("want ErrNoCells, got %v", err)
	}
}

func TestRemovingACellOnlyRemapsItsShare(t *testing.T) {
	cs := cells(5)
	moved := 0
	for i := 0; i < 10000; i++ {
		ws := fmt.Sprintf("w%d", i)
		before, _ := Pick(ws, cs)
		after, _ := Pick(ws, cs[:4])
		if before.ID != after.ID {
			if before.ID != "cell-4" {
				t.Fatal("a workspace on a surviving cell must not move")
			}
			moved++
		}
	}
	if moved < 1700 || moved > 2300 {
		t.Fatalf("moved %d, want about 2000", moved)
	}
}

func TestRouteIsStickyWhenCapacityIsAdded(t *testing.T) {
	ctx := context.Background()
	st := NewMemStore()
	for _, c := range cells(2) {
		st.UpsertCell(ctx, c)
	}
	r := New(st, time.Millisecond)
	first := map[string]string{}
	for i := 0; i < 500; i++ {
		ws := fmt.Sprintf("w%d", i)
		c, err := r.Route(ctx, ws)
		if err != nil {
			t.Fatal(err)
		}
		first[ws] = c.ID
	}
	st.UpsertCell(ctx, Cell{ID: "cell-new", Region: "r", Endpoint: "http://y", Status: "active", Weight: 100})
	r.Invalidate()
	for ws, id := range first {
		c, _ := r.Route(ctx, ws)
		if c.ID != id {
			t.Fatalf("%s moved from %s to %s after adding a cell", ws, id, c.ID)
		}
	}
	onNew := 0
	for i := 0; i < 600; i++ {
		c, _ := r.Route(ctx, fmt.Sprintf("fresh-%d", i))
		if c.ID == "cell-new" {
			onNew++
		}
	}
	if onNew < 130 {
		t.Fatalf("new cell got %d of 600 new workspaces, want about 200", onNew)
	}
}

func TestConcurrentFirstRouteAgrees(t *testing.T) {
	ctx := context.Background()
	st := NewMemStore()
	for _, c := range cells(4) {
		st.UpsertCell(ctx, c)
	}
	var wg sync.WaitGroup
	got := make([]string, 32)
	for i := range got {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c, _ := New(st, time.Second).Route(ctx, "same-workspace")
			got[i] = c.ID
		}(i)
	}
	wg.Wait()
	for _, g := range got {
		if g != got[0] {
			t.Fatal("independent router replicas must agree on the cell")
		}
	}
}
