// A TimeZero LAN sync peer: beacons on UDP 33000, the sync endpoint on TCP
// 32000, and the pulls and pushes that keep the active route and the anchor
// watch in step with TimeZero.
//
// How TimeZero behaves, as observed on a TZ Professional 5.0:
//  - The peer with the highest visible-host count is sync master. With a real
//    TimeZero present that is TimeZero, and we advertise 1 so we never contend.
//  - The master runs a sync round when a peer appears: GetLock, POST Schema,
//    GET UserObject?MinTick=<what it has from us>, POST UserObject (its changes),
//    GET then POST ActiveRoute, GET then POST FishIt, ReleaseLock. A higher
//    table tick in our beacon alone does not start a round.
//  - A POSTed UserObject table is taken as master data: the receiver adopts its
//    CurrentTick and SyncTicks. So we never push tables, we only offer them.
//  - ActiveRoute and AnchorWatch changes are announced in the beacon (fields 11
//    and 14) but not pushed; peers pull them, and a peer may push its own.

import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import http from "node:http";
import os from "node:os";
import {
  buildBeacon,
  isTimeZero,
  parseBeacon,
  type Peer,
} from "../protocol/beacon.js";
import {
  buildActiveRoute,
  buildAnchorWatch,
  parseActiveRoute,
  parseAnchorWatch,
  type ActiveRouteDto,
  type Anchor,
  type AnchorWatchDto,
  type Navigation,
} from "../protocol/navigation.js";
import {
  formatUserObject,
  parseUserObject,
  type UserObject,
  type UserObjectTableDto,
} from "../protocol/userObject.js";
import { loadState, saveState, type PeerState } from "./state.js";

export const DISCOVERY_PORT = 33000;
export const COMMAND_PORT = 32000;
const BEACON_INTERVAL_MS = 1000;
const PEER_STALE_MS = 5000;
const LOCK_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const VISIBLE_HOSTS_SOLE = 99;
const VISIBLE_HOSTS_DEFERRED = 1;
const API = "/LanSynchronizationApi";
const TABLE_PAGE_SIZE = 1000;
// A full table of a few thousand objects fits in a handful of pages; the cap
// only stops a misbehaving peer from keeping us reading forever.
const MAX_TABLE_PAGES = 50;

export interface PeerOptions {
  hostName: string;
  userId: string;
  stateFile: string;
  debug: (msg: string) => void;
  error: (msg: string) => void;
  // How long to stay silent so TimeZero drops us and syncs on our return.
  rejoinPauseMs: number;
}

export interface PeerEvents {
  objects: [UserObject[]];
  navigation: [Navigation];
  anchor: [Anchor | null];
  // Objects TimeZero pulled from us, by guid.
  pulled: [string[]];
  // A trusted TimeZero is on the network again (or for the first time).
  joined: [];
  status: [string];
}

interface HttpResult {
  status: number;
  body: string;
}

export class TimeZeroPeer extends EventEmitter<PeerEvents> {
  readonly peers = new Map<string, Peer>();
  private state: PeerState;
  private socket: dgram.Socket | null = null;
  private server: http.Server | null = null;
  private beaconTimer: NodeJS.Timeout | null = null;
  private silentUntil = 0;
  private lockHolder: string | null = null;
  private lockTakenAt = 0;
  private busy = false;
  private started = false;

  constructor(private readonly opts: PeerOptions) {
    super();
    this.state = loadState(opts.stateFile);
  }

  get hostId(): string {
    return `${this.opts.hostName}/${this.state.uuid}`;
  }

  get navigation(): Navigation {
    return this.state.navigation;
  }

  get anchor(): Anchor | null {
    return this.state.anchor;
  }

  get hasSynced(): { route: boolean; anchor: boolean } {
    return {
      route: this.state.routeTick > 0,
      anchor: this.state.anchorTick > 0,
    };
  }

