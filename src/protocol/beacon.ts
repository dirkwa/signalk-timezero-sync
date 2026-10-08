// The UDP discovery beacon every TimeZero sync peer broadcasts once a second
// on port 33000. Fields are semicolon-separated; the meaning of each was
// matched against TimeZero's own sync diagnostics page (/LanSynchronizationApi/).

export const PROTOCOL = "TZ Sync 1.0";
// A device type TimeZero accepts as a sync peer.
export const DEVICE_TYPE = "TZ iBoat";

const F = {
  protocol: 0,
  name: 1,
  deviceType: 2,
  layersToken: 3,
  userId: 4,
  cloud: 5,
  hostId: 6, // "<name>/<uuid>"
  age: 7,
  visibleHosts: 8,
  version: 9,
  tableTick: 10, // UserObject CurrentTick
  routeTick: 11, // ActiveRoute CurrentTick
  reserved12: 12,
  fishItTick: 13,
  anchorTick: 14, // AnchorWatch ChangeTick
  largeDataHash: 15,
  hash: 16,
} as const;
const FIELD_COUNT = 17;

export interface Beacon {
  name: string;
  deviceType: string;
  userId: string;
  uuid: string;
  visibleHosts: number;
  tableTick: number;
  routeTick: number;
  fishItTick: number;
  anchorTick: number;
}

export interface Peer extends Beacon {
  address: string;
  lastSeen: number;
}

// Age (field 7) is opaque; this is the value the plugin has always sent and
// TimeZero accepts.
const AGE = "10000000";

export function buildBeacon(b: Omit<Beacon, "deviceType">): string {
  const f = new Array<string>(FIELD_COUNT).fill("0");
  f[F.protocol] = PROTOCOL;
  f[F.name] = b.name;
  f[F.deviceType] = DEVICE_TYPE;
  f[F.layersToken] = "";
  f[F.userId] = b.userId;
  f[F.cloud] = "";
  f[F.hostId] = `${b.name}/${b.uuid}`;
  f[F.age] = AGE;
  f[F.visibleHosts] = String(b.visibleHosts);
  f[F.tableTick] = String(b.tableTick);
  f[F.routeTick] = String(b.routeTick);
  f[F.fishItTick] = String(b.fishItTick);
  f[F.anchorTick] = String(b.anchorTick);
  return f.join(";");
}

const int = (s: string | undefined): number => {
  const n = parseInt(s ?? "", 10);
  return Number.isFinite(n) ? n : 0;
};

export function parseBeacon(message: string): Beacon | null {
  if (!message.startsWith(PROTOCOL + ";")) return null;
  const f = message.split(";");
  if (f.length <= F.anchorTick) return null;
  const hostId = f[F.hostId] ?? "";
  return {
    name: f[F.name] ?? "",
    deviceType: f[F.deviceType] ?? "",
    userId: f[F.userId] ?? "",
    uuid: hostId.slice(hostId.indexOf("/") + 1),
    visibleHosts: int(f[F.visibleHosts]),
    tableTick: int(f[F.tableTick]),
    routeTick: int(f[F.routeTick]),
    fishItTick: int(f[F.fishItTick]),
    anchorTick: int(f[F.anchorTick]),
  };
}

// A real TimeZero instance, as opposed to another plugin or an unrelated host.
export const isTimeZero = (b: Beacon): boolean =>
  b.deviceType.startsWith("TZ") && b.visibleHosts > 0;
