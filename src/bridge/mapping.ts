// Mapping between TimeZero user objects and Signal K route and waypoint
// resources. The TimeZero GUID is used as the Signal K resource id, so an
// object is the same thing on both sides without a lookup table.

import type { Route, Waypoint } from "@signalk/server-api";
import {
  decodePoint,
  decodePolyline,
  encodePoint,
  encodePolyline,
  toTzTime,
  type LatLon,
} from "../protocol/geometry.js";
import type { SqlValue } from "../protocol/sqlRow.js";
import {
  blob,
  COLUMN,
  emptyPointRow,
  emptyRow,
  num,
  OBJECT_TYPE,
  POINT_COLUMN,
  text,
  type UserObject,
} from "../protocol/userObject.js";

export type SyncedType = "routes" | "waypoints";

// The default colour TimeZero gave routes created on the chart in testing.
const DEFAULT_ROUTE_COLOR = 3;
const DEFAULT_MARK_COLOR = 1;
// RoutingFlags on every route point after the first, as TimeZero writes them.
const ROUTE_POINT_FLAGS = 4;

export function typeOf(obj: UserObject): SyncedType | null {
  const t = num(obj.values[COLUMN.objectType]);
  if (t === OBJECT_TYPE.route) return "routes";
  if (t === OBJECT_TYPE.mark) return "waypoints";
  return null;
}

export const isDeleted = (obj: UserObject): boolean =>
  num(obj.values[COLUMN.deleted]) === 1;

// Objects in a TimeZero user layer belong to that layer's own sync; leave them.
export const inUserLayer = (obj: UserObject): boolean =>
  obj.values[COLUMN.userLayerGuid] !== null;

const lonLat = (p: LatLon): [number, number] => [p.longitude, p.latitude];
const latLon = ([longitude, latitude]: readonly (
  number | undefined
)[]): LatLon => ({
  latitude: latitude ?? 0,
  longitude: longitude ?? 0,
});

export function toSkRoute(obj: UserObject): Route | null {
  const points = decodePolyline(blob(obj.values[COLUMN.geometry]));
  if (!points || points.length < 2) return null;
  const names = new Array<string>(points.length).fill("");
  for (const row of obj.points ?? []) {
    const index = num(row[POINT_COLUMN.index]);
    const name = text(row[POINT_COLUMN.name]);
    if (index !== undefined && name && index < names.length)
      names[index] = name;
  }
  const properties: Record<string, unknown> = {};
  if (names.some((n) => n))
    properties.coordinatesMeta = names.map((name) => ({ name }));
  const route: Route = {
    feature: {
      type: "Feature",
      geometry: { type: "LineString", coordinates: points.map(lonLat) },
      properties,
    },
  };
  const name = text(obj.values[COLUMN.name]);
  const description = text(obj.values[COLUMN.comment]);
  if (name) route.name = name;
  if (description) route.description = description;
  return route;
}

export function toSkWaypoint(obj: UserObject): Waypoint | null {
  const point = decodePoint(blob(obj.values[COLUMN.geometry]));
  if (!point) return null;
  const waypoint: Waypoint = {
    feature: {
      type: "Feature",
      geometry: { type: "Point", coordinates: lonLat(point) },
      properties: {},
    },
  };
  const name = text(obj.values[COLUMN.name]);
  const description = text(obj.values[COLUMN.comment]);
  if (name) waypoint.name = name;
  if (description) waypoint.description = description;
  return waypoint;
}

// Start from what TimeZero last sent for this object, so its own fields
// (icon, colour, chart level, ...) survive an edit made in Signal K.
function baseRow(
  previous: UserObject | undefined,
  objectType: number,
  now: Date,
): SqlValue[] {
  const row = previous ? [...previous.values] : emptyRow();
  if (!previous) {
    row[COLUMN.objectType] = objectType;
    row[COLUMN.creationDate] = toTzTime(now);
    row[COLUMN.icon] = 0;
    row[COLUMN.color] =
      objectType === OBJECT_TYPE.route
        ? DEFAULT_ROUTE_COLOR
        : DEFAULT_MARK_COLOR;
    row[COLUMN.chartLevel] = 0;
    row[COLUMN.locked] = 0;
    row[COLUMN.shared] = 0;
  }
  row[COLUMN.deleted] = 0;
  row[COLUMN.lastModificationDate] = toTzTime(now);
  return row;
}

