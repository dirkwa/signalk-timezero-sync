// Keeps Signal K routes, waypoints and regions and TimeZero routes, marks and
// areas in step.
//
// TimeZero -> Signal K: objects TimeZero pushes during a sync round are written
// through the Resources API. Signal K -> TimeZero: a changed resource is offered
// to TimeZero, which pulls it in its next round (see TimeZeroPeer.offer).

import fs from "node:fs";
import type { Region, Route, ServerAPI, Waypoint } from "@signalk/server-api";
import type { TimeZeroPeer } from "../peer/engine.js";
import {
  formatUserObject,
  parseUserObject,
  type UserObject,
  type UserObjectDto,
} from "../protocol/userObject.js";
import {
  fingerprint,
  fromSkRegion,
  fromSkRoute,
  fromSkWaypoint,
  inUserLayer,
  isDeleted,
  isLocked,
  MAX_AREA_CORNERS,
  regionCorners,
  tombstone,
  toSkResource,
  typeOf,
  type SkResource,
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

// Object kinds TimeZero limits in number; a new one is only sent while there
// is room.
type Limited = "routes" | "regions";

interface Candidate {
  obj: Omit<UserObject, "tick">;
  // Set for a new object of a kind TimeZero limits.
  limited: Limited | null;
  record: () => void;
}

const CHANGE_SETTLE_MS = 1000;
// TimeZero's synced layer holds routes of at most 500 points.
const MAX_ROUTE_POINTS = 500;
// TimeZero's synced layer holds at most 100 areas and lines together.
const MAX_BOUNDARIES = 100;

interface SavedState {
  known: Record<string, Known>;
  // How far TimeZero's table is reflected in `known`. Behind the peer's own
  // tick (a lost or older state file) `known` cannot be trusted to tell
  // TimeZero's objects from new Signal K ones.
  tableTick: number;
  // Every route and mark guid TimeZero has sent, deleted ones included.
  seen: string[];
  // New routes and areas offered but not yet pulled: each holds one of
  // TimeZero's places until it is pulled, across restarts too.
  awaitingNew: string[];
  // New routes and areas held back for lack of room, retried when room may
  // open up. A list in older state files, which held routes only.
  held: Record<string, Limited> | string[];
}

export class ResourcesBridge {
  private known: Record<string, Known>;
  private tableTick: number;
  private seen: Set<string>;
  // Whether `known` covers TimeZero's table up to `tableTick`.
  private inStep: boolean;
  private awaitingNew: Set<string>;
  private held: Map<string, Limited>;
  private pending = new Map<string, { type: SyncedType; value: unknown }>();
  private flushTimer: NodeJS.Timeout | null = null;
  // Imports, offers and the start-up check run one at a time. A check that
  // overlapped an import would see a half-written Signal K, and two offers
  // checking room together could both take TimeZero's last route place.
  private ops: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: ServerAPI,
    private readonly peer: TimeZeroPeer,
    private readonly opts: ResourcesBridgeOptions,
  ) {
    const saved = loadState(opts.stateFile);
    this.known = saved.known;
    this.tableTick = saved.tableTick;
    this.seen = new Set(saved.seen);
    this.inStep = this.tableTick >= peer.tableTick;
    if (!this.inStep) {
      app.debug(
        `resource state is at tick ${this.tableTick}, the peer at ${peer.tableTick}: reading TimeZero's table again`,
      );
      peer.rereadTable();
    }
    this.awaitingNew = new Set(
      saved.awaitingNew.filter((g) => peer.isPending(g)),
    );
    this.held = new Map(
      Array.isArray(saved.held)
        ? saved.held.map((g) => [g, "routes" as const])
        : Object.entries(saved.held),
    );
    peer.on(
      "objects",
      (objects, tick) => void this.fromTimeZero(objects, tick),
    );
    // Only once all of TimeZero's objects are here can a Signal K resource be
    // told apart from one TimeZero already has.
    peer.on("caughtUp", () => {
      const tick = peer.tableTick;
      void this.enqueue(async () => {
        this.inStep = true;
        this.tableTick = Math.max(this.tableTick, tick);
        this.save();
        await this.reconcileNow();
      });
    });
    peer.on("pulled", (guids) => {
      guids.forEach((g) => this.awaitingNew.delete(g));
      this.retryHeld();
    });
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.ops.then(op);
    this.ops = run.catch((err: Error) =>
      this.app.error(`TimeZero resource sync: ${err.message}`),
    );
    return run;
  }

  // Routes and areas held back for TimeZero's limits go once there may be
  // room: after a pull, or after TimeZero sent deletions.
  private retryHeld(): void {
    if (this.held.size) void this.reconcile();
  }

  stop(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  // ---- TimeZero -> Signal K ----------------------------------------------

  fromTimeZero(objects: UserObject[], tick: number): Promise<void> {
    return this.enqueue(() => this.importObjects(objects, tick));
  }

  private async importObjects(
    objects: UserObject[],
    tick: number,
  ): Promise<void> {
    for (const obj of objects) {
      const type = typeOf(obj);
      if (!type || !this.opts.types.includes(type) || inUserLayer(obj))
        continue;
      this.seen.add(obj.guid);
      const known = this.known[obj.guid];
      try {
        if (isDeleted(obj)) {
          if (!known) continue;
          delete this.known[obj.guid];
          await this.app.resourcesApi.deleteResource(type, obj.guid);
          continue;
        }
        const resource = toSkResource(type, obj);
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
        // Not in Signal K, so not ours to compare against later.
        if (!known) delete this.known[obj.guid];
        this.app.error(
          `TimeZero ${type} ${obj.guid}: ${(err as Error).message}`,
        );
      }
    }
    // During a full read the pages are not yet the whole table.
    if (this.inStep) this.tableTick = Math.max(this.tableTick, tick);
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
    // Until TimeZero's table is read, a Signal K change cannot be told from
    // the echo of an object still being imported.
    if (!this.inStep) {
      this.flushTimer = setTimeout(() => this.flush(), CHANGE_SETTLE_MS);
      return;
    }
    const changes = [...this.pending];
    this.pending.clear();
    void this.enqueue(async () => {
      const now = new Date();
      const candidates: Candidate[] = [];
      for (const [id, { type, value }] of changes) {
        if (value === null) this.held.delete(id);
        const c = this.candidate(type, id, value as SkResource | null, now);
        if (c) candidates.push(c);
      }
      await this.commitNow(candidates);
    });
  }

  // What to offer for a Signal K change, without recording anything yet: a
  // new route or area may still be held back by TimeZero's limits.
  private candidate(
    type: SyncedType,
    id: string,
    resource: SkResource | null,
    now: Date,
  ): Candidate | null {
    const known = this.known[id];
    const previous = known ? parseUserObject(known.tz) : undefined;
    // TimeZero keeps a locked object from being moved or deleted. Signal K
    // has no lock, so a change made there is undone rather than sent.
    if (
      known &&
      previous &&
      isLocked(previous) &&
      (resource === null || fingerprint(type, resource) !== known.fingerprint)
    ) {
      void this.enqueue(() => this.restoreLocked(type, id, previous));
      return null;
    }
    if (resource === null) {
      if (!previous) return null;
      return {
        obj: tombstone(previous, now),
        limited: null,
        record: () => delete this.known[id],
      };
    }
    const print = fingerprint(type, resource);
    if (known?.fingerprint === print) return null;
    const points =
      type === "routes"
        ? ((resource as Route).feature?.geometry?.coordinates?.length ?? 0)
        : 0;
    if (points > MAX_ROUTE_POINTS) {
      this.app.setPluginStatus(
        `Route "${resource.name ?? id}" not sent: TimeZero takes at most ${MAX_ROUTE_POINTS} points per route, it has ${points}`,
      );
      return null;
    }
    if (type === "regions") {
      const corners = regionCorners(resource as Region);
      if (!corners || corners.length > MAX_AREA_CORNERS) {
        this.app.setPluginStatus(
          `Region "${resource.name ?? id}" not sent: TimeZero takes one outline without holes, of 3 to ${MAX_AREA_CORNERS} corners`,
        );
        return null;
      }
    }
    const obj =
      type === "routes"
        ? fromSkRoute(id, resource as Route, previous, now)
        : type === "regions"
          ? fromSkRegion(id, resource as Region, previous, now)
          : fromSkWaypoint(id, resource as Waypoint, previous, now);
    if (!obj) return null;
    return {
      obj,
      limited: !known && type !== "waypoints" ? type : null,
      record: () => {
        this.known[id] = {
          type,
          fingerprint: print,
          tz: formatUserObject({ ...obj, tick: 0 }),
        };
      },
    };
  }

  private async restoreLocked(
    type: SyncedType,
    id: string,
    obj: UserObject,
  ): Promise<void> {
    const resource = toSkResource(type, obj);
    if (!resource) return;
    this.app.setPluginStatus(
      `"${resource.name ?? id}" is locked in TimeZero: unlock it there to change or delete it`,
    );
    await this.app.resourcesApi.setResource(
      type,
      id,
      resource as unknown as Record<string, unknown>,
    );
  }

  // TimeZero's synced layer holds at most 200 routes, and TimeZero makes room
  // for a new one by deleting the route modified longest ago, on every device
  // it syncs with. So a new Signal K route is only sent while there is room;
  // a new area likewise, within TimeZero's 100 areas and lines.
  private async commitNow(candidates: Candidate[]): Promise<void> {
    const accepted = candidates.filter((c) => !c.limited);
    const limited = candidates.filter((c) => c.limited);
    if (limited.length) {
      const room = await this.room();
      const held: Candidate[] = [];
      for (const c of limited) {
        const kind = c.limited!;
        if (room[kind] > 0) {
          room[kind]--;
          accepted.push(c);
          this.held.delete(c.obj.guid);
        } else {
          held.push(c);
          this.held.set(c.obj.guid, kind);
        }
      }
      if (held.length)
        this.app.setPluginStatus(
          `${held.length} new route(s) or area(s) not sent: TimeZero has no room (at most ${this.opts.maxRoutes} routes, ${MAX_BOUNDARIES} areas and lines)`,
        );
      if (held.length && !accepted.length) this.save();
    }
    if (!accepted.length) return;
    for (const c of accepted) c.record();
    for (const c of accepted) if (c.limited) this.awaitingNew.add(c.obj.guid);
    this.save();
    this.peer.offer(accepted.map((c) => c.obj));
    this.app.debug(`offered ${accepted.length} object(s) to TimeZero`);
    this.peer.requestRound();
  }

  // Places left in TimeZero for new routes and areas, less those offered and
  // not yet pulled. Without TimeZero's counts, none: sending a new route
  // could cost an old one.
  private async room(): Promise<Record<Limited, number>> {
    const waiting = (kind: Limited) =>
      [...this.awaitingNew].filter((g) => this.known[g]?.type === kind).length;
    const counts = await this.peer.liveCounts();
    const routes =
      this.opts.maxRoutes <= 0
        ? Number.MAX_SAFE_INTEGER
        : counts
          ? this.opts.maxRoutes - counts.routes - waiting("routes")
          : 0;
    const regions =
      counts?.boundaries != null
        ? MAX_BOUNDARIES - counts.boundaries - waiting("regions")
        : 0;
    return { routes: Math.max(0, routes), regions: Math.max(0, regions) };
  }

  // Signal K resources TimeZero does not have yet, and edits made while the
  // plugin was off. A resource missing from Signal K is never taken as
  // deleted: it may simply not be written yet, and a wrong guess would delete
  // a route on every TimeZero device. Deletions go to TimeZero only when
  // Signal K reports them.
  reconcile(): Promise<void> {
    return this.enqueue(() => this.reconcileNow());
  }

  private async reconcileNow(): Promise<void> {
    if (!this.inStep) return;
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
        if (!this.known[id] && !this.opts.offerExisting && !this.held.has(id))
          continue;
        // An unknown resource TimeZero has had is not new: it is TimeZero's
        // object, perhaps deleted there since. Offering it would overwrite or
        // bring back TimeZero's copy.
        if (!this.known[id] && this.seen.has(id)) continue;
        const c = this.candidate(type, id, resource as SkResource, now);
        if (c) candidates.push(c);
      }
      for (const [id, kind] of this.held)
        if (kind === type && !(id in resources)) this.held.delete(id);
    }
    await this.commitNow(candidates);
  }

  private save(): void {
    try {
      const tmp = `${this.opts.stateFile}.tmp`;
      const state: SavedState = {
        known: this.known,
        tableTick: this.tableTick,
        seen: [...this.seen],
        awaitingNew: [...this.awaitingNew],
        held: Object.fromEntries(this.held),
      };
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.opts.stateFile);
    } catch (err) {
      this.app.error(`saving resource sync state: ${(err as Error).message}`);
    }
  }
}

function loadState(file: string): SavedState {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SavedState>;
    return {
      known: s.known ?? {},
      tableTick: s.tableTick ?? 0,
      seen: s.seen ?? [],
      awaitingNew: s.awaitingNew ?? [],
      held: s.held ?? [],
    };
  } catch {
    return { known: {}, tableTick: 0, seen: [], awaitingNew: [], held: {} };
  }
}
