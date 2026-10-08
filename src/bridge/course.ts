// Keeps the Signal K course (Course API) and TimeZero's active route in step:
// a go-to point, a followed route with its current point, or nothing.

import type { ServerAPI } from "@signalk/server-api";
import type { TimeZeroPeer } from "../peer/engine.js";
import type { LatLon } from "../protocol/geometry.js";
import type { Navigation } from "../protocol/navigation.js";

const ROUTE_HREF = /^\/resources\/routes\/([0-9a-fA-F-]{36})$/;
const CHANGE_SETTLE_MS = 1000;

// Origin positions differ between the two sides (each restarts the leg at its
// own vessel fix), so only what is navigated to identifies a course.
export function sameNavigation(a: Navigation, b: Navigation): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "goto" && b.kind === "goto")
    return samePosition(a.destination, b.destination) && a.mob === b.mob;
  if (a.kind === "route" && b.kind === "route")
    return (
      a.routeGuid.toLowerCase() === b.routeGuid.toLowerCase() &&
      a.pointIndex === b.pointIndex
    );
  return true;
}

// TimeZero stores positions to the centimetre; anything closer is the same.
const SAME_POSITION_DEGREES = 1e-6;
const samePosition = (a: LatLon, b: LatLon): boolean =>
  Math.abs(a.latitude - b.latitude) < SAME_POSITION_DEGREES &&
  Math.abs(a.longitude - b.longitude) < SAME_POSITION_DEGREES;

export class CourseBridge {
  private settleTimer: NodeJS.Timeout | null = null;
  // A route activation waiting for TimeZero to pull the route first.
  private waitingFor: { guid: string; nav: Navigation } | null = null;

  constructor(
    private readonly app: ServerAPI,
    private readonly peer: TimeZeroPeer,
  ) {
    peer.on("navigation", (nav) => void this.fromTimeZero(nav));
    peer.on("pulled", (guids) => {
      if (this.waitingFor && guids.includes(this.waitingFor.guid)) {
        const { nav } = this.waitingFor;
        this.waitingFor = null;
        this.peer.setNavigation(nav);
      }
    });
  }

  stop(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  async fromTimeZero(nav: Navigation): Promise<void> {
    try {
      if (nav.kind === "none") await this.app.clearDestination();
      else if (nav.kind === "goto")
        await this.app.setDestination({ position: nav.destination });
      else
        await this.app.activateRoute({
          href: `/resources/routes/${nav.routeGuid}`,
          pointIndex: nav.pointIndex,
        });
    } catch (err) {
      this.app.error(`applying TimeZero navigation: ${(err as Error).message}`);
    }
  }

  // Called for every navigation.course delta. The course settles first, since
  // one Course API call emits several deltas.
  onCourseDelta(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(
      () => void this.fromSignalK(),
      CHANGE_SETTLE_MS,
    );
  }

  async fromSignalK(): Promise<void> {
    this.settleTimer = null;
    let nav: Navigation | null;
    try {
      nav = toNavigation(await this.app.getCourse());
    } catch (err) {
      this.app.debug(`reading course: ${(err as Error).message}`);
      return;
    }
    // The latest course replaces an activation still waiting for its route.
    this.waitingFor = null;
    if (!nav || sameNavigation(nav, this.peer.navigation)) return;
    if (nav.kind === "route" && this.peer.isPending(nav.routeGuid)) {
      // TimeZero can only follow a route it has; activate once it pulled it.
      this.waitingFor = { guid: nav.routeGuid, nav };
      return;
    }
    this.peer.setNavigation(nav);
  }
}

type Course = Awaited<ReturnType<ServerAPI["getCourse"]>>;

// null when TimeZero cannot represent the course; it is then left alone
// rather than cancelled.
export function toNavigation(course: Course): Navigation | null {
  const origin = course.previousPoint?.position ?? null;
  const active = course.activeRoute;
  if (active) {
    const guid = ROUTE_HREF.exec(active.href)?.[1];
    // TimeZero has no reverse flag, and its route ids are GUIDs.
    if (!guid || active.reverse) return null;
    return {
      kind: "route",
      origin,
      routeGuid: guid,
      pointIndex: active.pointIndex,
    };
  }
  const destination = course.nextPoint?.position;
  if (destination) return { kind: "goto", origin, destination, mob: false };
  return { kind: "none" };
}
