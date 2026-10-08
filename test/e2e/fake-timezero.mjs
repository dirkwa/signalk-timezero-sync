// A fake TimeZero Professional acting as LAN sync master, for end-to-end
// tests. It follows what a real TZ Professional 5.0 did on a boat's NavNet:
//  - beacons every second with its table, route and anchor ticks;
//  - when a peer joins (or returns after going quiet) it runs a sync round:
//    lock, schema, read the peer's objects above the peer's record, push its
//    own objects above that record, read then push the active route and
//    FishIt, release; the peer's record is then its current tick;
//  - it takes pushed ActiveRoute and AnchorWatch records as they come;
//  - a pushed UserObject table is adopted as master data, which is why a peer
//    must never push one. Any such push is logged as a failure.
//
// Peers are trusted by My TIMEZERO user id, because a test network cannot be
// 172.31.x.x next to a real NavNet.
//
// Control API on :8080 — GET /state, POST /route, /navigate, /anchor.

import dgram from "node:dgram";
import http from "node:http";
import crypto from "node:crypto";
import {
  encodeCircle,
  encodePoint,
  encodePolyline,
  guidToBytes,
  toTzTime,
} from "/plugin/dist/protocol/geometry.js";
import {
  formatRow,
  formatValue,
  parseRow,
} from "/plugin/dist/protocol/sqlRow.js";

const USER_ID = process.env.USER_ID;
const BROADCAST = process.env.BROADCAST;
const NAME = "NAVSTATION";
const UUID = crypto.randomUUID();
const HOST_ID = `${NAME}/${UUID}`;
const PEER_GONE_MS = 8000;
// On a Furuno NavNet TimeZero keeps at most 200 routes and deletes the route
// modified longest ago to make room for a new one.
const MAX_ROUTES = Number(process.env.MAX_ROUTES || 200);

const s = {
  currentTick: 1000,
  objects: new Map(), // guid -> { Guid, Tick, Values, PointsValues }
  records: new Map(), // peer hostId -> tick the peer is synced to
  activeRoute: navigation({ kind: "none" }, 3),
  anchor: { ChangeTick: 50, Values: "NULL,10,0,0" },
  fishIt: { ChangeTick: 167, Values: "NULL,NULL,0,0,0,842852066,3000" },
  log: [],
  failures: [],
};
const peers = new Map(); // address -> { hostId, lastSeen, port }
const log = (line) =>
  s.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);

function navigation(nav, tick) {
  const NULL = "NULL";
  return {
    OriginPosition: NULL,
    TemporaryDestinationPosition:
      nav.kind === "goto"
        ? formatValue(encodePoint({ latitude: nav.lat, longitude: nav.lon }))
        : NULL,
    IndexOfNextRealDestinationPoint: -1,
    IndexOfDestinationPoint: nav.kind === "route" ? nav.index : -1,
    IsManOverBoard: 0,
    RouteGuid: nav.kind === "route" ? formatValue(guidToBytes(nav.guid)) : NULL,
    LastModificationDate: toTzTime(new Date()),
    CurrentTick: tick,
  };
}

