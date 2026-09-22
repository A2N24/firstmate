// Firstmate Calm's omp (Oh My Pi) presentation adapters.
//
// Verified against omp 18.1.16. omp is a Pi fork, and its extension API keeps Pi's
// registration surface, but its `ExtensionUIContext` has no `setWorkingVisible` and no
// `setHiddenThinkingLabel`, and it exposes no built-in `ToolDefinition` factories, so
// Calm cannot reach omp's rows the way `.pi/extensions/fm-calm.ts` reaches Pi's. What
// omp does expose is `ExtensionAPI.pi`, the host package's own exports, which is where
// every seam below comes from. Each adapter patches exactly one host presentation
// method, and every decision it applies comes from a shared owner:
// `.pi/extensions/lib/fm-calm-visibility.ts` for which class Calm hides,
// `.pi/extensions/lib/fm-operational-input.ts` for whether a user row is Firstmate
// operational input, `.pi/extensions/lib/fm-calm-row-policy.ts` for whether an
// assistant message is mid-turn, and
// `.claude/mods/firstmate-calm/lib/fm-calm-preservation.ts` for the mid-turn text rule.
//
// Each installer probes the exact method it patches and throws when it is gone, so
// `../fm-calm.ts` skips only that adapter with a diagnostic and leaves `/calm`, the
// other adapters, and unrelated omp extensions working.
//
// Nothing here rewrites a message. Every hidden row keeps its content in the message,
// the model context, session storage, and exports; only the drawn height changes. Tool
// execution, input delivery, and diagnostics are untouched.
import { calmTextIsSubstantive } from "../../../.claude/mods/firstmate-calm/lib/fm-calm-preservation.ts";
import { isFirstmateOperationalPresentationText } from "../../../.pi/extensions/lib/fm-operational-input.ts";
import { calmAssistantMessageIsMidTurn } from "../../../.pi/extensions/lib/fm-calm-row-policy.ts";
import {
  calmPresentationHides,
  calmPresentationIsActive,
} from "../../../.pi/extensions/lib/fm-calm-visibility.ts";

/** A zero-height drawing, kept as one stable reference so omp's row memoization holds. */
const HIDDEN_ROWS: readonly string[] = Object.freeze([]);

/** Marks a component whose drawing this module already owns, so a reload cannot stack wrappers. */
const CALM_HIDDEN_ROW = Symbol.for("firstmate:calm-omp-hidden-row");
const CALM_WORKING_SHIP_ROW = Symbol.for("firstmate:calm-omp-working-ship-row");
/**
 * Carries the unfiltered assistant message on the presentation copy handed to omp. omp
 * keeps that copy and replays it through `updateContent` on every `invalidate()`, so
 * recovering the original here is what lets a Calm toggle restore hidden text.
 */
const CALM_ORIGINAL_MESSAGE = Symbol.for("firstmate:calm-omp-original-assistant-message");

const CALM_TOOL_ROW_PATCH = Symbol.for("firstmate:calm-omp-tool-row:omp-18.1.16");
const CALM_OPERATIONAL_USER_PATCH = Symbol.for("firstmate:calm-omp-operational-user:omp-18.1.16");
const CALM_ASSISTANT_PATCH = Symbol.for("firstmate:calm-omp-assistant:omp-18.1.16");
const CALM_WORKING_SHIP_PATCH = Symbol.for("firstmate:calm-omp-working-ship:omp-18.1.16");

/** The host package exports, as omp hands them to an extension through `ExtensionAPI.pi`. */
export type OmpHostExports = Record<string, unknown>;

type RowComponent = {
  render(width: number): readonly string[];
  invalidate?(): void;
};

type RowContainer = {
  children?: unknown;
  invalidate?(): void;
};

/**
 * The public fields of omp's live `InteractiveMode` this module reads. It is captured
 * from the patched prototype methods below rather than requested from the extension
 * context, which never exposes the mode object.
 */
type InteractiveModeLike = {
  chatContainer?: RowContainer;
  statusContainer?: RowContainer;
  loadingAnimation?: RowComponent;
  ui?: { requestRender?(): void };
  getUserMessageText?(message: unknown): string;
  transcriptMessageComponents?: { get(message: object): unknown };
};

type UserMessageLike = {
  role?: unknown;
  content?: unknown;
};

