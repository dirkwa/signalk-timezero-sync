import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Route, ServerAPI, Waypoint } from "@signalk/server-api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AnchorBridge, sameAnchor } from "../src/bridge/anchor.js";
import {
  CourseBridge,
  sameNavigation,
  toNavigation,
} from "../src/bridge/course.js";
import {
  fingerprint,
  fromSkRoute,
  fromSkWaypoint,
  toSkRoute,
  toSkWaypoint,
  tombstone,
} from "../src/bridge/mapping.js";
import { ResourcesBridge } from "../src/bridge/resources.js";
import { TimeZeroPeer } from "../src/peer/engine.js";
import { encodePolyline } from "../src/protocol/geometry.js";
import {
  COLUMN,
  emptyRow,
  parseUserObject,
  type UserObject,
} from "../src/protocol/userObject.js";

const ID = "0059e9da-74ab-4e94-a9d9-25e6a4881769";
const NOW = new Date("2026-10-08T20:35:00Z");

const route: Route = {
  name: "SK test route",
  description: "three points east",
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
    properties: {
      coordinatesMeta: [{ name: "" }, { name: "Mid" }, { name: "" }],
    },
  },
};

const waypoint: Waypoint = {
  name: "Reef pass",
  feature: {
    type: "Feature",
    geometry: { type: "Point", coordinates: [177.2, -17.75] },
  },
};

const asObject = (o: Omit<UserObject, "tick">, tick = 1): UserObject => ({
  ...o,
  tick,
});

describe("mapping", () => {
  test("a Signal K route survives a trip through TimeZero", () => {
    const tz = asObject(fromSkRoute(ID, route, undefined, NOW)!);
    expect(tz.values[COLUMN.objectType]).toBe(5);
    expect(tz.values[COLUMN.name]).toBe("SK test route");
    // Rows for the first point and for the named one only, as TimeZero sends.
    expect(tz.points!.map((p) => p[0])).toEqual([0, 1]);
    const back = toSkRoute(tz)!;
    expect(back.name).toBe(route.name);
    expect(back.description).toBe(route.description);
    expect(fingerprint("routes", back)).toBe(fingerprint("routes", route));
  });

  test("a Signal K waypoint survives a trip through TimeZero", () => {
    const tz = asObject(fromSkWaypoint(ID, waypoint, undefined, NOW)!);
    expect(tz.values[COLUMN.objectType]).toBe(0);
    expect(fingerprint("waypoints", toSkWaypoint(tz)!)).toBe(
      fingerprint("waypoints", waypoint),
    );
  });

  test("an edit keeps TimeZero's own fields", () => {
    const original = asObject(fromSkWaypoint(ID, waypoint, undefined, NOW)!);
    original.values[COLUMN.icon] = 18;
    original.values[COLUMN.color] = 2;
    const edited = fromSkWaypoint(
      ID,
      { ...waypoint, name: "Renamed" },
      original,
      NOW,
    )!;
    expect(edited.values[COLUMN.icon]).toBe(18);
    expect(edited.values[COLUMN.color]).toBe(2);
    expect(edited.values[COLUMN.name]).toBe("Renamed");
  });

  test("a deletion becomes a tombstone of the last TimeZero copy", () => {
    const original = asObject(fromSkRoute(ID, route, undefined, NOW)!);
    const t = tombstone(original, NOW);
    expect(t.values[COLUMN.deleted]).toBe(1);
    expect(t.values[COLUMN.name]).toBe("SK test route");
  });

  test("ignores geometry that cannot be a route or a mark", () => {
    const row = emptyRow();
    row[COLUMN.objectType] = 5;
    row[COLUMN.geometry] = encodePolyline([{ latitude: 1, longitude: 1 }]);
    expect(
      toSkRoute({ guid: ID, tick: 1, values: row, points: null }),
    ).toBeNull();
    expect(
      fromSkRoute(
        ID,
        {
          ...route,
          feature: {
            ...route.feature,
            geometry: { type: "LineString", coordinates: [] },
          },
        },
        undefined,
        NOW,
      ),
    ).toBeNull();
  });
});

