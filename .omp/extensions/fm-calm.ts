// Firstmate's home-persistent omp (Oh My Pi) transcript presentation toggle.
//
// Verified against omp 18.1.16, which exposes `pi.registerCommand`, `session_start`,
// `agent_start`/`agent_end`, `ExtensionUIContext.setStatus()`, `ExtensionAPI.pi` (the
// host package's own exports), and isolated managed timers on the handler context.
// omp is a Pi fork, so `/calm` means the same thing here as in `.pi/extensions/fm-calm.ts`
// and reads and writes the same per-home preference; but its UI context has no
// `setWorkingVisible` and no `setHiddenThinkingLabel`, its `notify()` leaves its line
// standing in the transcript flow rather than expiring, and it ships no built-in
// `ToolDefinition` factories, so every row Calm presents is reached through a host
// presentation seam instead. ./lib/fm-calm-omp-layout.ts owns those seams; this file
// owns the preference, the command, the toggle's answer, and the working animation's
// lifetime.
//
// The presentation adapters probe the exact host method they patch when Calm loads. If
// a future omp removes one, Calm logs a diagnostic naming the unavailable adapter and
// skips only that adapter; `/calm`, the other adapters, and unrelated omp extensions
// remain available.
//
// docs/calm.md owns the captain-facing contract and its omp bounds, and
// docs/configuration.md owns the persisted preference schema.
//
// The omp extension API surface this file uses, declared locally: omp ships no
// separately installable type package and is a Pi fork whose event names match where
// they are used here.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  calmPreferencePath as resolveCalmPreferencePath,
  readCalmPreference,
  writeCalmPreference,
} from "../../.pi/extensions/lib/fm-calm-preference.ts";
import {
  calmPresentationIsActive,
  setCalmPresentation,
} from "../../.pi/extensions/lib/fm-calm-visibility.ts";
import {
  CALM_WORKING_SHIP_TICK_MS,
  createCalmWorkingShipAnimation,
} from "../../.pi/extensions/lib/fm-calm-working-ship.ts";
import {
  calmOmpRedrawTranscript,
  calmOmpRequestRender,
  calmOmpWorkingRowIsMounted,
  installCalmOmpAssistantLayout,
  installCalmOmpOperationalUserLayout,
  installCalmOmpToolRowLayout,
  installCalmOmpWorkingShip,
  reconcileCalmOmpAssistantRows,
  resetCalmOmpLayout,
  setCalmOmpWorkingShipFrame,
  type CalmOmpBranchEntry,
  type OmpHostExports,
} from "./lib/fm-calm-omp-layout.ts";

/** One omp managed-timer handle; only passed back to `clearTimer`. */
type ManagedTimer = unknown;

type ExtensionUIContext = {
  /** A keyed line above the editor, removed again by passing `undefined`. */
  setStatus(key: string, text: string | undefined): void;
};

type ExtensionContext = {
  ui: ExtensionUIContext;
  hasUI?: boolean;
  sessionManager?: { getBranch(): readonly CalmOmpBranchEntry[] };
  // omp runs extensions in-process with no isolation, so a raw timer callback that
  // throws is a process-level uncaught exception that tears the whole session down.
  // These managed timers contain a throw and are cleared on session shutdown.
  setInterval(handler: () => void, ms: number): ManagedTimer;
  setTimeout(handler: () => void, ms: number): ManagedTimer;
  clearTimer(timer: ManagedTimer): void;
};

type ExtensionAPI = {
  pi: OmpHostExports;
  on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
  registerCommand(
    name: string,
    definition: {
      description: string;
      handler: (args: string, ctx: ExtensionContext) => unknown;
    },
  ): void;
};

const extensionFile = fileURLToPath(import.meta.url);
const root = resolve(dirname(extensionFile), "../..");

/** Calm's own status key, and how long its answer stays on the line above the editor. */
const CALM_NOTICE_KEY = "firstmate-calm";
const CALM_NOTICE_MS = 4000;

