import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TimeZeroPeer } from "../src/peer/engine.js";
import { buildBeacon } from "../src/protocol/beacon.js";
import { encodePolyline } from "../src/protocol/geometry.js";
import {
  buildActiveRoute,
  buildAnchorWatch,
} from "../src/protocol/navigation.js";
import { formatRow } from "../src/protocol/sqlRow.js";
import {
  emptyRow,
  type UserObjectTableDto,
} from "../src/protocol/userObject.js";

const TZ_ADDRESS = "172.31.3.50";
const ROUTE_GUID = "b15c99c3-d6f9-45c2-b061-b16fdd7ae535";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz-sync-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function makePeer() {
  const peer = new TimeZeroPeer({
    hostName: "SignalK",
    userId: "",
    stateFile: path.join(dir, "peer.json"),
    rejoinPauseMs: 60000,
    debug: () => {},
    error: () => {},
  });
  // Pulls and pushes only run on a started peer; start() itself would bind
  // TimeZero's real ports, so flip the flag instead.
  (peer as unknown as { started: boolean }).started = true;
  return peer;
}

// Record the requests a peer makes, answering like TimeZero does.
function recordRequests(
  peer: TimeZeroPeer,
  answer: (path: string) => { status: number; body: string },
) {
  const calls: string[] = [];
  peer.request = async (_address, method, p, body) => {
    calls.push(`${method} ${p.split("?")[0]}${body ? " " + body : ""}`);
    return answer(p);
  };
  return calls;
}

const tzBeacon = (ticks: { table?: number; route?: number; anchor?: number }) =>
  buildBeacon({
    name: "NAVSTATION",
    userId: "",
    uuid: "00000000-1111-2222-3333-444444444444",
    visibleHosts: 2,
    tableTick: ticks.table ?? 33427,
    routeTick: ticks.route ?? 0,
    fishItTick: 167,
    anchorTick: ticks.anchor ?? 0,
  }).replace("TZ iBoat", "TZ Professional");

const flush = () => new Promise((r) => setImmediate(r));

// Serve a peer's sync endpoint on a loopback port, as if from TimeZero.
async function serve(peer: TimeZeroPeer) {
  const server = http.createServer((req, res) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: TZ_ADDRESS });
    (peer as unknown as { handle: http.RequestListener }).handle(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { call, close: () => server.close() };
}

const routeRow = (name: string) => {
  const row = emptyRow();
  row[0] = 5;
  row[1] = encodePolyline([
    { latitude: -17.807, longitude: 177.16 },
    { latitude: -17.807, longitude: 177.165 },
  ]);
  row[6] = name;
  row[10] = 0;
  return row;
};

describe("identity and ticks across a restart", () => {
  test("keeps the peer id and ticks", () => {
    const a = makePeer();
    a.setAnchor(null);
    a.offer([{ guid: ROUTE_GUID, values: routeRow("A"), points: null }]);
    const b = makePeer();
    expect(b.hostId).toBe(a.hostId);
    expect(b.isPending(ROUTE_GUID)).toBe(true);
    expect(b.hasSynced.anchor).toBe(true);
  });
});

