// Harness-neutral row-matching policy shared by every Node-hosted Calm presentation.
//
// ./fm-calm-visibility.ts owns which transcript class Calm hides. This module owns the
// two questions a layout adapter must answer before it can apply that decision to a
// concrete row: whether a user row is Firstmate operational input, and whether an
// assistant message is mid-turn. Both answers are identical on every harness, so the Pi
// adapters and the omp adapters consume them here rather than each carrying a copy that
// could drift. docs/calm.md owns the captain-facing contract.
import { classifyFirstmateCurrentOperationalText } from "./fm-operational-input.ts";

// The one pre-protocol away-supervisor shape kept only for persisted transcripts; every
// current operational input is recognized by the canonical classifier above.
const LEGACY_CALM_OPERATIONAL_PREFIX = "\u2063Supervisor escalate (";

/**
 * Whether a user row's text is Firstmate operational input rather than a captain
 * prompt. The U+2063 test is a cheap precondition every operational shape satisfies, so
 * an ordinary prompt never pays for the canonical classification behind it.
 */
export function calmRowIsOperationalUserInput(text: string): boolean {
  if (!text.includes("\u2063")) return false;
  return (
    classifyFirstmateCurrentOperationalText(text) !== undefined ||
    text.startsWith(LEGACY_CALM_OPERATIONAL_PREFIX)
  );
}

/** The part of an assistant message this policy reads, on either harness. */
export type CalmAssistantMessageShape = {
  readonly stopReason?: string | null;
  readonly content: readonly { readonly type: string }[];
};

/**
 * Whether the model did not end its response with this message: the agent loop runs its
 * tool calls and then issues another assistant message. `stopReason` is intrinsic to
 * each message and is already set while the message streams, so an adapter never has to
 * ask whether the turn ended.
 */
export function calmAssistantMessageIsMidTurn(message: CalmAssistantMessageShape): boolean {
  if (message.stopReason === "toolUse") return true;
  return (
    message.stopReason === "length" &&
    message.content.some((block) => block.type === "toolCall")
  );
}