// Structurally a CalmAssistantMessageShape, with the text blocks this module filters.
type AssistantMessageLike = {
  readonly role?: unknown;
  readonly stopReason?: string | null;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
};

let liveMode: InteractiveModeLike | undefined;

/** Draw one boat frame for this width, installed by ../fm-calm.ts while Calm is on. */
let shipFrame: ((width: number) => readonly string[]) | undefined;

/**
 * The assistant rows whose message settled as mid-turn. omp hands its transcript
 * component a display slice with no tool calls and a plain `stop` reason, so the row
 * itself cannot answer the shared mid-turn question; the session's own message can, and
 * `reconcileCalmOmpAssistantRows` below is what carries that answer to the row.
 */
const midTurnAssistantRows = new WeakSet<object>();

const globalPatches = globalThis as typeof globalThis & {
  [key: symbol]: boolean | undefined;
};

/**
 * The prototype of one host class, or a named failure the caller reports as an
 * unavailable adapter. Nothing is patched before every seam this adapter needs exists.
 */
function hostPrototype(host: OmpHostExports, name: string): Record<string, unknown> {
  const constructor = host[name];
  if (typeof constructor !== "function") {
    throw new Error(`Firstmate Calm requires omp's ${name} export`);
  }
  const prototype = (constructor as { prototype?: unknown }).prototype;
  if (typeof prototype !== "object" || prototype === null) {
    throw new Error(`Firstmate Calm requires omp's ${name} prototype`);
  }
  return prototype as Record<string, unknown>;
}

function hostMethod(
  prototype: Record<string, unknown>,
  owner: string,
  name: string,
): (...args: never[]) => unknown {
  const method = prototype[name];
  if (typeof method !== "function") {
    throw new Error(`Firstmate Calm requires omp's ${owner}.${name}`);
  }
  return method as (...args: never[]) => unknown;
}

/**
 * Replace one component's own drawing, keeping the prototype drawing for when Calm is
 * off. The wrapper is an own property, so it binds this row alone and every other row
 * of the same class is untouched.
 */
function overrideRowDrawing(
  component: RowComponent,
  marker: symbol,
  draw: (stock: (width: number) => readonly string[], width: number) => readonly string[],
): void {
  if (typeof component?.render !== "function") return;
  if (Object.prototype.hasOwnProperty.call(component, marker)) return;
  const stock = component.render.bind(component);
  Object.defineProperty(component, marker, { value: true, configurable: true });
  Object.defineProperty(component, "render", {
    value: (width: number) => draw(stock, width),
    configurable: true,
    writable: true,
  });
}

/**
 * Hide every tool call, tool result, and folded read group while Calm is on.
 *
 * omp draws a tool call and its result as one `ToolExecutionComponent`, and folds
 * repeated reads into a `ReadToolGroupComponent`. Both already return no rows on their
 * own zero-allocation path, so the transcript container handles a zero-height tool
 * block natively. Because the decision is read at draw time, a toggle applies to rows
 * already on screen without touching what omp stored.
 */
export function installCalmOmpToolRowLayout(host: OmpHostExports): void {
  const seams = ["ToolExecutionComponent", "ReadToolGroupComponent"].map((name) => {
    const prototype = hostPrototype(host, name);
    return { name, prototype, render: hostMethod(prototype, name, "render") };
  });
  if (globalPatches[CALM_TOOL_ROW_PATCH]) return;
  for (const seam of seams) {
    seam.prototype.render = function (this: RowComponent, width: number): readonly string[] {
      if (calmPresentationHides("assistant-tool-call") && calmPresentationHides("tool-result")) {
        return HIDDEN_ROWS;
      }
      return seam.render.call(this as never, width as never) as readonly string[];
    };
  }
  globalPatches[CALM_TOOL_ROW_PATCH] = true;
}

/**
 * Draw a Firstmate operational user row at zero height while Calm is on.
 *
 * omp builds the row inside `InteractiveMode.addMessageToChat` through a private
 * presenter, so the component cannot be constructed here the way the Pi adapter
 * constructs it. The rows that one call appends to the public transcript container are
 * this row and its spacer, so the adapter lets omp build them and then takes over their
 * drawing. A user row the canonical classifier does not recognize is never touched.
 */