function routeObject(guid, name, points, deleted) {
  const now = toTzTime(new Date());
  const values = [
    5,
    encodePolyline(
      points.map(([latitude, longitude]) => ({ latitude, longitude })),
    ),
    now,
    now,
    0,
    3,
    name,
    null,
    null,
    0,
    deleted ? 1 : 0,
    0,
    null,
    0,
    String(now),
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  return {
    Guid: guid,
    Tick: ++s.currentTick,
    Values: formatRow(values),
    PointsValues: [`0,NULL,NULL,0,0,0,${now},0,0,0,0`],
  };
}

function markObject(guid, name, [latitude, longitude]) {
  const now = toTzTime(new Date());
  const values = [
    0,
    encodePoint({ latitude, longitude }),
    now,
    now,
    0,
    1,
    name,
    null,
    null,
    0,
    0,
    0,
    null,
    0,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  return {
    Guid: guid,
    Tick: ++s.currentTick,
    Values: formatRow(values),
    PointsValues: null,
  };
}

// ---- beacon ---------------------------------------------------------------

const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
udp.on("message", (msg, rinfo) => {
  const f = msg.toString("utf8").split(";");
  if (f[0] !== "TZ Sync 1.0" || f[6] === HOST_ID || f[4] !== USER_ID) return;
  const known = peers.get(rinfo.address);
  const returning = !known || Date.now() - known.lastSeen > PEER_GONE_MS;
  peers.set(rinfo.address, { hostId: f[6], lastSeen: Date.now() });
  if (returning) {
    log(`peer ${f[6]} joined`);
    setTimeout(
      () =>
        void round(rinfo.address).catch((e) =>
          log(`round failed: ${e.message}`),
        ),
      1000,
    );
  }
});
udp.bind(33000, () => {
  udp.setBroadcast(true);
  setInterval(() => {
    const beacon = `TZ Sync 1.0;${NAME};TZ Professional;;${USER_ID};Cloud;${HOST_ID};33745900;2;1;${s.currentTick};${s.activeRoute.CurrentTick};0;167;${s.anchor.ChangeTick};0;175906`;
    udp.send(beacon, 33000, BROADCAST);
  }, 1000);
});

// ---- the master's sync round ------------------------------------------------

function request(address, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: address,
        port: 32000,
        method,
        path,
        timeout: 5000,
        headers: body ? { "Content-Type": "text/plain; charset=utf-8" } : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

async function round(address) {
  const peer = peers.get(address);
  const id = encodeURIComponent(HOST_ID);
  const lock = await request(
    address,
    "GET",
    `/LanSynchronizationApi/GetLock?NetworkID=${id}`,
  );
  if (lock.status !== 202) return log(`round: peer lock ${lock.status}`);
  try {
    await request(
      address,
      "POST",
      "/LanSynchronizationApi/Schema",
      '{"Version":1,"Tables":[]}',
    );
    const record = s.records.get(peer.hostId) ?? 0;
    const pulled = JSON.parse(
      (
        await request(
          address,
          "GET",
          `/LanSynchronizationApi/UserObject?MinTick=${record}&Limit=5000&CanUseLayers=False`,
        )
      ).body,
    );
    for (const o of pulled.Objects) {
      s.objects.set(o.Guid, { ...o, Tick: ++s.currentTick });
      log(`round: pulled ${o.Guid} deleted=${parseRow(o.Values)[10]}`);
      trimRoutes();
    }
    // A peer without layer support gets no objects that live in a layer.
    const ours = [...s.objects.values()].filter(
      (o) => o.Tick > record && !inLayer(o),
    );
    await request(
      address,
      "POST",
      "/LanSynchronizationApi/UserObject",
      JSON.stringify({
        CurrentTick: s.currentTick,
        SyncTicks: `${HOST_ID}:${s.currentTick}`,
        RemainingToSync: 0,
        Objects: ours,
        Layers: [],
      }),
    );
    log(`round: pushed ${ours.length} object(s) to ${peer.hostId}`);
    s.records.set(peer.hostId, s.currentTick);
    const theirs = JSON.parse(
      (await request(address, "GET", "/LanSynchronizationApi/ActiveRoute"))
        .body || "{}",
    );
    if (theirs.CurrentTick > s.activeRoute.CurrentTick) s.activeRoute = theirs;
    await request(
      address,
      "POST",
      "/LanSynchronizationApi/ActiveRoute",
      JSON.stringify(s.activeRoute),
    );
    await request(address, "GET", "/LanSynchronizationApi/FishIt");
    await request(
      address,
      "POST",
      "/LanSynchronizationApi/FishIt",
      JSON.stringify(s.fishIt),
    );
  } finally {
    await request(
      address,
      "GET",
      `/LanSynchronizationApi/ReleaseLock?NetworkID=${id}`,
    ).catch(() => {});
  }
}

function inLayer(o) {
  return parseRow(o.Values)[12] !== null;
}

function liveRoutes() {
  return [...s.objects.values()].filter((o) => {
    const v = parseRow(o.Values);
    return v[0] === 5 && v[10] === 0;
  });
}

function trimRoutes() {
  const live = liveRoutes();
  if (live.length <= MAX_ROUTES) return;
  const oldest = live.sort(
    (a, b) => parseRow(a.Values)[3] - parseRow(b.Values)[3],
  )[0];
  const v = parseRow(oldest.Values);
  v[10] = 1;
  s.objects.set(oldest.Guid, {
    ...oldest,
    Tick: ++s.currentTick,
    Values: formatRow(v),
  });
  s.failures.push(`route limit: deleted ${oldest.Guid} to make room`);
}

// ---- our own sync endpoint ----------------------------------------------------

let lockHolder = null;
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://tz");
      const p = url.pathname;
      const json = (o) =>
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(o));
      if (p.endsWith("/GetLock")) {
        const who = url.searchParams.get("NetworkID");
        if (lockHolder && lockHolder !== who) return res.writeHead(409).end();
        lockHolder = who;
        return res.writeHead(202).end();
      }
      if (p.endsWith("/ReleaseLock")) {
        lockHolder = null;
        return res.writeHead(200).end();
      }
      if (p.endsWith("/UserObject") && req.method === "GET") {
        const min = Number(url.searchParams.get("MinTick") || 0);
        const limit = Number(url.searchParams.get("Limit") || 5000);
        const layers = url.searchParams.get("CanUseLayers") === "True";
        const newer = [...s.objects.values()]
          .filter((o) => o.Tick > min && (layers || !inLayer(o)))
          .sort((a, b) => a.Tick - b.Tick);
        log(
          `read by peer: UserObject MinTick=${min} -> ${Math.min(newer.length, limit)}`,
        );
        return json({
          CurrentTick: s.currentTick,
          SyncTicks: "",
          RemainingToSync: Math.max(0, newer.length - limit),
          Objects: newer.slice(0, limit),
          Layers: [],
        });
      }
      if (p.endsWith("/UserObject") && req.method === "POST") {
        // What a real TimeZero does with this, and why a peer must not send it.
        const t = JSON.parse(body);
        s.currentTick = t.CurrentTick;
        s.failures.push(
          `peer pushed a UserObject table (CurrentTick ${t.CurrentTick})`,
        );
        return res.writeHead(201).end();
      }
      if (p.endsWith("/ActiveRoute") && req.method === "GET")
        return json(s.activeRoute);
      if (p.endsWith("/ActiveRoute") && req.method === "POST") {
        s.activeRoute = JSON.parse(body);
        log(`peer pushed ActiveRoute tick ${s.activeRoute.CurrentTick}`);
        return res.writeHead(201).end();
      }
      if (p.endsWith("/AnchorWatch") && req.method === "GET")
        return json(s.anchor);
      if (p.endsWith("/AnchorWatch") && req.method === "POST") {
        s.anchor = JSON.parse(body);
        log(`peer pushed AnchorWatch tick ${s.anchor.ChangeTick}`);
        return res.writeHead(201).end();
      }
      if (p.endsWith("/FishIt") && req.method === "GET") return json(s.fishIt);
      if (p === "/LanSynchronizationApi/" || p === "/LanSynchronizationApi") {
        const routes = [...s.objects.values()].filter(
          (o) => parseRow(o.Values)[0] === 5,
        );
        const live = liveRoutes().length;
        return res
          .writeHead(200, { "Content-Type": "text/html" })
          .end(
            `<h2>User Objects Information</h2>\r\n<table class="full-size"><tr><th>Name</th><th>Live Count</th><th>Deleted Count</th></tr>\r\n<tr><td>Routes</td><td>${live}</td><td>${routes.length - live}</td></tr></table>`,
          );
      }
      res.writeHead(200).end();
    });
  })
  .listen(32000, "0.0.0.0");

