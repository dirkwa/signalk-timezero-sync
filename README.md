# TimeZero Sync for Signal K

Keeps Signal K and [TimeZero](https://mytimezero.com/) (TZ Professional and TZ
iBoat) in step over TimeZero's own LAN sync, the same way two TimeZero
installations sync with each other:

|                                 | TimeZero → Signal K | Signal K → TimeZero |
| ------------------------------- | ------------------- | ------------------- |
| Routes                          | ✓                   | ✓                   |
| Marks / waypoints               | ✓                   | ✓                   |
| Areas / regions                 | ✓                   | ✓                   |
| Go-to                           | ✓                   | ✓                   |
| Active route and its next point | ✓                   | ✓                   |
| Cancel navigation               | ✓                   | ✓                   |
| Man overboard                   | ✓                   | ✓                   |
| Anchor watch (circle)           | ✓                   | ✓                   |

On the Signal K side it uses the standard Resources API, Course API,
Notifications API and anchor paths, so Freeboard-SK and every other Signal K chart app sees TimeZero's routes
and course, and their changes reach TimeZero.

## Requirements

- Signal K server 2.x with a resources provider (the bundled
  `@signalk/resources-provider` is fine) for routes and waypoints.
- For the anchor watch: an anchor alarm plugin that accepts
  `PUT navigation.anchor.position`, such as Hoeken's Anchor Alarm. **Turn off its
  own "Sync Anchor with TimeZero"**: only one plugin can talk to TimeZero, and
  this one takes over the anchor sync.
- For navigation: **turn on "API Only Mode" for the Course API** (Signal K
  admin, Server → Settings). TimeZero puts its destination on the NMEA 2000
  (or 0183) network while it navigates, and with API Only Mode off, Signal K
  takes that destination over as its own course, beside this plugin. The two
  then fight: a go-to cancelled in a Signal K app comes back from the network
  about 15 seconds later, and a go-to set in Signal K bounces between both
  paths. With API Only Mode on, the course goes only through this plugin, in
  both directions. The plugin's status warns while it is off.
- The network: TimeZero syncs without an account only with devices on a Furuno
  NavNet address (172.31.x.x). If the Signal K server has one, leave the user ID
  blank. On an ordinary LAN, TimeZero only syncs with peers that share its
  My TIMEZERO user ID; enter it in the plugin settings (experimental).

The plugin enables itself when it is installed and starts syncing at the next
server start, with the default settings. These include offering TimeZero the
Signal K routes, waypoints and regions it has never had.

## How it works

The plugin joins TimeZero's sync as a peer named after the "Name shown in
TimeZero" setting. TimeZero stays the sync master.

- **Routes and waypoints** use the TimeZero GUID as the Signal K resource id, so
  each object is the same on both sides. TimeZero sends its routes and marks
  when the plugin joins, and the plugin reads later edits as TimeZero announces
  them. A route or waypoint created, edited or deleted in Signal K is offered to
  TimeZero, which collects it in a sync round. The plugin starts one by
  briefly claiming the sync master role in a single beacon, which makes
  TimeZero sync with it; the next beacon hands the role straight back.
- **Deletions go both ways.** A route or mark deleted in TimeZero is deleted in
  Signal K, and one deleted in Signal K is deleted in TimeZero and on every
  device TimeZero syncs with. Clearing out routes in TimeZero clears them in
  Signal K too, including Signal K routes TimeZero had just received.
- **Locked objects stay locked.** TimeZero protects a locked route or mark
  from being moved or deleted. Signal K has no lock, so a change made to one in
  a Signal K app is undone there and not sent; the plugin's status says so.
  Unlock it in TimeZero first. TimeZero does not share the lock of an area with
  other devices, so a locked area is not protected from Signal K.
- **Man overboard**: a MOB in TimeZero raises Signal K's Person Overboard alarm
  (Notifications API), and TimeZero ending it clears that alarm. A MOB alarm
  raised in Signal K, for example with Freeboard's MOB button, becomes a MOB
  go-to in TimeZero at the alarm's position.
- **Navigation**: TimeZero's go-to and active route map to the Signal K Course
  API both ways. A route has to exist on both sides before it can be activated,
  so activating a new Signal K route waits until TimeZero has collected it.
- **Anchor watch**: the anchor plugin's position and radius go to TimeZero, and
  a drop or raise in TimeZero is applied through the anchor plugin.

State that has to survive a restart (the peer id and sync ticks) is kept in the
plugin's data directory, so a restart neither makes TimeZero re-send everything
nor lets its older state overwrite a newer one.

## Limitations

- **TimeZero holds at most 200 routes, of up to 500 points each.** This is a
  hard limit of TimeZero's own "TimeZero" layer, the only one it syncs with
  TZ iBoat, TZ Navigator and Furuno MFDs (see TimeZero's
  [layer limits](https://userguide.mytimezero.com/tz-professional/Layer_Introduction.htm);
  marks are limited to 30,000). When a 201st route arrives, TimeZero makes
  room by deleting the route modified longest ago, on every device it syncs
  with. The plugin therefore only sends a new Signal K route while TimeZero has
  room, and holds back a route of more than 500 points altogether; its status
  says when it does. Edits and deletions of routes TimeZero has always go
  through. To send held-back routes, delete old routes in TimeZero: they go
  as soon as there is room.

- Only changes made while the plugin runs are sent to TimeZero. A route or
  waypoint deleted in Signal K while the plugin was off stays in TimeZero, and a
  course or anchor that was already set when Signal K started is not sent: a
  go-to left over from an earlier passage must not become TimeZero's course.
  Anchor changes in the first minute after start are not sent either, while an
  anchor plugin may still be restoring its anchor.
- **Areas** sync as Signal K regions with one outline of 3 to 50 corners and
  no holes; TimeZero holds at most 100 areas and lines together, and a new
  region is only sent while there is room. Regions with holes or several
  polygons are not sent.
- **MOB**: clearing the MOB alarm in Signal K does not end the MOB navigation
  in TimeZero; end it at the plotter. A MOB that TimeZero started while Signal K
  was off, or before a Signal K restart, does not raise the alarm in Signal K.
  TimeZero's MOB event marks are not synced.
- TimeZero marks, routes and areas in user layers are left alone.
- Circles, lines, events and tracks are not synced.
- TimeZero has no reverse flag, so a route followed in reverse in Signal K is not
  sent to TimeZero.
- TimeZero's anchor watch is a circle; polygon and sector anchor zones are not
  sent.
- Signal K changes reach TimeZero within a few seconds, not instantly;
  sometimes TimeZero only answers the plugin's next request, a minute later.
- If a Signal K plugin such as signalk-to-nmea2000 also puts Signal K's course
  on the NMEA 2000 network, TimeZero and Signal K both send the same
  destination there while navigating. Make sure an autopilot follows only one
  of them.

## Development

```sh
npm install
npm test
npm run build
node test/e2e/run.ts --image ghcr.io/signalk/signalk-server:latest --anchor-plugin ../hoekens-anchor-alarm
```

The end-to-end test runs a real Signal K server against a fake TimeZero master
on a private podman network. See [AGENTS.md](AGENTS.md) for what the plugin
relies on in TimeZero's sync, and the rules for testing against a real one.

## License

Copyright 2026 Dirk Wahrheit. Licensed under the [Apache License 2.0](LICENSE).
