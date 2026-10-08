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
- The master runs a sync round only when a peer joins: lock, schema, read the
  peer's objects above its record, push its own, then active route and FishIt.
  A higher tick in our beacon does not start one, so to hand TimeZero a change
  we go quiet until it drops us and rejoin (`TimeZeroPeer.rejoin`).
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
- Timestamps count seconds from 2000-01-01. GUIDs travel in .NET byte order.

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
