package main

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"testing"

	"github.com/mj41/s-w42-eu-assets/robot3d"
)

// glb reads back what build wrote: the document and the binary chunk.
func glb(t *testing.T, b []byte) (document, []byte) {
	t.Helper()
	if len(b) < 20 || binary.LittleEndian.Uint32(b) != 0x46546C67 || binary.LittleEndian.Uint32(b[4:]) != 2 {
		t.Fatal("not a glTF 2 binary")
	}
	if int(binary.LittleEndian.Uint32(b[8:])) != len(b) {
		t.Fatal("wrong length")
	}
	jl := int(binary.LittleEndian.Uint32(b[12:]))
	var doc document
	if err := json.Unmarshal(b[20:20+jl], &doc); err != nil {
		t.Fatal(err)
	}
	bin := b[20+jl+8:]
	if len(doc.Buffers) != 1 || doc.Buffers[0].ByteLength != len(bin) {
		t.Fatal("buffer length")
	}
	return doc, bin
}

// m4 is row major for column vectors, like robot3d's.
type m4 [16]float64

func ident() m4 { return m4{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1} }

func (a m4) mul(b m4) m4 {
	var m m4
	for r := 0; r < 4; r++ {
		for c := 0; c < 4; c++ {
			for k := 0; k < 4; k++ {
				m[r*4+c] += a[r*4+k] * b[k*4+c]
			}
		}
	}
	return m
}

func (a m4) point(p robot3d.V3) robot3d.V3 {
	return robot3d.V3{X: a[0]*p.X + a[1]*p.Y + a[2]*p.Z + a[3], Y: a[4]*p.X + a[5]*p.Y + a[6]*p.Z + a[7], Z: a[8]*p.X + a[9]*p.Y + a[10]*p.Z + a[11]}
}

func trans(v robot3d.V3) m4 { return m4{1, 0, 0, v.X, 0, 1, 0, v.Y, 0, 0, 1, v.Z, 0, 0, 0, 1} }

func rotX(a float64) m4 {
	s, c := math.Sincos(a)
	return m4{1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1}
}

func rotY(a float64) m4 {
	s, c := math.Sincos(a)
	return m4{c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1}
}

func local(n node) m4 {
	m := ident()
	if n.Translation != nil {
		m = trans(robot3d.V3{X: n.Translation[0], Y: n.Translation[1], Z: n.Translation[2]})
	}
	if n.Scale != nil {
		m = m.mul(m4{n.Scale[0], 0, 0, 0, 0, n.Scale[1], 0, 0, 0, 0, n.Scale[2], 0, 0, 0, 0, 1})
	}
	return m
}

// world gives each node's matrix, a joint's pose (pose[name]) applied after its own transform,
// the robot node's metres back to millimetres (as a page with the robot at scale 1000 sees it).
func world(doc document, pose map[string]m4) map[string]m4 {
	out := map[string]m4{}
	var walk func(i int, parent m4)
	walk = func(i int, parent m4) {
		n := doc.Nodes[i]
		m := parent.mul(local(n))
		if p, ok := pose[n.Name]; ok {
			m = m.mul(p)
		}
		out[n.Name] = m
		for _, c := range n.Children {
			walk(c, m)
		}
	}
	walk(doc.Scenes[doc.Scene].Nodes[0], m4{1000, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 1})
	return out
}

// triangles gives a mesh's vertices in index order: three per triangle, as robot3d lists them.
func triangles(t *testing.T, doc document, bin []byte, mesh int) []robot3d.V3 {
	t.Helper()
	pr := doc.Meshes[mesh].Primitives[0]
	data := func(a int) ([]byte, accessor) {
		acc := doc.Accessors[a]
		v := doc.BufferViews[acc.BufferView]
		return bin[v.ByteOffset : v.ByteOffset+v.ByteLength], acc
	}
	pos, pa := data(pr.Attributes["POSITION"])
	idx, ia := data(pr.Indices)
	if pa.ComponentType != glFloat || ia.ComponentType != glUnsignedInt {
		t.Fatal("component types")
	}
	f := func(o int) float64 { return float64(math.Float32frombits(binary.LittleEndian.Uint32(pos[o:]))) }
	out := make([]robot3d.V3, ia.Count)
	for i := range out {
		j := int(binary.LittleEndian.Uint32(idx[4*i:]))
		if j >= pa.Count {
			t.Fatalf("index %d out of %d", j, pa.Count)
		}
		out[i] = robot3d.V3{X: f(12 * j), Y: f(12*j + 4), Z: f(12*j + 8)}
	}
	return out
}

func near(a, b robot3d.V3, tol float64) bool { return a.Sub(b).Len() <= tol }

func export(t *testing.T) (document, []byte) {
	t.Helper()
	centre, w, h := robot3d.Screen()
	b, err := build(robot3d.Parts(), robot3d.PitchPivot(), centre, w, h, nil)
	if err != nil {
		t.Fatal(err)
	}
	return glb(t, b)
}

