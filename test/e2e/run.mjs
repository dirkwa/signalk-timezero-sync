#!/usr/bin/env node
// End-to-end test: a real Signal K server with this plugin, Hoeken's Anchor
// Alarm and the resources provider, against the fake TimeZero master, on a
// private podman network. Needs podman and a Signal K server image.
//
//   node test/e2e/run.mjs [--image <signalk-server image>] [--server-src <checkout>]
//                         [--anchor-plugin <dir>]
//
// --server-src runs a built signalk-server checkout (e.g. master) inside the
// image instead of the server it ships.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, a, i, all) =>
        a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc,
      [],
    ),
);
const IMAGE = args.image ?? "ghcr.io/signalk/signalk-server:latest";
const PLUGIN = path.resolve(new URL("../..", import.meta.url).pathname);
const ANCHOR_PLUGIN = args["anchor-plugin"]
  ? path.resolve(args["anchor-plugin"])
  : null;
const SERVER_SRC = args["server-src"] ? path.resolve(args["server-src"]) : null;
const E2E = path.dirname(new URL(import.meta.url).pathname);
const USER_ID = "d5ff170c-4a28-47e0-b54f-1f98bda46c1c";
const NET = "tz-sync-e2e";
const SK = "tz-sync-e2e-sk";
const TZ = "tz-sync-e2e-tz";
const API = "http://127.0.0.1:3911";
const CTL = "http://127.0.0.1:3912";
const SELF = { latitude: -17.8075, longitude: 177.1545 };

const podman = (...a) =>
  execFileSync("podman", a, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const quiet = (...a) => {
  try {
    podman(...a);
  } catch {
    /* already gone */
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures++;
};
async function waitFor(name, fn, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return check(name, true);
    } catch (e) {
      last = e.message;
    }
    await sleep(1000);
  }
  check(name, false, `last: ${JSON.stringify(last)?.slice(0, 300)}`);
}

const get = async (url) => (await fetch(url)).json();
const send = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const tz = (p = "/state", body) =>
  body ? send("POST", CTL + p, body).then((r) => r.json) : get(CTL + p);
const course = () =>
  get(`${API}/signalk/v2/api/vessels/self/navigation/course`);
const routes = () => get(`${API}/signalk/v2/api/resources/routes`);
const anchorPosition = async () =>
  (
    await get(
      `${API}/signalk/v1/api/vessels/self/navigation/anchor/position`,
    ).catch(() => ({}))
  ).value ?? null;

function cleanup() {
  quiet("rm", "-f", "-t", "2", SK, TZ);
  quiet("network", "rm", "-f", NET);
}

// preload: resources and a course the server already has before the plugin
// first runs, like a boat that has been sailing with Signal K for a while.
function serverHome({ maxRoutes = 2, anchorZone = null, preload = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz-sync-e2e-"));
  const cfg = path.join(home, "plugin-config-data");
  fs.mkdirSync(cfg, { recursive: true });
  fs.mkdirSync(path.join(home, "node_modules"));
  fs.writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({ pipedProviders: [], interfaces: {} }),
  );
  const deps = { "signalk-timezero-sync": "*" };
  if (ANCHOR_PLUGIN) deps["hoekens-anchor-alarm"] = "*";
  fs.writeFileSync(
    path.join(home, "package.json"),
    JSON.stringify({ name: "e2e", dependencies: deps }),
  );
  const plugin = (id, configuration) =>
    fs.writeFileSync(
      path.join(cfg, `${id}.json`),
      JSON.stringify({ enabled: true, configuration }),
    );
  plugin("signalk-timezero-sync", {
    hostName: "SignalK-E2E",
    userId: USER_ID,
    rejoinPauseSeconds: 12,
    maxRoutes,
  });
  plugin("resources-provider", {
    standard: { routes: true, waypoints: true, notes: true, regions: true },
    custom: [],
    path: "./resources",
  });
  if (ANCHOR_PLUGIN)
    plugin("hoekens-anchor-alarm", {
      state: "emergency",
      enableTimeZeroSync: false,
      noPositionAlarmTime: 0,
      allowZoneOutsideVessel: true,
      enableEngineCheck: false,
      ...(anchorZone ? { zone: JSON.stringify(anchorZone) } : {}),
    });
  if (preload) {
    for (const type of ["routes", "waypoints"]) {
      const dir = path.join(cfg, "resources-provider", "resources", type);
      fs.mkdirSync(dir, { recursive: true });
      for (const [id, value] of Object.entries(preload[type] ?? {}))
        fs.writeFileSync(path.join(dir, id), JSON.stringify(value));
    }
    if (preload.course) {
      const dir = path.join(home, "serverState", "course");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "settings.json"),
        JSON.stringify(preload.course),
      );
    }
  }
  return home;
}

