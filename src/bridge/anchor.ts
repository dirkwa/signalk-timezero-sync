// Keeps the Signal K anchor and TimeZero's anchor watch in step, through the
// standard paths any anchor alarm plugin uses: the anchor position and radius
// it publishes, and the PUT handler it registers on navigation.anchor.position
// (a position with a radius drops the anchor, null raises it).

import type { ServerAPI } from "@signalk/server-api";
import type { TimeZeroPeer } from "../peer/engine.js";
import type { Anchor } from "../protocol/navigation.js";

const CHANGE_SETTLE_MS = 1000;
// TimeZero stores the centre to the centimetre and the radius to 1 cm.
const SAME_POSITION_DEGREES = 1e-6;
const SAME_RADIUS_METERS = 0.01;

export function sameAnchor(a: Anchor | null, b: Anchor | null): boolean {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.position.latitude - b.position.latitude) <
      SAME_POSITION_DEGREES &&
    Math.abs(a.position.longitude - b.position.longitude) <
      SAME_POSITION_DEGREES &&
    Math.abs(a.radius - b.radius) < SAME_RADIUS_METERS
  );
}

interface Position {
  latitude: number;
  longitude: number;
}

const isPosition = (v: unknown): v is Position =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Position).latitude === "number" &&
  typeof (v as Position).longitude === "number";

export class AnchorBridge {
  private settleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly app: ServerAPI,
    private readonly peer: TimeZeroPeer,
  ) {
    peer.on("anchor", (anchor) => this.fromTimeZero(anchor));
  }

  stop(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  fromTimeZero(anchor: Anchor | null): void {
    const value = anchor
      ? {
          latitude: anchor.position.latitude,
          longitude: anchor.position.longitude,
          radius: anchor.radius,
        }
      : null;
    this.app
      .putSelfPath("navigation.anchor.position", value, () => {})
      .then((reply) => {
        const r = reply as
          { state?: string; statusCode?: number; message?: string } | undefined;
        if (r?.state === "FAILED" || (r?.statusCode ?? 200) >= 400)
          this.app.error(
            `applying TimeZero anchor: ${r?.message ?? r?.statusCode}. Is an anchor alarm plugin installed?`,
          );
      })
      .catch((err: Error) =>
        this.app.error(`applying TimeZero anchor: ${err.message}`),
      );
  }

  // Called for every navigation.anchor delta; the anchor plugin emits several
  // per drop or raise, so let them settle.
  onAnchorDelta(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.fromSignalK(), CHANGE_SETTLE_MS);
  }

  fromSignalK(): void {
    this.settleTimer = null;
    const position = this.app.getSelfPath("navigation.anchor.position.value");
    const radius = this.app.getSelfPath("navigation.anchor.maxRadius.value");
    let anchor: Anchor | null = null;
    if (isPosition(position)) {
      // TimeZero's anchor watch is a circle; an anchor without one (a polygon
      // or sector zone) cannot be shown there, so leave TimeZero alone.
      if (typeof radius !== "number") return;
      anchor = {
        position: {
          latitude: position.latitude,
          longitude: position.longitude,
        },
        radius,
      };
    }
    if (sameAnchor(anchor, this.peer.anchor)) return;
    this.peer.setAnchor(anchor);
  }
}
