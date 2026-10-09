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
  fromSkRegion,
  fromSkRoute,
  fromSkWaypoint,
  toSkRegion,
  toSkRoute,
  toSkWaypoint,
  tombstone,
} from "../src/bridge/mapping.js";
import { MobBridge } from "../src/bridge/mob.js";
import { ResourcesBridge } from "../src/bridge/resources.js";
import type { Region } from "@signalk/server-api";
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

const region: Region = {
  name: "No anchoring",
  description: "cable area",
  feature: {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [177.15, -17.8],
          [177.16, -17.8],
          [177.16, -17.81],
          [177.15, -17.81],
          [177.15, -17.8],
        ],
      ],
    },
    properties: {},
  },
};

describe("mapping", () => {
  test("reads an area as TimeZero sends it, as a closed polygon", () => {
    // A live area from a TZ Professional on a boat's NavNet.
    const tz = parseUserObject({
      Guid: ID,
      Tick: 30000,
      Values:
        "8,X'029B530C38F4FDAB019B536330F4FD5C249B533B54F4FD1C4C9B52D23EF4FD7DF0',749161040,749161180,0,9,'',NULL,NULL,0,0,0,NULL,0,NULL,NULL,'40',NULL,NULL,NULL,NULL",
      PointsValues: null,
    });
    const r = toSkRegion(tz)!;
    const ring = (r.feature.geometry.coordinates as number[][][])[0]!;
    expect(ring).toHaveLength(5);
    expect(ring[4]).toEqual(ring[0]);
    expect(ring[0]![0]).toBeCloseTo(-151.6, 0);
    expect(ring[0]![1]).toBeCloseTo(-16.5, 0);
  });

  test("a Signal K region survives a trip through TimeZero", () => {
    const tz = asObject(fromSkRegion(ID, region, undefined, NOW)!);
    expect(tz.values[COLUMN.objectType]).toBe(8);
    expect(tz.values[COLUMN.value3]).toBe("40");
    const back = toSkRegion(tz)!;
    expect(back.name).toBe(region.name);
    expect(back.description).toBe(region.description);
    expect(fingerprint("regions", back)).toBe(fingerprint("regions", region));
  });

  test("leaves out regions TimeZero cannot hold", () => {
    const ring = (
      region.feature.geometry.coordinates as [number, number][][]
    )[0]!;
    const withHole: Region = {
      ...region,
      feature: {
        ...region.feature,
        geometry: { type: "Polygon", coordinates: [ring, ring] },
      },
    };
    expect(fromSkRegion(ID, withHole, undefined, NOW)).toBeNull();
    const many = Array.from({ length: 51 }, (_, i): [number, number] => [
      177 + Math.cos(i / 8),
      -17 + Math.sin(i / 8),
    ]);
    const tooMany: Region = {
      ...region,
      feature: {
        ...region.feature,
        geometry: { type: "Polygon", coordinates: [[...many, many[0]!]] },
      },
    };
    expect(fromSkRegion(ID, tooMany, undefined, NOW)).toBeNull();
  });

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
    regions: {},
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
    debug: () => {},
    error: () => {},
  });
}

