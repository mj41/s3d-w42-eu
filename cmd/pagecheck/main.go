// Command pagecheck checks the page in a headless Chrome or Chromium over the DevTools protocol
// (standard library only): it builds and starts the site on a free port (or checks -url), opens
// it at 1200 and 420 px and checks that
//
//   - the robot is drawn and fills most of the view, also after a resize;
//   - the markers are grouped: a group's label is a count, and a tap opens its list;
//   - no two labels overlap while the robot turns;
//   - the side panel's links wrap: nothing overflows the panel or the page;
//   - there are no console errors or uncaught exceptions.
//
// It writes a screenshot of each width to a temporary directory (or -o) and prints its path;
// -views also writes the 3D view alone at 1200 px from fixed views (the page's ?view=…: front,
// back, left, right, and close-ups of the head and the LED bars), for comparing with photos.
// Run from the repository's root:
//
//	go run ./cmd/pagecheck [-chrome path] [-url http://…] [-three-dir node_modules/three] [-o dir] [-views all|front,leds,…]
//
// -three-dir serves three.js from a local copy (npm three@0.160.0) in place of jsDelivr, for
// a machine that cannot reach it.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/png"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type width struct {
	name         string
	w, h         int
	mobile       bool
	resizedWidth int // checked again at this width
}

var widths = []width{
	{name: "1200", w: 1200, h: 800, resizedWidth: 840},
	{name: "420", w: 420, h: 860, mobile: true, resizedWidth: 320},
}

// minFill: the robot's drawn bounds cover at least this much of the 3D view's height or width.
const minFill = 0.6

func main() {
	chromeFlag := flag.String("chrome", "", "Chrome or Chromium (default: $CHROME, then the usual names and places)")
	siteURL := flag.String("url", "", "check this site (default: build and start this repository's site)")
	threeDir := flag.String("three-dir", "", "serve three.js from this copy of npm three in place of jsDelivr")
	out := flag.String("o", "", "the directory for the screenshots (default: a new temporary one)")
	viewsFlag := flag.String("views", "", "also screenshot these fixed views (comma-separated, or all: "+strings.Join(allViews, ",")+"; view#app with an app's LEDs)")
	flag.Parse()

	views := strings.Split(*viewsFlag, ",")
	switch *viewsFlag {
	case "":
		views = nil
	case "all":
		views = allViews
	}
	failed, err := run(*chromeFlag, *siteURL, *threeDir, *out, views)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pagecheck:", err)
		os.Exit(2)
	}
	if failed > 0 {
		fmt.Printf("pagecheck: %d checks failed\n", failed)
		os.Exit(1)
	}
	fmt.Println("pagecheck: all checks passed")
}

// allViews are the page's fixed views (web/app.js: views).
var allViews = []string{"front", "back", "left", "right", "head", "leds", "top"}

func run(chromeFlag, siteURL, threeDir, out string, views []string) (int, error) {
	chrome, err := findChrome(chromeFlag)
	if err != nil {
		return 0, err
	}
	if out == "" {
		if out, err = os.MkdirTemp("", "pagecheck-"); err != nil {
			return 0, err
		}
	}
	if siteURL == "" {
		stop, u, err := startSite()
		if err != nil {
			return 0, err
		}
		defer stop()
		siteURL = u
	}
	b, err := startBrowser(chrome)
	if err != nil {
		return 0, err
	}
	defer b.Close()
	fmt.Printf("pagecheck: %s with %s\n", siteURL, chrome)

	failed := 0
	for _, w := range widths {
		n, err := checkWidth(b, siteURL, threeDir, out, w)
		if err != nil {
			fmt.Printf("FAIL %s px: %v\n", w.name, err)
			n++
		}
		failed += n
	}
	for _, v := range views {
		if err := shootView(b, siteURL, threeDir, out, v); err != nil {
			fmt.Printf("FAIL view %s: %v\n", v, err)
			failed++
		}
	}
	return failed, nil
}