function startServer(home) {
  const mounts = [
    "-v",
    `${home}:/home/node/.signalk`,
    "-v",
    `${PLUGIN}:/home/node/.signalk/node_modules/signalk-timezero-sync:ro`,
  ];
  if (ANCHOR_PLUGIN)
    mounts.push(
      "-v",
      `${ANCHOR_PLUGIN}:/home/node/.signalk/node_modules/hoekens-anchor-alarm:ro`,
    );
  let bin = "/home/node/signalk/node_modules/signalk-server/bin/signalk-server";
  if (SERVER_SRC) {
    mounts.push("-v", `${SERVER_SRC}:/sk:ro`);
    bin = "/sk/bin/signalk-server";
  }
  podman(
    "run",
    "-d",
    "--init",
    "--name",
    SK,
    "--network",
    NET,
    "--ip",
    "10.89.201.10",
    "-p",
    "127.0.0.1:3911:3000",
    "--userns",
    "keep-id:uid=1000,gid=1000",
    ...mounts,
    "--env",
    "PORT=3000",
    "--env",
    "SIGNALK_NODE_CONF_DIR=/home/node/.signalk",
    "--env",
    "DEBUG=signalk-timezero-sync",
    "--entrypoint",
    bin,
    IMAGE,
  );
}

async function serverReady() {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`${API}/signalk/v2/api/resources/routes`)).ok)
        return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error(
    `server did not come up:\n${podman("logs", "--tail", "40", SK)}`,
  );
}

// Keep a vessel position flowing: the Course API and the anchor need one.
function feedPosition() {
  const ws = new WebSocket(
    `${API.replace("http", "ws")}/signalk/v1/stream?subscribe=none`,
  );
  const timer = setInterval(() => {
    if (ws.readyState === 1)
      ws.send(
        JSON.stringify({
          context: "vessels.self",
          updates: [{ values: [{ path: "navigation.position", value: SELF }] }],
        }),
      );
  }, 1000);
  return () => {
    clearInterval(timer);
    ws.close();
  };
}

const ROUTE_A = "aaaaaaaa-0000-4000-8000-000000000001";
const MARK_A = "aaaaaaaa-0000-4000-8000-000000000002";

function startFakeTimeZero(env, mounts = []) {
  podman(
    "run",
    "-d",
    "--name",
    TZ,
    "--network",
    NET,
    "--ip",
    "10.89.201.50",
    "-p",
    "127.0.0.1:3912:8080",
    "-v",
    `${PLUGIN}:/plugin:ro`,
    "-v",
    `${E2E}:/e2e:ro`,
    ...mounts,
    "--env",
    `USER_ID=${USER_ID}`,
    "--env",
    "BROADCAST=10.89.201.255",
    ...env.flatMap((e) => ["--env", e]),
    "--entrypoint",
    "node",
    IMAGE,
    "/e2e/fake-timezero.mjs",
  );
}

