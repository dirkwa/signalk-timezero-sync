// Keeps Signal K routes and waypoints and TimeZero routes and marks in step.
//
// TimeZero -> Signal K: objects TimeZero pushes during a sync round are written
// through the Resources API. Signal K -> TimeZero: a changed resource is offered
// to TimeZero, which pulls it in its next round (see TimeZeroPeer.offer).

import fs from "node:fs";
import type { Route, ServerAPI, Waypoint } from "@signalk/server-api";
import type { TimeZeroPeer } from "../peer/engine.js";
import {
  formatUserObject,
  parseUserObject,
  type UserObject,
  type UserObjectDto,
} from "../protocol/userObject.js";
import {
  fingerprint,
  fromSkRoute,
  fromSkWaypoint,
  inUserLayer,
  isDeleted,
  tombstone,
  toSkRoute,
  toSkWaypoint,
  typeOf,
  type SyncedType,
} from "./mapping.js";

interface Known {
  type: SyncedType;
  // The Signal K side as last synced in either direction.
  fingerprint: string;
  // TimeZero's last copy, kept so its own fields survive Signal K edits.
  tz: UserObjectDto;
}

export interface ResourcesBridgeOptions {
  types: SyncedType[];
  stateFile: string;
  // Offer Signal K resources TimeZero has never had, on start.
  offerExisting: boolean;
  // TimeZero's route limit; 0 for none.
  maxRoutes: number;
}

interface Candidate {
  obj: Omit<UserObject, "tick">;
  newRoute: boolean;
  record: () => void;
}

const CHANGE_SETTLE_MS = 1000;

