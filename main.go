// Command s3d-w42-eu serves s3d.w42.eu: the Stackchan robot in 3D (web/index.html, web/app.js,
// web/robot.glb from cmd/s3dgen), its sensors and actuators (data/parts.json) and what each app
// does with them (data/apps/*.json, served together as data/apps.json). Everything is embedded.
package main

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
)

//go:embed web/index.html web/app.js web/robot.glb data/parts.json data/apps/*.json
var files embed.FS

// Source is where an entry is described: a line of a file in one of the related repos
// (github.com/mj41/<repo>, at commit ref); quote is a piece of that line.
//
// Or a page of M5Stack's docs (url, under https://docs.m5stack.com/), e.g. the annotated picture
// of the robot there; quote is what it says (a label on the picture).
type Source struct {
	Repo  string `json:"repo,omitempty"`
	Ref   string `json:"ref,omitempty"`
	Path  string `json:"path,omitempty"`
	Line  int    `json:"line,omitempty"`
	URL   string `json:"url,omitempty"`
	Quote string `json:"quote"`
}

// Where is a place on the robot: a part of robot.glb and an offset in it (millimetres,
// robot3d's rest space).
type Where struct {
	Part   string     `json:"part"`
	Offset [3]float64 `json:"offset"`
	How    string     `json:"how"`             // exact, joint, inside, near
	Area   string     `json:"area,omitempty"`  // screen: the screen's rectangle, outlined
	Out    []float64  `json:"out,omitempty"`   // from where its marker is seen (at rest); none: out from the yaw axis
	Shape  *Shape     `json:"shape,omitempty"` // its outline on the robot; none: a dot
	Note   string     `json:"note"`
	Source Source     `json:"source"`
}

// Shape is a part's outline on the robot (mm), on its surface facing out: a circle (r), or a
// rect (w across, h up, corners rounded by r). Free: at the offset itself, not on the surface
// (e.g. a ring round the turntable).
type Shape struct {
	Kind string  `json:"kind"` // circle, rect
	R    float64 `json:"r,omitempty"`
	W    float64 `json:"w,omitempty"`
	H    float64 `json:"h,omitempty"`
	Free bool    `json:"free,omitempty"`
}

// Part is a sensor or an actuator.
type Part struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Kind    string   `json:"kind"`           // sensor, actuator
	With    []string `json:"with,omitempty"` // a feature of these parts: no place of its own
	Chip    string   `json:"chip"`
	Does    string   `json:"does"`
	Where   *Where   `json:"where,omitempty"` // nil: the docs do not say where
	Sources []Source `json:"sources"`
}

// Parts is data/parts.json.
type Parts struct {
	About string `json:"about"`
	Parts []Part `json:"parts"`
}

// Use is what an app does with a sensor or an actuator.
type Use struct {
	Part    string   `json:"part"`
	Does    string   `json:"does"`
	Sources []Source `json:"sources"`
}

// LEDs is the colour an app's LEDs show on the page (#rrggbb), and why. Each, if given, is each
// LED's colour in robot3d's -leds form (s-w42-eu-assets renders.json): "#rrggbb*12", or 12
// comma-separated colours numbered as the robot's leds command does (left 0-5, right 6-11; 0 and
// 11 at the front), empty for an unlit LED; Color is then the colour of its lit ones.
type LEDs struct {
	Color   string   `json:"color"`
	Each    string   `json:"each,omitempty"`
	Does    string   `json:"does"`
	Sources []Source `json:"sources"`
}

// App is data/apps/<id>.json.
type App struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	About   string   `json:"about"`
	Repo    string   `json:"repo"`
	Web     string   `json:"web,omitempty"`
	Sources []Source `json:"sources"`
	LEDs    *LEDs    `json:"leds,omitempty"` // nil: the page's default
	Uses    []Use    `json:"uses"`
}

