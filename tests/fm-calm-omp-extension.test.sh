#!/usr/bin/env bash
# Contract checks for Calm on omp: the shared preference the /calm command toggles,
# which transcript rows each presentation adapter hides, and what survives when one
# adapter's seam is gone.
#
# The extension is driven over a fake omp host, the same shape tests/fm-omp-harness.test.sh
# drives the other two tracked .omp extensions with. That host stands in only for omp's
# call sequence; the seams it names are the ones the live host really exports, which
# tests/fm-calm-omp-seams-live.test.sh proves against the installed omp.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v node >/dev/null 2>&1 || { echo "skip: omp Calm test prerequisite not found: node"; exit 0; }

TMP_ROOT=$(fm_test_tmproot fm-calm-omp-extension)

if ! printf 'export const answer: number = 1;\n' > "$TMP_ROOT/ts-probe.ts" ||
  ! node --input-type=module -e "await import('file://$TMP_ROOT/ts-probe.ts');" >/dev/null 2>&1; then
  echo "skip: omp Calm test prerequisite not found: a node that imports TypeScript modules"
  exit 0
fi

OPERATIONAL_INPUT="$ROOT/bin/fm-operational-input.sh"
OPERATIONAL_ROW=$(printf 'firstmate steer body' | "$OPERATIONAL_INPUT" encode from-firstmate) ||
  fail "could not encode a canonical operational user row"
NEAR_MISS_ROW="[fm-from-firstmate]firstmate steer body"

# The fixture is a whole repo layout because the extension reaches its shared owners by
# relative path: the Calm policy and preference under .pi/extensions/lib, the mid-turn
# text rule under .claude/mods, and the canonical operational-input owner under bin.
install_fixture() {  # <repo>
  local repo=$1
  mkdir -p "$repo/.omp/extensions/lib" "$repo/.pi/extensions/lib" \
    "$repo/.claude/mods/firstmate-calm/lib" "$repo/bin" \
    "$repo/node_modules/@earendil-works/pi-coding-agent"
  cp "$ROOT/.omp/extensions/fm-calm.ts" "$repo/.omp/extensions/fm-calm.ts"
  cp "$ROOT/.omp/extensions/lib/fm-calm-omp-layout.ts" "$repo/.omp/extensions/lib/fm-calm-omp-layout.ts"
  local lib
  for lib in fm-calm-preference fm-calm-row-policy fm-calm-visibility fm-calm-working-ship \
    fm-calm-working-ship-sprite fm-operational-input; do
    cp "$ROOT/.pi/extensions/lib/$lib.ts" "$repo/.pi/extensions/lib/$lib.ts"
  done
  cp "$ROOT/.claude/mods/firstmate-calm/lib/fm-calm-preservation.ts" \
    "$repo/.claude/mods/firstmate-calm/lib/fm-calm-preservation.ts"
  cp "$OPERATIONAL_INPUT" "$repo/bin/fm-operational-input.sh"
  chmod +x "$repo/bin/fm-operational-input.sh"
  printf '%s\n' '{"type":"module"}' > "$repo/package.json"
  # The Calm policy module imports Pi's package for the one renderer omp never installs.
  # Only the specifier has to resolve; omp itself supplies the real host at runtime.
  printf '%s\n' '{"name":"@earendil-works/pi-coding-agent","type":"module","exports":"./index.js"}' \
    > "$repo/node_modules/@earendil-works/pi-coding-agent/package.json"
  cat > "$repo/node_modules/@earendil-works/pi-coding-agent/index.js" <<'JS'
export class UserMessageComponent {}
export const getMarkdownTheme = () => ({});
JS
}