// shootView writes the 3D view alone (no markers, no hint) at 1200 px from a fixed view; a name
// like leds#focus shows an app (its LEDs).
func shootView(b *browser, site, threeDir, out, name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	p, err := openPage(b, threeDir)
	if err != nil {
		return err
	}
	defer p.ws.Close()
	if err := p.setSize(ctx, widths[0], widths[0].w); err != nil {
		return err
	}
	if err := p.Call(ctx, "Page.navigate", map[string]any{"url": site + "/?view=" + name}, nil); err != nil {
		return err
	}
	time.Sleep(500 * time.Millisecond)
	if err := p.waitFor(ctx, `!document.getElementById('status')`, 45*time.Second); err != nil {
		return err
	}
	var st rect
	if err := p.Eval(ctx, `(() => {
		const box = document.getElementById('markers');
		if (box.checked) { box.checked = false; box.dispatchEvent(new Event('change')); }
		document.getElementById('hint').style.visibility = 'hidden';
		const r = document.getElementById('stage').getBoundingClientRect();
		return {X: r.left + scrollX, Y: r.top + scrollY, W: r.width, H: r.height};
	})()`, &st); err != nil {
		return err
	}
	time.Sleep(800 * time.Millisecond)
	shot, err := p.screenshot(ctx, map[string]any{"x": st.X, "y": st.Y, "width": st.W, "height": st.H, "scale": 1})
	if err != nil {
		return err
	}
	file := filepath.Join(out, "view-"+strings.ReplaceAll(name, "#", "-")+".png")
	if err := os.WriteFile(file, shot, 0o644); err != nil {
		return err
	}
	p.mu.Lock()
	errs := append([]string(nil), p.errors...)
	p.mu.Unlock()
	if len(errs) > 0 {
		return fmt.Errorf("console errors: %s", strings.Join(errs, "; "))
	}
	fmt.Printf("     view %s: screenshot %s\n", name, file)
	return nil
}

// startSite builds this repository's site and starts it on a free local port.
func startSite() (stop func(), url string, err error) {
	dir, err := os.MkdirTemp("", "pagecheck-site-")
	if err != nil {
		return nil, "", err
	}
	bin := filepath.Join(dir, "s3d-w42-eu")
	build := exec.Command("go", "build", "-o", bin, ".")
	build.Stdout, build.Stderr = os.Stderr, os.Stderr
	if err := build.Run(); err != nil {
		os.RemoveAll(dir)
		return nil, "", fmt.Errorf("go build (run pagecheck from the repository's root): %w", err)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, "", err
	}
	addr := l.Addr().String()
	l.Close()
	cmd := exec.Command(bin, "-listen", addr)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, "", err
	}
	stop = func() { cmd.Process.Kill(); cmd.Wait(); os.RemoveAll(dir) }
	url = "http://" + addr
	for i := 0; i < 100; i++ {
		if res, err := http.Get(url + "/healthz"); err == nil {
			res.Body.Close()
			return stop, url, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	stop()
	return nil, "", fmt.Errorf("the site did not answer at %s", url)
}

// page is a tab with what it logged.
type page struct {
	*cdp
	mu     sync.Mutex
	errors []string
}

func (p *page) logError(s string) {
	p.mu.Lock()
	p.errors = append(p.errors, s)
	p.mu.Unlock()
}

func openPage(b *browser, threeDir string) (*page, error) {
	p := &page{}
	var c *cdp
	threeURL := regexp.MustCompile(`^https://cdn\.jsdelivr\.net/npm/three@[^/]+/(.+)$`)
	onEvent := func(method string, params json.RawMessage) {
		switch method {
		case "Runtime.exceptionThrown":
			var e struct {
				ExceptionDetails struct {
					Text      string `json:"text"`
					Exception struct {
						Description string `json:"description"`
					} `json:"exception"`
				} `json:"exceptionDetails"`
			}
			json.Unmarshal(params, &e)
			p.logError("exception: " + e.ExceptionDetails.Text + " " + e.ExceptionDetails.Exception.Description)
		case "Runtime.consoleAPICalled":
			var e struct {
				Type string `json:"type"`
				Args []struct {
					Value       any    `json:"value"`
					Description string `json:"description"`
				} `json:"args"`
			}
			json.Unmarshal(params, &e)
			if e.Type == "error" || e.Type == "assert" {
				var parts []string
				for _, a := range e.Args {
					if a.Description != "" {
						parts = append(parts, a.Description)
					} else {
						parts = append(parts, fmt.Sprint(a.Value))
					}
				}
				p.logError("console." + e.Type + ": " + strings.Join(parts, " "))
			}
		case "Log.entryAdded":
			var e struct {
				Entry struct {
					Level string `json:"level"`
					Text  string `json:"text"`
					URL   string `json:"url"`
				} `json:"entry"`
			}
			json.Unmarshal(params, &e)
			if e.Entry.Level == "error" {
				p.logError("log: " + e.Entry.Text + " " + e.Entry.URL)
			}
		case "Fetch.requestPaused": // three.js from -three-dir
			var e struct {
				RequestID string `json:"requestId"`
				Request   struct {
					URL string `json:"url"`
				} `json:"request"`
			}
			json.Unmarshal(params, &e)
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				m := threeURL.FindStringSubmatch(e.Request.URL)
				var body []byte
				var err error
				if m != nil {
					body, err = os.ReadFile(filepath.Join(threeDir, filepath.FromSlash(m[1])))
				}
				if m == nil || err != nil {
					c.Call(ctx, "Fetch.failRequest", map[string]any{"requestId": e.RequestID, "errorReason": "FileNotFound"}, nil)
					return
				}
				c.Call(ctx, "Fetch.fulfillRequest", map[string]any{
					"requestId": e.RequestID, "responseCode": 200, "body": base64.StdEncoding.EncodeToString(body),
					"responseHeaders": []map[string]string{{"name": "Content-Type", "value": "text/javascript"}, {"name": "Access-Control-Allow-Origin", "value": "*"}},
				}, nil)
			}()
		}
	}
	c, err := b.newPage(onEvent)
	if err != nil {
		return nil, err
	}
	p.cdp = c
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for _, m := range []string{"Runtime.enable", "Log.enable", "Page.enable"} {
		if err := c.Call(ctx, m, nil, nil); err != nil {
			return nil, err
		}
	}
	if threeDir != "" {
		if err := c.Call(ctx, "Fetch.enable", map[string]any{"patterns": []map[string]string{{"urlPattern": "https://cdn.jsdelivr.net/npm/three@*"}}}, nil); err != nil {
			return nil, err
		}
	}
	return p, nil
}

