# signalk-timezero-sync

A Signal K server plugin that joins TimeZero's LAN sync as a peer and keeps
routes, waypoints, the active route and the anchor watch in step between Signal
K and TimeZero (TZ Professional / TZ iBoat).

## Layout

- `src/protocol/` — TimeZero's wire formats, pure and unit-tested: geometry
  blobs (ellipsoidal Mercator), the 2000 epoch, .NET GUID bytes, SQL value rows,
  the discovery beacon, UserObject, ActiveRoute and AnchorWatch.
- `src/peer/` — the sync peer: beacon, the HTTP sync endpoint on port 32000,
  pulls and pushes, and the state that has to survive a restart.
- `src/bridge/` — the Signal K side: Resources API (routes, waypoints), Course
  API (go-to, active route) and the standard anchor paths.
- `test/` — vitest unit tests. `test/e2e/` — a fake TimeZero master and a
  driver that runs a real Signal K server against it in podman.

## How TimeZero's sync behaves

Observed on a TZ Professional 5.0 on a Furuno NavNet; the code depends on all
of it.

- Peers find each other by a UDP beacon on port 33000 once a second. Fields 10,
  11 and 14 carry the table, active-route and anchor ticks; field 13 is the
  FishIt tick. The peer with the most visible hosts is sync master. With a real
  TimeZero present that must be TimeZero, so we advertise 1.
- Without a My TIMEZERO user id, TimeZero trusts only 172.31.x.x (NavNet)
  addresses.
- The master runs a sync round when a new peer appears, or when a peer's beacon
  claims the master role (a visible-hosts count above its own): lock, schema,
  read the peer's objects above its record, push its own, then active route
  and FishIt. Nothing else starts one: not a higher tick in our beacon, not a
  lower active-route or FishIt tick, and not a peer coming back after a pause
  (TimeZero keeps a silent peer listed for more than ten minutes). So to hand
  TimeZero a change we claim the master role in a single beacon and give it
  back in the next (`TimeZeroPeer.requestRound`).
- TimeZero announces its own edits in its beacon but does not send them, so we
  read them (`GET UserObject`), which is safe.
- **Never POST a UserObject table to TimeZero.** It takes a pushed table as
  master data and replaces its own CurrentTick and sync records with the ones
  in the push, which breaks its sync with every other device. Offer objects
  and let TimeZero pull them.
- ActiveRoute and AnchorWatch are single records: higher tick wins, and a peer
  may push its own. TimeZero accepts a push even with a lower tick than its own,
  so only push when its beacon shows it behind.
- Each restart with a new peer id makes TimeZero re-send every object and add a
  record for the new id to the state it shares with all its peers. The peer id
  and ticks are persisted in the data dir for that reason.
- TimeZero's synced "TimeZero" layer holds at most 200 routes of up to 500
  points (documented in its user guide, Layer Introduction). A new route
  beyond that makes it delete the route modified longest ago, everywhere it
  syncs. The live count is on its diagnostics page
  (`GET /LanSynchronizationApi/`); new routes are only offered while there is
  room, and routes over 500 points are not offered.
- Timestamps count seconds from 2000-01-01. GUIDs travel in .NET byte order.

## What the Signal K side must not do

Learned on a live first contact (see the `fix: make first contact and
start-up safe` commit):

- Never infer a deletion from a resource being absent. During first contact
  hundreds of TimeZero objects are still being written; absence means nothing.
- Never compare Signal K against itself while an import is running: imports,
  offers and the start-up check share one queue.
- Never trust the record of which resources are TimeZero's when it is behind
  the peer's table tick (a lost or older `resources.json`). TimeZero sends a
  returning peer only what is newer than its record of it, so Signal K's
  copies of its objects would look new; the peer reads the whole table again
  first (`TimeZeroPeer.rereadTable`). An unknown resource whose guid TimeZero
  has ever sent is never offered as new.
- Never send state that predates the plugin. The Course API restores its saved
  course after plugins start; a new course counts only if its `startTime` is
  after the plugin started. Anchor changes in the first minute are ignored.
- Run `node test/e2e/run.mjs --seed <captured table>` before any live test: it
  starts from a real TimeZero table and a Signal K with existing state.

## Rules

- **Tests must never reach the network.** Beacons in tests use real NavNet
  addresses, and a pull or push goes to port 32000 on that address, which on a
  boat is a live chartplotter. `test/setup.ts` makes every request fail unless a
  test stubs it, and tests never call `TimeZeroPeer.start()`.
- Live testing against a real TimeZero changes the boat's navigation state.
  Only do it with the owner's go-ahead, and snapshot TimeZero's sync state
  (`GET /LanSynchronizationApi/UserObject?MinTick=999999999`) before and after.
- Code style: TypeScript, ESM, strict. Comments explain why. Keep the protocol
  layer free of I/O.
- Commits: conventional commits, one logical change each.

## Commands

```sh
npm test            # unit tests
npm run ci-lint     # eslint + prettier --check
npm run typecheck
npm run build
node test/e2e/run.mjs --image <signalk-server image> --anchor-plugin <dir>
```