# The fake omp host: one class per seam the adapters patch, with the call sequence the
# live host performs. Shared by every case below through a copied module.
install_host() {  # <repo>
  cat > "$1/host.js" <<'JS'
export class ToolExecutionComponent {
  constructor(rows) { this.rows = rows; }
  render() { return this.rows; }
  invalidate() {}
}

export class ReadToolGroupComponent {
  constructor(rows) { this.rows = rows; }
  render() { return this.rows; }
  invalidate() {}
}

export class UserRow {
  constructor(rows) { this.rows = rows; }
  render() { return this.rows; }
  invalidate() {}
}

// omp stores the copy it was handed and replays it on every invalidate().
export class AssistantMessageComponent {
  updateContent(message) { this.drawn = message; }
  invalidate() { if (this.drawn) this.updateContent(this.drawn); }
  texts() { return (this.drawn?.content ?? []).filter((b) => b.type === "text").map((b) => b.text); }
}

export class Loader {
  render(width) { return ["", `Working... ${width}`]; }
  invalidate() {}
}

export class InteractiveMode {
  constructor() {
    this.chatContainer = { children: [], invalidate() {} };
    this.statusContainer = { children: [] };
    this.transcriptMessageComponents = new WeakMap();
    this.renders = 0;
    this.ui = { requestRender: () => { this.renders += 1; } };
  }
  getUserMessageText(message) { return message.content.map((block) => block.text).join(""); }
  addMessageToChat(message) {
    const row = new UserRow([this.getUserMessageText(message)]);
    this.chatContainer.children.push(row);
    return row;
  }
  ensureLoadingAnimation() {
    this.loadingAnimation = new Loader();
    this.statusContainer.children.push(this.loadingAnimation);
  }
}

export function hostExports(omit = []) {
  const all = {
    InteractiveMode,
    AssistantMessageComponent,
    ToolExecutionComponent,
    ReadToolGroupComponent,
  };
  for (const name of omit) delete all[name];
  return all;
}

// The extension surface omp hands a factory, recording what the extension registers.
// `status` is the keyed line above the editor: the live host removes it when the key is
// set to undefined, so the recorded history shows both the answer and its removal.
// Managed timers are collected rather than run, so a case fires them when it chooses.
export function fakePi(host) {
  const handlers = new Map();
  const status = [];
  const timers = new Map();
  let nextTimer = 0;
  return {
    pi: host,
    handlers,
    status,
    command: undefined,
    /** The status keys still shown, in the order they were last set. */
    shownStatus() {
      const shown = new Map();
      for (const entry of status) {
        if (entry.text === undefined) shown.delete(entry.key);
        else shown.set(entry.key, entry.text);
      }
      return [...shown.values()];
    },
    runTimers() {
      const due = [...timers.values()];
      timers.clear();
      for (const handler of due) handler();
    },
    on(event, handler) { handlers.set(event, handler); },
    registerCommand(name, definition) { this.command = { name, definition }; },
    ctx(mode) {
      return {
        hasUI: true,
        ui: { setStatus: (key, text) => status.push({ key, text }) },
        sessionManager: { getBranch: () => mode.branch ?? [] },
        setTimeout: (handler) => { const id = ++nextTimer; timers.set(id, handler); return id; },
        setInterval: (handler) => { const id = ++nextTimer; timers.set(id, handler); return id; },
        clearTimer: (id) => { timers.delete(id); },
      };
    },
  };
}
JS
}

run_case() {  # <repo> <label> <env...> -- stdin is the module body
  local repo=$1 label=$2
  shift 2
  local out status
  out=$( (cd "$repo" && env "$@" node --input-type=module) 2>&1 )
  status=$?
  expect_code 0 "$status" "$label: $out"
  [ -z "$out" ] || fail "$label printed output: $out"
}

# --- 1. the shared preference ------------------------------------------------

test_command_toggles_and_persists_the_shared_preference() {
  local repo="$TMP_ROOT/pref/repo" home="$TMP_ROOT/pref/home"
  install_fixture "$repo"
  install_host "$repo"
  mkdir -p "$home/config"
  # "max" is the legacy value of the removed third level and must restore as on.
  printf 'max\n' > "$home/config/calm"
  run_case "$repo" "preference toggle" "FM_HOME=$home" <<'JS'
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { fakePi, hostExports, InteractiveMode, ToolExecutionComponent } from "./host.js";

const mode = new InteractiveMode();
const pi = fakePi(hostExports());
const { default: factory } = await import(pathToFileURL(`${process.cwd()}/.omp/extensions/fm-calm.ts`).href);
factory(pi);

if (pi.command?.name !== "calm") throw new Error(`/calm was not registered: ${JSON.stringify(pi.command)}`);
const ctx = pi.ctx(mode);
pi.handlers.get("session_start")({}, ctx);

const row = new ToolExecutionComponent(["tool row"]);
if (row.render(80).length !== 0) throw new Error("a stored 'max' preference did not restore Calm as on");

const preference = `${process.env.FM_HOME}/config/calm`;
await pi.command.definition.handler("", ctx);
if (readFileSync(preference, "utf8") !== "off\n") throw new Error(`first toggle did not persist off: ${readFileSync(preference, "utf8")}`);
if (row.render(80).length === 0) throw new Error("Calm off still hid the tool row");

await pi.command.definition.handler("", ctx);
if (readFileSync(preference, "utf8") !== "on\n") throw new Error("second toggle did not persist on");
if (row.render(80).length !== 0) throw new Error("Calm on did not hide the tool row");

const answered = pi.status.filter((entry) => entry.text !== undefined).map((entry) => entry.text);
if (answered.join("|") !== "Calm off|Calm on") throw new Error(`the toggle did not answer: ${answered.join("|")}`);
if (pi.shownStatus().join("|") !== "Calm on") throw new Error("the answer was not the only line still shown");
// The answer expires: omp removes the line when its key is set back to undefined.
pi.runTimers();
if (pi.shownStatus().length !== 0) throw new Error("the answer stayed on screen instead of expiring");
// And it was never a transcript row.
if (mode.chatContainer.children.length !== 0) throw new Error("the toggle added a transcript row");
JS
  pass "/calm toggles Calm, persists the shared per-home preference, and answers on a line that expires rather than a transcript row"
}