describe("offering objects for TimeZero to pull", () => {
  test("ticks offers above the shared tick and serves only what TimeZero lacks", async () => {
    const peer = makePeer();
    const { call, close } = await serve(peer);
    try {
      // TimeZero pushed its table: we continue from its tick.
      const push: UserObjectTableDto = {
        CurrentTick: 33430,
        SyncTicks: "",
        RemainingToSync: 0,
        Objects: [],
        Layers: [],
      };
      expect(
        (await call("POST", "/LanSynchronizationApi/UserObject", push)).status,
      ).toBe(201);
      peer.offer([{ guid: ROUTE_GUID, values: routeRow("A"), points: null }]);

      const pull = await call(
        "GET",
        "/LanSynchronizationApi/UserObject?MinTick=33430&Limit=5000",
      );
      expect(
        pull.json.Objects.map((o: { Guid: string; Tick: number }) => [
          o.Guid,
          o.Tick,
        ]),
      ).toEqual([[ROUTE_GUID, 33431]]);
      expect(pull.json.CurrentTick).toBe(33431);
      // TimeZero already holds everything at or below MinTick.
      const after = await call(
        "GET",
        "/LanSynchronizationApi/UserObject?MinTick=33431&Limit=5000",
      );
      expect(after.json.Objects).toEqual([]);
      expect(peer.isPending(ROUTE_GUID)).toBe(false);
    } finally {
      close();
    }
  });

  test("treats TimeZero sending an offered object back as confirmation", async () => {
    const peer = makePeer();
    const pulled: string[][] = [];
    peer.on("pulled", (g) => pulled.push(g));
    const objects: unknown[] = [];
    peer.on("objects", (o) => objects.push(...o));
    peer.offer([{ guid: ROUTE_GUID, values: routeRow("A"), points: null }]);
    const { call, close } = await serve(peer);
    try {
      await call("POST", "/LanSynchronizationApi/UserObject", {
        CurrentTick: 33432,
        SyncTicks: "",
        RemainingToSync: 0,
        Objects: [
          {
            Guid: ROUTE_GUID,
            Tick: 33432,
            Values: formatRow(routeRow("A")),
            PointsValues: null,
          },
        ],
        Layers: [],
      });
      expect(pulled).toEqual([[ROUTE_GUID]]);
      expect(peer.isPending(ROUTE_GUID)).toBe(false);
      expect(objects).toHaveLength(1);
    } finally {
      close();
    }
  });

  test("going quiet stops the beacon until the pause is over", () => {
    const peer = makePeer();
    const sent: string[] = [];
    const internals = peer as unknown as {
      socket: { send: (b: string) => void };
      broadcastAddresses: () => string[];
      sendBeacon: () => void;
      silentUntil: number;
    };
    internals.socket = { send: (b) => sent.push(b) };
    internals.broadcastAddresses = () => ["172.31.255.255"];
    internals.sendBeacon();
    peer.rejoin();
    internals.sendBeacon();
    expect(sent).toHaveLength(1);
    internals.silentUntil = Date.now() - 1;
    internals.sendBeacon();
    expect(sent).toHaveLength(2);
  });
});

describe("reading TimeZero's routes and marks", () => {
  test("pulls edits announced in the beacon, page by page", async () => {
    const peer = makePeer();
    const received: string[] = [];
    peer.on("objects", (o) => received.push(...o.map((x) => x.guid)));
    const obj = (guid: string, tick: number) => ({
      Guid: guid,
      Tick: tick,
      Values: formatRow(routeRow(guid)),
      PointsValues: null,
    });
    const pages: Record<string, UserObjectTableDto> = {
      "0": {
        CurrentTick: 33500,
        SyncTicks: "",
        RemainingToSync: 1,
        Objects: [obj("a", 33100)],
        Layers: [],
      },
      "33100": {
        CurrentTick: 33500,
        SyncTicks: "",
        RemainingToSync: 0,
        Objects: [obj("b", 33200)],
        Layers: [],
      },
    };
    const calls = recordRequests(peer, (p) => {
      if (p.includes("GetLock")) return { status: 202, body: "" };
      const min = /MinTick=(\d+)/.exec(p)?.[1];
      return min
        ? { status: 200, body: JSON.stringify(pages[min]) }
        : { status: 200, body: "" };
    });
    peer.onBeacon(tzBeacon({ table: 33500 }), TZ_ADDRESS);
    await flush();
    expect(calls.filter((c) => c.includes("UserObject"))).toHaveLength(2);
    expect(received).toEqual(["a", "b"]);
    // Up to date now: the same beacon reads nothing more.
    calls.length = 0;
    peer.onBeacon(tzBeacon({ table: 33500 }), TZ_ADDRESS);
    await flush();
    expect(calls).toEqual([]);
  });

  test("offers count on above both TimeZero's tick and our last offer", async () => {
    const peer = makePeer();
    const { call, close } = await serve(peer);
    try {
      peer.offer([{ guid: "a", values: routeRow("a"), points: null }]);
      await call("POST", "/LanSynchronizationApi/UserObject", {
        CurrentTick: 33500,
        SyncTicks: "",
        RemainingToSync: 0,
        Objects: [],
        Layers: [],
      });
      peer.offer([{ guid: "b", values: routeRow("b"), points: null }]);
      const pull = await call(
        "GET",
        "/LanSynchronizationApi/UserObject?MinTick=0&Limit=5000",
      );
      expect(
        pull.json.Objects.map((o: { Guid: string; Tick: number }) => [
          o.Guid,
          o.Tick,
        ]),
      ).toEqual([
        ["a", 1],
        ["b", 33501],
      ]);
    } finally {
      close();
    }
  });
});