func (p *page) setSize(ctx context.Context, w width, px int) error {
	if err := p.Call(ctx, "Emulation.setDeviceMetricsOverride", map[string]any{"width": px, "height": w.h, "deviceScaleFactor": 1, "mobile": w.mobile}, nil); err != nil {
		return err
	}
	return p.Call(ctx, "Emulation.setTouchEmulationEnabled", map[string]any{"enabled": w.mobile, "maxTouchPoints": 5}, nil)
}

// waitFor evaluates a boolean expression until it is true.
func (p *page) waitFor(ctx context.Context, expr string, limit time.Duration) error {
	end := time.Now().Add(limit)
	for {
		var ok bool
		err := p.Eval(ctx, expr, &ok) // fails while the page is still being replaced: tried again
		if err == nil && ok {
			return nil
		}
		if time.Now().After(end) {
			if err != nil {
				return err
			}
			return fmt.Errorf("not within %s: %s", limit, expr)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func (p *page) screenshot(ctx context.Context, clip map[string]any) ([]byte, error) {
	var r struct {
		Data string `json:"data"`
	}
	params := map[string]any{"format": "png", "captureBeyondViewport": true}
	if clip != nil {
		params["clip"] = clip
	}
	if err := p.Call(ctx, "Page.captureScreenshot", params, &r); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(r.Data)
}

type rect struct{ X, Y, W, H float64 }

// robotFill gives how much of the 3D view's height and width the robot's drawing covers: the
// markers and the hint hidden, a screenshot of the view, the bounds of what differs from its
// background.
func (p *page) robotFill(ctx context.Context) (fh, fw float64, err error) {
	var st rect
	err = p.Eval(ctx, `(() => {
		const box = document.getElementById('markers');
		if (box.checked) { box.checked = false; box.dispatchEvent(new Event('change')); }
		document.getElementById('hint').style.visibility = 'hidden';
		const r = document.getElementById('stage').getBoundingClientRect();
		return {X: r.left + scrollX, Y: r.top + scrollY, W: r.width, H: r.height};
	})()`, &st)
	if err != nil {
		return 0, 0, err
	}
	time.Sleep(300 * time.Millisecond)
	b, err := p.screenshot(ctx, map[string]any{"x": st.X, "y": st.Y, "width": st.W, "height": st.H, "scale": 1})
	restore := `(() => { const box = document.getElementById('markers'); box.checked = true; box.dispatchEvent(new Event('change'));
		document.getElementById('hint').style.visibility = ''; return true; })()`
	if e := p.Eval(ctx, restore, nil); err == nil {
		err = e
	}
	if err != nil {
		return 0, 0, err
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		return 0, 0, err
	}
	box := drawnBounds(img)
	bw, bh := img.Bounds().Dx(), img.Bounds().Dy()
	return float64(box.Dy()) / float64(bh), float64(box.Dx()) / float64(bw), nil
}

// drawnBounds is the box of the pixels that differ from the background (taken a few pixels in
// from the middle of the left edge), 14 px inside the edges (the view's rounded border).
func drawnBounds(img image.Image) image.Rectangle {
	r := img.Bounds()
	br, bg, bb, _ := img.At(r.Min.X+4, (r.Min.Y+r.Max.Y)/2).RGBA()
	box := image.Rectangle{}
	diff := func(a, b uint32) int {
		d := int(a>>8) - int(b>>8)
		if d < 0 {
			return -d
		}
		return d
	}
	for y := r.Min.Y + 14; y < r.Max.Y-14; y++ { // inside the view's rounded border
		for x := r.Min.X + 14; x < r.Max.X-14; x++ {
			cr, cg, cb, _ := img.At(x, y).RGBA()
			if diff(cr, br)+diff(cg, bg)+diff(cb, bb) > 24 {
				box = box.Union(image.Rect(x, y, x+1, y+1))
			}
		}
	}
	return box
}

// labelsJS gives the visible labels with their boxes and the side panel's overflow.
const labelsJS = `(() => {
	const ls = [...document.querySelectorAll('.label')].filter((e) => e.offsetParent && getComputedStyle(e.parentElement).display !== 'none')
		.map((e) => { const r = e.getBoundingClientRect(); return {text: e.textContent, group: e.classList.contains('group'), x: r.left, y: r.top, w: r.width, h: r.height}; });
	const aside = document.querySelector('aside'), ar = aside.getBoundingClientRect();
	const wide = [...aside.querySelectorAll('a, .src, .does, .about, .meta')].filter((e) => e.getBoundingClientRect().right > ar.right + 1).map((e) => e.textContent.slice(0, 60));
	return {labels: ls, asideOverflow: aside.scrollWidth - aside.clientWidth, pageOverflow: document.documentElement.scrollWidth - innerWidth, wide};
})()`

type label struct {
	Text       string
	Group      bool
	X, Y, W, H float64
}

type layout struct {
	Labels        []label
	AsideOverflow float64
	PageOverflow  float64
	Wide          []string
}

func checkWidth(b *browser, site, threeDir, out string, w width) (failed int, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	p, err := openPage(b, threeDir)
	if err != nil {
		return 0, err
	}
	defer p.ws.Close()
	report := func(ok bool, what string, args ...any) {
		state := "ok  "
		if !ok {
			state = "FAIL"
			failed++
		}
		fmt.Printf("%s %s px: %s\n", state, w.name, fmt.Sprintf(what, args...))
	}

	if err := p.setSize(ctx, w, w.w); err != nil {
		return 0, err
	}
	if err := p.Call(ctx, "Page.navigate", map[string]any{"url": site + "/#pet"}, nil); err != nil {
		return 0, err
	}
	time.Sleep(500 * time.Millisecond)
	loaded := p.waitFor(ctx, `!document.getElementById('status') || document.getElementById('status').textContent.startsWith('Could not')`, 45*time.Second)
	var status string
	p.Eval(ctx, `(document.getElementById('status') || {}).textContent || ''`, &status)
	report(loaded == nil && status == "", "the robot loaded%s", errText(loaded, status))
	if loaded != nil || status != "" {
		return failed, nil
	}
	time.Sleep(1500 * time.Millisecond)

	// The robot drawn, filling the view.
	fh, fw, err := p.robotFill(ctx)
	if err != nil {
		return failed, err
	}
	report(max(fh, fw) >= minFill, "the robot drawn: %.0f%% of the view's height, %.0f%% of its width (at least %.0f%% of one)", 100*fh, 100*fw, 100*minFill)

	// The markers grouped; no labels overlapping as it turns; nothing overflowing.
	var groups []string
	overlaps := map[string]bool{}
	var l layout
	for frame := 0; frame < 10; frame++ {
		if err := p.Eval(ctx, labelsJS, &l); err != nil {
			return failed, err
		}
		for i, a := range l.Labels {
			for _, c := range l.Labels[i+1:] {
				if a.X < c.X+c.W && c.X < a.X+a.W && a.Y < c.Y+c.H && c.Y < a.Y+a.H {
					overlaps[fmt.Sprintf("%s %.0f,%.0f %.0fx%.0f / %s %.0f,%.0f %.0fx%.0f", a.Text, a.X, a.Y, a.W, a.H, c.Text, c.X, c.Y, c.W, c.H)] = true
				}
			}
		}
		time.Sleep(600 * time.Millisecond)
	}
	count := regexp.MustCompile(`^(\d+) parts$`)
	bad := []string{}
	for _, lb := range l.Labels {
		if lb.Group {
			groups = append(groups, lb.Text)
			if !count.MatchString(lb.Text) {
				bad = append(bad, lb.Text)
			}
		}
	}
	report(len(groups) > 0 && len(bad) == 0, "markers grouped: %d labels, groups %q%s", len(l.Labels), groups, listText(" not a count:", bad))
	report(len(overlaps) == 0, "no labels overlap in 10 frames as it turns%s", listText(":", keys(overlaps)))
	report(l.AsideOverflow <= 0 && l.PageOverflow <= 0 && len(l.Wide) == 0, "links wrap: the panel overflows by %.0f px, the page by %.0f px%s", l.AsideOverflow, l.PageOverflow, listText(" wider than the panel:", l.Wide))

	// A tap on a group opens its list, one row a part.
	var g struct {
		Text string
		X, Y float64
	}
	if err := p.Eval(ctx, `(() => { const e = document.querySelector('.label.group'); if (!e) return {Text: ''}; const r = e.getBoundingClientRect(); return {Text: e.textContent, X: r.left + r.width / 2, Y: r.top + r.height / 2}; })()`, &g); err != nil {
		return failed, err
	}
	if g.Text != "" {
		for _, t := range []string{"mousePressed", "mouseReleased"} {
			if err := p.Call(ctx, "Input.dispatchMouseEvent", map[string]any{"type": t, "x": g.X, "y": g.Y, "button": "left", "clickCount": 1}, nil); err != nil {
				return failed, err
			}
		}
		time.Sleep(300 * time.Millisecond)
		var rows int
		p.Eval(ctx, `(() => { const e = document.getElementById('pop'); return e && !e.hidden ? e.querySelectorAll('.row').length : 0; })()`, &rows)
		want := 0
		if m := count.FindStringSubmatch(g.Text); m != nil {
			fmt.Sscan(m[1], &want)
		}
		report(rows == want && rows > 0, "a tap on %q opens its list: %d rows", g.Text, rows)
	}

	// The screenshot, then the robot framed again after a resize.
	shot, err := p.screenshot(ctx, nil)
	if err != nil {
		return failed, err
	}
	file := filepath.Join(out, "pagecheck-"+w.name+".png")
	if err := os.WriteFile(file, shot, 0o644); err != nil {
		return failed, err
	}
	fmt.Printf("     %s px: screenshot %s\n", w.name, file)
	p.Eval(ctx, `(() => { const e = document.getElementById('pop'); if (e && !e.hidden) document.getElementById('stage').click(); return true; })()`, nil)
	if err := p.setSize(ctx, w, w.resizedWidth); err != nil {
		return failed, err
	}
	time.Sleep(800 * time.Millisecond)
	if fh, fw, err = p.robotFill(ctx); err != nil {
		return failed, err
	}
	report(max(fh, fw) >= minFill, "resized to %d px: the robot fills %.0f%% of the view's height, %.0f%% of its width", w.resizedWidth, 100*fh, 100*fw)

	p.mu.Lock()
	errs := append([]string(nil), p.errors...)
	p.mu.Unlock()
	report(len(errs) == 0, "no console errors%s", listText(":", errs))
	return failed, nil
}

func errText(err error, status string) string {
	switch {
	case status != "":
		return ": " + status
	case err != nil:
		return ": " + err.Error()
	}
	return ""
}

func listText(prefix string, items []string) string {
	if len(items) == 0 {
		return ""
	}
	return prefix + " " + strings.Join(items, "; ")
}

func keys(m map[string]bool) []string {
	var k []string
	for s := range m {
		k = append(k, s)
	}
	return k
}