  start(): Promise<void> {
    this.started = true;
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.once("error", (err) => {
        this.started = false;
        reject(err);
      });
      server.listen(COMMAND_PORT, "0.0.0.0", () => {
        server.removeAllListeners("error");
        server.on("error", (err) =>
          this.opts.error(`sync endpoint: ${err.message}`),
        );
        this.server = server;
        this.startDiscovery();
        resolve();
      });
    });
  }

  stop(): void {
    this.started = false;
    if (this.beaconTimer) clearInterval(this.beaconTimer);
    this.beaconTimer = null;
    this.socket?.close();
    this.socket = null;
    this.server?.close();
    this.server = null;
  }

  // ---- local changes ------------------------------------------------------

  // Offer objects for TimeZero to pull. Each gets a tick above everything
  // TimeZero has seen from us, which is what its next pull asks for.
  offer(objects: Omit<UserObject, "tick">[]): void {
    for (const obj of objects) {
      this.state.offerTick = this.servedTick + 1;
      this.state.offered[obj.guid] = formatUserObject({
        ...obj,
        tick: this.state.offerTick,
      });
    }
    this.save();
  }

  // The table tick we advertise and serve.
  private get servedTick(): number {
    return Math.max(this.state.tzTableTick, this.state.offerTick);
  }

  get hasUnpulledOffers(): boolean {
    return Object.keys(this.state.offered).length > 0;
  }

  setNavigation(nav: Navigation): void {
    this.state.routeTick = this.nextTick(
      this.state.routeTick,
      (p) => p.routeTick,
    );
    this.state.navigation = nav;
    this.save();
  }

  setAnchor(anchor: Anchor | null): void {
    this.state.anchorTick = this.nextTick(
      this.state.anchorTick,
      (p) => p.anchorTick,
    );
    this.state.anchor = anchor;
    this.save();
  }

  // A local change must look newer than anything a peer advertises, or no
  // peer would take it.
  private nextTick(own: number, of: (p: Peer) => number): number {
    let highest = own;
    for (const p of this.peers.values()) highest = Math.max(highest, of(p));
    return highest + 1;
  }

  // Go quiet until TimeZero drops us; it runs a sync round when we return.
  rejoin(): void {
    if (Date.now() < this.silentUntil) return;
    this.opts.debug(
      `going silent for ${this.opts.rejoinPauseMs} ms so TimeZero syncs on return`,
    );
    this.silentUntil = Date.now() + this.opts.rejoinPauseMs;
  }

  // ---- discovery ----------------------------------------------------------

  private startDiscovery(): void {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", (err) => this.opts.error(`discovery: ${err.message}`));
    socket.on("message", (msg, rinfo) =>
      this.onBeacon(msg.toString("utf8"), rinfo.address),
    );
    socket.bind(DISCOVERY_PORT, () => {
      socket.setBroadcast(true);
      this.opts.debug(`discovery on :${DISCOVERY_PORT} as ${this.hostId}`);
    });
    this.socket = socket;
    this.beaconTimer = setInterval(() => this.sendBeacon(), BEACON_INTERVAL_MS);
  }

  private sendBeacon(): void {
    if (!this.socket || Date.now() < this.silentUntil) return;
    const beacon = buildBeacon({
      name: this.opts.hostName,
      userId: this.opts.userId,
      uuid: this.state.uuid,
      visibleHosts: this.otherTimeZeroPresent()
        ? VISIBLE_HOSTS_DEFERRED
        : VISIBLE_HOSTS_SOLE,
      tableTick: this.servedTick,
      routeTick: this.state.routeTick,
      fishItTick: this.state.fishIt?.ChangeTick ?? 0,
      anchorTick: this.state.anchorTick,
    });
    for (const address of this.broadcastAddresses())
      this.socket.send(beacon, DISCOVERY_PORT, address, (err) => {
        if (err) this.opts.debug(`beacon to ${address}: ${err.message}`);
      });
  }

  // Without a user id TimeZero trusts only NavNet (172.31.x.x) addresses, so
  // there is no point beaconing anywhere else.
  private broadcastAddresses(): string[] {
    const out = new Set<string>();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== "IPv4" || ni.internal) continue;
        if (!this.opts.userId && !ni.address.startsWith("172.31.")) continue;
        const ip = ni.address.split(".").map(Number);
        const mask = ni.netmask.split(".").map(Number);
        out.add(
          ip
            .map((o, i) => (o & (mask[i] ?? 0)) | (~(mask[i] ?? 0) & 255))
            .join("."),
        );
      }
    }
    return [...out];
  }

  private otherTimeZeroPresent(): boolean {
    const now = Date.now();
    for (const p of this.peers.values())
      if (now - p.lastSeen <= PEER_STALE_MS && isTimeZero(p)) return true;
    return false;
  }

  onBeacon(message: string, address: string): void {
    const beacon = parseBeacon(message);
    if (!beacon || beacon.uuid === this.state.uuid) return;
    const known = this.peers.get(address);
    const wasPresent = this.timeZeroAddress() !== null;
    this.peers.set(address, { ...beacon, address, lastSeen: Date.now() });
    if (!known)
      this.opts.debug(`peer ${beacon.name} (${address}) ${beacon.deviceType}`);
    if (!this.isTrusted(address) || !isTimeZero(beacon)) return;
    if (!wasPresent) this.emit("joined");

    if (beacon.routeTick > this.state.routeTick)
      void this.pullNavigation(address);
    else if (
      beacon.routeTick < this.state.routeTick &&
      this.state.routeTick > 0
    )
      void this.pushNavigation(address);
    else if (beacon.anchorTick > this.state.anchorTick)
      void this.pullAnchor(address);
    else if (
      beacon.anchorTick < this.state.anchorTick &&
      this.state.anchorTick > 0
    )
      void this.pushAnchor(address);
    // TimeZero announces edits to routes and marks in its beacon but only
    // sends them when a peer joins, so read them ourselves.
    else if (beacon.tableTick > this.state.tzTableTick)
      void this.pullObjects(address);
  }

  // NavNet is the subnet TimeZero itself trusts for account-free sync. Off
  // NavNet only a peer advertising our My TIMEZERO user id is trusted.
  isTrusted(address: string): boolean {
    if (address.startsWith("172.31.")) return true;
    if (!this.opts.userId) return false;
    return this.peers.get(address)?.userId === this.opts.userId;
  }

  // A trusted TimeZero that is on the network now.
  private timeZeroAddress(): string | null {
    const now = Date.now();
    for (const p of this.peers.values())
      if (
        now - p.lastSeen <= PEER_STALE_MS &&
        isTimeZero(p) &&
        this.isTrusted(p.address)
      )
        return p.address;
    return null;
  }

  // TimeZero's own count of live routes, layers included, from its sync
  // diagnostics page. null when there is no TimeZero or the page has changed.
  async liveRouteCount(): Promise<number | null> {
    const address = this.timeZeroAddress();
    if (!address) return null;
    try {
      const res = await this.request(address, "GET", `${API}/`);
      const m = /<td>Routes<\/td>\s*<td>(\d+)<\/td>/.exec(res.body);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  // ---- pulls and pushes ---------------------------------------------------

  private async withLock(
    address: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (this.busy || !this.started) return;
    this.busy = true;
    const id = encodeURIComponent(this.hostId);
    try {
      const lock = await this.request(
        address,
        "GET",
        `${API}/GetLock?NetworkID=${id}`,
      );
      if (lock.status !== 202) return; // busy; the next beacon retries
      try {
        if (this.started) await fn();
      } finally {
        await this.request(
          address,
          "GET",
          `${API}/ReleaseLock?NetworkID=${id}`,
        ).catch(() => {});
      }
    } catch (err) {
      this.opts.debug(`sync with ${address}: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private pullNavigation(address: string): Promise<void> {
    return this.withLock(address, async () => {
      const res = await this.request(address, "GET", `${API}/ActiveRoute`);
      if (res.status === 200)
        this.acceptNavigation(JSON.parse(res.body) as ActiveRouteDto);
    });
  }

  private pushNavigation(address: string): Promise<void> {
    return this.withLock(address, async () => {
      const dto = buildActiveRoute(
        this.state.navigation,
        this.state.routeTick,
        new Date(),
      );
      const res = await this.request(
        address,
        "POST",
        `${API}/ActiveRoute`,
        JSON.stringify(dto),
      );
      this.opts.debug(
        `pushed navigation tick ${dto.CurrentTick} to ${address}: ${res.status}`,
      );
    });
  }

  // A read only: unlike a pushed table, it changes nothing on TimeZero.
  private pullObjects(address: string): Promise<void> {
    return this.withLock(address, async () => {
      for (let page = 0; page < MAX_TABLE_PAGES; page++) {
        const res = await this.request(
          address,
          "GET",
          `${API}/UserObject?MinTick=${this.state.tzTableTick}&Limit=${TABLE_PAGE_SIZE}&CanUseLayers=False`,
        );
        if (res.status !== 200) return;
        const table = JSON.parse(res.body) as UserObjectTableDto;
        const before = this.state.tzTableTick;
        this.acceptObjects(table);
        if (table.RemainingToSync <= 0 || this.state.tzTableTick <= before)
          return;
      }
    });
  }

  private pullAnchor(address: string): Promise<void> {
    return this.withLock(address, async () => {
      const res = await this.request(address, "GET", `${API}/AnchorWatch`);
      if (res.status === 200)
        this.acceptAnchor(JSON.parse(res.body) as AnchorWatchDto);
    });
  }

  private pushAnchor(address: string): Promise<void> {
    return this.withLock(address, async () => {
      const dto = buildAnchorWatch(
        this.state.anchor,
        this.state.anchorTick,
        new Date(),
      );
      const res = await this.request(
        address,
        "POST",
        `${API}/AnchorWatch`,
        JSON.stringify(dto),
      );
      this.opts.debug(
        `pushed anchor tick ${dto.ChangeTick} to ${address}: ${res.status}`,
      );
    });
  }

  private acceptNavigation(dto: ActiveRouteDto): void {
    if (!(dto.CurrentTick > this.state.routeTick)) return;
    const firstSync = this.state.routeTick === 0;
    this.state.routeTick = dto.CurrentTick;
    const nav = parseActiveRoute(dto);
    // On first contact adopt TimeZero's tick, but don't let "no navigation"
    // cancel a course Signal K already had.
    if (firstSync && nav.kind === "none") {
      this.save();
      return;
    }
    this.state.navigation = nav;
    this.save();
    this.emit("navigation", nav);
  }

  private acceptAnchor(dto: AnchorWatchDto): void {
    if (!(dto.ChangeTick > this.state.anchorTick)) return;
    const firstSync = this.state.anchorTick === 0;
    this.state.anchorTick = dto.ChangeTick;
    const anchor = parseAnchorWatch(dto);
    if (firstSync && anchor === null) {
      this.save();
      return;
    }
    this.state.anchor = anchor;
    this.save();
    this.emit("anchor", anchor);
  }

  private acceptObjects(table: UserObjectTableDto): void {
    // A table is master data: continue from the master's tick once it is all
    // here, and from the last object received while pages are outstanding.
    const lastTick = Math.max(0, ...table.Objects.map((o) => o.Tick));
    this.state.tzTableTick = Math.max(
      this.state.tzTableTick,
      table.RemainingToSync > 0 ? lastTick : table.CurrentTick,
    );
    const objects: UserObject[] = [];
    const pulled: string[] = [];
    for (const dto of table.Objects) {
      // TimeZero sends an object it pulled from us straight back under its
      // own tick, in the same round: that is the confirmation it has it.
      if (this.state.offered[dto.Guid]) {
        delete this.state.offered[dto.Guid];
        pulled.push(dto.Guid);
      }
      try {
        objects.push(parseUserObject(dto));
      } catch (err) {
        this.opts.debug((err as Error).message);
      }
    }
    this.save();
    if (pulled.length) this.emit("pulled", pulled);
    if (objects.length) this.emit("objects", objects);
  }

  // Offered to TimeZero but not yet confirmed as pulled.
  isPending(guid: string): boolean {
    return guid in this.state.offered;
  }

  // The master asks for our objects above the tick it already has; anything
  // at or below it has been pulled.
  private serveObjects(minTick: number, limit: number): UserObjectTableDto {
    const pulled = Object.values(this.state.offered)
      .filter((o) => o.Tick <= minTick)
      .map((o) => o.Guid);
    for (const guid of pulled) delete this.state.offered[guid];
    if (pulled.length) {
      this.save();
      this.emit("pulled", pulled);
    }
    const newer = Object.values(this.state.offered)
      .filter((o) => o.Tick > minTick)
      .sort((a, b) => a.Tick - b.Tick);
    return {
      CurrentTick: this.servedTick,
      SyncTicks: "",
      RemainingToSync: Math.max(0, newer.length - limit),
      Objects: newer.slice(0, limit),
      Layers: [],
    };
  }

  // ---- the sync endpoint --------------------------------------------------

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (!this.isTrusted(remote)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://peer");
    const path = url.pathname.replace(/\/+$/, "");
    const json = (status: number, body: unknown) =>
      res
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify(body));

    readBody(req)
      .then((body) => {
        if (path === `${API}/GetLock`) {
          const who = url.searchParams.get("NetworkID");
          const free =
            !this.lockHolder ||
            this.lockHolder === who ||
            Date.now() - this.lockTakenAt > LOCK_TIMEOUT_MS;
          if (!free) return res.writeHead(409).end();
          this.lockHolder = who;
          this.lockTakenAt = Date.now();
          return res.writeHead(202).end();
        }
        if (path === `${API}/ReleaseLock`) {
          if (this.lockHolder === url.searchParams.get("NetworkID"))
            this.lockHolder = null;
          return res.writeHead(200).end();
        }
        if (path === `${API}/UserObject` && req.method === "GET") {
          const minTick = Number(url.searchParams.get("MinTick") ?? 0) || 0;
          const limit = Number(url.searchParams.get("Limit") ?? 5000) || 5000;
          return json(200, this.serveObjects(minTick, limit));
        }
        if (path === `${API}/UserObject` && req.method === "POST") {
          this.acceptObjects(JSON.parse(body) as UserObjectTableDto);
          return res.writeHead(201).end();
        }
        if (
          /\/(PlanningRoutePoint|LargeData)$/.test(path) &&
          req.method === "GET"
        )
          return json(200, {
            CurrentTick: this.servedTick,
            SyncTicks: "",
            RemainingToSync: 0,
            Objects: [],
            Layers: [],
          });
        if (path === `${API}/ActiveRoute` && req.method === "GET")
          return json(
            200,
            buildActiveRoute(
              this.state.navigation,
              this.state.routeTick,
              new Date(),
            ),
          );
        if (path === `${API}/ActiveRoute` && req.method === "POST") {
          this.acceptNavigation(JSON.parse(body) as ActiveRouteDto);
          return res.writeHead(201).end();
        }
        if (path === `${API}/AnchorWatch` && req.method === "GET")
          return json(
            200,
            buildAnchorWatch(
              this.state.anchor,
              this.state.anchorTick,
              new Date(),
            ),
          );
        if (path === `${API}/AnchorWatch` && req.method === "POST") {
          this.acceptAnchor(JSON.parse(body) as AnchorWatchDto);
          return res.writeHead(201).end();
        }
        if (path === `${API}/FishIt` && req.method === "GET")
          return json(
            200,
            this.state.fishIt ?? { ChangeTick: 0, Values: "NULL" },
          );
        if (path === `${API}/FishIt` && req.method === "POST") {
          this.state.fishIt = JSON.parse(body) as AnchorWatchDto;
          this.save();
          return res.writeHead(201).end();
        }
        // Schema posts and TimeZero's reachability probe (GET /).
        return res.writeHead(200).end();
      })
      .catch((err: Error) => {
        this.opts.debug(`request ${req.method} ${path}: ${err.message}`);
        if (!res.headersSent) res.writeHead(400).end();
      });
  }

  // ---- plumbing -----------------------------------------------------------

  request(
    address: string,
    method: string,
    path: string,
    body?: string,
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: address,
          port: COMMAND_PORT,
          path,
          method,
          timeout: REQUEST_TIMEOUT_MS,
          // TimeZero sends its own bodies as text/plain JSON.
          headers: body ? { "Content-Type": "text/plain; charset=utf-8" } : {},
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (data += c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: data }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end(body);
    });
  }

  private save(): void {
    try {
      saveState(this.opts.stateFile, this.state);
    } catch (err) {
      this.opts.error(`saving sync state: ${(err as Error).message}`);
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