describe("active route", () => {
  test("pulls a newer TimeZero course and emits it", async () => {
    const peer = makePeer();
    const navs: unknown[] = [];
    peer.on("navigation", (n) => navs.push(n));
    const route = buildActiveRoute(
      { kind: "route", origin: null, routeGuid: ROUTE_GUID, pointIndex: 3 },
      7,
      new Date(),
    );
    const calls = recordRequests(peer, (p) =>
      p.includes("GetLock")
        ? { status: 202, body: "" }
        : {
            status: 200,
            body: p.endsWith("ActiveRoute") ? JSON.stringify(route) : "",
          },
    );
    peer.onBeacon(tzBeacon({ route: 7 }), TZ_ADDRESS);
    await flush();
    expect(calls).toEqual([
      "GET /LanSynchronizationApi/GetLock",
      "GET /LanSynchronizationApi/ActiveRoute",
      "GET /LanSynchronizationApi/ReleaseLock",
    ]);
    expect(navs).toEqual([
      { kind: "route", origin: null, routeGuid: ROUTE_GUID, pointIndex: 3 },
    ]);
  });

  test("on first contact, TimeZero having no course does not cancel ours", async () => {
    const peer = makePeer();
    const navs: unknown[] = [];
    peer.on("navigation", (n) => navs.push(n));
    const none = buildActiveRoute({ kind: "none" }, 12, new Date());
    recordRequests(peer, (p) =>
      p.includes("GetLock")
        ? { status: 202, body: "" }
        : {
            status: 200,
            body: p.endsWith("ActiveRoute") ? JSON.stringify(none) : "",
          },
    );
    peer.onBeacon(tzBeacon({ route: 12 }), TZ_ADDRESS);
    await flush();
    expect(navs).toEqual([]);
    expect(peer.hasSynced.route).toBe(true);
  });

  test("pushes a local course to a TimeZero that is behind", async () => {
    const peer = makePeer();
    const calls = recordRequests(peer, (p) => ({
      status: p.includes("GetLock") ? 202 : 201,
      body: "",
    }));
    peer.onBeacon(tzBeacon({ route: 10 }), TZ_ADDRESS); // learn TimeZero's tick
    await flush();
    peer.setNavigation({
      kind: "goto",
      origin: null,
      destination: { latitude: -17.8, longitude: 177.16 },
      mob: false,
    });
    calls.length = 0;
    peer.onBeacon(tzBeacon({ route: 10 }), TZ_ADDRESS);
    await flush();
    expect(calls[1]).toMatch(/^POST \/LanSynchronizationApi\/ActiveRoute /);
    expect(
      JSON.parse(calls[1]!.split(" ").slice(2).join(" ")).CurrentTick,
    ).toBe(11);
  });
});

