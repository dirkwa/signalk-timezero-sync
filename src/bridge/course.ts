// Keeps the Signal K course (Course API) and TimeZero's active route in step:
// a go-to point, a followed route with its current point, or nothing.

import type { ServerAPI } from "@signalk/server-api";
import type { TimeZeroPeer } from "../peer/engine.js";
import type { LatLon } from "../protocol/geometry.js";
import type { Navigation } from "../protocol/navigation.js";

const ROUTE_HREF = /^\/resources\/routes\/([0-9a-fA-F-]{36})$/;
const CHANGE_SETTLE_MS = 1000;

// Origin positions differ between the two sides (each restarts the leg at its
// own vessel fix), so only what is navigated to identifies a course. The MOB
// flag does not count: a Signal K course has none, and a Signal K go-to to the
// MOB position must not turn TimeZero's MOB into a plain go-to.
export function sameNavigation(a: Navigation, b: Navigation): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "goto" && b.kind === "goto")
    return samePosition(a.destination, b.destination);
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

const sameOrBothNull = (a: Navigation | null, b: Navigation | null): boolean =>
  a === null || b === null ? a === b : sameNavigation(a, b);

// Slack for the clocks of the Course API and this plugin, which are the same
// process, and for the time between a course being set and us reading it.
const START_SLACK_MS = 5000;

export class CourseBridge {
  private readonly startedAt = Date.now();
  private settleTimer: NodeJS.Timeout | null = null;
  // A route activation waiting for TimeZero to pull the route first.
  private waitingFor: { guid: string; nav: Navigation } | null = null;
  // The Signal K course as last seen. Only a change from it is sent: a course
  // that was already set when the plugin started (perhaps left over from a
  // passage days ago) stays in Signal K.
  private baseline: Navigation | null | "unset" = "unset";

  constructor(
    private readonly app: ServerAPI,
    private readonly peer: TimeZeroPeer,
  ) {
    peer.on("navigation", (nav) => void this.fromTimeZero(nav));
    app
      .getCourse()
      .then((course) => {
        if (this.baseline === "unset") this.baseline = toNavigation(course);
      })
      .catch(() => {});
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
    // What we apply comes back as course deltas; it is not a Signal K change.
    this.baseline = nav;
    try {
      // TimeZero updates its record while navigating; re-applying an unchanged
      // course would restart the Signal K leg each time.
      if (sameOrBothNull(toNavigation(await this.app.getCourse()), nav)) return;
      this.app.debug(`TimeZero navigation to Signal K: ${describe(nav)}`);
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
    let course: Course;
    try {
      course = await this.app.getCourse();
    } catch (err) {
      this.app.debug(`reading course: ${(err as Error).message}`);
      return;
    }
    const nav = toNavigation(course);
    const before = this.baseline;
    if (before === "unset") {
      this.baseline = nav;
      return;
    }
    if (sameOrBothNull(nav, before)) return;
    this.baseline = nav;
    // The latest course replaces an activation still waiting for its route.
    this.waitingFor = null;
    const change = `Signal K course ${describe(nav)} (was ${describe(before)}, TimeZero ${describe(this.peer.navigation)})`;
    if (!nav || sameNavigation(nav, this.peer.navigation)) {
      this.app.debug(`${change}: TimeZero has it`);
      return;
    }
    if (!this.isNewAction(nav, before, course)) {
      this.app.debug(`${change}: not sent, not a new action`);
      return;
    }
    this.app.debug(`${change}: sent`);
    if (nav.kind === "route" && this.peer.isPending(nav.routeGuid)) {
      // TimeZero can only follow a route it has; activate once it pulled it.
      this.waitingFor = { guid: nav.routeGuid, nav };
      return;
    }
    this.peer.setNavigation(nav);
  }

  // Whether a Signal K course change is something someone just did, rather
  // than the Course API restoring a course saved before a restart (which can
  // arrive after the plugin has started and look like a change).
  private isNewAction(
    nav: Navigation,
    before: Navigation | null,
    course: Course,
  ): boolean {
    // Moving along a followed route keeps its start time.
    if (
      nav.kind === "route" &&
      before?.kind === "route" &&
      nav.routeGuid.toLowerCase() === before.routeGuid.toLowerCase()
    )
      return true;
    // A cancel only goes when the two sides agreed before it; clearing an old
    // Signal K course must not cancel what TimeZero is navigating.
    if (nav.kind === "none")
      return before !== null && sameNavigation(before, this.peer.navigation);
    // A new go-to or route activation carries the time it was set.
    const started = course.startTime ? Date.parse(course.startTime) : NaN;
    return started >= this.startedAt - START_SLACK_MS;
  }
}

type Course = Awaited<ReturnType<ServerAPI["getCourse"]>>;

function describe(nav: Navigation | null): string {
  if (!nav) return "not representable in TimeZero";
  if (nav.kind === "goto")
    return `go-to ${nav.destination.latitude.toFixed(5)},${nav.destination.longitude.toFixed(5)}${nav.mob ? " (MOB)" : ""}`;
  if (nav.kind === "route")
    return `route ${nav.routeGuid} point ${nav.pointIndex}`;
  return "none";
}

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