async function defaultScenario() {
  cleanup();
  podman("network", "create", "--subnet", "10.89.201.0/24", NET);
  startFakeTimeZero(["MAX_ROUTES=2"]);
  const home = serverHome();
  startServer(home);
  await serverReady();
  // The anchor bridge ignores anchor changes for its first minute, while an
  // anchor plugin may still be restoring its anchor.
  const anchorSettled = Date.now() + 65000;
  let stopFeed = feedPosition();

  console.log("== TimeZero -> Signal K: routes and marks on first contact");
  await waitFor(
    "TimeZero's route appears in Signal K",
    async () => (await routes())[ROUTE_A]?.name === "TZ Route A",
  );
  await waitFor(
    "TimeZero's mark appears as a waypoint",
    async () =>
      (await get(`${API}/signalk/v2/api/resources/waypoints`))[MARK_A]?.name ===
      "TZ Mark 1",
  );

  console.log("== TimeZero -> Signal K: navigation");
  await tz("/navigate", { kind: "route", guid: ROUTE_A, index: 1 });
  await waitFor(
    "a route activated in TimeZero is active in Signal K",
    async () => {
      const c = await course();
      return (
        c.activeRoute?.href === `/resources/routes/${ROUTE_A}` &&
        c.activeRoute.pointIndex === 1
      );
    },
  );
  await tz("/navigate", { kind: "none" });
  await waitFor(
    "a cancel in TimeZero clears the Signal K course",
    async () => !(await course()).nextPoint,
  );
  await tz("/navigate", { kind: "goto", lat: -17.79, lon: 177.16 });
  await waitFor(
    "a go-to in TimeZero is the Signal K destination",
    async () =>
      Math.abs(((await course()).nextPoint?.position?.latitude ?? 0) + 17.79) <
      1e-6,
  );

  console.log("== Signal K -> TimeZero: navigation");
  await send(
    "PUT",
    `${API}/signalk/v2/api/vessels/self/navigation/course/destination`,
    { position: { latitude: -17.7, longitude: 177.2 } },
  );
  await waitFor(
    "a Signal K go-to reaches TimeZero",
    async () =>
      (await tz()).activeRoute.TemporaryDestinationPosition !== "NULL" &&
      (await tz()).log.some((l) => l.includes("peer pushed ActiveRoute")),
  );
  await send("DELETE", `${API}/signalk/v2/api/vessels/self/navigation/course`);
  await waitFor("a Signal K cancel reaches TimeZero", async () => {
    const a = (await tz()).activeRoute;
    return a.TemporaryDestinationPosition === "NULL" && a.RouteGuid === "NULL";
  });

  console.log("== Signal K -> TimeZero: a new route, activated");
  const created = await send("POST", `${API}/signalk/v2/api/resources/routes`, {
    name: "SK Route B",
    feature: {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [177.16, -17.807],
          [177.165, -17.807],
          [177.17, -17.8065],
        ],
      },
      properties: {},
    },
  });
  const routeB = created.json?.id;
  check(
    "Signal K created route B",
    created.status < 300 && typeof routeB === "string",
    JSON.stringify(created),
  );
  await waitFor(
    "TimeZero pulls route B after the rejoin",
    async () =>
      (await tz()).objects.some(
        (o) => o.guid === routeB && o.name === "SK Route B" && o.deleted === 0,
      ),
    60000,
  );
  await send(
    "PUT",
    `${API}/signalk/v2/api/vessels/self/navigation/course/activeRoute`,
    { href: `/resources/routes/${routeB}` },
  );
  await waitFor(
    "route B activated in Signal K is active in TimeZero",
    async () => {
      const r = (await tz()).activeRoute.RouteGuid;
      return r !== "NULL" && r.length > 10;
    },
    30000,
  );

  console.log("== TimeZero's route limit (2 in this test)");
  const createdC = await send(
    "POST",
    `${API}/signalk/v2/api/resources/routes`,
    {
      name: "SK Route C",
      feature: {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [177.2, -17.8],
            [177.21, -17.8],
          ],
        },
        properties: {},
      },
    },
  );
  const routeC = createdC.json?.id;
  await sleep(30000);
  const atLimit = await tz();
  check(
    "a new route is held back while TimeZero is full",
    !atLimit.objects.some((o) => o.guid === routeC) &&
      atLimit.failures.length === 0,
    JSON.stringify(atLimit.failures),
  );

  console.log("== TimeZero -> Signal K: an edit outside a sync round");
  await tz("/route", {
    guid: ROUTE_A,
    name: "TZ Route A renamed",
    points: [
      [-17.8, 177.15],
      [-17.79, 177.16],
      [-17.78, 177.17],
    ],
  });
  await waitFor(
    "a route renamed in TimeZero is renamed in Signal K",
    async () => (await routes())[ROUTE_A]?.name === "TZ Route A renamed",
  );

  if (ANCHOR_PLUGIN) {
    console.log("== anchor, both ways");
    await sleep(Math.max(0, anchorSettled - Date.now()));
    await send("POST", `${API}/plugins/hoekens-anchor-alarm/dropAnchor`, {
      position: SELF,
      zone: { type: "circle", radius: 50 },
    });
    await waitFor("a Signal K anchor drop reaches TimeZero", async () =>
      (await tz()).anchor.Values.startsWith("X'04"),
    );
    await tz("/anchor", { raise: true });
    await waitFor(
      "a raise in TimeZero raises the Signal K anchor",
      async () => (await anchorPosition()) === null,
    );
    await tz("/anchor", {
      lat: SELF.latitude,
      lon: SELF.longitude,
      radius: 70,
    });
    await waitFor(
      "a drop in TimeZero drops the Signal K anchor",
      async () => (await anchorPosition())?.latitude !== undefined,
    );
  }

  console.log("== Signal K -> TimeZero: a deletion");
  await send("DELETE", `${API}/signalk/v2/api/resources/routes/${routeB}`);
  await waitFor(
    "TimeZero gets route B's deletion after the rejoin",
    async () =>
      (await tz()).objects.some((o) => o.guid === routeB && o.deleted === 1),
    60000,
  );

  console.log("== restart");
  const before = await tz();
  stopFeed();
  podman("restart", "-t", "10", SK);
  await serverReady();
  stopFeed = feedPosition();
  await sleep(15000);
  const after = await tz();
  check(
    "TimeZero sees the same Signal K peer after a restart",
    Object.keys(after.records).length === Object.keys(before.records).length,
    JSON.stringify(after.records),
  );
  if (ANCHOR_PLUGIN)
    check(
      "the anchor survives the restart",
      (await anchorPosition())?.latitude !== undefined,
    );
  // Route B was deleted, so route C now fits and goes on start.
  await waitFor(
    "the held-back route reaches TimeZero once there is room",
    async () =>
      (await tz()).objects.some((o) => o.guid === routeC && o.deleted === 0),
    90000,
  );
  const end = await tz();
  check(
    "TimeZero never had to delete a route, and no table was pushed to it",
    end.failures.length === 0,
    end.failures.join("; "),
  );

  stopFeed();
  console.log("\n-- fake TimeZero log --\n" + after.log.join("\n"));
}