// ---- control API ------------------------------------------------------------

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = body ? JSON.parse(body) : {};
      if (req.method === "POST" && req.url === "/route") {
        const o = routeObject(
          b.guid ?? crypto.randomUUID(),
          b.name,
          b.points,
          b.deleted,
        );
        s.objects.set(o.Guid, o);
        log(`local edit: route ${o.Guid} tick ${o.Tick}`);
      } else if (req.method === "POST" && req.url === "/mark") {
        const o = markObject(b.guid ?? crypto.randomUUID(), b.name, b.position);
        s.objects.set(o.Guid, o);
      } else if (req.method === "POST" && req.url === "/navigate") {
        s.activeRoute = navigation(b, s.activeRoute.CurrentTick + 1);
      } else if (req.method === "POST" && req.url === "/anchor") {
        const now = toTzTime(new Date());
        const geometry = b.raise
          ? null
          : encodeCircle({ latitude: b.lat, longitude: b.lon }, b.radius);
        s.anchor = {
          ChangeTick: s.anchor.ChangeTick + 1,
          Values: `${formatValue(geometry)},10,${now},${now}`,
        };
      }
      const objects = [...s.objects.values()].map((o) => {
        const v = parseRow(o.Values);
        return {
          guid: o.Guid,
          tick: o.Tick,
          type: v[0],
          name: v[6],
          deleted: v[10],
        };
      });
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          currentTick: s.currentTick,
          records: Object.fromEntries(s.records),
          activeRoute: s.activeRoute,
          anchor: s.anchor,
          objects,
          log: s.log,
          failures: s.failures,
        }),
      );
    });
  })
  .listen(8080, "0.0.0.0");

// Start from a captured TimeZero table (SEED: a UserObject read with
// CanUseLayers=True), or from one route and one mark.
if (process.env.SEED) {
  const { readFileSync } = await import("node:fs");
  const seed = JSON.parse(readFileSync(process.env.SEED, "utf8"));
  for (const o of seed.Objects) s.objects.set(o.Guid, o);
  s.currentTick = seed.CurrentTick;
  console.log(`seeded ${seed.Objects.length} objects at tick ${s.currentTick}`);
} else {
  seedDemo();
}

function seedDemo() {
  const routeA = routeObject(
    "aaaaaaaa-0000-4000-8000-000000000001",
    "TZ Route A",
    [
      [-17.8, 177.15],
      [-17.79, 177.16],
      [-17.78, 177.17],
    ],
  );
  s.objects.set(routeA.Guid, routeA);
  const markA = markObject(
    "aaaaaaaa-0000-4000-8000-000000000002",
    "TZ Mark 1",
    [-17.81, 177.14],
  );
  s.objects.set(markA.Guid, markA);
}
console.log(`fake TimeZero up as ${HOST_ID}`);