describe("resources bridge", () => {
  const tzRoute = () =>
    asObject(fromSkRoute(ID, route, undefined, NOW)!, 33430);

  function setup(offerExisting = true, liveRoutes: number | null = 150) {
    const peer = makePeer();
    const count = { live: liveRoutes, boundaries: 2 };
    vi.spyOn(peer, "liveCounts").mockImplementation(async () =>
      count.live === null
        ? null
        : { routes: count.live, boundaries: count.boundaries },
    );
    const offers: string[] = [];
    vi.spyOn(peer, "offer").mockImplementation((objs) =>
      offers.push(...objs.map((o) => o.guid)),
    );
    vi.spyOn(peer, "requestRound").mockImplementation(() => {});
    // The provider's write deltas go to the bridge, created just below.
    const ref: { bridge?: ResourcesBridge } = {};
    const { app, store } = mockApp((type, id, value) =>
      ref.bridge?.onResourceDelta(type as "routes", id, value),
    );
    const bridge = new ResourcesBridge(app, peer, {
      types: ["routes", "waypoints", "regions"],
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
    await bridge.fromTimeZero([tzRoute()], 33430);
    expect((store.routes![ID] as Route).name).toBe("SK test route");
    await vi.runAllTimersAsync();
    expect(offers).toEqual([]);
  });

  test("offers a route edited in Signal K", async () => {
    const { bridge, offers } = setup();
    await bridge.fromTimeZero([tzRoute()], 33430);
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
    await bridge.fromTimeZero([tzRoute()], 33430);
    const deleted = parseUserObject({
      Guid: ID,
      Tick: 33433,
      Values: (await import("../src/protocol/sqlRow.js")).formatRow(
        tombstone(tzRoute(), NOW).values,
      ),
      PointsValues: null,
    });
    await bridge.fromTimeZero([deleted], 33433);
    expect(store.routes![ID]).toBeUndefined();
    // A TimeZero tombstone for something Signal K never had is ignored.
    await bridge.fromTimeZero(
      [{ ...deleted, guid: "11111111-2222-3333-4444-555555555555" }],
      33433,
    );
  });

  test("never takes a known object missing from Signal K for a deletion", async () => {
    const { bridge, store, offers } = setup();
    await bridge.fromTimeZero([tzRoute()], 33430);
    await vi.runAllTimersAsync();
    delete store.routes![ID]; // e.g. not written yet, or another provider
    await bridge.reconcile();
    expect(offers).toEqual([]);
  });

  test("a check started during an import waits for it and offers nothing back", async () => {
    const { bridge, store, offers } = setup();
    // Writes are slow, as with hundreds of objects arriving on first contact.
    const api = (bridge as unknown as { app: ServerAPI }).app.resourcesApi;
    const write = api.setResource.bind(api);
    api.setResource = async (...args: Parameters<typeof write>) => {
      await new Promise((r) => setTimeout(r, 50));
      return write(...args);
    };
    const objects = Array.from({ length: 20 }, (_, i) =>
      asObject(
        fromSkRoute(
          `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          route,
          undefined,
          NOW,
        )!,
        33000 + i,
      ),
    );
    const importing = bridge.fromTimeZero(objects, 33019);
    const checking = bridge.reconcile();
    await vi.runAllTimersAsync();
    await Promise.all([importing, checking]);
    expect(Object.keys(store.routes!)).toHaveLength(20);
    expect(offers).toEqual([]);
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
        expect.stringContaining("at most 200 routes"),
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
      await bridge.fromTimeZero([tzRoute()], 33430);
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
        vi.spyOn(peer, "liveCounts").mockImplementation(async () =>
          count.live === null ? null : { routes: count.live, boundaries: 2 },
        );
        vi.spyOn(peer, "requestRound").mockImplementation(() => {});
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
      vi.mocked(peer.liveCounts).mockImplementation(() =>
        gate.then(() => ({ routes: 199, boundaries: 2 })),
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

  test("does not send a route with more points than TimeZero takes", async () => {
    const { bridge, offers, status } = setup();
    const long: Route = {
      ...route,
      feature: {
        ...route.feature,
        geometry: {
          type: "LineString",
          coordinates: Array.from({ length: 501 }, (_, i) => [
            177 + i * 0.001,
            -17.8,
          ]),
        },
        properties: {},
      },
    };
    bridge.onResourceDelta("routes", ID, long);
    await vi.runAllTimersAsync();
    expect(offers).toEqual([]);
    expect(status).toHaveBeenCalledWith(expect.stringContaining("500 points"));
  });

  test("a new region waits while TimeZero holds 100 areas and lines", async () => {
    const { bridge, offers, count, status } = setup();
    count.boundaries = 100;
    bridge.onResourceDelta("regions", ID, region);
    await vi.runAllTimersAsync();
    expect(offers).toEqual([]);
    expect(status).toHaveBeenCalledWith(
      expect.stringContaining("100 areas and lines"),
    );
    count.boundaries = 99;
    bridge.onResourceDelta("regions", ID, region);
    await vi.runAllTimersAsync();
    expect(offers).toEqual([ID]);
  });

  test("a change to an object locked in TimeZero is undone, not sent", async () => {
    const { bridge, store, offers, status } = setup();
    const locked = tzRoute();
    locked.values[COLUMN.locked] = 1;
    await bridge.fromTimeZero([locked], 33430);
    await vi.runAllTimersAsync();
    bridge.onResourceDelta("routes", ID, null); // deleted in Freeboard
    delete store.routes![ID];
    await vi.runAllTimersAsync();
    expect(offers).toEqual([]);
    expect((store.routes![ID] as Route).name).toBe("SK test route");
    expect(status).toHaveBeenCalledWith(
      expect.stringContaining("locked in TimeZero"),
    );
    bridge.onResourceDelta("routes", ID, { ...route, name: "Moved" });
    await vi.runAllTimersAsync();
    expect(offers).toEqual([]);
    expect((store.routes![ID] as Route).name).toBe("SK test route");
  });

  test("on start, leaves them alone when offering existing ones is off", async () => {
    const { bridge, store, offers } = setup(false);
    store.routes![ID] = route;
    await bridge.reconcile();
    expect(offers).toEqual([]);
  });

  test("with a resource state behind the peer's, reads TimeZero again and offers nothing until it has", async () => {
    // The peer has synced up to 33500, but the record of which Signal K
    // resources are TimeZero's is gone. TimeZero sends nothing on rejoin.
    fs.writeFileSync(
      path.join(dir, "peer.json"),
      JSON.stringify({
        uuid: "b0b0afa6-0000-4000-8000-000000000000",
        tzTableTick: 33500,
      }),
    );
    const { peer, bridge, store, offers } = setup();
    expect((peer as unknown as { readFrom: number | null }).readFrom).toBe(0);
    const OWN = "bbbbbbbb-0000-4000-8000-000000000003";
    store.routes![ID] = route; // Signal K's copy of TimeZero's route
    store.waypoints![OWN] = waypoint; // Signal K's own
    await bridge.reconcile();
    bridge.onResourceDelta("routes", ID, { ...route, name: "Edited" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(offers).toEqual([]);
    // The full read brings TimeZero's route; then the peer is caught up.
    peer.emit("objects", [tzRoute()], 33500);
    peer.emit("caughtUp");
    await vi.advanceTimersByTimeAsync(3000);
    // TimeZero's copy is written over the edit made during the read, so the
    // two sides agree; only Signal K's own waypoint goes.
    expect(offers).toEqual([OWN]);
    expect((store.routes![ID] as Route).name).toBe("SK test route");
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "resources.json"), "utf8"),
    );
    expect(saved.tableTick).toBe(33500);
  });

  test("a kind synced for the first time makes the peer read TimeZero's table again", () => {
    // State from a version that synced routes and waypoints only.
    fs.writeFileSync(
      path.join(dir, "peer.json"),
      JSON.stringify({
        uuid: "b0b0afa6-0000-4000-8000-000000000000",
        tzTableTick: 33500,
      }),
    );
    fs.writeFileSync(
      path.join(dir, "resources.json"),
      JSON.stringify({ known: {}, tableTick: 33500, seen: [] }),
    );
    const { peer } = setup();
    expect((peer as unknown as { readFrom: number | null }).readFrom).toBe(0);
  });

  test("on start, never offers a resource TimeZero has had, even one deleted there", async () => {
    const { bridge, store, offers } = setup();
    const deleted = { ...tzRoute(), values: tombstone(tzRoute(), NOW).values };
    await bridge.fromTimeZero([deleted], 33433);
    store.routes![ID] = route;
    await bridge.reconcile();
    expect(offers).toEqual([]);
  });
});

describe("course bridge", () => {
  const routeCourse = (reverse = false) => ({
    startTime: new Date().toISOString(),
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

  test("a Signal K go-to to the MOB position keeps TimeZero's MOB", async () => {
    const peer = makePeer();
    const mobNav = {
      kind: "goto" as const,
      origin: null,
      destination: { latitude: -17.822, longitude: 177.171 },
      mob: true,
    };
    (peer as unknown as { state: { navigation: unknown } }).state.navigation =
      mobNav;
    const set = vi.spyOn(peer, "setNavigation");
    const { app, state } = courseApp(noCourse);
    const bridge = new CourseBridge(app, peer);
    await vi.runAllTimersAsync();
    state.course = {
      ...staleGoto,
      startTime: new Date().toISOString(),
    };
    await bridge.fromSignalK();
    expect(set).not.toHaveBeenCalled();
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

  // A Signal K app whose course is whatever `state.course` holds.
  const courseApp = (initial: unknown) => {
    const state = { course: initial };
    const app = {
      getCourse: async () => state.course,
      clearDestination: vi.fn(async () => {
        state.course = noCourse;
      }),
      setDestination: vi.fn(async () => {}),
      activateRoute: vi.fn(async () => {}),
      debug: () => {},
      error: vi.fn(),
    } as unknown as ServerAPI;
    return { app, state };
  };
  const noCourse = { ...routeCourse(), activeRoute: null };
  const staleGoto = {
    ...noCourse,
    startTime: "2026-10-08T01:40:04.715Z",
    nextPoint: {
      type: "Location",
      position: { latitude: -17.822, longitude: 177.171 },
    },
  };

  test("a course already set when the plugin starts is not sent to TimeZero", async () => {
    // A go-to left in Signal K from a passage the day before.
    const peer = makePeer();
    const set = vi.spyOn(peer, "setNavigation");
    const { app } = courseApp(staleGoto);
    const bridge = new CourseBridge(app, peer);
    await vi.runAllTimersAsync();
    await bridge.fromSignalK(); // the Course API re-emitting its state
    expect(set).not.toHaveBeenCalled();
  });

  test("a saved course the Course API restores after start-up is not sent", async () => {
    // The Course API can restore its saved course after the plugin started,
    // which looks like a change from "no course".
    const peer = makePeer();
    const set = vi.spyOn(peer, "setNavigation");
    const { app, state } = courseApp(noCourse);
    const bridge = new CourseBridge(app, peer);
    await vi.runAllTimersAsync();
    state.course = staleGoto;
    await bridge.fromSignalK();
    expect(set).not.toHaveBeenCalled();
  });

  test("clearing an old Signal K course does not cancel TimeZero's", async () => {
    const peer = makePeer();
    peer.setNavigation({
      kind: "route",
      origin: null,
      routeGuid: ID,
      pointIndex: 0,
    });
    const set = vi.spyOn(peer, "setNavigation");
    const { app, state } = courseApp(staleGoto);
    const bridge = new CourseBridge(app, peer);
    await vi.runAllTimersAsync();
    state.course = noCourse;
    await bridge.fromSignalK();
    expect(set).not.toHaveBeenCalled();
  });

  test("moving to the next point of a route both follow is sent", async () => {
    const peer = makePeer();
    const old = { ...routeCourse(), startTime: "2026-10-08T01:40:04.715Z" };
    peer.setNavigation({
      kind: "route",
      origin: null,
      routeGuid: ID,
      pointIndex: 1,
    });
    const set = vi.spyOn(peer, "setNavigation");
    const { app, state } = courseApp(old);
    const bridge = new CourseBridge(app, peer);
    await vi.runAllTimersAsync();
    state.course = {
      ...old,
      activeRoute: { ...old.activeRoute, pointIndex: 2 },
    };
    await bridge.fromSignalK();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ pointIndex: 2 }),
    );
  });

  test("a route GUID in another case is still the same route", async () => {
    const peer = makePeer();
    const old = { ...routeCourse(), startTime: "2026-10-08T01:40:04.715Z" };
    const bridge = new CourseBridge(courseApp(old).app, peer);
    await vi.runAllTimersAsync();
    // TimeZero's copy of the course, with the GUID in upper case.
    await bridge.fromTimeZero({
      kind: "route",
      origin: null,
      routeGuid: ID.toUpperCase(),
      pointIndex: 1,
    });
    peer.setNavigation({
      kind: "route",
      origin: null,
      routeGuid: ID.toUpperCase(),
      pointIndex: 1,
    });
    const set = vi.spyOn(peer, "setNavigation");
    const app = (
      bridge as unknown as { app: { getCourse: () => Promise<unknown> } }
    ).app;
    app.getCourse = async () => ({
      ...old,
      activeRoute: { ...old.activeRoute, pointIndex: 2 },
    });
    await bridge.fromSignalK();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ pointIndex: 2 }),
    );
  });

  test("a course set while running is sent", async () => {
    const peer = makePeer();
    const set = vi.spyOn(peer, "setNavigation");
    const { app, state } = courseApp(noCourse);
    const bridge = new CourseBridge(app, peer);
    await vi.runAllTimersAsync();
    state.course = { ...staleGoto, startTime: new Date().toISOString() };
    await bridge.fromSignalK();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ kind: "goto" }));
  });

  test("waits for TimeZero to pull a route before activating it there", async () => {
    const peer = makePeer();
    peer.offer([fromSkRoute(ID, route, undefined, NOW)!]);
    const set = vi.spyOn(peer, "setNavigation");
    const { app, state } = courseApp(noCourse);
    const bridge = new CourseBridge(app, peer);
    await vi.runAllTimersAsync();
    state.course = routeCourse();
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
    const { app, state } = courseApp(noCourse);
    const bridge = new CourseBridge(app, peer);
    await vi.runAllTimersAsync();
    state.course = routeCourse();
    await bridge.fromSignalK();
    state.course = noCourse;
    await bridge.fromSignalK();
    peer.emit("pulled", [ID]);
    expect(set).not.toHaveBeenCalled();
  });

  test("applies TimeZero navigation through the Course API, and not back again", async () => {
    const peer = makePeer();
    const set = vi.spyOn(peer, "setNavigation");
    const { app, state } = courseApp(noCourse);
    const bridge = new CourseBridge(app, peer);
    await vi.runAllTimersAsync();
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
    // The Course API now shows it; that echo must not go back to TimeZero.
    state.course = {
      ...routeCourse(),
      activeRoute: { ...routeCourse().activeRoute, pointIndex: 2 },
    };
    await bridge.fromSignalK();
    expect(set).not.toHaveBeenCalled();
    await bridge.fromTimeZero({ kind: "none" });
    expect(app.clearDestination).toHaveBeenCalled();
  });

  test("does not re-apply a TimeZero course Signal K already shows", async () => {
    const peer = makePeer();
    const { app } = courseApp(routeCourse());
    const bridge = new CourseBridge(app, peer);
    await bridge.fromTimeZero({
      kind: "route",
      origin: null,
      routeGuid: ID,
      pointIndex: 1,
    });
    expect(app.activateRoute).not.toHaveBeenCalled();
  });
});

describe("anchor bridge", () => {
  const ANCHOR = { latitude: -17.8, longitude: 177.15 };
  const anchorApp = (values: Record<string, unknown>) => {
    const puts: unknown[] = [];
    const app = {
      getSelfPath: (p: string) => values[p],
      putSelfPath: vi.fn(async (_p: string, value: unknown) => {
        puts.push(value);
        return { state: "COMPLETED", statusCode: 200 };
      }),
      error: vi.fn(),
    } as unknown as ServerAPI;
    return { app, puts };
  };
  const down = (radius: number | null = 60) => ({
    "navigation.anchor.position.value": ANCHOR,
    "navigation.anchor.maxRadius.value": radius,
  });

  test("drops and raises through the anchor plugin's PUT handler", async () => {
    const peer = makePeer();
    const values: Record<string, unknown> = {};
    const { app, puts } = anchorApp(values);
    const bridge = new AnchorBridge(app, peer, 0);
    bridge.fromTimeZero({ position: ANCHOR, radius: 60 });
    await vi.runAllTimersAsync();
    Object.assign(values, down()); // the anchor plugin dropped it
    bridge.fromTimeZero(null);
    await vi.runAllTimersAsync();
    expect(puts).toEqual([{ ...ANCHOR, radius: 60 }, null]);
  });

  test("an anchor already down when the plugin starts is not sent", () => {
    const peer = makePeer();
    const set = vi.spyOn(peer, "setAnchor");
    const { app } = anchorApp(down());
    const bridge = new AnchorBridge(app, peer, 0);
    bridge.fromSignalK();
    expect(set).not.toHaveBeenCalled();
  });

  test("sends a Signal K anchor change, but not a zone TimeZero cannot show", () => {
    const peer = makePeer();
    const set = vi.spyOn(peer, "setAnchor");
    const values: Record<string, unknown> = {};
    const { app } = anchorApp(values);
    const bridge = new AnchorBridge(app, peer, 0);
    Object.assign(values, down());
    bridge.fromSignalK();
    expect(set).toHaveBeenLastCalledWith({ position: ANCHOR, radius: 60 });
    Object.assign(values, down(null)); // a polygon zone
    values["navigation.anchor.position.value"] = {
      latitude: -17.9,
      longitude: 177.15,
    };
    bridge.fromSignalK();
    expect(set).toHaveBeenCalledTimes(1);
  });

  test("an anchor restored just after start-up is not sent", () => {
    const peer = makePeer();
    const set = vi.spyOn(peer, "setAnchor");
    const values: Record<string, unknown> = {};
    const { app } = anchorApp(values);
    const bridge = new AnchorBridge(app, peer, 60000);
    Object.assign(values, down()); // the anchor plugin restores its anchor
    bridge.fromSignalK();
    expect(set).not.toHaveBeenCalled();
  });

  test("a TimeZero anchor Signal K already shows is not applied again", async () => {
    const peer = makePeer();
    const { app, puts } = anchorApp(down());
    const bridge = new AnchorBridge(app, peer, 0);
    bridge.fromTimeZero({ position: ANCHOR, radius: 60 });
    await vi.runAllTimersAsync();
    expect(puts).toEqual([]);
  });

  test("compares anchors to TimeZero's precision", () => {
    const a = { position: ANCHOR, radius: 60 };
    expect(sameAnchor(a, { ...a, radius: 60.001 })).toBe(true);
    expect(sameAnchor(a, null)).toBe(false);
    expect(sameAnchor(null, null)).toBe(true);
  });
});

describe("man overboard", () => {
  const MOB_AT = { latitude: -17.8, longitude: 177.15 };
  const mobNav = {
    kind: "goto" as const,
    origin: MOB_AT,
    destination: MOB_AT,
    mob: true,
  };

  function mobApp() {
    const ref: { bridge?: MobBridge } = {};
    const raised: string[] = [];
    const cleared: string[] = [];
    const app = {
      notifications: {
        mob: vi.fn(() => {
          const id = `id-${raised.length + 1}`;
          raised.push(id);
          // The alarm's delta arrives before mob() returns.
          ref.bridge?.onMobDelta(`notifications.mob.${id}`, {
            state: "emergency",
            createdAt: new Date().toISOString(),
            position: MOB_AT,
          });
          return id;
        }),
        clear: vi.fn((id: string) => cleared.push(id)),
      },
      getSelfPath: () => ({ value: MOB_AT }),
      debug: () => {},
      error: vi.fn(),
    } as unknown as ServerAPI;
    return { app, ref, raised, cleared };
  }

  test("a MOB in TimeZero raises Signal K's alarm once, and its end clears it", () => {
    const peer = makePeer();
    const set = vi.spyOn(peer, "setNavigation");
    const { app, ref, raised, cleared } = mobApp();
    ref.bridge = new MobBridge(app, peer);
    peer.emit("navigation", mobNav);
    peer.emit("navigation", mobNav); // TimeZero updating its record
    expect(raised).toEqual(["id-1"]);
    // Our own alarm is not sent back to TimeZero as a new MOB.
    expect(set).not.toHaveBeenCalled();
    peer.emit("navigation", { kind: "none" });
    expect(cleared).toEqual(["id-1"]);
  });

  test("a MOB raised in Signal K becomes a MOB go-to in TimeZero", () => {
    const peer = makePeer();
    const set = vi.spyOn(peer, "setNavigation");
    const { app, ref } = mobApp();
    ref.bridge = new MobBridge(app, peer);
    ref.bridge.onMobDelta("notifications.mob.abc", {
      state: "emergency",
      createdAt: new Date().toISOString(),
      position: MOB_AT,
    });
    // The same alarm updated (silenced, acknowledged) is not a new MOB.
    ref.bridge.onMobDelta("notifications.mob.abc", {
      state: "emergency",
      createdAt: new Date().toISOString(),
      position: MOB_AT,
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({
      kind: "goto",
      origin: MOB_AT,
      destination: MOB_AT,
      mob: true,
    });
  });

  test("a MOB alarm from before the plugin started is not sent", () => {
    const peer = makePeer();
    const set = vi.spyOn(peer, "setNavigation");
    const { app, ref } = mobApp();
    ref.bridge = new MobBridge(app, peer);
    ref.bridge.onMobDelta("notifications.mob", {
      state: "emergency",
      createdAt: "2026-10-01T00:00:00Z",
      position: MOB_AT,
    });
    expect(set).not.toHaveBeenCalled();
  });
});