// A Signal K app with an in-memory resources provider that, like the real
// server, emits a resource delta for every write.
function mockApp(onWrite: (type: string, id: string, value: unknown) => void) {
  const store: Record<string, Record<string, unknown>> = {
    routes: {},
    waypoints: {},
  };
  return {
    store,
    app: {
      debug: () => {},
      error: vi.fn(),
      resourcesApi: {
        listResources: async (type: string) => ({ ...store[type] }),
        setResource: async (
          type: string,
          id: string,
          value: Record<string, unknown>,
        ) => {
          store[type]![id] = value;
          onWrite(type, id, value);
        },
        deleteResource: async (type: string, id: string) => {
          delete store[type]![id];
          onWrite(type, id, null);
        },
      },
    } as unknown as ServerAPI,
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz-bridge-"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makePeer() {
  return new TimeZeroPeer({
    hostName: "SignalK",
    userId: "",
    stateFile: path.join(dir, "peer.json"),
    rejoinPauseMs: 60000,
    debug: () => {},
    error: () => {},
  });
}

describe("resources bridge", () => {
  const tzRoute = () =>
    asObject(fromSkRoute(ID, route, undefined, NOW)!, 33430);

  function setup(offerExisting = true, liveRoutes: number | null = 150) {
    const peer = makePeer();
    const count = { live: liveRoutes };
    vi.spyOn(peer, "liveRouteCount").mockImplementation(async () => count.live);
    const offers: string[] = [];
    vi.spyOn(peer, "offer").mockImplementation((objs) =>
      offers.push(...objs.map((o) => o.guid)),
    );
    vi.spyOn(peer, "rejoin").mockImplementation(() => {});
    // The provider's write deltas go to the bridge, created just below.
    const ref: { bridge?: ResourcesBridge } = {};
    const { app, store } = mockApp((type, id, value) =>
      ref.bridge?.onResourceDelta(type as "routes", id, value),
    );
    const bridge = new ResourcesBridge(app, peer, {
      types: ["routes", "waypoints"],
      stateFile: path.join(dir, "resources.json"),
      offerExisting,
      maxRoutes: 200,
    });
    ref.bridge = bridge;
    const status = vi.fn();
    (app as unknown as { setPluginStatus: typeof status }).setPluginStatus =
      status;
    return { peer, bridge, store, offers, count, status };
  }

  test("writes a TimeZero route into Signal K and does not echo it back", async () => {
    const { bridge, store, offers } = setup();
    await bridge.fromTimeZero([tzRoute()]);
    expect((store.routes![ID] as Route).name).toBe("SK test route");
    await vi.runAllTimersAsync();
    expect(offers).toEqual([]);
  });

  test("offers a route edited in Signal K", async () => {
    const { bridge, offers } = setup();
    await bridge.fromTimeZero([tzRoute()]);
    await vi.runAllTimersAsync();
    bridge.onResourceDelta("routes", ID, {
      ...route,
      name: "Edited in Freeboard",
    });
    await vi.runAllTimersAsync();
    expect(offers).toEqual([ID]);
  });

  test("a route deleted in TimeZero is deleted in Signal K, and only if synced", async () => {
    const { bridge, store } = setup();
    await bridge.fromTimeZero([tzRoute()]);
    const deleted = parseUserObject({
      Guid: ID,
      Tick: 33433,
      Values: (await import("../src/protocol/sqlRow.js")).formatRow(
        tombstone(tzRoute(), NOW).values,
      ),
      PointsValues: null,
    });
    await bridge.fromTimeZero([deleted]);
    expect(store.routes![ID]).toBeUndefined();
    // A TimeZero tombstone for something Signal K never had is ignored.
    await bridge.fromTimeZero([
      { ...deleted, guid: "11111111-2222-3333-4444-555555555555" },
    ]);
  });

  test("on start, offers Signal K routes TimeZero never had", async () => {
    const { bridge, store, offers } = setup();
    store.routes![ID] = route;
    await bridge.reconcile();
    expect(offers).toEqual([ID]);
  });

  describe("TimeZero's route limit", () => {
    const newRoute = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

    test("holds back a new route when TimeZero has no room", async () => {
      const { bridge, offers, status } = setup(true, 200);
      bridge.onResourceDelta("routes", newRoute(1), route);
      await vi.runAllTimersAsync();
      expect(offers).toEqual([]);
      expect(status).toHaveBeenCalledWith(
        expect.stringContaining("200-route limit"),
      );
    });

    test("sends it once there is room, and counts routes still to be pulled", async () => {
      const { bridge, offers, count } = setup(true, 199);
      bridge.onResourceDelta("routes", newRoute(1), route);
      bridge.onResourceDelta("routes", newRoute(2), route);
      await vi.runAllTimersAsync();
      expect(offers).toEqual([newRoute(1)]);
      // Route 1 is not pulled yet, so it still takes the last place.
      count.live = 199;
      bridge.onResourceDelta("routes", newRoute(2), route);
      await vi.runAllTimersAsync();
      expect(offers).toEqual([newRoute(1)]);
    });

    test("sends nothing new when TimeZero's count cannot be read", async () => {
      const { bridge, offers } = setup(true, null);
      bridge.onResourceDelta("routes", newRoute(1), route);
      await vi.runAllTimersAsync();
      expect(offers).toEqual([]);
    });

    test("always sends edits and deletions of routes TimeZero has", async () => {
      const { bridge, offers } = setup(true, 200);
      await bridge.fromTimeZero([tzRoute()]);
      await vi.runAllTimersAsync();
      bridge.onResourceDelta("routes", ID, { ...route, name: "Edited" });
      await vi.runAllTimersAsync();
      bridge.onResourceDelta("routes", ID, null);
      await vi.runAllTimersAsync();
      expect(offers).toEqual([ID, ID]);
    });

    test("a held-back route goes once a pull frees room", async () => {
      const { peer, bridge, store, offers, count } = setup(true, 200);
      bridge.onResourceDelta("routes", newRoute(1), route);
      await vi.runAllTimersAsync();
      expect(offers).toEqual([]);
      count.live = 199;
      store.routes![newRoute(1)] = route;
      peer.emit("pulled", ["something-else"]);
      await vi.runAllTimersAsync();
      expect(offers).toEqual([newRoute(1)]);
    });

    test("a route still waiting to be pulled keeps its place after a restart", async () => {
      const count = { live: 199 as number | null };
      const makeBridge = (offers: string[]) => {
        const peer = makePeer();
        vi.spyOn(peer, "liveRouteCount").mockImplementation(
          async () => count.live,
        );
        vi.spyOn(peer, "rejoin").mockImplementation(() => {});
        const real = peer.offer.bind(peer);
        vi.spyOn(peer, "offer").mockImplementation((objs) => {
          offers.push(...objs.map((o) => o.guid));
          real(objs);
        });
        const { app } = mockApp(() => {});
        (app as unknown as { setPluginStatus: () => void }).setPluginStatus =
          () => {};
        const bridge = new ResourcesBridge(app, peer, {
          types: ["routes"],
          stateFile: path.join(dir, "resources.json"),
          offerExisting: true,
          maxRoutes: 200,
        });
        return bridge;
      };
      const first: string[] = [];
      const before = makeBridge(first);
      before.onResourceDelta("routes", newRoute(1), route);
      await vi.runAllTimersAsync();
      expect(first).toEqual([newRoute(1)]);
      // Restart: TimeZero has not pulled route 1, so its place is still taken.
      const second: string[] = [];
      const after = makeBridge(second);
      after.onResourceDelta("routes", newRoute(2), route);
      await vi.runAllTimersAsync();
      expect(second).toEqual([]);
    });

    test("two changes at once cannot both take the last place", async () => {
      const { peer, bridge, store, offers } = setup(true, 199);
      // Both counts arrive in the same instant, so without serialising the
      // two commits both would see one free place.
      let answer!: () => void;
      const gate = new Promise<void>((r) => (answer = r));
      vi.mocked(peer.liveRouteCount).mockImplementation(() =>
        gate.then(() => 199),
      );
      store.routes![newRoute(2)] = route;
      bridge.onResourceDelta("routes", newRoute(1), route);
      await vi.advanceTimersByTimeAsync(1100); // the first change settles
      const reconciling = bridge.reconcile();
      await vi.advanceTimersByTimeAsync(10);
      answer();
      await vi.runAllTimersAsync();
      await reconciling;
      expect(offers).toHaveLength(1);
    });

    test("a held-back route is retried even when existing routes are not sent", async () => {
      const { peer, bridge, store, offers, count } = setup(false, 200);
      bridge.onResourceDelta("routes", newRoute(1), route);
      await vi.runAllTimersAsync();
      expect(offers).toEqual([]);
      store.routes![newRoute(1)] = route;
      count.live = 150;
      peer.emit("pulled", ["something-else"]);
      await vi.runAllTimersAsync();
      expect(offers).toEqual([newRoute(1)]);
    });

    test("a held-back route is sent on a later start", async () => {
      const { bridge, store, offers, count } = setup(true, 200);
      store.routes![newRoute(1)] = route;
      await bridge.reconcile();
      expect(offers).toEqual([]);
      count.live = 150;
      await bridge.reconcile();
      expect(offers).toEqual([newRoute(1)]);
    });
  });

  test("on start, leaves them alone when offering existing ones is off", async () => {
    const { bridge, store, offers } = setup(false);
    store.routes![ID] = route;
    await bridge.reconcile();
    expect(offers).toEqual([]);
  });
});

describe("course bridge", () => {
  const routeCourse = (reverse = false) => ({
    startTime: null,
    targetArrivalTime: null,
    arrivalCircle: 0,
    activeRoute: {
      href: `/resources/routes/${ID}`,
      pointIndex: 1,
      pointTotal: 3,
      reverse,
      name: "r",
    },
    nextPoint: null,
    previousPoint: null,
  });

  test("maps Signal K courses to TimeZero navigation", () => {
    expect(toNavigation(routeCourse() as never)).toMatchObject({
      kind: "route",
      routeGuid: ID,
      pointIndex: 1,
    });
    expect(
      toNavigation({
        ...routeCourse(),
        activeRoute: null,
        nextPoint: {
          type: "Location",
          position: { latitude: 1, longitude: 2 },
        },
      } as never),
    ).toMatchObject({ kind: "goto" });
    expect(
      toNavigation({ ...routeCourse(), activeRoute: null } as never),
    ).toEqual({ kind: "none" });
  });

  test("leaves TimeZero alone for a reversed route", () => {
    expect(toNavigation(routeCourse(true) as never)).toBeNull();
  });

  test("compares courses by what is navigated to, not the origin", () => {
    const a = {
      kind: "goto" as const,
      origin: { latitude: 0, longitude: 0 },
      destination: { latitude: 1, longitude: 2 },
      mob: false,
    };
    expect(sameNavigation(a, { ...a, origin: null })).toBe(true);
    expect(
      sameNavigation(a, {
        ...a,
        destination: { latitude: 1.001, longitude: 2 },
      }),
    ).toBe(false);
  });

  test("waits for TimeZero to pull a route before activating it there", async () => {
    const peer = makePeer();
    peer.offer([fromSkRoute(ID, route, undefined, NOW)!]);
    const set = vi.spyOn(peer, "setNavigation");
    const app = {
      getCourse: async () => routeCourse(),
      debug: () => {},
      error: () => {},
    } as unknown as ServerAPI;
    const bridge = new CourseBridge(app, peer);
    await bridge.fromSignalK();
    expect(set).not.toHaveBeenCalled();
    peer.emit("pulled", [ID]);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "route", routeGuid: ID }),
    );
  });

  test("a cancel before TimeZero pulls the route drops the waiting activation", async () => {
    const peer = makePeer();
    peer.offer([fromSkRoute(ID, route, undefined, NOW)!]);
    const set = vi.spyOn(peer, "setNavigation");
    let current: unknown = routeCourse();
    const app = {
      getCourse: async () => current,
      debug: () => {},
      error: () => {},
    } as unknown as ServerAPI;
    const bridge = new CourseBridge(app, peer);
    await bridge.fromSignalK();
    current = { ...routeCourse(), activeRoute: null };
    await bridge.fromSignalK();
    peer.emit("pulled", [ID]);
    expect(set).not.toHaveBeenCalled();
  });

  test("applies TimeZero navigation through the Course API", async () => {
    const peer = makePeer();
    const app = {
      clearDestination: vi.fn(async () => {}),
      setDestination: vi.fn(async () => {}),
      activateRoute: vi.fn(async () => {}),
      error: vi.fn(),
    } as unknown as ServerAPI;
    const bridge = new CourseBridge(app, peer);
    await bridge.fromTimeZero({
      kind: "route",
      origin: null,
      routeGuid: ID,
      pointIndex: 2,
    });
    expect(app.activateRoute).toHaveBeenCalledWith({
      href: `/resources/routes/${ID}`,
      pointIndex: 2,
    });
    await bridge.fromTimeZero({ kind: "none" });
    expect(app.clearDestination).toHaveBeenCalled();
  });
});