test_preference_follows_the_shared_home_resolution() {
  local repo="$TMP_ROOT/home/repo" home="$TMP_ROOT/home/home" elsewhere="$TMP_ROOT/home/elsewhere"
  install_fixture "$repo"
  install_host "$repo"
  mkdir -p "$home/config" "$elsewhere"
  run_case "$repo" "config override" "FM_HOME=$home" "FM_CONFIG_OVERRIDE=$elsewhere" <<'JS'
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { fakePi, hostExports, InteractiveMode } from "./host.js";

const pi = fakePi(hostExports());
const { default: factory } = await import(pathToFileURL(`${process.cwd()}/.omp/extensions/fm-calm.ts`).href);
factory(pi);
const ctx = pi.ctx(new InteractiveMode());
pi.handlers.get("session_start")({}, ctx);
await pi.command.definition.handler("", ctx);

const overridden = `${process.env.FM_CONFIG_OVERRIDE}/calm`;
if (readFileSync(overridden, "utf8") !== "on\n") throw new Error("FM_CONFIG_OVERRIDE did not name the config directory");
if (existsSync(`${process.env.FM_HOME}/config/calm`)) throw new Error("FM_HOME was written despite the config override");
JS
  pass "the Calm preference resolves through FM_CONFIG_OVERRIDE ahead of FM_HOME"
}

test_unwritable_preference_leaves_the_choice_unchanged() {
  local repo="$TMP_ROOT/readonly/repo" home="$TMP_ROOT/readonly/home"
  install_fixture "$repo"
  install_host "$repo"
  mkdir -p "$home/config"
  printf 'on\n' > "$home/config/calm"
  chmod 500 "$home/config"
  run_case "$repo" "unwritable preference" "FM_HOME=$home" <<'JS'
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { fakePi, hostExports, InteractiveMode, ToolExecutionComponent } from "./host.js";

const pi = fakePi(hostExports());
const { default: factory } = await import(pathToFileURL(`${process.cwd()}/.omp/extensions/fm-calm.ts`).href);
factory(pi);
const ctx = pi.ctx(new InteractiveMode());
pi.handlers.get("session_start")({}, ctx);

const row = new ToolExecutionComponent(["tool row"]);
await pi.command.definition.handler("", ctx);

if (readFileSync(`${process.env.FM_HOME}/config/calm`, "utf8") !== "on\n") throw new Error("the stored choice changed");
if (row.render(80).length !== 0) throw new Error("a failed write changed the live presentation");
const reported = pi.shownStatus().at(-1) ?? "";
if (!reported.startsWith("Calm unchanged: could not save ")) throw new Error(`the failure was not reported: ${reported}`);
JS
  chmod 700 "$home/config"
  pass "a preference that cannot be written leaves the current Calm choice unchanged and says so"
}

# --- 2. which rows each adapter hides ----------------------------------------

test_tool_rows_hide_while_calm_is_on() {
  local repo="$TMP_ROOT/tools/repo" home="$TMP_ROOT/tools/home"
  install_fixture "$repo"
  install_host "$repo"
  mkdir -p "$home/config"
  printf 'on\n' > "$home/config/calm"
  run_case "$repo" "tool rows" "FM_HOME=$home" <<'JS'
import { pathToFileURL } from "node:url";
import { fakePi, hostExports, InteractiveMode, ReadToolGroupComponent, ToolExecutionComponent } from "./host.js";

const pi = fakePi(hostExports());
const { default: factory } = await import(pathToFileURL(`${process.cwd()}/.omp/extensions/fm-calm.ts`).href);
factory(pi);
const ctx = pi.ctx(new InteractiveMode());
pi.handlers.get("session_start")({}, ctx);

const call = new ToolExecutionComponent(["$ echo hi", "hi"]);
const group = new ReadToolGroupComponent(["read x", "read y"]);
if (call.render(80).length !== 0) throw new Error("the tool call and result row was drawn while Calm was on");
if (group.render(80).length !== 0) throw new Error("the folded read group was drawn while Calm was on");

await pi.command.definition.handler("", ctx);
if (call.render(80).join("|") !== "$ echo hi|hi") throw new Error("Calm off did not restore the tool row");
if (group.render(80).join("|") !== "read x|read y") throw new Error("Calm off did not restore the read group");
JS
  pass "tool call, tool result, and folded read rows draw at zero height under Calm and restore when it is off"
}

