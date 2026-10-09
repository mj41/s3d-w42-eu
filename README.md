# s3d-w42-eu

[s3d.w42.eu](https://s3d.w42.eu): the Stackchan robot in 3D, in the browser — turn it round, see
its sensors and actuators (or hide them), pick an app and see what each sensor and actuator does
in it. Everything shown is generated from data: the robot's parts and their places come from
`robot3d` in [s-w42-eu-assets](https://github.com/mj41/s-w42-eu-assets), the sensors and
actuators from the firmware and the wire package, each app's use of them from the app's own
description — so a new app is a new description, not new code.

Related projects (all public, cloned beside this one by `setup.sh`):

| Repo | What it gives here |
|---|---|
| [s-w42-eu-assets](https://github.com/mj41/s-w42-eu-assets) | `robot3d`: the 3D model (M5Stack's StackChan STLs, MIT, and the CoreS3 drawn), parts and offsets (`robot3d/mesh.go`) |
| [s-w42-eu-raw](https://github.com/mj41/s-w42-eu-raw) | the wire package: the sensor and command list |
| [StackChan](https://github.com/mj41/StackChan) (branch `embody-mj41`) | the firmware's sensors and actuators (`firmware/main/apps/app_embody_mode/README.md`) |
| [s-w42-eu-pet](https://github.com/mj41/s-w42-eu-pet), [s-w42-eu-focus](https://github.com/mj41/s-w42-eu-focus) | what each app does with them |
| [s-w42-eu-manager](https://github.com/mj41/s-w42-eu-manager) | the app catalog |
| [w42-eu-web](https://github.com/mj41/w42-eu-web) | the sites' pattern: one Go binary, pages embedded |
| [home-w42-eu](https://github.com/mj41/home-w42-eu) | the docs |

Work is done in `claude/…` branches (a Claude cloud session may make them); `main` is merged by
hand after review. `tasks/` holds the tasks given to cloud sessions.

## What is here

| Path | What it is |
|---|---|
| `cmd/s3dgen` | writes `web/robot.glb` from robot3d (`robot3d.Parts`, `PitchPivot`, `Screen`): nodes robot (mm → m) → base → yaw → head (at the pitch pivot), each part a named node under its joint, the screen a textured quad |
| `data/parts.json` | the sensors and actuators: what each does, where it is (a robot3d part and an offset in mm; left out where the docs do not say), its sources (repo, commit, file, line, a quote from that line) |
| `data/apps/<app>.json` | what an app does with each sensor and actuator it uses, with sources |
| `web/index.html`, `web/app.js` | the page: three.js r160 from jsDelivr (pinned), the robot turning, drag to turn, markers, an app picker |
| `main.go` | the site: one binary, standard library only, everything embedded |
| `cmd/pagecheck` | a headless check of the page in Chrome over the DevTools protocol (standard library only) |

```bash
./setup.sh                 # the related repos beside this one
go run ./cmd/s3dgen        # web/robot.glb (after a change in robot3d)
go vet ./... && go test ./...   # the sources' quotes are checked in the repos beside this one
go run .                   # http://localhost:8080
```

The page check needs Chrome or Chromium installed (found on `PATH`, in the usual places on macOS
and Windows, or in Playwright's download; or give `-chrome` or `$CHROME`). From the
repository's root:

```bash
go run ./cmd/pagecheck     # builds and starts the site on a free port, checks it at 1200 and 420 px
```

It checks that the robot loads and fills most of the view (also after a resize), that the
markers are grouped and a tap on a group opens its list, that no labels overlap while the robot
turns, that nothing overflows the side panel or the page, and that there are no console errors;
it prints each check, the path of a screenshot of each width (in a temporary directory, or
`-o dir`), and exits 1 if a check failed. `-url` checks a running site instead; `-three-dir
node_modules/three` serves three.js from a local copy (npm `three@0.160.0`) where jsDelivr
cannot be reached.

**robot3d's details as textures.** `s3dgen` bakes what robot3d's renderer draws on the CoreS3,
the main body and the back panel (the glass front and the red ring, the sensors' dots, the vents,
the ports and the power button, the labels) into textures, from `robot3d.Surface`. `go.mod` pins
s-w42-eu-assets at the commit that has it (branch `claude/robot3d-interior` there, with the inside of
the head as on the photos: the servo body's top cover and the black pitch servo); once that is in
its `main`, `go get` the merge.

**The page's light.** The robot casts a soft shadow on the ground, and its LEDs glow (the bars lit
and a soft glow over each of the 12 LEDs): light blue as on the photos of a real robot, or the
colour an app's `leds` gives (with its sources), e.g. Focus's red while focusing.

A new app is a new `data/apps/<app>.json`; a new sensor a new entry in `data/parts.json`.

## License

Apache License 2.0 (see LICENSE); the StackChan structure files it shows are M5Stack's, MIT.
