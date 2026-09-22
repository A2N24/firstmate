// The Node-side owner of Firstmate's shared per-home Calm preference file.
//
// One captain choice applies on every harness, so the file, its home resolution, its
// value schema, and its atomic write live in exactly one place per runtime. This module
// is that place for the Node-hosted extensions (Pi and omp); the Claude Code mod reaches
// the same file through its own engine filesystem interface, and
// ../../../.claude/mods/firstmate-calm/lib/fm-calm-presentation.ts is the owner there.
// docs/configuration.md owns the persisted value schema both implementations honor.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The effective home's `config/calm` path: `FM_CONFIG_OVERRIDE` names the config
 * directory outright, otherwise `FM_HOME`, then `FM_ROOT_OVERRIDE`, then the tracked
 * code root the calling extension belongs to.
 */
export function calmPreferencePath(codeRoot: string): string {
  const fmHome = process.env.FM_HOME || process.env.FM_ROOT_OVERRIDE || codeRoot;
  const configDirectory = process.env.FM_CONFIG_OVERRIDE || resolve(fmHome, "config");
  return resolve(configDirectory, "calm");
}

/**
 * Whether the stored preference reads as Calm on. "max" is the legacy value written by
 * the removed third presentation level, whose behavior is now ordinary Calm, so a home
 * upgraded from it restores as on rather than dropping to off. An absent, unreadable, or
 * unrecognized value reads as off.
 */
export function readCalmPreference(path: string): boolean {
  let stored: string;
  try {
    stored = readFileSync(path, "utf8").trim();
  } catch {
    return false;
  }
  return stored === "on" || stored === "max";
}

/**
 * Persist the choice atomically: a temporary sibling is written with an exclusive
 * create and renamed over the preference, so a concurrent reader never observes a
 * partial file. Throws when the choice could not be stored, which every caller reports
 * while leaving the live presentation unchanged.
 */
export function writeCalmPreference(path: string, active: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, active ? "on\n" : "off\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
