import { defineScript } from "./core.js";
import { LUA_COMMON } from "./lua-common.js";

/**
 * Bounded reads with the owner check. ARGV: 1 actor, 2 mode (all|recent|since|context),
 * 3 a (recent: limit; since: afterSeq; context: tail size), 4 b (since: limit).
 * Replies {0, events[]} or, for context, {0, events[], checkpoint JSON or ''}; {5} when denied.
 * Reads do not refresh the idle expiry: only writes keep a session alive.
 */
export const READ = defineScript(`${LUA_COMMON}
if owner_mismatch(ARGV[1]) then return { R_OWNER } end
local mode = ARGV[2]
if mode == 'all' then return { 0, redis.call('LRANGE', KEYS[2], 0, -1) } end
if mode == 'recent' then return { 0, redis.call('LRANGE', KEYS[2], -tonumber(ARGV[3]), -1) } end
if mode == 'since' then
  local after = tonumber(ARGV[3])
  return { 0, redis.call('LRANGE', KEYS[2], after, after + tonumber(ARGV[4]) - 1) }
end
return { 0, redis.call('LRANGE', KEYS[2], -tonumber(ARGV[3]), -1), redis.call('GET', KEYS[5]) or '' }`);
