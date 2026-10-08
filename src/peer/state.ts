// Sync state that has to outlive a restart. The peer id keeps TimeZero from
// treating each restart as a new device (which re-sends every object and adds
// another entry to the sync records it shares with its other peers), and the
// ticks keep TimeZero's older state from overwriting ours after a restart.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type {
  Anchor,
  AnchorWatchDto,
  Navigation,
} from "../protocol/navigation.js";
import type { UserObjectDto } from "../protocol/userObject.js";

export interface PeerState {
  uuid: string;
  // How far we have TimeZero's routes and marks: its CurrentTick as of its
  // last push to us or our last read from it.
  tzTableTick: number;
  // The tick of our latest offer. Offers count on from the higher of the two,
  // so they are always above what TimeZero has already taken from us.
  offerTick: number;
  // Objects we offer TimeZero, until it has pulled them.
  offered: Record<string, UserObjectDto>;
  routeTick: number;
  navigation: Navigation;
  anchorTick: number;
  anchor: Anchor | null;
  // TimeZero's FishIt record, served back as is.
  fishIt: AnchorWatchDto | null;
}

export function freshState(): PeerState {
  return {
    uuid: randomUUID(),
    tzTableTick: 0,
    offerTick: 0,
    offered: {},
    routeTick: 0,
    navigation: { kind: "none" },
    anchorTick: 0,
    anchor: null,
    fishIt: null,
  };
}

export function loadState(file: string): PeerState {
  try {
    const saved = JSON.parse(
      fs.readFileSync(file, "utf8"),
    ) as Partial<PeerState>;
    return { ...freshState(), ...saved };
  } catch {
    return freshState();
  }
}

// Atomic write (tmp + rename) so a crash mid-write can't tear the file.
export function saveState(file: string, state: PeerState): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}