// First contact with a TimeZero that already holds a real table, from a
// Signal K that already has routes, a waypoint, an old go-to and an anchor
// down. Nothing of TimeZero's may change, and nothing Signal K had before the
// plugin started may be pushed as if it were a change.
async function firstContact(seed) {
  const table = JSON.parse(fs.readFileSync(seed, "utf8"));
  const row = (o) => {
    const out = [];
    let cur = "";
    let q = false;
    for (const ch of o.Values) {
      if (ch === "'") q = !q;
      if (ch === "," && !q) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const liveNoLayer = (type) =>
    table.Objects.filter((o) => {
      const r = row(o);
      return r[0] === type && r[10] === "0" && r[12] === "NULL";
    }).length;
  const liveRoutes = table.Objects.filter(
    (o) => row(o)[0] === "5" && row(o)[10] === "0",
  ).length;
  const skRoute = (lon) => ({
    name: `SK own route ${lon}`,
    feature: {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [lon, -17.8],
          [lon + 0.01, -17.8],
        ],
      },
      properties: {},
    },
  });
  const SK_ROUTES = {
    "bbbbbbbb-0000-4000-8000-000000000001": skRoute(177.3),
    "bbbbbbbb-0000-4000-8000-000000000002": skRoute(177.4),
  };
  const SK_WAYPOINT = "bbbbbbbb-0000-4000-8000-000000000003";
  const STALE_GOTO = {
    startTime: "2026-10-08T01:40:04.715Z",
    targetArrivalTime: null,
    arrivalCircle: 20,
    activeRoute: null,
    nextPoint: {
      position: { latitude: -17.822, longitude: 177.171 },
      type: "Location",
      name: "DP",
    },
    previousPoint: {
      position: { latitude: -17.79, longitude: 177.244 },
      type: "VesselPosition",
      name: "VP",
    },
  };

  cleanup();
  podman("network", "create", "--subnet", "10.89.201.0/24", NET);
  // Full, as the boat's TimeZero was.
  startFakeTimeZero(
    [`SEED=/seed/table.json`, `MAX_ROUTES=${liveRoutes}`],
    ["-v", `${seed}:/seed/table.json:ro`],
  );
  const home = serverHome({
    maxRoutes: liveRoutes,
    anchorZone: ANCHOR_PLUGIN
      ? { type: "circle", radius: 46, position: SELF }
      : null,
    preload: {
      routes: SK_ROUTES,
      waypoints: {
        [SK_WAYPOINT]: {
          name: "SK own waypoint",
          feature: {
            type: "Feature",
            geometry: { type: "Point", coordinates: [177.3, -17.7] },
          },
        },
      },
      course: STALE_GOTO,
    },
  });
  startServer(home);
  await serverReady();
  const stopFeed = feedPosition();
  const tzBefore = await tz();

  console.log(`== first contact: ${table.Objects.length} TimeZero objects`);
  await waitFor(
    `all of TimeZero's ${liveNoLayer("5")} routes are in Signal K`,
    async () => Object.keys(await routes()).length >= liveNoLayer("5") + 2,
    180000,
  );
  await waitFor(
    `all of TimeZero's ${liveNoLayer("0")} marks are waypoints in Signal K`,
    async () =>
      Object.keys(await get(`${API}/signalk/v2/api/resources/waypoints`))
        .length >=
      liveNoLayer("0") + 1,
    180000,
  );
  await waitFor(
    "TimeZero pulls Signal K's own waypoint",
    async () => (await tz()).objects.some((o) => o.guid === SK_WAYPOINT),
    90000,
  );
  // Let any further offers and rejoins play out.
  await sleep(45000);
  const after = await tz();
  const seedByGuid = new Map(table.Objects.map((o) => [o.Guid, o]));
  const changed = after.objects.filter((o) => {
    const orig = seedByGuid.get(o.guid);
    return (
      orig && (o.tick !== orig.Tick || String(o.deleted) !== row(orig)[10])
    );
  });
  check(
    "none of TimeZero's objects changed",
    changed.length === 0,
    JSON.stringify(changed.slice(0, 5)),
  );
  check(
    "TimeZero pulled nothing but Signal K's own objects",
    after.log
      .filter((l) => l.includes("round: pulled"))
      .every((l) => l.includes(SK_WAYPOINT)),
    after.log.filter((l) => l.includes("round: pulled")).join("; "),
  );
  check(
    "Signal K's own routes are held back while TimeZero is full",
    !after.objects.some((o) => o.guid in SK_ROUTES),
  );
  check(
    "the old Signal K go-to is not pushed to TimeZero",
    after.activeRoute.TemporaryDestinationPosition === "NULL" &&
      after.activeRoute.RouteGuid === "NULL",
    JSON.stringify(after.activeRoute),
  );
  check(
    "TimeZero's anchor watch is unchanged",
    after.anchor.ChangeTick === tzBefore.anchor.ChangeTick,
    JSON.stringify(after.anchor),
  );
  check(
    "Signal K keeps its go-to",
    Math.abs(((await course()).nextPoint?.position?.latitude ?? 0) + 17.822) <
      1e-6,
  );
  if (ANCHOR_PLUGIN)
    check(
      "Signal K's anchor stays down",
      (await anchorPosition())?.latitude !== undefined,
    );
  check(
    "TimeZero never had to delete a route, and no table was pushed to it",
    after.failures.length === 0,
    after.failures.join("; "),
  );
  stopFeed();

  // A restart that lost the record of which objects came from TimeZero (a
  // deleted or older resources.json) while the peer state survived: TimeZero
  // then sends nothing on rejoin, and Signal K's copies of its objects must
  // not look new.
  console.log("== restart without resources.json");
  quiet("rm", "-f", "-t", "5", SK);
  const state = path.join(home, "plugin-config-data", "signalk-timezero-sync");
  fs.renameSync(
    path.join(state, "resources.json"),
    path.join(state, "resources.json.lost"),
  );
  const pullsBefore = after.log.filter((l) => l.includes("round: pulled"));
  startServer(home);
  await serverReady();
  const stopFeed2 = feedPosition();
  await waitFor(
    "the plugin knows TimeZero's objects again",
    () => {
      try {
        const saved = JSON.parse(
          fs.readFileSync(path.join(state, "resources.json"), "utf8"),
        );
        return Object.keys(saved.known).length >= liveNoLayer("5");
      } catch {
        return false;
      }
    },
    180000,
  );
  // A rejoin pause and a round, had anything been offered.
  await sleep(45000);
  const restarted = await tz();
  const pullsAfter = restarted.log.filter((l) => l.includes("round: pulled"));
  check(
    "after the restart TimeZero pulls nothing",
    pullsAfter.length === pullsBefore.length,
    pullsAfter.slice(pullsBefore.length).join("; "),
  );
  const offered = JSON.parse(
    fs.readFileSync(path.join(state, "peer.json"), "utf8"),
  ).offered;
  check(
    "after the restart nothing is offered",
    Object.keys(offered).length === 0,
    Object.keys(offered).slice(0, 5).join(", "),
  );
  const changedAfterRestart = restarted.objects.filter((o) => {
    const orig = seedByGuid.get(o.guid);
    return (
      orig && (o.tick !== orig.Tick || String(o.deleted) !== row(orig)[10])
    );
  });
  check(
    "after the restart none of TimeZero's objects changed",
    changedAfterRestart.length === 0,
    JSON.stringify(changedAfterRestart.slice(0, 5)),
  );
  stopFeed2();
  console.log(
    "\n-- fake TimeZero log (tail) --\n" + restarted.log.slice(-25).join("\n"),
  );
}

(args.seed ? firstContact(path.resolve(args.seed)) : defaultScenario())
  .catch((e) => {
    failures++;
    console.error(e);
  })
  .finally(() => {
    try {
      console.log(
        "\n-- server log (tail) --\n" + podman("logs", "--tail", "120", SK),
      );
    } catch {
      /* no server */
    }
    cleanup();
    console.log(`\n${failures} failure(s)`);
    process.exit(failures ? 1 : 0);
  });
