// Keeps a man overboard in step. TimeZero marks a MOB as a go-to with its MOB
// flag set; Signal K raises a Person Overboard alarm, notifications.mob.<id>
// from the Notifications API or notifications.mob from other sources.
//
// TimeZero -> Signal K: a MOB in TimeZero raises the alarm (the course itself
// follows through the course bridge); TimeZero ending it clears that alarm.
// Signal K -> TimeZero: a MOB alarm raised in Signal K becomes a MOB go-to to
// the alarm's position. Clearing the alarm in Signal K leaves TimeZero's
// navigation alone: ending the MOB there is the crew's call at the plotter.

import type { NotificationId, ServerAPI } from "@signalk/server-api";
import type { TimeZeroPeer } from "../peer/engine.js";
import type { LatLon } from "../protocol/geometry.js";
import type { Navigation } from "../protocol/navigation.js";

const MOB_MESSAGE = "Person Overboard! (from TimeZero)";
// Slack for an alarm raised just before the plugin started.
const START_SLACK_MS = 5000;

const isMob = (nav: Navigation): boolean => nav.kind === "goto" && nav.mob;

interface MobValue {
  state?: string;
  position?: LatLon | null;
  createdAt?: string;
}

export class MobBridge {
  private readonly startedAt = Date.now();
  // The alarm raised for TimeZero's MOB, and whether one is being raised (its
  // delta arrives before the call returns the id).
  private raisedId: NotificationId | null = null;
  private raising = false;
  // Signal K MOB alarms in an emergency state, by path.
  private readonly active = new Set<string>();

  constructor(
    private readonly app: ServerAPI,
    private readonly peer: TimeZeroPeer,
  ) {
    peer.on("navigation", (nav) => this.fromTimeZero(nav));
  }

  fromTimeZero(nav: Navigation): void {
    try {
      if (isMob(nav) && !this.raisedId && !this.active.size) {
        this.raising = true;
        try {
          this.raisedId = this.app.notifications.mob(MOB_MESSAGE);
        } finally {
          this.raising = false;
        }
      } else if (!isMob(nav) && this.raisedId) {
        const id = this.raisedId;
        this.raisedId = null;
        this.app.notifications.clear(id);
      }
    } catch (err) {
      this.app.error(`TimeZero MOB alarm: ${(err as Error).message}`);
    }
  }

  // Called for every notifications.mob delta.
  onMobDelta(path: string, value: unknown): void {
    if (
      this.raising ||
      (this.raisedId && path === `notifications.mob.${this.raisedId}`)
    )
      return;
    const v = (value ?? {}) as MobValue;
    if (v.state !== "emergency" && v.state !== "alarm") {
      this.active.delete(path);
      return;
    }
    if (this.active.has(path)) return;
    this.active.add(path);
    // An alarm from before the plugin started is not one to act on now.
    const created = v.createdAt ? Date.parse(v.createdAt) : Date.now();
    if (created < this.startedAt - START_SLACK_MS) return;
    if (isMob(this.peer.navigation)) return;
    const self = this.app.getSelfPath("navigation.position") as
      { value?: LatLon } | undefined;
    const position = v.position ?? self?.value;
    if (!position) {
      this.app.error("Signal K MOB without a position: not sent to TimeZero");
      return;
    }
    this.peer.setNavigation({
      kind: "goto",
      origin: position,
      destination: position,
      mob: true,
    });
  }
}
