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

interface SavedState {
  known: Record<string, Known>;
  // How far TimeZero's table is reflected in `known`. Behind the peer's own
  // tick (a lost or older state file) `known` cannot be trusted to tell
  // TimeZero's objects from new Signal K ones.
  tableTick: number;
  // Every route and mark guid TimeZero has sent, deleted ones included.
  seen: string[];
  // New routes offered but not yet pulled: each holds one of TimeZero's
  // places until it is pulled, across restarts too.
  awaitingNew: string[];
  // New routes held back for lack of room, retried when room may open up.
  held: string[];
}

export class ResourcesBridge {
  private known: Record<string, Known>;
  private tableTick: number;
  private seen: Set<string>;
  // Whether `known` covers TimeZero's table up to `tableTick`.
  private inStep: boolean;
  private awaitingNew: Set<string>;
  private held: Set<string>;
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
    this.held = new Set(saved.held);
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

  // Routes held back for TimeZero's limit go once there may be room: after a
  // pull, or after TimeZero sent deletions.
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
        const c = this.candidate(
          type,
          id,
          value as Route | Waypoint | null,
          now,
        );
        if (c) candidates.push(c);
      }
      await this.commitNow(candidates);
    });
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
  private async commitNow(candidates: Candidate[]): Promise<void> {
    const newRoutes = candidates.filter((c) => c.newRoute);
    let accepted = candidates.filter((c) => !c.newRoute);
    if (newRoutes.length) {
      const room = await this.routeRoom();
      const fits = newRoutes.slice(0, room);
      const held = newRoutes.slice(room);
      accepted = accepted.concat(fits);
      fits.forEach((c) => this.held.delete(c.obj.guid));
      held.forEach((c) => this.held.add(c.obj.guid));
      if (held.length)
        this.app.setPluginStatus(
          `${held.length} new route(s) not sent: TimeZero is at its ${this.opts.maxRoutes}-route limit`,
        );
      if (held.length && !accepted.length) this.save();
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
        const c = this.candidate(type, id, resource as Route | Waypoint, now);
        if (c) candidates.push(c);
      }
      if (type === "routes")
        for (const id of this.held)
          if (!(id in resources)) this.held.delete(id);
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
        held: [...this.held],
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
    return { known: {}, tableTick: 0, seen: [], awaitingNew: [], held: [] };
  }
}