test_operational_user_rows_hide_and_near_misses_stay() {
  local repo="$TMP_ROOT/rows/repo" home="$TMP_ROOT/rows/home"
  install_fixture "$repo"
  install_host "$repo"
  mkdir -p "$home/config"
  printf 'on\n' > "$home/config/calm"
  run_case "$repo" "operational rows" "FM_HOME=$home" \
    "FM_OPERATIONAL_ROW=$OPERATIONAL_ROW" "FM_NEAR_MISS_ROW=$NEAR_MISS_ROW" <<'JS'
import { pathToFileURL } from "node:url";
import { fakePi, hostExports, InteractiveMode } from "./host.js";

const pi = fakePi(hostExports());
const { default: factory } = await import(pathToFileURL(`${process.cwd()}/.omp/extensions/fm-calm.ts`).href);
factory(pi);
const mode = new InteractiveMode();
const ctx = pi.ctx(mode);
pi.handlers.get("session_start")({}, ctx);

const userMessage = (text) => ({ role: "user", content: [{ type: "text", text }] });
const operational = mode.addMessageToChat(userMessage(process.env.FM_OPERATIONAL_ROW));
const nearMiss = mode.addMessageToChat(userMessage(process.env.FM_NEAR_MISS_ROW));

if (operational.render(80).length !== 0) throw new Error("a canonical operational row was drawn while Calm was on");
if (nearMiss.render(80).length === 0) throw new Error("a near miss was hidden as operational input");

await pi.command.definition.handler("", ctx);
if (operational.render(80).length === 0) throw new Error("Calm off did not restore the operational row");
JS
  pass "a canonically classified operational user row hides under Calm, a near miss stays visible, and both restore"
}

test_mid_turn_working_notes_follow_the_shared_preservation_rule() {
  local repo="$TMP_ROOT/notes/repo" home="$TMP_ROOT/notes/home"
  install_fixture "$repo"
  install_host "$repo"
  mkdir -p "$home/config"
  printf 'on\n' > "$home/config/calm"
  run_case "$repo" "working notes" "FM_HOME=$home" <<'JS'
import { pathToFileURL } from "node:url";
import { AssistantMessageComponent, fakePi, hostExports, InteractiveMode } from "./host.js";

const pi = fakePi(hostExports());
const { default: factory } = await import(pathToFileURL(`${process.cwd()}/.omp/extensions/fm-calm.ts`).href);
factory(pi);
const mode = new InteractiveMode();
const ctx = pi.ctx(mode);
pi.handlers.get("session_start")({}, ctx);
// Capturing the live mode is what lets a row be reached from its message.
mode.addMessageToChat({ role: "user", content: [{ type: "text", text: "go" }] });

const substantive = "x".repeat(240);
// One mid-turn step: a short note, substantive text beside it, and the tool call that
// makes the step mid-turn. omp hands the row only the display slice.
const midTurn = {
  role: "assistant",
  stopReason: "toolUse",
  content: [
    { type: "text", text: "checking now." },
    { type: "text", text: substantive },
    { type: "toolCall", id: "t1", name: "bash" },
  ],
};
const reply = {
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "text", text: "all set." }],
};

const rows = new Map();
for (const message of [midTurn, reply]) {
  const row = new AssistantMessageComponent();
  rows.set(message, row);
  mode.transcriptMessageComponents.set(message, row);
  mode.chatContainer.children.push(row);
  row.updateContent({ ...message, content: message.content.filter((b) => b.type === "text") });
}
mode.branch = [midTurn, reply].map((message) => ({ message }));
pi.handlers.get("message_end")({}, ctx);

const noteRow = rows.get(midTurn).texts();
if (noteRow.includes("checking now.")) throw new Error("the short mid-turn note was still drawn");
if (!noteRow.includes(substantive)) throw new Error("substantive mid-turn text was hidden");
if (!rows.get(reply).texts().includes("all set.")) throw new Error("a final reply was hidden as a working note");

await pi.command.definition.handler("", ctx);
if (!rows.get(midTurn).texts().includes("checking now.")) throw new Error("Calm off did not restore the working note");
JS
  pass "a short mid-turn note hides beside preserved substantive text, the final reply stays, and a toggle restores both"
}

