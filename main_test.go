package main

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/mj41/s-w42-eu-assets/robot3d"
)

func load(t *testing.T) (Parts, []App) {
	t.Helper()
	p, err := loadParts(files)
	if err != nil {
		t.Fatal(err)
	}
	apps, err := loadApps(files)
	if err != nil {
		t.Fatal(err)
	}
	return p, apps
}

func checkSource(t *testing.T, what string, s Source) {
	t.Helper()
	if s.URL != "" {
		if !strings.HasPrefix(s.URL, "https://docs.m5stack.com/") || s.Repo != "" || s.Quote == "" {
			t.Errorf("%s: a docs source is an M5Stack docs page and a quote: %+v", what, s)
		}
		return
	}
	if s.Repo == "" || len(s.Ref) != 40 || s.Path == "" || s.Line < 1 || s.Quote == "" {
		t.Errorf("%s: incomplete source %+v", what, s)
	}
}

// The robot's part names in robot.glb: robot3d's and the screen.
func modelParts() map[string]robot3d.Part {
	m := map[string]robot3d.Part{}
	for _, p := range robot3d.Parts() {
		m[p.Name] = p
	}
	return m
}

func TestParts(t *testing.T) {
	p, _ := load(t)
	if len(p.Parts) == 0 {
		t.Fatal("no parts")
	}
	model := modelParts()
	seen := map[string]bool{}
	for _, e := range p.Parts {
		seen[e.ID] = true
	}
	for _, e := range p.Parts {
		for _, w := range e.With {
			if !seen[w] || w == e.ID {
				t.Errorf("%s: with %q, not another part", e.ID, w)
			}
		}
	}
	seen = map[string]bool{}
	for _, e := range p.Parts {
		if e.ID == "" || e.Name == "" || e.Does == "" || e.Chip == "" {
			t.Errorf("%q: id, name, chip and what it does are needed", e.ID)
		}
		if seen[e.ID] {
			t.Errorf("%s: twice", e.ID)
		}
		seen[e.ID] = true
		if e.Kind != "sensor" && e.Kind != "actuator" {
			t.Errorf("%s: kind %q", e.ID, e.Kind)
		}
		if len(e.Sources) == 0 {
			t.Errorf("%s: no source", e.ID)
		}
		for _, s := range e.Sources {
			checkSource(t, e.ID, s)
		}
		if len(e.With) > 0 && e.Where != nil {
			t.Errorf("%s: with %v and a where of its own", e.ID, e.With)
		}
		if e.Where == nil {
			continue
		}
		w := e.Where
		if w.Area != "" && w.Area != "screen" {
			t.Errorf("%s: area %q", e.ID, w.Area)
		}
		if w.Out != nil && (len(w.Out) != 3 || w.Out[0] == 0 && w.Out[1] == 0 && w.Out[2] == 0) {
			t.Errorf("%s: out %v: a direction", e.ID, w.Out)
		}
		checkSource(t, e.ID+" where", w.Source)
		switch w.How {
		case "exact", "joint", "inside", "near":
		default:
			t.Errorf("%s: how %q", e.ID, w.How)
		}
		mp, ok := model[w.Part]
		if !ok {
			t.Errorf("%s: part %q is not one of robot3d's", e.ID, w.Part)
			continue
		}
		// The offset is on or in its part: within its bounds (0.5 mm to spare).
		lo, hi := mp.Positions[0], mp.Positions[0]
		for _, v := range mp.Positions {
			lo = robot3d.V3{X: min(lo.X, v.X), Y: min(lo.Y, v.Y), Z: min(lo.Z, v.Z)}
			hi = robot3d.V3{X: max(hi.X, v.X), Y: max(hi.Y, v.Y), Z: max(hi.Z, v.Z)}
		}
		o := w.Offset
		if o[0] < lo.X-0.5 || o[0] > hi.X+0.5 || o[1] < lo.Y-0.5 || o[1] > hi.Y+0.5 || o[2] < lo.Z-0.5 || o[2] > hi.Z+0.5 {
			t.Errorf("%s: offset %v outside %s (%+v to %+v)", e.ID, o, w.Part, lo, hi)
		}
	}
}

// The places taken from robot3d's exported values are those values.
func TestPlaces(t *testing.T) {
	p, _ := load(t)
	at := map[string][3]float64{}
	for _, e := range p.Parts {
		if e.Where != nil {
			at[e.ID] = e.Where.Offset
		}
	}
	c, _, _ := robot3d.Screen()
	pv := robot3d.PitchPivot()
	for id, want := range map[string]robot3d.V3{"display": c, "touch-screen": c, "pitch-servo": pv} {
		got := at[id]
		if math.Abs(got[0]-want.X)+math.Abs(got[1]-want.Y)+math.Abs(got[2]-want.Z) > 1e-9 {
			t.Errorf("%s at %v, robot3d %+v", id, got, want)
		}
	}
}