// loadParts reads data/parts.json.
func loadParts(fsys fs.FS) (Parts, error) {
	var p Parts
	b, err := fs.ReadFile(fsys, "data/parts.json")
	if err == nil {
		err = strictJSON(b, &p)
	}
	return p, err
}

// loadApps reads data/apps/*.json, sorted by id.
func loadApps(fsys fs.FS) ([]App, error) {
	names, err := fs.Glob(fsys, "data/apps/*.json")
	if err != nil {
		return nil, err
	}
	var apps []App
	for _, n := range names {
		b, err := fs.ReadFile(fsys, n)
		if err != nil {
			return nil, err
		}
		var a App
		if err := strictJSON(b, &a); err != nil {
			return nil, fmt.Errorf("%s: %w", n, err)
		}
		if a.ID+".json" != path.Base(n) {
			return nil, fmt.Errorf("%s: id %q", n, a.ID)
		}
		apps = append(apps, a)
	}
	sort.Slice(apps, func(i, j int) bool { return apps[i].ID < apps[j].ID })
	return apps, nil
}

func strictJSON(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	return d.Decode(v)
}

// importMapHash is the CSP hash of the page's inline import map (three.js from jsDelivr).
func importMapHash(page []byte) (string, error) {
	m := regexp.MustCompile(`(?s)<script type="importmap">(.*?)</script>`).FindSubmatch(page)
	if m == nil {
		return "", fmt.Errorf("index.html: no import map")
	}
	sum := sha256.Sum256(m[1])
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'", nil
}

func handler() (http.Handler, error) {
	if _, err := loadParts(files); err != nil {
		return nil, fmt.Errorf("data/parts.json: %w", err)
	}
	apps, err := loadApps(files)
	if err != nil {
		return nil, err
	}
	appsJSON, err := json.Marshal(map[string]any{"apps": apps})
	if err != nil {
		return nil, err
	}
	index, _ := files.ReadFile("web/index.html")
	hash, err := importMapHash(index)
	if err != nil {
		return nil, err
	}
	csp := strings.Join([]string{
		"default-src 'none'",
		"script-src 'self' https://cdn.jsdelivr.net " + hash,
		"style-src 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"connect-src 'self' data: blob:",
		"base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
	}, "; ")

	// Every file is checked again on each load (no-cache, with an ETag: unchanged, a 304), so a
	// release shows at once, never an old robot.glb from a browser's cache.
	serve := func(body []byte, ct string) http.HandlerFunc {
		sum := sha256.Sum256(body)
		etag := `"` + base64.RawURLEncoding.EncodeToString(sum[:12]) + `"`
		return func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("Content-Type", ct)
			h.Set("Cache-Control", "no-cache")
			h.Set("ETag", etag)
			h.Set("X-Content-Type-Options", "nosniff")
			if strings.HasPrefix(ct, "text/html") {
				h.Set("Content-Security-Policy", csp)
				h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
			}
			if r.Header.Get("If-None-Match") == etag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Write(body)
		}
	}
	read := func(name string) []byte {
		b, _ := files.ReadFile(name)
		return b
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", serve(index, "text/html; charset=utf-8"))
	mux.HandleFunc("GET /app.js", serve(read("web/app.js"), "text/javascript; charset=utf-8"))
	mux.HandleFunc("GET /robot.glb", serve(read("web/robot.glb"), "model/gltf-binary"))
	mux.HandleFunc("GET /data/parts.json", serve(read("data/parts.json"), "application/json"))
	mux.HandleFunc("GET /data/apps.json", serve(appsJSON, "application/json"))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok\n")) })
	return mux, nil
}

func main() {
	listen := flag.String("listen", ":8080", "HTTP listen address")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	h, err := handler()
	if err != nil {
		log.Error("data", "err", err)
		os.Exit(1)
	}
	srv := &http.Server{
		Addr:              *listen,
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Info("s3d-w42-eu listening", "listen", *listen)
	if err := srv.ListenAndServe(); err != nil {
		log.Error("server stopped", "err", err)
		os.Exit(1)
	}
}