// Each presentation adapter probes the exact omp API it patches. If a future omp
// removes that API, only the affected adapter degrades; the rest of Calm keeps working.
function installCalmPresentationAdapter(name: string, install: () => void): void {
  try {
    install();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Firstmate Calm: ${name} presentation adapter unavailable, skipping. ${reason}`);
  }
}

export default function (pi: ExtensionAPI) {
  installCalmPresentationAdapter("tool-row", () => installCalmOmpToolRowLayout(pi.pi));
  installCalmPresentationAdapter("operational-user-row", () =>
    installCalmOmpOperationalUserLayout(pi.pi),
  );
  installCalmPresentationAdapter("assistant-working-note", () =>
    installCalmOmpAssistantLayout(pi.pi),
  );
  installCalmPresentationAdapter("working-ship", () => installCalmOmpWorkingShip(pi.pi));

  // ../../.pi/extensions/lib/fm-calm-preference.ts owns the shared file, its home
  // resolution, its value schema, and its atomic write, so omp and Pi cannot drift.
  const calmPreferencePath = resolveCalmPreferencePath(root);

  // One animation instance per extension lifetime, exactly as on Pi: hiding the working
  // row freezes it and the next working period resumes from that logical state, while a
  // fresh session resets it to the normal initial position. Never module-global.
  const workingShipAnimation = createCalmWorkingShipAnimation();
  setCalmOmpWorkingShipFrame((width) => workingShipAnimation.render(width));

  // The boat's own cadence. omp repaints its working row on the stock spinner's
  // schedule, which is not the sprite's, so Calm advances the sprite here and asks omp
  // to repaint. The timer runs only while a run is under way and Calm is on, and stands
  // down by itself once omp has taken the working row down.
  let shipTicker: ManagedTimer | undefined;
  const stopShipTicker = (ctx: ExtensionContext): void => {
    if (shipTicker === undefined) return;
    ctx.clearTimer(shipTicker);
    shipTicker = undefined;
  };
  const applyWorkingPresentation = (ctx: ExtensionContext, running: boolean): void => {
    if (!running || !calmPresentationIsActive()) {
      stopShipTicker(ctx);
      calmOmpRequestRender();
      return;
    }
    if (shipTicker !== undefined) return;
    shipTicker = ctx.setInterval(() => {
      if (!calmPresentationIsActive() || !calmOmpWorkingRowIsMounted()) {
        stopShipTicker(ctx);
        return;
      }
      workingShipAnimation.tick();
      calmOmpRequestRender();
    }, CALM_WORKING_SHIP_TICK_MS);
  };

  // The toggle's answer. omp's notify() leaves its line standing in the transcript flow,
  // so Calm answers on the keyed status line above the editor and clears that key again,
  // which removes the line and leaves no transcript row behind.
  let noticeTimer: ManagedTimer | undefined;
  const answerTransiently = (ctx: ExtensionContext, notice: string): void => {
    if (noticeTimer !== undefined) {
      ctx.clearTimer(noticeTimer);
      noticeTimer = undefined;
    }
    ctx.ui.setStatus(CALM_NOTICE_KEY, notice);
    noticeTimer = ctx.setTimeout(() => {
      noticeTimer = undefined;
      ctx.ui.setStatus(CALM_NOTICE_KEY, undefined);
    }, CALM_NOTICE_MS);
  };

  let agentRunActive = false;

  // The session's own messages are the only place the shared mid-turn rule can be
  // answered, so every point where the branch gains a settled assistant message
  // reclassifies its row. session_start covers a resumed transcript's restored rows.
  const reconcileAssistantRows = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager?.getBranch();
    if (branch) reconcileCalmOmpAssistantRows(branch);
  };

  pi.on("session_start", (_event, ctx) => {
    resetCalmOmpLayout();
    agentRunActive = false;
    stopShipTicker(ctx);
    // A genuine new session lifetime starts the boat at the normal initial position.
    workingShipAnimation.reset();
    setCalmPresentation(readCalmPreference(calmPreferencePath));
    reconcileAssistantRows(ctx);
  });

  // A resumed transcript can restore its rows before this extension has seen the live
  // mode, so the first run of the session reclassifies them once more.
  pi.on("agent_start", (_event, ctx) => {
    agentRunActive = true;
    applyWorkingPresentation(ctx, true);
    reconcileAssistantRows(ctx);
  });

  pi.on("message_end", (_event, ctx) => reconcileAssistantRows(ctx));

  pi.on("agent_end", (_event, ctx) => {
    agentRunActive = false;
    applyWorkingPresentation(ctx, false);
    reconcileAssistantRows(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    agentRunActive = false;
    stopShipTicker(ctx);
  });

  pi.registerCommand("calm", {
    description: "Toggle Firstmate's supported conversation-only transcript presentation.",
    handler: (_args, ctx) => {
      const active = !calmPresentationIsActive();
      // Persist before changing live presentation, so a failed write leaves the current
      // choice unchanged rather than claiming a persistence that did not happen.
      try {
        writeCalmPreference(calmPreferencePath, active);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        answerTransiently(ctx, `Calm unchanged: could not save ${calmPreferencePath} (${reason})`);
        return;
      }
      setCalmPresentation(active);
      applyWorkingPresentation(ctx, agentRunActive);
      // Every adapter reads Calm when it draws, so redrawing the live rows is what makes
      // a toggle apply to what is already on screen.
      calmOmpRedrawTranscript();
      answerTransiently(ctx, active ? "Calm on" : "Calm off");
    },
  });
}