func TestApps(t *testing.T) {
	p, apps := load(t)
	ids := map[string]bool{}
	for _, e := range p.Parts {
		ids[e.ID] = true
	}
	got := map[string]bool{}
	for _, a := range apps {
		got[a.ID] = true
		if a.Name == "" || a.About == "" || a.Repo == "" || len(a.Sources) == 0 || len(a.Uses) == 0 {
			t.Errorf("%s: name, about, repo, sources and uses are needed", a.ID)
		}
		for _, s := range a.Sources {
			checkSource(t, a.ID, s)
		}
		if l := a.LEDs; l != nil {
			if !regexp.MustCompile(`^#[0-9a-f]{6}$`).MatchString(l.Color) || l.Does == "" || len(l.Sources) == 0 {
				t.Errorf("%s: leds %+v: a #rrggbb colour, what it shows and a source are needed", a.ID, l)
			}
			if l.Each != "" {
				each := strings.Split(l.Each, ",")
				if m := regexp.MustCompile(`^(#[0-9a-f]{6})\*12$`).FindStringSubmatch(l.Each); m != nil {
					each = []string{m[1]}
				} else if len(each) != 12 {
					t.Errorf("%s: leds each %q: 12 LEDs, not %d", a.ID, l.Each, len(each))
				}
				for _, c := range each {
					if c != "" && c != l.Color {
						t.Errorf("%s: leds each %q: %q, its colour is %s", a.ID, l.Each, c, l.Color)
					}
				}
			}
			for _, s := range l.Sources {
				checkSource(t, a.ID+" leds", s)
			}
		}
		used := map[string]bool{}
		for _, u := range a.Uses {
			if !ids[u.Part] {
				t.Errorf("%s: uses %q, not in parts.json", a.ID, u.Part)
			}
			if used[u.Part] {
				t.Errorf("%s: %s twice", a.ID, u.Part)
			}
			used[u.Part] = true
			if u.Does == "" || len(u.Sources) == 0 {
				t.Errorf("%s %s: what it does and a source are needed", a.ID, u.Part)
			}
			for _, s := range u.Sources {
				checkSource(t, a.ID+" "+u.Part, s)
			}
		}
	}
	for _, id := range []string{"pet", "focus", "raw"} {
		if !got[id] {
			t.Errorf("app %s missing", id)
		}
	}
}

// Every source's quote is on its line, at its commit, in the repos cloned beside this one
// (setup.sh); skipped where a repo or git is not there.
func TestSourcesQuoted(t *testing.T) {
	p, apps := load(t)
	var all []Source
	for _, e := range p.Parts {
		all = append(all, e.Sources...)
		if e.Where != nil {
			all = append(all, e.Where.Source)
		}
	}
	for _, a := range apps {
		all = append(all, a.Sources...)
		if a.LEDs != nil {
			all = append(all, a.LEDs.Sources...)
		}
		for _, u := range a.Uses {
			all = append(all, u.Sources...)
		}
	}
	cache := map[string][]string{}
	checked := 0
	for _, s := range all {
		if s.URL != "" { // a docs page: not in a repo
			continue
		}
		dir := filepath.Join("..", s.Repo)
		if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
			continue
		}
		k := s.Repo + "@" + s.Ref + ":" + s.Path
		lines, ok := cache[k]
		if !ok {
			out, err := exec.Command("git", "-C", dir, "show", s.Ref+":"+s.Path).Output()
			if err != nil {
				t.Errorf("%s: %v", k, err)
				cache[k] = nil
				continue
			}
			lines = strings.Split(string(out), "\n")
			cache[k] = lines
		}
		if lines == nil {
			continue
		}
		if s.Line > len(lines) || !strings.Contains(lines[s.Line-1], s.Quote) {
			t.Errorf("%s line %d: %q not there", k, s.Line, s.Quote)
		}
		checked++
	}
	if checked == 0 {
		t.Skip("no related repos beside this one (setup.sh)")
	}
	t.Logf("%d of %d sources checked against the repos beside this one", checked, len(all))
}

func TestServe(t *testing.T) {
	h, err := handler()
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	for p, want := range map[string]int{
		"/": 200, "/app.js": 200, "/robot.glb": 200, "/data/parts.json": 200, "/data/apps.json": 200,
		"/healthz": 200, "/main.go": 404, "/web/index.html": 404, "/data/apps/pet.json": 404,
	} {
		res, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != want {
			t.Errorf("%s: %d, want %d", p, res.StatusCode, want)
		}
		switch p {
		case "/":
			csp := res.Header.Get("Content-Security-Policy")
			if !strings.Contains(csp, "'sha256-") || !strings.Contains(csp, "https://cdn.jsdelivr.net") {
				t.Errorf("CSP %q", csp)
			}
		case "/data/apps.json":
			var v struct{ Apps []App }
			if err := json.Unmarshal(b, &v); err != nil || len(v.Apps) < 2 {
				t.Errorf("apps.json: %v, %d apps", err, len(v.Apps))
			}
		case "/robot.glb":
			if len(b) < 12 || string(b[:4]) != "glTF" {
				t.Error("robot.glb: not a glTF binary")
			}
		}
	}
}