export function installCalmOmpOperationalUserLayout(host: OmpHostExports): void {
  const prototype = hostPrototype(host, "InteractiveMode");
  const addMessageToChat = hostMethod(prototype, "InteractiveMode", "addMessageToChat");
  hostMethod(prototype, "InteractiveMode", "getUserMessageText");
  if (globalPatches[CALM_OPERATIONAL_USER_PATCH]) return;

  prototype.addMessageToChat = function (
    this: InteractiveModeLike,
    message: UserMessageLike,
    options?: unknown,
  ): unknown {
    liveMode = this;
    const children = this.chatContainer?.children;
    if (
      message?.role !== "user" ||
      !contentIsTextOnly(message.content) ||
      !Array.isArray(children) ||
      typeof this.getUserMessageText !== "function"
    ) {
      return addMessageToChat.call(this as never, message as never, options as never);
    }
    const text = this.getUserMessageText(message);
    if (!text || !isFirstmateOperationalPresentationText(text)) {
      return addMessageToChat.call(this as never, message as never, options as never);
    }
    const before = children.length;
    const result = addMessageToChat.call(this as never, message as never, options as never);
    for (const appended of children.slice(before) as RowComponent[]) {
      overrideRowDrawing(appended, CALM_HIDDEN_ROW, (stock, width) =>
        calmPresentationHides("synthetic-user") ? HIDDEN_ROWS : stock(width),
      );
    }
    return result;
  };
  globalPatches[CALM_OPERATIONAL_USER_PATCH] = true;
}

/** Whether a message's content is text only, so its whole row is the text this adapter read. */
function contentIsTextOnly(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => {
    if (typeof block !== "object" || block === null) return false;
    if (!("type" in block) || !("text" in block)) return false;
    return block.type === "text" && typeof block.text === "string";
  });
}

/**
 * The unfiltered message a presentation copy carries, when omp is replaying one. The
 * symbol is this module's own, so its presence is proof the value came from the filter
 * below rather than from omp.
 */
function carriedOriginalMessage(
  message: AssistantMessageLike | undefined,
): AssistantMessageLike | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const carried = Object.getOwnPropertyDescriptor(message, CALM_ORIGINAL_MESSAGE)?.value;
  if (typeof carried !== "object" || carried === null) return undefined;
  // Only the filter below ever writes this symbol, so the value is a message it copied.
  const originalMessage: AssistantMessageLike = carried;
  return originalMessage;
}

/**
 * Drop mid-turn assistant working notes from a presentation copy of the message.
 *
 * The shared preservation rule decides each text block on its own, so a short working
 * note hides beside preserved substantive text in the same message. Which rows are
 * mid-turn is settled by `reconcileCalmOmpAssistantRows` from the session's own
 * messages, because the copy omp hands this component has already had its tool calls
 * removed. omp replays that copy on every `invalidate()`, so the unfiltered message
 * travels with it and the decision is retaken under the current Calm state; that is
 * what lets a toggle restore text already on screen. The stored message, model context,
 * and exports keep every block.
 */
export function installCalmOmpAssistantLayout(host: OmpHostExports): void {
  const prototype = hostPrototype(host, "AssistantMessageComponent");
  const updateContent = hostMethod(prototype, "AssistantMessageComponent", "updateContent");
  if (globalPatches[CALM_ASSISTANT_PATCH]) return;

  prototype.updateContent = function (
    this: object,
    message: AssistantMessageLike,
    options?: unknown,
  ): unknown {
    const original = carriedOriginalMessage(message) ?? message;
    if (
      !original?.content ||
      !calmPresentationHides("assistant-working-note") ||
      !midTurnAssistantRows.has(this)
    ) {
      return updateContent.call(this as never, original as never, options as never);
    }
    const visible = original.content.filter(
      (block) => !(block.type === "text" && !calmTextIsSubstantive(block.text ?? "")),
    );
    if (visible.length === original.content.length) {
      return updateContent.call(this as never, original as never, options as never);
    }
    const presentation = { ...original, content: visible };
    Object.defineProperty(presentation, CALM_ORIGINAL_MESSAGE, {
      value: original,
      enumerable: false,
      configurable: true,
    });
    return updateContent.call(this as never, presentation as never, options as never);
  };
  globalPatches[CALM_ASSISTANT_PATCH] = true;
}

