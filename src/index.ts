// Signal K plugin: sync routes, waypoints, the active route and the anchor
// watch with TimeZero (TZ Professional / TZ iBoat) over TimeZero's LAN sync.

import path from "node:path";
import type { Delta, Plugin, ServerAPI } from "@signalk/server-api";
import { Type, type Static } from "typebox";
import { AnchorBridge } from "./bridge/anchor.js";
import { CourseBridge } from "./bridge/course.js";
import type { SyncedType } from "./bridge/mapping.js";
import { ResourcesBridge } from "./bridge/resources.js";
import { COMMAND_PORT, TimeZeroPeer } from "./peer/engine.js";

const ConfigSchema = Type.Object({
  hostName: Type.String({
    title: "Name shown in TimeZero",
    description:
      "The name this server uses in TimeZero's list of sync devices.",
    default: "SignalK",
  }),
  syncRoutes: Type.Boolean({ title: "Sync routes", default: true }),
  syncWaypoints: Type.Boolean({
    title: "Sync waypoints (TimeZero marks)",
    default: true,
  }),
  offerExisting: Type.Boolean({
    title: "Send existing Signal K routes and waypoints to TimeZero",
    description:
      "On start, offer TimeZero the routes and waypoints it has never had. When off, only ones created or edited while the plugin runs are sent.",
    default: true,
  }),
  maxRoutes: Type.Number({
    title: "TimeZero route limit",
    description:
      "On a Furuno NavNet, TimeZero keeps at most 200 routes and deletes the route modified longest ago to make room for a new one, on every device it syncs with. New Signal K routes are only sent while TimeZero has room. 0 turns the check off.",
    default: 200,
    minimum: 0,
  }),
  syncNavigation: Type.Boolean({
    title: "Sync the active route and go-to",
    default: true,
  }),
  syncAnchor: Type.Boolean({
    title: "Sync the anchor watch",
    description:
      "Needs an anchor alarm plugin that accepts PUT navigation.anchor.position, such as Hoeken's Anchor Alarm. Turn off its own TimeZero sync: only one plugin can talk to TimeZero.",
    default: true,
  }),
  userId: Type.String({
    title: "My TIMEZERO user ID (off NavNet only)",
    description:
      "Leave blank on a Furuno NavNet (172.31.x.x) network. On an ordinary LAN, TimeZero only syncs with peers that advertise the same My TIMEZERO user ID (a GUID).",
    default: "",
  }),
});
type Config = Static<typeof ConfigSchema>;

const ANCHOR_PATHS = /^navigation\.anchor\.(position|maxRadius)$/;
// calcValues update every second from course-provider; only the course itself counts.
const COURSE_PATHS =
  /^navigation\.course\.(nextPoint|previousPoint|activeRoute)(\.|$)/;
const RESOURCE_PATH = /^resources\.(routes|waypoints)\.(.+)$/;

export default function (app: ServerAPI): Plugin {
  let peer: TimeZeroPeer | null = null;
  let resources: ResourcesBridge | null = null;
  let course: CourseBridge | null = null;
  let anchor: AnchorBridge | null = null;
  let deltaHandlerRegistered = false;

  // Handlers cannot be unregistered, so register once and look at whichever
  // bridges are running.
  const onDelta = (delta: Delta): void => {
    if (!peer) return;
    if (
      delta.context &&
      delta.context !== "vessels.self" &&
      delta.context !== app.selfContext
    )
      return;
    for (const update of delta.updates ?? []) {
      if (!("values" in update)) continue;
      for (const pv of update.values ?? []) {
        // A stale-data timeout is not a change made by anyone.
        if ((pv as { state?: { timedOut?: boolean } }).state?.timedOut)
          continue;
        const p = String(pv.path);
        const res = RESOURCE_PATH.exec(p);
        if (res && resources)
          resources.onResourceDelta(res[1] as SyncedType, res[2]!, pv.value);
        else if (COURSE_PATHS.test(p)) course?.onCourseDelta();
        else if (ANCHOR_PATHS.test(p)) anchor?.onAnchorDelta();
      }
    }
  };

  const plugin: Plugin = {
    id: "signalk-timezero-sync",
    name: "TimeZero Sync",
    description:
      "Sync routes, waypoints, the active route and the anchor watch with TimeZero over its LAN sync.",
    schema: () => ConfigSchema,

    start(options: object) {
      const config = options as Config;
      const dataDir = app.getDataDirPath();
      peer = new TimeZeroPeer({
        hostName: config.hostName || "SignalK",
        userId: (config.userId ?? "").trim(),
        stateFile: path.join(dataDir, "peer.json"),
        debug: (msg) => app.debug(msg),
        error: (msg) => app.error(msg),
      });
      const types: SyncedType[] = [];
      if (config.syncRoutes !== false) types.push("routes");
      if (config.syncWaypoints !== false) types.push("waypoints");
      if (types.length)
        resources = new ResourcesBridge(app, peer, {
          types,
          stateFile: path.join(dataDir, "resources.json"),
          offerExisting: config.offerExisting !== false,
          maxRoutes: config.maxRoutes ?? 200,
        });
      if (config.syncNavigation !== false) course = new CourseBridge(app, peer);
      if (config.syncAnchor !== false) anchor = new AnchorBridge(app, peer);

      if (!deltaHandlerRegistered) {
        deltaHandlerRegistered = true;
        app.registerDeltaInputHandler((delta, next) => {
          try {
            onDelta(delta);
          } catch (err) {
            app.error(`TimeZero sync: ${(err as Error).message}`);
          }
          next(delta);
        });
      }

      const running = peer;
      running
        .start()
        .then(() => {
          app.setPluginStatus(`Syncing as ${running.hostId.split("/")[0]}`);
        })
        .catch((err: NodeJS.ErrnoException) => {
          const message =
            err.code === "EADDRINUSE"
              ? `TimeZero sync port ${COMMAND_PORT} is in use. Turn off "Sync Anchor with TimeZero" in Hoeken's Anchor Alarm: only one plugin can talk to TimeZero.`
              : `Could not start TimeZero sync: ${err.message}`;
          app.setPluginError(message);
          plugin.stop();
        });
    },

    stop() {
      resources?.stop();
      course?.stop();
      anchor?.stop();
      peer?.stop();
      peer = null;
      resources = null;
      course = null;
      anchor = null;
    },
  };
  return plugin;
}