# --- 3. degradation when a seam is gone --------------------------------------

test_missing_seam_degrades_only_its_own_adapter() {
  local repo="$TMP_ROOT/degrade/repo" home="$TMP_ROOT/degrade/home"
  install_fixture "$repo"
  install_host "$repo"
  mkdir -p "$home/config"
  printf 'on\n' > "$home/config/calm"
  run_case "$repo" "missing seam" "FM_HOME=$home" "FM_OPERATIONAL_ROW=$OPERATIONAL_ROW" <<'JS'
import { pathToFileURL } from "node:url";
import { fakePi, hostExports, InteractiveMode, ToolExecutionComponent } from "./host.js";

const diagnostics = [];
const stockError = console.error;
console.error = (message) => diagnostics.push(String(message));

const pi = fakePi(hostExports(["ToolExecutionComponent"]));
const { default: factory } = await import(pathToFileURL(`${process.cwd()}/.omp/extensions/fm-calm.ts`).href);
factory(pi);
console.error = stockError;

if (pi.command?.name !== "calm") throw new Error("/calm was lost with the missing seam");
if (!diagnostics.some((line) => line.includes("tool-row presentation adapter unavailable"))) {
  throw new Error(`the unavailable adapter was not named: ${diagnostics.join("|")}`);
}
if (diagnostics.length !== 1) throw new Error(`an unrelated adapter also degraded: ${diagnostics.join("|")}`);

const mode = new InteractiveMode();
const ctx = pi.ctx(mode);
pi.handlers.get("session_start")({}, ctx);

const operational = mode.addMessageToChat({ role: "user", content: [{ type: "text", text: process.env.FM_OPERATIONAL_ROW }] });
if (operational.render(80).length !== 0) throw new Error("the operational row adapter stopped working too");
if (new ToolExecutionComponent(["tool row"]).render(80).length === 0) throw new Error("the skipped adapter still hid a tool row");
JS
  pass "a missing host seam skips only its own adapter and leaves /calm and the rest of Calm working"
}

# --- 4. an in-process reload ------------------------------------------------

test_reload_keeps_the_toggle_driving_the_installed_wrappers() {
  local repo="$TMP_ROOT/reload/repo" reloaded="$TMP_ROOT/reload/reloaded" home="$TMP_ROOT/reload/home"
  install_fixture "$repo"
  install_host "$repo"
  # omp re-imports an extension's whole module graph in-process behind a cache-busting
  # tag, so a reload runs a second, separate instance of every Calm module beside the
  # first, against the same already-patched host prototypes. A copied tree reproduces
  # exactly that: distinct module instances, one shared host.
  cp -R "$repo" "$reloaded"
  mkdir -p "$home/config"
  printf 'off\n' > "$home/config/calm"
  run_case "$repo" "reload" "FM_HOME=$home" "FM_RELOADED=$reloaded" <<'JS'
import { pathToFileURL } from "node:url";
import { fakePi, hostExports, InteractiveMode, ToolExecutionComponent } from "./host.js";

const host = hostExports();
const first = fakePi(host);
const { default: factory } = await import(pathToFileURL(`${process.cwd()}/.omp/extensions/fm-calm.ts`).href);
factory(first);
first.handlers.get("session_start")({}, first.ctx(new InteractiveMode()));

const reloaded = fakePi(host);
const { default: reloadedFactory } = await import(pathToFileURL(`${process.env.FM_RELOADED}/.omp/extensions/fm-calm.ts`).href);
reloadedFactory(reloaded);
const ctx = reloaded.ctx(new InteractiveMode());
reloaded.handlers.get("session_start")({}, ctx);

const row = new ToolExecutionComponent(["tool row"]);
if (row.render(80).length === 0) throw new Error("Calm was off but the tool row was already hidden");

await reloaded.command.definition.handler("", ctx);
if (row.render(80).length !== 0) {
  throw new Error("the reloaded /calm did not reach the wrappers the first load installed");
}
JS
  pass "after an in-process reload, /calm still drives the wrappers the earlier load installed"
}

test_command_toggles_and_persists_the_shared_preference
test_preference_follows_the_shared_home_resolution
test_unwritable_preference_leaves_the_choice_unchanged
test_tool_rows_hide_while_calm_is_on
test_operational_user_rows_hide_and_near_misses_stay
test_mid_turn_working_notes_follow_the_shared_preservation_rule
test_missing_seam_degrades_only_its_own_adapter
test_reload_keeps_the_toggle_driving_the_installed_wrappers