export function fromSkRoute(
  id: string,
  route: Route,
  previous: UserObject | undefined,
  now: Date,
): Omit<UserObject, "tick"> | null {
  const coordinates = route.feature?.geometry?.coordinates ?? [];
  if (coordinates.length < 2) return null;
  const row = baseRow(previous, OBJECT_TYPE.route, now);
  row[COLUMN.geometry] = encodePolyline(coordinates.map(latLon));
  row[COLUMN.name] = route.name ?? "";
  row[COLUMN.comment] = route.description ?? null;
  // TimeZero keeps the modification time as text in Value1 on routes.
  row[COLUMN.value1] = String(row[COLUMN.lastModificationDate]);

  const meta = (
    route.feature?.properties as
      { coordinatesMeta?: { name?: string }[] } | undefined
  )?.coordinatesMeta;
  const points: SqlValue[][] = [];
  coordinates.forEach((_, i) => {
    const name = meta?.[i]?.name || null;
    const previousRow = previous?.points?.find(
      (p) => num(p[POINT_COLUMN.index]) === i,
    );
    const p = previousRow ? [...previousRow] : emptyPointRow(i);
    if (!previousRow)
      p[POINT_COLUMN.routingFlags] = i === 0 ? 0 : ROUTE_POINT_FLAGS;
    p[POINT_COLUMN.name] = name;
    if (i === 0 && !previousRow)
      p[POINT_COLUMN.eta] = row[COLUMN.creationDate] ?? 0;
    // TimeZero sends a row for the first point and for points carrying data.
    if (i === 0 || name || previousRow) points.push(p);
  });
  return { guid: id, values: row, points };
}

export function fromSkWaypoint(
  id: string,
  waypoint: Waypoint,
  previous: UserObject | undefined,
  now: Date,
): Omit<UserObject, "tick"> | null {
  const coordinates = waypoint.feature?.geometry?.coordinates;
  if (!coordinates || coordinates.length < 2) return null;
  const row = baseRow(previous, OBJECT_TYPE.mark, now);
  row[COLUMN.geometry] = encodePoint(latLon(coordinates));
  row[COLUMN.name] = waypoint.name ?? "";
  row[COLUMN.comment] = waypoint.description ?? null;
  return { guid: id, values: row, points: null };
}

export function tombstone(
  previous: UserObject,
  now: Date,
): Omit<UserObject, "tick"> {
  const row = [...previous.values];
  row[COLUMN.deleted] = 1;
  row[COLUMN.lastModificationDate] = toTzTime(now);
  return { guid: previous.guid, values: row, points: previous.points };
}

// What a Signal K resource looks like to TimeZero. Comparing these tells a
// real change from the echo of our own write, regardless of key order or
// sub-centimetre float noise.
export function fingerprint(
  type: SyncedType,
  resource: Route | Waypoint,
): string {
  if (type === "routes") {
    const r = resource as Route;
    const coords = r.feature?.geometry?.coordinates ?? [];
    const meta = (
      r.feature?.properties as
        { coordinatesMeta?: { name?: string }[] } | undefined
    )?.coordinatesMeta;
    return JSON.stringify([
      r.name ?? "",
      r.description ?? "",
      encodePolyline(coords.map(latLon)).toString("hex"),
      coords.map((_, i) => meta?.[i]?.name ?? ""),
    ]);
  }
  const w = resource as Waypoint;
  const c = w.feature?.geometry?.coordinates;
  return JSON.stringify([
    w.name ?? "",
    w.description ?? "",
    c ? encodePoint(latLon(c)).toString("hex") : "",
  ]);
}
