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
| `tools/pagecheck.cjs` | a headless check of the page (Playwright): labels apart, panel not overflowing, a group's list on tap, at 1200, 420 and 1600 px |

```bash
./setup.sh                 # the related repos beside this one
go run ./cmd/s3dgen        # web/robot.glb (after a change in robot3d)
go vet ./... && go test ./...   # the sources' quotes are checked in the repos beside this one
go run .                   # http://localhost:8080
```

A new app is a new `data/apps/<app>.json`; a new sensor a new entry in `data/parts.json`.

## License

Apache License 2.0 (see LICENSE); the StackChan structure files it shows are M5Stack's, MIT.
