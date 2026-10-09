# Task 001: the robot in 3D, turning, with its sensors and actuators

For a Claude cloud session in `mj41/s3d-w42-eu`. Paste the part below the line as the session's
first message.

---

You work in `mj41/s3d-w42-eu`, a public repo (Apache-2.0): nothing private in it — no tokens, no
hosts other than the public sites, no personal data. Push only a branch named
`claude/rotating-robot`, never `main`. The setup script (`setup.sh`) has cloned the related public
repos beside this one (`../s-w42-eu-assets`, `../s-w42-eu-raw`, `../StackChan` on branch
`embody-mj41`, `../s-w42-eu-pet`, `../s-w42-eu-focus`, `../s-w42-eu-manager`, `../w42-eu-web`,
`../home-w42-eu`); read the README first.

The goal of the project: s3d.w42.eu shows the Stackchan robot in 3D in the browser; it turns (by
itself, and by drag), its sensors and actuators are marked on it (a toggle hides them), and an app
picked shows what each sensor and actuator does in that app. Everything shown is generated from
data, so a new app is a new description, not new code.

This task builds the first working version:

1. **The model from robot3d.** `../s-w42-eu-assets/robot3d` is a Go software renderer of the
   robot (M5Stack's StackChan STLs plus the drawn CoreS3; parts and offsets in `mesh.go`). Do not
   rewrite it: write a Go command here (`cmd/s3dgen`, importing the public module
   `github.com/mj41/s-w42-eu-assets/robot3d`, or with a `replace` to `../s-w42-eu-assets` if a
   change there is needed — then say what change, as a separate patch) that exports the robot's
   geometry, each part named and placed as robot3d places it, to a glTF binary (`web/robot.glb`).
   If robot3d's types need an exported accessor for this, put it in the patch for s-w42-eu-assets.
2. **The parts as data.** `data/parts.json`: each sensor and actuator — id, name, kind (sensor or
   actuator), what it measures or does, where on the robot (a part and an offset, from robot3d's
   geometry), its source (the file and line in the firmware's or the wire package's docs where it
   is described). Generated or written from those docs, every entry with its source; nothing
   invented — what the docs do not say is left out, and listed in the summary.
3. **The apps as data.** `data/apps/<app>.json` for the apps the manager's catalog lists that have
   their own repo here (pet, focus): for each sensor and actuator the app uses, what it does with
   it, each with its source (file and line). An app not described there is not added.
4. **The page.** `web/index.html` and one script: WebGL2 (or three.js, pinned version, loaded from
   cdnjs/jsdelivr, if it is clearly simpler — say which and why), the robot from `robot.glb`,
   turning slowly by itself, drag to turn, the sensors and actuators as markers with their names
   (a toggle: on by default), an app picker that highlights the parts that app uses and lists what
   each does. Works on a phone (touch drag, one column) and a desktop.
5. **The site.** A Go binary in the style of `../w42-eu-web` (one binary, the pages embedded, no
   dependencies beyond the standard library), `go run .` serves it on :8080; a Dockerfile like
   w42-eu-web's.
6. **Tests.** Go tests: the glTF exported has every part robot3d has, with the placement robot3d
   uses (a few points checked); `parts.json` and `apps/*.json` load, every app's parts exist in
   `parts.json`, every entry has a source. `go vet ./...` and `go test ./...` green.

When done: push `claude/rotating-robot`, and end with a short summary — what was built, the tests
and their results, what the docs did not say (left out), and any patch for s-w42-eu-assets.