export class ResourcesBridge {
  private known: Record<string, Known>;
  private pending = new Map<string, { type: SyncedType; value: unknown }>();
  // New routes offered but not yet pulled: they count against the limit.
  private awaitingNew = new Set<string>();
  private heldBack = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly app: ServerAPI,
    private readonly peer: TimeZeroPeer,
    private readonly opts: ResourcesBridgeOptions,
  ) {
    this.known = loadKnown(opts.stateFile);
    peer.on("objects", (objects) => void this.fromTimeZero(objects));
    peer.on("pulled", (guids) => {
      guids.forEach((g) => this.awaitingNew.delete(g));
      this.retryHeld();
    });
  }

  // Routes held back for TimeZero's limit go once there may be room: after a
  // pull, or after TimeZero sent deletions.
  private retryHeld(): void {
    if (this.heldBack) void this.reconcile();
  }

  stop(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  // ---- TimeZero -> Signal K ----------------------------------------------

  async fromTimeZero(objects: UserObject[]): Promise<void> {
    for (const obj of objects) {
      const type = typeOf(obj);
      if (!type || !this.opts.types.includes(type) || inUserLayer(obj))
        continue;
      const known = this.known[obj.guid];
      try {
        if (isDeleted(obj)) {
          if (!known) continue;
          delete this.known[obj.guid];
          await this.app.resourcesApi.deleteResource(type, obj.guid);
          continue;
        }
        const resource = type === "routes" ? toSkRoute(obj) : toSkWaypoint(obj);
        if (!resource) continue;
        const print = fingerprint(type, resource);
        const unchanged = known?.fingerprint === print;
        // Record before writing: the write echoes back as a resource delta,
        // which must be recognised as ours.
        this.known[obj.guid] = {
          type,
          fingerprint: print,
          tz: formatUserObject(obj),
        };
        if (!unchanged)
          await this.app.resourcesApi.setResource(
            type,
            obj.guid,
            resource as unknown as Record<string, unknown>,
          );
      } catch (err) {
        this.app.error(
          `TimeZero ${type} ${obj.guid}: ${(err as Error).message}`,
        );
      }
    }
    this.save();
    if (objects.some(isDeleted)) this.retryHeld();
  }

  // ---- Signal K -> TimeZero ----------------------------------------------

  // Called for every resources.<type>.<id> delta, including the echoes of our
  // own writes. Changes settle briefly so an editor's burst of saves becomes
  // one offer.
  onResourceDelta(type: SyncedType, id: string, value: unknown): void {
    if (!this.opts.types.includes(type)) return;
    this.pending.set(id, { type, value });
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), CHANGE_SETTLE_MS);
  }

  private flush(): void {
    this.flushTimer = null;
    const now = new Date();
    const candidates: Candidate[] = [];
    for (const [id, { type, value }] of this.pending) {
      const c = this.candidate(type, id, value as Route | Waypoint | null, now);
      if (c) candidates.push(c);
    }
    this.pending.clear();
    void this.commit(candidates);
  }

  // What to offer for a Signal K change, without recording anything yet: a
  // new route may still be held back by TimeZero's route limit.
  private candidate(
    type: SyncedType,
    id: string,
    resource: Route | Waypoint | null,
    now: Date,
  ): Candidate | null {
    const known = this.known[id];
    const previous = known ? parseUserObject(known.tz) : undefined;
    if (resource === null) {
      if (!previous) return null;
      return {
        obj: tombstone(previous, now),
        newRoute: false,
        record: () => delete this.known[id],
      };
    }
    const print = fingerprint(type, resource);
    if (known?.fingerprint === print) return null;
    const obj =
      type === "routes"
        ? fromSkRoute(id, resource as Route, previous, now)
        : fromSkWaypoint(id, resource as Waypoint, previous, now);
    if (!obj) return null;
    return {
      obj,
      newRoute: type === "routes" && !known,
      record: () => {
        this.known[id] = {
          type,
          fingerprint: print,
          tz: formatUserObject({ ...obj, tick: 0 }),
        };
      },
    };
  }

  // On a Furuno NavNet, TimeZero holds at most 200 routes and makes room for
  // a new one by deleting the route modified longest ago, on every device it
  // syncs with. So a new Signal K route is only sent while there is room.
  private async commit(candidates: Candidate[]): Promise<void> {
    const newRoutes = candidates.filter((c) => c.newRoute);
    let accepted = candidates.filter((c) => !c.newRoute);
    if (newRoutes.length) {
      const room = await this.routeRoom();
      accepted = accepted.concat(newRoutes.slice(0, room));
      const held = newRoutes.length - Math.min(room, newRoutes.length);
      this.heldBack = held > 0;
      if (held)
        this.app.setPluginStatus(
          `${held} new route(s) not sent: TimeZero is at its ${this.opts.maxRoutes}-route limit`,
        );
    }
    if (!accepted.length) return;
    for (const c of accepted) c.record();
    for (const c of accepted) if (c.newRoute) this.awaitingNew.add(c.obj.guid);
    this.save();
    this.peer.offer(accepted.map((c) => c.obj));
    this.app.debug(`offered ${accepted.length} object(s) to TimeZero`);
    this.peer.rejoin();
  }

  private async routeRoom(): Promise<number> {
    if (this.opts.maxRoutes <= 0) return Number.MAX_SAFE_INTEGER;
    const live = await this.peer.liveRouteCount();
    // Without TimeZero's count, sending a new route could cost an old one.
    if (live === null) return 0;
    return Math.max(0, this.opts.maxRoutes - live - this.awaitingNew.size);
  }

  // Resources changed while the plugin was off, or never synced at all.
  async reconcile(): Promise<void> {
    const now = new Date();
    const candidates: Candidate[] = [];
    for (const type of this.opts.types) {
      let resources: Record<string, unknown>;
      try {
        resources = await this.app.resourcesApi.listResources(type, {});
      } catch (err) {
        this.app.debug(`listing ${type}: ${(err as Error).message}`);
        continue;
      }
      for (const [id, resource] of Object.entries(resources)) {
        if (!this.known[id] && !this.opts.offerExisting) continue;
        const c = this.candidate(type, id, resource as Route | Waypoint, now);
        if (c) candidates.push(c);
      }
      for (const [id, known] of Object.entries(this.known)) {
        if (known.type !== type || id in resources) continue;
        const c = this.candidate(type, id, null, now);
        if (c) candidates.push(c);
      }
    }
    await this.commit(candidates);
  }

  private save(): void {
    try {
      const tmp = `${this.opts.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.known));
      fs.renameSync(tmp, this.opts.stateFile);
    } catch (err) {
      this.app.error(`saving resource sync state: ${(err as Error).message}`);
    }
  }
}

function loadKnown(file: string): Record<string, Known> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Known>;
  } catch {
    return {};
  }
}
