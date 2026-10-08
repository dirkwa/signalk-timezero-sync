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
}

const CHANGE_SETTLE_MS = 1000;

export class ResourcesBridge {
  private known: Record<string, Known>;
  private pending = new Map<string, { type: SyncedType; value: unknown }>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly app: ServerAPI,
    private readonly peer: TimeZeroPeer,
    private readonly opts: ResourcesBridgeOptions,
  ) {
    this.known = loadKnown(opts.stateFile);
    peer.on("objects", (objects) => void this.fromTimeZero(objects));
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
    const offers: Omit<UserObject, "tick">[] = [];
    for (const [id, { type, value }] of this.pending) {
      const offer = this.toOffer(
        type,
        id,
        value as Route | Waypoint | null,
        now,
      );
      if (offer) offers.push(offer);
    }
    this.pending.clear();
    this.commit(offers);
  }

  private toOffer(
    type: SyncedType,
    id: string,
    resource: Route | Waypoint | null,
    now: Date,
  ): Omit<UserObject, "tick"> | null {
    const known = this.known[id];
    const previous = known ? parseUserObject(known.tz) : undefined;
    if (resource === null) {
      if (!previous) return null;
      delete this.known[id];
      return tombstone(previous, now);
    }
    const print = fingerprint(type, resource);
    if (known?.fingerprint === print) return null;
    const obj =
      type === "routes"
        ? fromSkRoute(id, resource as Route, previous, now)
        : fromSkWaypoint(id, resource as Waypoint, previous, now);
    if (!obj) return null;
    this.known[id] = {
      type,
      fingerprint: print,
      tz: formatUserObject({ ...obj, tick: 0 }),
    };
    return obj;
  }

  private commit(offers: Omit<UserObject, "tick">[]): void {
    if (!offers.length) return;
    this.save();
    this.peer.offer(offers);
    this.app.debug(`offered ${offers.length} object(s) to TimeZero`);
    this.peer.rejoin();
  }

  // Resources changed while the plugin was off, or never synced at all.
  async reconcile(): Promise<void> {
    const now = new Date();
    const offers: Omit<UserObject, "tick">[] = [];
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
        const offer = this.toOffer(type, id, resource as Route | Waypoint, now);
        if (offer) offers.push(offer);
      }
      for (const [id, known] of Object.entries(this.known)) {
        if (known.type !== type || id in resources) continue;
        const offer = this.toOffer(type, id, null, now);
        if (offer) offers.push(offer);
      }
    }
    this.commit(offers);
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
