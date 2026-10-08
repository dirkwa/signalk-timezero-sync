// Tests feed beacons from real NavNet addresses, and a pull or push goes to
// port 32000 on whatever address a beacon came from. On a boat that is a live
// chartplotter, so no request leaves the process unless a test stubs it.
import { TimeZeroPeer } from "../src/peer/engine.js";

TimeZeroPeer.prototype.request = () =>
  Promise.reject(new Error("network access is disabled in tests"));
