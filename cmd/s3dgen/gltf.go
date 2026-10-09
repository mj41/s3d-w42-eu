package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"math"

	"github.com/mj41/s-w42-eu-assets/robot3d"
)

// The glTF 2.0 document, only what is written here.
type document struct {
	Asset          asset          `json:"asset"`
	ExtensionsUsed []string       `json:"extensionsUsed,omitempty"`
	Scene          int            `json:"scene"`
	Scenes         []scene        `json:"scenes"`
	Nodes          []node         `json:"nodes"`
	Meshes         []mesh         `json:"meshes"`
	Materials      []material     `json:"materials"`
	Textures       []texture      `json:"textures,omitempty"`
	Images         []gltfImage    `json:"images,omitempty"`
	Samplers       []sampler      `json:"samplers,omitempty"`
	Accessors      []accessor     `json:"accessors"`
	BufferViews    []bufferView   `json:"bufferViews"`
	Buffers        []buffer       `json:"buffers"`
	Extras         map[string]any `json:"extras,omitempty"`
}

type asset struct {
	Version   string `json:"version"`
	Generator string `json:"generator"`
	Copyright string `json:"copyright,omitempty"`
}

type scene struct {
	Name  string `json:"name"`
	Nodes []int  `json:"nodes"`
}

type node struct {
	Name        string         `json:"name"`
	Mesh        *int           `json:"mesh,omitempty"`
	Children    []int          `json:"children,omitempty"`
	Translation []float64      `json:"translation,omitempty"`
	Scale       []float64      `json:"scale,omitempty"`
	Extras      map[string]any `json:"extras,omitempty"`
}

type mesh struct {
	Name       string      `json:"name"`
	Primitives []primitive `json:"primitives"`
}

type primitive struct {
	Attributes map[string]int `json:"attributes"`
	Indices    int            `json:"indices"`
	Material   int            `json:"material"`
}

type material struct {
	Name                 string         `json:"name"`
	PBRMetallicRoughness pbr            `json:"pbrMetallicRoughness"`
	Extensions           map[string]any `json:"extensions,omitempty"`
}

type pbr struct {
	BaseColorFactor  []float64    `json:"baseColorFactor"`
	BaseColorTexture *textureInfo `json:"baseColorTexture,omitempty"`
	MetallicFactor   float64      `json:"metallicFactor"`
	RoughnessFactor  float64      `json:"roughnessFactor"`
}

type textureInfo struct {
	Index int `json:"index"`
}

type texture struct {
	Sampler int `json:"sampler"`
	Source  int `json:"source"`
}

type gltfImage struct {
	BufferView int    `json:"bufferView"`
	MimeType   string `json:"mimeType"`
}

type sampler struct {
	MagFilter int `json:"magFilter"`
	MinFilter int `json:"minFilter"`
	WrapS     int `json:"wrapS"`
	WrapT     int `json:"wrapT"`
}

type accessor struct {
	BufferView    int       `json:"bufferView"`
	ComponentType int       `json:"componentType"`
	Count         int       `json:"count"`
	Type          string    `json:"type"`
	Min           []float64 `json:"min,omitempty"`
	Max           []float64 `json:"max,omitempty"`
}

type bufferView struct {
	Buffer     int `json:"buffer"`
	ByteOffset int `json:"byteOffset"`
	ByteLength int `json:"byteLength"`
	Target     int `json:"target,omitempty"`
}

type buffer struct {
	ByteLength int `json:"byteLength"`
}

const (
	glFloat        = 5126
	glUnsignedInt  = 5125
	glArrayBuffer  = 34962
	glElementArray = 34963
	glLinear       = 9729
	glClampToEdge  = 33071
)

// The joints' nodes, in the order robot3d's Part.Joint names them.
var joints = []string{"base", "yaw", "head"}

// screenLift puts the screen's quad this far (mm) in front of the CoreS3's front.
const screenLift = 0.05

// builder collects the binary chunk and its views.
type builder struct {
	doc document
	bin bytes.Buffer
}

func (b *builder) view(data []byte, target int) int {
	for b.bin.Len()%4 != 0 {
		b.bin.WriteByte(0)
	}
	b.doc.BufferViews = append(b.doc.BufferViews, bufferView{ByteOffset: b.bin.Len(), ByteLength: len(data), Target: target})
	b.bin.Write(data)
	return len(b.doc.BufferViews) - 1
}

func (b *builder) accessor(a accessor) int {
	b.doc.Accessors = append(b.doc.Accessors, a)
	return len(b.doc.Accessors) - 1
}