describe("anchor bridge", () => {
  test("drops and raises through the anchor plugin's PUT handler", async () => {
    const peer = makePeer();
    const puts: unknown[] = [];
    const app = {
      putSelfPath: vi.fn(async (_p: string, value: unknown) => {
        puts.push(value);
        return { state: "COMPLETED", statusCode: 200 };
      }),
      error: vi.fn(),
    } as unknown as ServerAPI;
    const bridge = new AnchorBridge(app, peer);
    bridge.fromTimeZero({
      position: { latitude: -17.8, longitude: 177.15 },
      radius: 60,
    });
    bridge.fromTimeZero(null);
    await vi.runAllTimersAsync();
    expect(puts).toEqual([
      { latitude: -17.8, longitude: 177.15, radius: 60 },
      null,
    ]);
  });

  test("sends a Signal K anchor change, but not a zone TimeZero cannot show", () => {
    const peer = makePeer();
    const set = vi.spyOn(peer, "setAnchor");
    const values: Record<string, unknown> = {
      "navigation.anchor.position.value": {
        latitude: -17.8,
        longitude: 177.15,
      },
      "navigation.anchor.maxRadius.value": 60,
    };
    const app = {
      getSelfPath: (p: string) => values[p],
    } as unknown as ServerAPI;
    const bridge = new AnchorBridge(app, peer);
    bridge.fromSignalK();
    expect(set).toHaveBeenLastCalledWith({
      position: { latitude: -17.8, longitude: 177.15 },
      radius: 60,
    });
    values["navigation.anchor.maxRadius.value"] = null; // a polygon zone
    values["navigation.anchor.position.value"] = {
      latitude: -17.9,
      longitude: 177.15,
    };
    bridge.fromSignalK();
    expect(set).toHaveBeenCalledTimes(1);
  });

  test("compares anchors to TimeZero's precision", () => {
    const a = { position: { latitude: -17.8, longitude: 177.15 }, radius: 60 };
    expect(sameAnchor(a, { ...a, radius: 60.001 })).toBe(true);
    expect(sameAnchor(a, null)).toBe(false);
    expect(sameAnchor(null, null)).toBe(true);
  });
});
