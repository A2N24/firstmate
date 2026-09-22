// Harness-neutral row-matching policy shared by every Node-hosted Calm presentation.
//
// ./fm-calm-visibility.ts owns which transcript class Calm hides, and
// ./fm-operational-input.ts owns whether a user row is Firstmate operational input.
// This module owns the remaining question a layout adapter must answer before it can
// apply that decision to a concrete row: whether an assistant message is mid-turn. The
// answer is identical on every harness, so the Pi adapters and the omp adapters consume
// it here rather than each carrying a copy that could drift. docs/calm.md owns the
// captain-facing contract.

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
