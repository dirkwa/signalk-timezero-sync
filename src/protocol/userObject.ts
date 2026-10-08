// TimeZero user objects (marks, routes, areas, ...) as they travel in the
// UserObject sync table. The row is kept as parsed values so fields this
// plugin does not interpret survive a round trip unchanged.

import { formatRow, parseRow, type SqlValue } from "./sqlRow.js";

// Column order of the UserObject table after Guid and ChangeTick, from the
// schema TimeZero posts at the start of each sync round.
export const COLUMN = {
  objectType: 0,
  geometry: 1,
  creationDate: 2,
  lastModificationDate: 3,
  icon: 4,
  color: 5,
  name: 6,
  comment: 7,
  largeDataGuid: 8,
  chartLevel: 9,
  deleted: 10,
  locked: 11,
  userLayerGuid: 12,
  shared: 13,
  value1: 14,
  value2: 15,
  value3: 16,
  value4: 17,
  value5: 18,
  value6: 19,
  photoThumbnail: 20,
} as const;
const COLUMN_COUNT = 21;

// Columns of a PlanningRoutePoint row after RouteGuid. Route point rows are
// sparse: TimeZero sends one only for points with a name or other attribute.
export const POINT_COLUMN = {
  index: 0,
  name: 1,
  comment: 2,
  xtd: 3,
  circleRadius: 4,
  stw: 5,
  eta: 6,
  parallelLineOffset: 7,
  tidalCurrentId: 8,
  layover: 9,
  routingFlags: 10,
} as const;
const POINT_COLUMN_COUNT = 11;

// ObjectType values seen on a live TZ Professional, matched against the
// counts on its sync diagnostics page.
export const OBJECT_TYPE = {
  mark: 0,
  circle: 3,
  line: 4,
  route: 5,
  event: 7,
  area: 8,
  track: 9,
} as const;

// The wire shape of one object in a UserObject table read or push.
export interface UserObjectDto {
  Guid: string;
  Tick: number;
  Values: string;
  PointsValues: string[] | null;
}

// The envelope of a UserObject table read (GET) or push (POST).
export interface UserObjectTableDto {
  CurrentTick: number;
  SyncTicks: string;
  RemainingToSync: number;
  Objects: UserObjectDto[];
  Layers: unknown[];
}

export interface UserObject {
  guid: string;
  tick: number;
  values: SqlValue[];
  points: SqlValue[][] | null;
}

export function parseUserObject(dto: UserObjectDto): UserObject {
  const values = parseRow(dto.Values);
  if (values.length !== COLUMN_COUNT)
    throw new Error(`UserObject ${dto.Guid}: ${values.length} columns`);
  const points = dto.PointsValues?.map((row) => parseRow(row)) ?? null;
  if (points?.some((p) => p.length !== POINT_COLUMN_COUNT))
    throw new Error(`UserObject ${dto.Guid}: bad route point row`);
  return { guid: dto.Guid, tick: dto.Tick, values, points };
}

export function formatUserObject(obj: UserObject): UserObjectDto {
  return {
    Guid: obj.guid,
    Tick: obj.tick,
    Values: formatRow(obj.values),
    PointsValues: obj.points?.map(formatRow) ?? null,
  };
}

export function emptyRow(): SqlValue[] {
  return new Array<SqlValue>(COLUMN_COUNT).fill(null);
}

export function emptyPointRow(index: number): SqlValue[] {
  const row = new Array<SqlValue>(POINT_COLUMN_COUNT).fill(0);
  row[POINT_COLUMN.index] = index;
  row[POINT_COLUMN.name] = null;
  row[POINT_COLUMN.comment] = null;
  return row;
}

export const text = (v: SqlValue | undefined): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

export const num = (v: SqlValue | undefined): number | undefined =>
  typeof v === "number" ? v : undefined;

export const blob = (v: SqlValue | undefined): Buffer | null =>
  Buffer.isBuffer(v) ? v : null;