/** One entry of omp's session branch, as this module reads it. */
export type CalmOmpBranchEntry = {
  readonly message?: AssistantMessageLike;
};

/**
 * Carry the shared mid-turn answer from the session's messages to their transcript rows.
 *
 * omp keeps the settled message, with its stop reason and tool calls intact, and maps it
 * to the row that drew it, so this is an exact per-row classification rather than a
 * guess from what the row was handed. Run it whenever the branch gains a settled
 * assistant message and once per session start, which is what also classifies the rows
 * a resumed transcript restored.
 */
export function reconcileCalmOmpAssistantRows(branch: readonly CalmOmpBranchEntry[]): void {
  const components = liveMode?.transcriptMessageComponents;
  if (typeof components?.get !== "function") return;
  for (const entry of branch) {
    const message = entry?.message;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const row = components.get(message);
    if (typeof row !== "object" || row === null) continue;
    const midTurn = calmAssistantMessageIsMidTurn(message);
    if (midTurn === midTurnAssistantRows.has(row)) continue;
    if (midTurn) midTurnAssistantRows.add(row);
    else midTurnAssistantRows.delete(row);
    const component: RowComponent = row as RowComponent;
    component.invalidate?.();
  }
  calmOmpRequestRender();
}

/**
 * Draw the animated boat in place of omp's stock working row while Calm is on and a run
 * is under way.
 *
 * omp's extension UI context cannot hide that row, so the boat replaces its drawing
 * instead: `ensureLoadingAnimation` is where omp creates and re-mounts the row, which
 * makes it the one place a per-instance drawing can be installed. Both rows occupy the
 * same two lines, so the transcript never shifts when Calm changes. The row's lifetime
 * stays omp's: the boat appears and disappears exactly where the stock row would.
 */
export function installCalmOmpWorkingShip(host: OmpHostExports): void {
  const prototype = hostPrototype(host, "InteractiveMode");
  const ensureLoadingAnimation = hostMethod(
    prototype,
    "InteractiveMode",
    "ensureLoadingAnimation",
  );
  if (globalPatches[CALM_WORKING_SHIP_PATCH]) return;

  prototype.ensureLoadingAnimation = function (this: InteractiveModeLike): unknown {
    liveMode = this;
    const result = ensureLoadingAnimation.call(this as never);
    const loader = this.loadingAnimation;
    if (loader) {
      overrideRowDrawing(loader, CALM_WORKING_SHIP_ROW, (stock, width) => {
        const frame = shipFrame?.(width);
        return frame && calmPresentationIsActive() ? frame : stock(width);
      });
    }
    return result;
  };
  globalPatches[CALM_WORKING_SHIP_PATCH] = true;
}

/** Install or clear the boat drawing the working-row adapter paints. */
export function setCalmOmpWorkingShipFrame(
  frame: ((width: number) => readonly string[]) | undefined,
): void {
  shipFrame = frame;
}

/** Whether omp currently has the working row mounted, so an idle ticker can stand down. */
export function calmOmpWorkingRowIsMounted(): boolean {
  const loader = liveMode?.loadingAnimation;
  const mounted = liveMode?.statusContainer?.children;
  return loader !== undefined && Array.isArray(mounted) && mounted.includes(loader);
}

/** Ask omp to repaint. Silent before the live mode is captured, which is before anything is drawn. */
export function calmOmpRequestRender(): void {
  liveMode?.ui?.requestRender?.();
}

/**
 * Redraw the rows already on screen after a toggle. Every adapter above reads Calm at
 * draw time, so invalidating the live transcript is all a toggle needs to hide or
 * restore what is already there. Rows the terminal has already scrolled out of the live
 * screen keep the drawing they were emitted with; docs/calm.md owns that bound.
 */
export function calmOmpRedrawTranscript(): void {
  const mode = liveMode;
  if (!mode) return;
  const children = mode.chatContainer?.children;
  if (Array.isArray(children)) {
    for (const child of children as RowComponent[]) child?.invalidate?.();
  }
  mode.chatContainer?.invalidate?.();
  calmOmpRequestRender();
}

/** Drop the captured mode so a new session never redraws a retired screen. */
export function resetCalmOmpLayout(): void {
  liveMode = undefined;
}
