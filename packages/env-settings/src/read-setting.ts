/**
 * Reads one named setting from an environment map, honouring the names it replaced.
 *
 * Setting names change: a name first chosen for one product turns out to be shared by all of them,
 * or a plain infrastructure name (`REDIS_URL`, `S3_BUCKET`) replaces a home-grown one. A rename must
 * not break a running deployment, and it must not leave that deployment quietly reading a stale
 * value either. So every read names the current setting together with the retired names it
 * replaced, and this one function decides what the process sees:
 *
 * - only the current name is set: its value;
 * - only a retired name is set: that value, plus one warning line in the service log that names
 *   the current name (once per process and name, so a setting read on every request cannot flood
 *   the log). The warning goes to the operator's log, never to a user;
 * - the current name and a retired name hold the same value: the current one, silently — that is
 *   a migration in progress, not a mistake;
 * - they hold different values: refusal, because either choice would be a guess about which one
 *   the operator meant.
 *
 * Values are trimmed and an empty value counts as unset, which is how every caller read settings
 * before this existed. Messages name settings, never their values: a value may be a secret.
 */

/** Any environment map: `process.env`, a composed copy, or a literal in a test. */
export type SettingsEnv = Readonly<Record<string, string | undefined>>;

/** Receives the one-time retired-name warning. */
export type SettingLog = (message: string) => void;

export interface ReadSettingOptions {
  /**
   * Retired names this setting replaced, in precedence order. Without the current name, the first
   * retired name that is set wins, which is how the old names were read against each other.
   */
  readonly legacy?: readonly string[];
  /** Where the retired-name warning goes. Defaults to the process log (stderr). */
  readonly log?: SettingLog;
}

/** A setting's value and the name it was actually read from (a retired name, when that is all that is set). */
export interface SettingSource {
  readonly value: string;
  readonly name: string;
}

/** Thrown when the current name and a retired name disagree; the process should not start. */
export class SettingConflictError extends Error {
  constructor(readonly setting: string, readonly retired: string) {
    super(`${setting} and its retired name ${retired} are both set, to different values; keep only ${setting}`);
    this.name = "SettingConflictError";
  }
}

const defaultLog: SettingLog = (message) => { console.warn(message); };
const warned = new WeakMap<SettingLog, Set<string>>();

function present(env: SettingsEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Writes `message` to the service log once per process (per `log` and `key`). For notices about how
 * a setting was resolved — a retired name, a development default — that would otherwise repeat on
 * every read.
 */
export function noticeOnce(key: string, message: string, log: SettingLog = defaultLog): void {
  let seen = warned.get(log);
  if (!seen) { seen = new Set(); warned.set(log, seen); }
  if (seen.has(key)) return;
  seen.add(key);
  log(`[settings] ${message}`);
}

function warnOnce(log: SettingLog, retired: string, setting: string): void {
  noticeOnce(`retired\u0000${retired}\u0000${setting}`, `${retired} is a retired setting name and is still read for now; rename it to ${setting}`, log);
}

/** Like `readSetting`, but also says which name the value came from, for messages about that value. */
export function readSettingSource(env: SettingsEnv, name: string, options: ReadSettingOptions = {}): SettingSource | undefined {
  const current = present(env, name);
  const legacy = options.legacy ?? [];
  if (current !== undefined) {
    for (const retired of legacy) {
      const old = present(env, retired);
      if (old !== undefined && old !== current) throw new SettingConflictError(name, retired);
    }
    return { value: current, name };
  }
  for (const retired of legacy) {
    const old = present(env, retired);
    if (old === undefined) continue;
    warnOnce(options.log ?? defaultLog, retired, name);
    return { value: old, name: retired };
  }
  return undefined;
}

/** The setting's trimmed value, or `undefined` when neither it nor a retired name is set. */
export function readSetting(env: SettingsEnv, name: string, options: ReadSettingOptions = {}): string | undefined {
  return readSettingSource(env, name, options)?.value;
}

/** A `true`/`false` setting; anything else is refused with the name that holds it. */
export function readFlag(env: SettingsEnv, name: string, fallback: boolean, options: ReadSettingOptions = {}): boolean {
  const source = readSettingSource(env, name, options);
  if (source === undefined) return fallback;
  const value = source.value.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${source.name} must be true or false`);
}

/**
 * Refuses settings a component does not read, instead of ignoring them.
 *
 * A product that ships its own skills or profile used to drop these silently, so an operator who
 * set one believed it applied. Naming it at boot is the only way that belief gets corrected.
 */
export function refuseUnreadSettings(env: SettingsEnv, names: readonly string[], reason: string): void {
  const set = names.filter((name) => present(env, name) !== undefined);
  if (set.length === 0) return;
  throw new Error(`${set.join(" and ")} ${set.length === 1 ? "is" : "are"} set but not read here: ${reason}. Unset ${set.length === 1 ? "it" : "them"}`);
}

/**
 * Names removed settings a deployment still sets, once each, and reads nothing more of them.
 *
 * A removed setting no longer does anything. Refusing to start would break a running deployment over a line that is now
 * inert; ignoring it silently would leave the operator believing it still applies. One notice in the service log names it
 * and says what replaced it. Only presence is checked: the value is never read or logged.
 */
export function noticeRemovedSettings(env: SettingsEnv, names: readonly string[], replacement: string, log: SettingLog = defaultLog): void {
  for (const name of names) {
    if (present(env, name) === undefined) continue;
    noticeOnce(`removed\u0000${name}`, `${name} is a removed setting and is ignored: ${replacement}. Unset it`, log);
  }
}