describe("anchor watch", () => {
  test("serves the anchor and takes a newer one pushed by TimeZero", async () => {
    const peer = makePeer();
    const anchors: unknown[] = [];
    peer.on("anchor", (a) => anchors.push(a));
    peer.setAnchor({
      position: { latitude: -17.8076, longitude: 177.1549 },
      radius: 60,
    });
    const { call, close } = await serve(peer);
    try {
      const served = await call("GET", "/LanSynchronizationApi/AnchorWatch");
      expect(served.json.ChangeTick).toBe(1);
      expect(served.json.Values).toMatch(/^X'04/);
      // An older tick from a peer must not win.
      await call(
        "POST",
        "/LanSynchronizationApi/AnchorWatch",
        buildAnchorWatch(null, 1, new Date()),
      );
      expect(anchors).toEqual([]);
      await call(
        "POST",
        "/LanSynchronizationApi/AnchorWatch",
        buildAnchorWatch(null, 2, new Date()),
      );
      expect(anchors).toEqual([null]);
    } finally {
      close();
    }
  });
});

describe("TimeZero joining", () => {
  test("announces a TimeZero once when it appears", () => {
    const peer = makePeer();
    recordRequests(peer, () => ({ status: 409, body: "" }));
    let joined = 0;
    peer.on("joined", () => joined++);
    peer.onBeacon(tzBeacon({}), TZ_ADDRESS);
    peer.onBeacon(tzBeacon({}), TZ_ADDRESS);
    expect(joined).toBe(1);
  });
});

describe("TimeZero's route count", () => {
  // From a TZ Professional 5.0 sync diagnostics page.
  const PAGE =
    '<h2>User Objects Information</h2>\r\n<table class="full-size"><tr><th>Name</th><th>Live Count</th><th>Deleted Count</th></tr>\r\n<tr><td>Marks</td><td>742</td><td>87</td></tr><tr><td>Routes</td><td>200</td><td>329</td></tr><tr><td>Areas</td><td>2</td><td>3</td></tr>';

  test("reads the live route count from TimeZero's diagnostics page", async () => {
    const peer = makePeer();
    recordRequests(peer, () => ({ status: 200, body: PAGE }));
    peer.onBeacon(tzBeacon({ table: 0 }), TZ_ADDRESS);
    expect(await peer.liveRouteCount()).toBe(200);
  });

  test("gives no count when the page has changed or no TimeZero is present", async () => {
    const peer = makePeer();
    expect(await peer.liveRouteCount()).toBeNull();
    recordRequests(peer, () => ({ status: 200, body: "<html>other</html>" }));
    peer.onBeacon(tzBeacon({ table: 0 }), TZ_ADDRESS);
    expect(await peer.liveRouteCount()).toBeNull();
  });
});

describe("the sync endpoint", () => {
  test("refuses hosts outside NavNet when no user id is set", async () => {
    const peer = makePeer();
    const server = http.createServer((req, res) => {
      Object.defineProperty(req.socket, "remoteAddress", {
        value: "192.168.0.50",
      });
      (peer as unknown as { handle: http.RequestListener }).handle(req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(
        `http://127.0.0.1:${port}/LanSynchronizationApi/AnchorWatch`,
      );
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  test("grants the sync lock to one peer at a time", async () => {
    const peer = makePeer();
    const { call, close } = await serve(peer);
    try {
      const lock = "/LanSynchronizationApi/GetLock?NetworkID=";
      expect((await call("GET", `${lock}A`)).status).toBe(202);
      expect((await call("GET", `${lock}B`)).status).toBe(409);
      expect(
        (await call("GET", "/LanSynchronizationApi/ReleaseLock?NetworkID=A"))
          .status,
      ).toBe(200);
      expect((await call("GET", `${lock}B`)).status).toBe(202);
    } finally {
      close();
    }
  });

  test("keeps TimeZero's FishIt record and serves it back", async () => {
    const peer = makePeer();
    const { call, close } = await serve(peer);
    try {
      const fishIt = {
        ChangeTick: 167,
        Values: "NULL,NULL,0,0,0,842852066,3000",
      };
      await call("POST", "/LanSynchronizationApi/FishIt", fishIt);
      expect((await call("GET", "/LanSynchronizationApi/FishIt")).json).toEqual(
        fishIt,
      );
    } finally {
      close();
    }
  });
});
