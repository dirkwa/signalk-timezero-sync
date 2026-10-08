import { describe, expect, test } from "vitest";
import {
  buildBeacon,
  isTimeZero,
  parseBeacon,
} from "../src/protocol/beacon.js";
import {
  decodeCircle,
  decodePoint,
  decodePolyline,
  encodeCircle,
  encodePoint,
  encodePolyline,
  fromTzTime,
  guidFromBytes,
  guidToBytes,
  toTzTime,
} from "../src/protocol/geometry.js";
import {
  buildActiveRoute,
  buildAnchorWatch,
  parseActiveRoute,
  parseAnchorWatch,
} from "../src/protocol/navigation.js";
import { formatRow, parseRow } from "../src/protocol/sqlRow.js";

const FIJI = { latitude: -17.807543, longitude: 177.154503 };
const close = (a: number, b: number) =>
  expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe("geometry", () => {
  test("a point blob matches the one TimeZero sent for the same position", () => {
    // TimeZero's own origin blob for a go-to started at this position.
    const fromTz = Buffer.from("00758B7996F4113B20", "hex");
    const p = decodePoint(fromTz)!;
    expect(p.latitude).toBeCloseTo(FIJI.latitude, 5);
    expect(p.longitude).toBeCloseTo(FIJI.longitude, 5);
    // Re-encoding lands within a few centimetres (the fixture is rounded).
    const again = encodePoint(p);
    expect(again.toString("hex").toUpperCase()).toBe("00758B7996F4113B20");
  });

  test("round-trips points, polylines and circles to the centimetre", () => {
    const route = [
      FIJI,
      { latitude: -17.8, longitude: 177.2 },
      { latitude: 51.85, longitude: 1.3 },
    ];
    decodePolyline(encodePolyline(route))!.forEach((p, i) => {
      close(p.latitude, route[i]!.latitude);
      close(p.longitude, route[i]!.longitude);
    });
    const circle = decodeCircle(encodeCircle(FIJI, 60.5))!;
    close(circle.centre.latitude, FIJI.latitude);
    expect(circle.radius).toBe(60.5);
  });

  test("rejects blobs of the wrong type or length", () => {
    expect(decodePoint(encodePolyline([FIJI]))).toBeNull();
    expect(decodePolyline(Buffer.from("02aabb", "hex"))).toBeNull();
    expect(decodeCircle(encodePoint(FIJI))).toBeNull();
    expect(decodePoint(null)).toBeNull();
  });

  test("uses TimeZero's 2000 epoch", () => {
    // A live TZ Professional named a route "Rte 2025-01-28" with this
    // CreationDate: 2025-01-27T19:16:27Z, the 28th in the boat's UTC+12.
    expect(fromTzTime(791320587).toISOString()).toBe(
      "2025-01-27T19:16:27.000Z",
    );
    expect(toTzTime(new Date("2000-01-01T00:00:00Z"))).toBe(0);
  });

  test("writes GUIDs in .NET byte order", () => {
    // RouteGuid as TimeZero sent it, and the GUID of that route in its table.
    const wire = Buffer.from("C3995CB1F9D6C245B061B16FDD7AE535", "hex");
    expect(guidFromBytes(wire)).toBe("b15c99c3-d6f9-45c2-b061-b16fdd7ae535");
    expect(
      guidToBytes("b15c99c3-d6f9-45c2-b061-b16fdd7ae535").equals(wire),
    ).toBe(true);
  });
});

describe("SQL rows", () => {
  test("parses every literal kind and formats back unchanged", () => {
    const row = "5,X'0201',791320587,NULL,'it''s, here\nline two','',-1.5";
    const v = parseRow(row);
    expect(v).toEqual([
      5,
      Buffer.from("0201", "hex"),
      791320587,
      null,
      "it's, here\nline two",
      "",
      -1.5,
    ]);
    expect(formatRow(v)).toBe(row);
  });

  test("rejects malformed rows", () => {
    expect(() => parseRow("'open")).toThrow();
    expect(() => parseRow("X'0G'")).toThrow();
    expect(() => parseRow("abc")).toThrow();
  });
});

