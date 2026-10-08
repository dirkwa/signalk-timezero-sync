// Geometry, time and identifier encodings used by TimeZero's LAN sync.
//
// Positions travel in true ellipsoidal WGS84 Mercator metres, stored as
// big-endian int32 centimetres in a typed blob. Using spherical Web Mercator
// instead puts positions tens of kilometres off away from the equator.

export interface LatLon {
  latitude: number;
  longitude: number;
}

const WGS84_A = 6378137.0; // semi-major axis, metres
const WGS84_E = 0.0818191908426; // first eccentricity
const MAX_LATITUDE = 85.05112878;

const BLOB_POINT = 0x00;
const BLOB_POLYLINE = 0x02;
const BLOB_CIRCLE = 0x04;
const COORD_BYTES = 8;

export function toMercator(position: LatLon): { x: number; y: number } {
  const lat = Math.max(
    -MAX_LATITUDE,
    Math.min(MAX_LATITUDE, position.latitude),
  );
  const latRad = (lat * Math.PI) / 180;
  const esin = WGS84_E * Math.sin(latRad);
  return {
    x: WGS84_A * ((position.longitude * Math.PI) / 180),
    y:
      WGS84_A *
      Math.log(
        Math.tan(Math.PI / 4 + latRad / 2) *
          Math.pow((1 - esin) / (1 + esin), WGS84_E / 2),
      ),
  };
}

// The inverse latitude has no closed form; ten iterations converge to well
// under a millimetre.
export function fromMercator(x: number, y: number): LatLon {
  const t = Math.exp(-y / WGS84_A);
  let phi = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 10; i++) {
    const esin = WGS84_E * Math.sin(phi);
    phi =
      Math.PI / 2 -
      2 * Math.atan(t * Math.pow((1 - esin) / (1 + esin), WGS84_E / 2));
  }
  return {
    latitude: (phi * 180) / Math.PI,
    longitude: (x / WGS84_A) * (180 / Math.PI),
  };
}

function writeCoord(buf: Buffer, offset: number, position: LatLon): void {
  const { x, y } = toMercator(position);
  buf.writeInt32BE(Math.round(x * 100), offset);
  buf.writeInt32BE(Math.round(y * 100), offset + 4);
}

function readCoord(buf: Buffer, offset: number): LatLon {
  return fromMercator(
    buf.readInt32BE(offset) / 100,
    buf.readInt32BE(offset + 4) / 100,
  );
}

export function encodePoint(position: LatLon): Buffer {
  const buf = Buffer.alloc(1 + COORD_BYTES);
  buf.writeUInt8(BLOB_POINT, 0);
  writeCoord(buf, 1, position);
  return buf;
}

export function encodePolyline(points: LatLon[]): Buffer {
  const buf = Buffer.alloc(1 + COORD_BYTES * points.length);
  buf.writeUInt8(BLOB_POLYLINE, 0);
  points.forEach((p, i) => writeCoord(buf, 1 + COORD_BYTES * i, p));
  return buf;
}

export function encodeCircle(centre: LatLon, radiusMeters: number): Buffer {
  const buf = Buffer.alloc(1 + COORD_BYTES + 4);
  buf.writeUInt8(BLOB_CIRCLE, 0);
  writeCoord(buf, 1, centre);
  buf.writeInt32BE(Math.round(radiusMeters * 100), 1 + COORD_BYTES);
  return buf;
}

export function decodePoint(buf: Buffer | null): LatLon | null {
  if (!buf || buf.length < 1 + COORD_BYTES || buf.readUInt8(0) !== BLOB_POINT)
    return null;
  return readCoord(buf, 1);
}

export function decodePolyline(buf: Buffer | null): LatLon[] | null {
  if (!buf || buf.length < 1 || buf.readUInt8(0) !== BLOB_POLYLINE) return null;
  if ((buf.length - 1) % COORD_BYTES !== 0) return null;
  const points: LatLon[] = [];
  for (let offset = 1; offset < buf.length; offset += COORD_BYTES)
    points.push(readCoord(buf, offset));
  return points;
}

export function decodeCircle(
  buf: Buffer | null,
): { centre: LatLon; radius: number } | null {
  if (
    !buf ||
    buf.length < 1 + COORD_BYTES + 4 ||
    buf.readUInt8(0) !== BLOB_CIRCLE
  )
    return null;
  return {
    centre: readCoord(buf, 1),
    radius: buf.readInt32BE(1 + COORD_BYTES) / 100,
  };
}

// TimeZero timestamps count seconds from 2000-01-01T00:00:00Z. Confirmed on a
// live TZ Professional: its route "Rte 2025-01-28" has CreationDate 791320587.
const TZ_EPOCH_UNIX = 946684800;

export function toTzTime(date: Date): number {
  return Math.round(date.getTime() / 1000) - TZ_EPOCH_UNIX;
}

export function fromTzTime(seconds: number): Date {
  return new Date((seconds + TZ_EPOCH_UNIX) * 1000);
}

// GUID-valued columns carry .NET Guid.ToByteArray() order: the first three
// groups are little-endian, the last two as written.
export function guidToBytes(guid: string): Buffer {
  const b = Buffer.from(guid.replace(/-/g, ""), "hex");
  if (b.length !== 16) throw new Error(`not a GUID: ${guid}`);
  return Buffer.concat([
    Buffer.from(b.subarray(0, 4)).reverse(),
    Buffer.from(b.subarray(4, 6)).reverse(),
    Buffer.from(b.subarray(6, 8)).reverse(),
    b.subarray(8),
  ]);
}

export function guidFromBytes(bytes: Buffer): string | null {
  if (bytes.length !== 16) return null;
  const hex = Buffer.concat([
    Buffer.from(bytes.subarray(0, 4)).reverse(),
    Buffer.from(bytes.subarray(4, 6)).reverse(),
    Buffer.from(bytes.subarray(6, 8)).reverse(),
    bytes.subarray(8),
  ]).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