// vec3s writes float32 triples; with bounds, it gives min and max (positions need them).
func (b *builder) vec3s(vs []robot3d.V3, bounds bool) int {
	buf := make([]byte, 0, 12*len(vs))
	lo := []float64{math.Inf(1), math.Inf(1), math.Inf(1)}
	hi := []float64{math.Inf(-1), math.Inf(-1), math.Inf(-1)}
	for _, v := range vs {
		for k, c := range [3]float64{v.X, v.Y, v.Z} {
			f := float32(c)
			buf = binary.LittleEndian.AppendUint32(buf, math.Float32bits(f))
			lo[k], hi[k] = math.Min(lo[k], float64(f)), math.Max(hi[k], float64(f))
		}
	}
	a := accessor{BufferView: b.view(buf, glArrayBuffer), ComponentType: glFloat, Count: len(vs), Type: "VEC3"}
	if bounds {
		a.Min, a.Max = lo, hi
	}
	return b.accessor(a)
}

func (b *builder) node(n node) int {
	b.doc.Nodes = append(b.doc.Nodes, n)
	return len(b.doc.Nodes) - 1
}

func (b *builder) child(parent, n int) {
	b.doc.Nodes[parent].Children = append(b.doc.Nodes[parent].Children, n)
}

// primitive adds an indexed triangle list (the same position and normal merged into one vertex).
func (b *builder) primitive(positions, normals []robot3d.V3, uvs [][2]float32, mat int) primitive {
	type key struct{ p, n [3]float32 }
	seen := map[key]uint32{}
	var pos, nrm []robot3d.V3
	var uv [][2]float32
	idx := make([]byte, 0, 4*len(positions))
	for i, p := range positions {
		n := normals[i]
		k := key{[3]float32{float32(p.X), float32(p.Y), float32(p.Z)}, [3]float32{float32(n.X), float32(n.Y), float32(n.Z)}}
		j, ok := seen[k]
		if !ok || uvs != nil {
			j = uint32(len(pos))
			seen[k] = j
			pos, nrm = append(pos, p), append(nrm, n)
			if uvs != nil {
				uv = append(uv, uvs[i])
			}
		}
		idx = binary.LittleEndian.AppendUint32(idx, j)
	}
	pr := primitive{Attributes: map[string]int{"POSITION": b.vec3s(pos, true), "NORMAL": b.vec3s(nrm, false)}, Material: mat}
	if uvs != nil {
		buf := make([]byte, 0, 8*len(uv))
		for _, t := range uv {
			buf = binary.LittleEndian.AppendUint32(buf, math.Float32bits(t[0]))
			buf = binary.LittleEndian.AppendUint32(buf, math.Float32bits(t[1]))
		}
		pr.Attributes["TEXCOORD_0"] = b.accessor(accessor{BufferView: b.view(buf, glArrayBuffer), ComponentType: glFloat, Count: len(uv), Type: "VEC2"})
	}
	pr.Indices = b.accessor(accessor{BufferView: b.view(idx, glElementArray), ComponentType: glUnsignedInt, Count: len(positions), Type: "SCALAR"})
	return pr
}

func (b *builder) mesh(name string, pr primitive) int {
	b.doc.Meshes = append(b.doc.Meshes, mesh{Name: name, Primitives: []primitive{pr}})
	return len(b.doc.Meshes) - 1
}

func (b *builder) material(m material) int {
	b.doc.Materials = append(b.doc.Materials, m)
	return len(b.doc.Materials) - 1
}

// linear turns an 8-bit sRGB channel into glTF's linear colour factor.
func linear(c uint8) float64 {
	s := float64(c) / 255
	if s <= 0.04045 {
		return s / 12.92
	}
	return math.Pow((s+0.055)/1.055, 2.4)
}

// darkScreen is the picture when none is given: an unlit screen.
func darkScreen() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 4, 3))
	for i := range img.Pix {
		img.Pix[i] = 0x0d
		if i%4 == 3 {
			img.Pix[i] = 0xff
		}
	}
	var buf bytes.Buffer
	png.Encode(&buf, img)
	return buf.Bytes()
}