describe("beacon", () => {
  // Field layout as on a TZ Professional on NavNet (uuid replaced).
  const TZ_PRO =
    "TZ Sync 1.0;NAVSTATION;TZ Professional;;;;NAVSTATION/00000000-1111-2222-3333-444444444444;33745900;2;1;33427;10;0;167;2065;0;175906";

  test("reads TimeZero's ticks from the right fields", () => {
    const b = parseBeacon(TZ_PRO)!;
    expect(b).toMatchObject({
      name: "NAVSTATION",
      deviceType: "TZ Professional",
      uuid: "00000000-1111-2222-3333-444444444444",
      visibleHosts: 2,
      tableTick: 33427,
      routeTick: 10,
      fishItTick: 167,
      anchorTick: 2065,
    });
    expect(isTimeZero(b)).toBe(true);
  });

  test("round-trips our own beacon", () => {
    const ours = {
      name: "SignalK",
      userId: "",
      uuid: "abcd",
      visibleHosts: 1,
      tableTick: 33431,
      routeTick: 12,
      fishItTick: 167,
      anchorTick: 2066,
    };
    expect(parseBeacon(buildBeacon(ours))).toEqual({
      ...ours,
      deviceType: "TZ iBoat",
    });
  });

  test("ignores other UDP traffic", () => {
    expect(parseBeacon("M-SEARCH * HTTP/1.1")).toBeNull();
    expect(parseBeacon("TZ Sync 1.0;short")).toBeNull();
  });
});

describe("active route", () => {
  const base = {
    IndexOfNextRealDestinationPoint: -1,
    IsManOverBoard: 0,
    LastModificationDate: 844804034,
    CurrentTick: 4,
  };

  test("reads a go-to as TimeZero sends it", () => {
    const nav = parseActiveRoute({
      ...base,
      OriginPosition: "X'00758B7996F4113B20'",
      TemporaryDestinationPosition: "X'00758CF06FF4117D97'",
      IndexOfDestinationPoint: -1,
      RouteGuid: "NULL",
    });
    expect(nav.kind).toBe("goto");
    if (nav.kind === "goto") close(nav.destination.latitude, -17.806079);
  });

  test("reads a followed route as TimeZero sends it", () => {
    const nav = parseActiveRoute({
      ...base,
      OriginPosition: "X'00758B797FF4113B1C'",
      TemporaryDestinationPosition: "NULL",
      IndexOfDestinationPoint: 155,
      RouteGuid: "X'C3995CB1F9D6C245B061B16FDD7AE535'",
    });
    expect(nav).toMatchObject({
      kind: "route",
      routeGuid: "b15c99c3-d6f9-45c2-b061-b16fdd7ae535",
      pointIndex: 155,
    });
  });

  test("builds what it reads", () => {
    const now = new Date("2026-10-08T19:49:04Z");
    for (const nav of [
      { kind: "none" as const },
      { kind: "goto" as const, origin: FIJI, destination: FIJI, mob: false },
      {
        kind: "route" as const,
        origin: null,
        routeGuid: "b15c99c3-d6f9-45c2-b061-b16fdd7ae535",
        pointIndex: 2,
      },
    ]) {
      const dto = buildActiveRoute(nav, 9, now);
      expect(dto.CurrentTick).toBe(9);
      expect(dto.LastModificationDate).toBe(toTzTime(now));
      expect(parseActiveRoute(dto).kind).toBe(nav.kind);
    }
  });
});

describe("anchor watch", () => {
  test("round-trips a set and a raised anchor", () => {
    const now = new Date();
    const set = parseAnchorWatch(
      buildAnchorWatch({ position: FIJI, radius: 60 }, 2066, now),
    )!;
    close(set.position.latitude, FIJI.latitude);
    expect(set.radius).toBe(60);
    expect(parseAnchorWatch(buildAnchorWatch(null, 2067, now))).toBeNull();
  });

  test("reads the anchor TimeZero accepted from Signal K", () => {
    const anchor = parseAnchorWatch({
      ChangeTick: 2065,
      Values: "X'04758B8AE3F411388500001770',10,844801429,844801429",
    })!;
    expect(anchor.radius).toBe(60);
  });
});
