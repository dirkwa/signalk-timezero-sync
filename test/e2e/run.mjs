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

function serverHome() {
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
    });
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

async function main() {
  cleanup();
  podman("network", "create", "--subnet", "10.89.201.0/24", NET);
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
    "--env",
    `USER_ID=${USER_ID}`,
    "--env",
    "BROADCAST=10.89.201.255",
    "--entrypoint",
    "node",
    IMAGE,
    "/e2e/fake-timezero.mjs",
  );
  const home = serverHome();
  startServer(home);
  await serverReady();
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
  check(
    "Signal K never pushed a UserObject table",
    after.failures.length === 0,
    after.failures.join("; "),
  );

  stopFeed();
  console.log("\n-- fake TimeZero log --\n" + after.log.join("\n"));
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
  })
  .finally(() => {
    try {
      console.log(
        "\n-- server log (tail) --\n" + podman("logs", "--tail", "25", SK),
      );
    } catch {
      /* no server */
    }
    cleanup();
    console.log(`\n${failures} failure(s)`);
    process.exit(failures ? 1 : 0);
  });