// Every part robot3d has is a node with its mesh under its joint, and every triangle is where
// robot3d has it at rest.
func TestPartsPlaced(t *testing.T) {
	doc, bin := export(t)
	byName := map[string]node{}
	parentOf := map[string]string{}
	for _, n := range doc.Nodes {
		byName[n.Name] = n
		for _, c := range n.Children {
			parentOf[doc.Nodes[c].Name] = n.Name
		}
	}
	if parentOf["base"] != "robot" || parentOf["yaw"] != "base" || parentOf["head"] != "yaw" {
		t.Fatalf("joints: %v", parentOf)
	}
	at := world(doc, nil)
	parts := robot3d.Parts()
	if len(parts) != 8 {
		t.Errorf("robot3d has %d parts, want 8", len(parts))
	}
	for _, p := range parts {
		n, ok := byName[p.Name]
		if !ok || n.Mesh == nil {
			t.Errorf("%s: no node with a mesh", p.Name)
			continue
		}
		if parentOf[p.Name] != p.Joint {
			t.Errorf("%s: under %q, robot3d's joint is %q", p.Name, parentOf[p.Name], p.Joint)
		}
		got := triangles(t, doc, bin, *n.Mesh)
		if len(got) != len(p.Positions) {
			t.Errorf("%s: %d vertices, robot3d %d", p.Name, len(got), len(p.Positions))
			continue
		}
		bad := 0
		for i, v := range got {
			if !near(at[p.Name].point(v), p.Positions[i], 1e-4) {
				bad++
			}
		}
		if bad > 0 {
			t.Errorf("%s: %d of %d vertices not where robot3d has them", p.Name, bad, len(got))
		}
	}
}

// A few points by hand: the plate on the ground, the head's top at 70.5 mm, the LED bars on
// the sides, the screen's corners at robot3d.Screen().
func TestPoints(t *testing.T) {
	doc, bin := export(t)
	at := world(doc, nil)
	bounds := func(name string) (lo, hi robot3d.V3) {
		for _, n := range doc.Nodes {
			if n.Name == name {
				vs := triangles(t, doc, bin, *n.Mesh)
				lo, hi = at[name].point(vs[0]), at[name].point(vs[0])
				for _, v := range vs {
					w := at[name].point(v)
					lo = robot3d.V3{X: min(lo.X, w.X), Y: min(lo.Y, w.Y), Z: min(lo.Z, w.Z)}
					hi = robot3d.V3{X: max(hi.X, w.X), Y: max(hi.Y, w.Y), Z: max(hi.Z, w.Z)}
				}
			}
		}
		return
	}
	if lo, _ := bounds("plate"); math.Abs(lo.Y) > 1e-3 {
		t.Errorf("plate's bottom at y %.3f, want 0", lo.Y)
	}
	if _, hi := bounds("core"); math.Abs(hi.Y-70.5) > 1e-3 || math.Abs(hi.Z-33.6) > 1e-3 {
		t.Errorf("core's top front at %+v, want y 70.5, z 33.6", hi)
	}
	if lo, _ := bounds("led-bar-left"); lo.X < 25 {
		t.Errorf("led-bar-left at x %.2f: not on the robot's left (+X)", lo.X)
	}
	if _, hi := bounds("led-bar-right"); hi.X > -25 {
		t.Errorf("led-bar-right at x %.2f: not on the robot's right (-X)", hi.X)
	}
	c, w, h := robot3d.Screen()
	lo, hi := bounds("screen")
	if !near(lo, robot3d.V3{X: c.X - w/2, Y: c.Y - h/2, Z: c.Z + screenLift}, 1e-3) || !near(hi, robot3d.V3{X: c.X + w/2, Y: c.Y + h/2, Z: c.Z + screenLift}, 1e-3) {
		t.Errorf("screen from %+v to %+v, robot3d's centre %+v, %gx%g", lo, hi, c, w, h)
	}
}

// Turned: the yaw node about Y and the head node about X by -pitch move a head point as
// robot3d does (rotY(yaw) · T(pivot) · rotX(-pitch) · T(-pivot)); the plate stays.
func TestPose(t *testing.T) {
	doc, _ := export(t)
	pivot := robot3d.PitchPivot()
	for _, pose := range [][2]float64{{30, 0}, {0, 20}, {-45, 60}} {
		yaw, pitch := pose[0]*math.Pi/180, pose[1]*math.Pi/180
		at := world(doc, map[string]m4{"yaw": rotY(yaw), "head": rotX(-pitch)})
		want := rotY(yaw).mul(trans(pivot)).mul(rotX(-pitch)).mul(trans(pivot.Mul(-1)))
		for _, p := range []robot3d.V3{{X: 0, Y: 44.5, Z: 33.6}, {X: 26.1, Y: 69.4, Z: -1.65}, {X: -27, Y: 16.5, Z: 18.1}} {
			for _, name := range []string{"core", "body", "led-bar-left", "screen"} {
				if got := at[name].point(p); !near(got, want.point(p), 1e-6) {
					t.Errorf("yaw %v pitch %v %s: %+v → %+v, robot3d %+v", pose[0], pose[1], name, p, got, want.point(p))
				}
			}
			if got := at["servo"].point(p); !near(got, rotY(yaw).point(p), 1e-6) {
				t.Errorf("servo: %+v, want %+v", got, rotY(yaw).point(p))
			}
			if got := at["plate"].point(p); !near(got, p, 1e-6) {
				t.Errorf("plate moved: %+v", got)
			}
		}
		// +pitch lifts the front: the screen's centre goes up.
		if pose[1] > 0 && pose[0] == 0 {
			if c := at["screen"].point(robot3d.V3{X: 0, Y: 44.5, Z: 33.6}); c.Y <= 44.5 {
				t.Errorf("pitch %v: the screen's centre at y %.2f, not lifted", pose[1], c.Y)
			}
		}
	}
}