// build gives the glTF binary of the parts: the joints as nodes, each part a node with its mesh
// under its joint, the screen a textured quad (centre, width, height) on the head.
func build(parts []robot3d.Part, pivot, centre robot3d.V3, w, h float64, screenPNG []byte) ([]byte, error) {
	if len(screenPNG) == 0 {
		screenPNG = darkScreen()
	}
	if _, err := png.DecodeConfig(bytes.NewReader(screenPNG)); err != nil {
		return nil, fmt.Errorf("screen: %w", err)
	}
	b := &builder{}
	b.doc.Asset = asset{Version: "2.0", Generator: "s3d-w42-eu cmd/s3dgen from robot3d (s-w42-eu-assets)",
		Copyright: "StackChan structure: M5Stack (MIT); the rest: Apache-2.0"}
	b.doc.Extras = map[string]any{
		"units":      "the robot node scales millimetres to metres; below it, millimetres",
		"axes":       "Y up, the robot faces +Z; +yaw (about Y) turns the head to the robot's left (+X), +pitch lifts the front (the head node turns about X by -pitch)",
		"pitchPivot": []float64{pivot.X, pivot.Y, pivot.Z},
		"screen":     map[string]any{"centre": []float64{centre.X, centre.Y, centre.Z}, "width": w, "height": h, "pixels": []int{320, 240}},
	}

	root := b.node(node{Name: "robot", Scale: []float64{0.001, 0.001, 0.001}})
	jointNode := map[string]int{}
	parent := root
	for _, j := range joints {
		n := node{Name: j, Extras: map[string]any{"joint": j}}
		switch j {
		case "yaw":
			n.Extras["axis"] = "y"
		case "head":
			n.Translation = []float64{pivot.X, pivot.Y, pivot.Z}
			n.Extras["axis"] = "x"
			n.Extras["note"] = "at the pitch pivot: rotate by -pitch about X (+pitch lifts the front)"
		}
		k := b.node(n)
		b.child(parent, k)
		jointNode[j], parent = k, k
	}

	place := func(name, joint string, m int) error {
		jn, ok := jointNode[joint]
		if !ok {
			return fmt.Errorf("part %s: unknown joint %q", name, joint)
		}
		n := node{Name: name, Mesh: &m, Extras: map[string]any{"joint": joint}}
		if joint == "head" {
			n.Translation = []float64{-pivot.X, -pivot.Y, -pivot.Z}
		}
		b.child(jn, b.node(n))
		return nil
	}

	for _, p := range parts {
		if len(p.Positions) == 0 || len(p.Positions)%3 != 0 || len(p.Normals) != len(p.Positions) {
			return nil, fmt.Errorf("part %s: %d positions, %d normals", p.Name, len(p.Positions), len(p.Normals))
		}
		mat := b.material(material{Name: p.Name, PBRMetallicRoughness: pbr{
			BaseColorFactor: []float64{linear(p.Color.R), linear(p.Color.G), linear(p.Color.B), 1},
			RoughnessFactor: 0.6,
		}})
		if err := place(p.Name, p.Joint, b.mesh(p.Name, b.primitive(p.Positions, p.Normals, nil, mat))); err != nil {
			return nil, err
		}
	}

	// The screen: the picture's top left at centre - (w/2, -h/2), facing +Z, unlit.
	img := b.view(screenPNG, 0)
	b.doc.Images = []gltfImage{{BufferView: img, MimeType: "image/png"}}
	b.doc.Samplers = []sampler{{MagFilter: glLinear, MinFilter: glLinear, WrapS: glClampToEdge, WrapT: glClampToEdge}}
	b.doc.Textures = []texture{{Sampler: 0, Source: 0}}
	b.doc.ExtensionsUsed = []string{"KHR_materials_unlit"}
	mat := b.material(material{Name: "screen", PBRMetallicRoughness: pbr{
		BaseColorFactor: []float64{1, 1, 1, 1}, BaseColorTexture: &textureInfo{Index: 0}, RoughnessFactor: 1,
	}, Extensions: map[string]any{"KHR_materials_unlit": map[string]any{}}})
	z := centre.Z + screenLift
	tl := robot3d.V3{X: centre.X - w/2, Y: centre.Y + h/2, Z: z}
	tr := robot3d.V3{X: centre.X + w/2, Y: centre.Y + h/2, Z: z}
	br := robot3d.V3{X: centre.X + w/2, Y: centre.Y - h/2, Z: z}
	bl := robot3d.V3{X: centre.X - w/2, Y: centre.Y - h/2, Z: z}
	fwd := robot3d.V3{Z: 1}
	pos := []robot3d.V3{tl, bl, br, tl, br, tr} // counter-clockwise seen from the front
	uv := [][2]float32{{0, 0}, {0, 1}, {1, 1}, {0, 0}, {1, 1}, {1, 0}}
	if err := place("screen", "head", b.mesh("screen", b.primitive(pos, []robot3d.V3{fwd, fwd, fwd, fwd, fwd, fwd}, uv, mat))); err != nil {
		return nil, err
	}

	b.doc.Scenes = []scene{{Name: "robot", Nodes: []int{root}}}
	for b.bin.Len()%4 != 0 {
		b.bin.WriteByte(0)
	}
	b.doc.Buffers = []buffer{{ByteLength: b.bin.Len()}}
	js, err := json.Marshal(b.doc)
	if err != nil {
		return nil, err
	}
	for len(js)%4 != 0 {
		js = append(js, ' ')
	}

	var out bytes.Buffer
	le := func(v uint32) { binary.Write(&out, binary.LittleEndian, v) }
	le(0x46546C67) // "glTF"
	le(2)
	le(uint32(12 + 8 + len(js) + 8 + b.bin.Len()))
	le(uint32(len(js)))
	le(0x4E4F534A) // "JSON"
	out.Write(js)
	le(uint32(b.bin.Len()))
	le(0x004E4942) // "BIN\0"
	out.Write(b.bin.Bytes())
	return out.Bytes(), nil
}
