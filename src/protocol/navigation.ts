// The two single-record sync endpoints: ActiveRoute (go-to, followed route,
// MOB) and AnchorWatch. Both carry a tick, and the higher tick wins.

import {
  decodeCircle,
  decodePoint,
  encodeCircle,
  encodePoint,
  guidFromBytes,
  guidToBytes,
  toTzTime,
  type LatLon,
} from "./geometry.js";
import { formatValue, parseRow, type SqlValue } from "./sqlRow.js";

export interface ActiveRouteDto {
  OriginPosition: string;
  TemporaryDestinationPosition: string;
  IndexOfNextRealDestinationPoint: number;
  IndexOfDestinationPoint: number;
  IsManOverBoard: number;
  RouteGuid: string;
  LastModificationDate: number;
  CurrentTick: number;
}

export type Navigation =
  | { kind: "none" }
  | { kind: "goto"; origin: LatLon | null; destination: LatLon; mob: boolean }
  | {
      kind: "route";
      origin: LatLon | null;
      routeGuid: string;
      pointIndex: number;
    };

const literal = (s: string): SqlValue | undefined => {
  try {
    return parseRow(s)[0];
  } catch {
    return undefined;
  }
};
const blobOf = (s: string): Buffer | null => {
  const v = literal(s);
  return Buffer.isBuffer(v) ? v : null;
};

export function parseActiveRoute(dto: ActiveRouteDto): Navigation {
  const origin = decodePoint(blobOf(dto.OriginPosition));
  const destination = decodePoint(blobOf(dto.TemporaryDestinationPosition));
  if (destination)
    return { kind: "goto", origin, destination, mob: dto.IsManOverBoard === 1 };
  const guidBytes = blobOf(dto.RouteGuid);
  const routeGuid = guidBytes ? guidFromBytes(guidBytes) : null;
  if (routeGuid && dto.IndexOfDestinationPoint >= 0)
    return {
      kind: "route",
      origin,
      routeGuid,
      pointIndex: dto.IndexOfDestinationPoint,
    };
  return { kind: "none" };
}

export function buildActiveRoute(
  nav: Navigation,
  tick: number,
  now: Date,
): ActiveRouteDto {
  const NULL = "NULL";
  const origin =
    nav.kind !== "none" && nav.origin
      ? formatValue(encodePoint(nav.origin))
      : NULL;
  return {
    OriginPosition: origin,
    TemporaryDestinationPosition:
      nav.kind === "goto" ? formatValue(encodePoint(nav.destination)) : NULL,
    IndexOfNextRealDestinationPoint: -1,
    IndexOfDestinationPoint: nav.kind === "route" ? nav.pointIndex : -1,
    IsManOverBoard: nav.kind === "goto" && nav.mob ? 1 : 0,
    RouteGuid:
      nav.kind === "route" ? formatValue(guidToBytes(nav.routeGuid)) : NULL,
    LastModificationDate: toTzTime(now),
    CurrentTick: tick,
  };
}

export interface AnchorWatchDto {
  ChangeTick: number;
  Values: string;
}

export interface Anchor {
  position: LatLon;
  radius: number;
}

// Values: Geometry, WarningDelay, LastModificationDate, ActivationDate.
const ANCHOR_WARNING_DELAY = 10;

export function parseAnchorWatch(dto: AnchorWatchDto): Anchor | null {
  let values: SqlValue[];
  try {
    values = parseRow(dto.Values);
  } catch {
    return null;
  }
  const geometry = values[0];
  const circle = decodeCircle(Buffer.isBuffer(geometry) ? geometry : null);
  return circle ? { position: circle.centre, radius: circle.radius } : null;
}

export function buildAnchorWatch(
  anchor: Anchor | null,
  tick: number,
  now: Date,
  activatedAt: Date = now,
): AnchorWatchDto {
  const t = toTzTime(now);
  const geometry = anchor ? encodeCircle(anchor.position, anchor.radius) : null;
  const activation = anchor ? toTzTime(activatedAt) : t;
  return {
    ChangeTick: tick,
    Values: [formatValue(geometry), ANCHOR_WARNING_DELAY, t, activation].join(
      ",",
    ),
  };
}
