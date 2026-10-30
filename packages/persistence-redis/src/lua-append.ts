import { defineScript } from "./core.js";
import { LUA_COMMON } from "./lua-common.js";

/**
 * Unleased append. ARGV: 1 actor, 2 session ttl, 3 idempotency ttl, 4 expectedSeq, 5 fingerprint,
 * 6 idempotency key, 7 checkpoint JSON, 8 created, 9 input JSON, 10.. event JSON.
 * Replies {code, seq|head, created}.
 */
export const APPEND = defineScript(`${LUA_COMMON}
if owner_mismatch(ARGV[1]) then return { R_OWNER, 0, '' } end
if redis.call('HEXISTS', KEYS[1], 'lease_turn') == 1 then return { R_UNLEASED, 0, '' } end
local code, seq = apply(tonumber(ARGV[4]), ARGV[5], ARGV[6], collect(10), ARGV[7])
if code ~= 0 then return { code, seq, '' } end
local listed = stamp(ARGV[1], ARGV[8], ARGV[9])
touch(tonumber(ARGV[2]), tonumber(ARGV[3]))
return { 0, seq, listed }`);

/**
 * Append or finish under a lease. ARGV as APPEND for 1-9, then 10 mode (append|finish),
 * 11 turnId, 12 ownerId, 13 fencing token, 14 terminal valid (1|0), 15 terminal status
 * (completed|failed), 16 error code, 17.. event JSON.
 */
export const LEASED = defineScript(`${LUA_COMMON}
if redis.call('HEXISTS', KEYS[1], 'head') == 0 then return { R_NOSESSION, 0, '' } end
if owner_mismatch(ARGV[1]) then return { R_OWNER, 0, '' } end
local lease = redis.call('HMGET', KEYS[1], 'lease_turn', 'lease_owner', 'lease_token', 'lease_exp')
if not lease[1] or lease[1] ~= ARGV[11] or lease[2] ~= ARGV[12] or lease[3] ~= ARGV[13] then return { R_LOST, 0, '' } end
if tonumber(lease[4]) <= now_ms() then return { R_EXPIRED, 0, '' } end
if ARGV[10] == 'finish' and ARGV[14] ~= '1' then return { 9, 0, '' } end
local idem_key = ARGV[6]
local code, seq = apply(tonumber(ARGV[4]), ARGV[5], idem_key, collect(17), ARGV[7])
if code ~= 0 then return { code, seq, '' } end
if ARGV[10] == 'finish' then
  local req_key = redis.call('HGET', KEYS[1], 'lease_req')
  local raw = req_key and redis.call('HGET', KEYS[4], req_key)
  if raw then
    local rec = cjson.decode(raw)
    rec.status = ARGV[15]
    rec.resultSeq = seq
    if ARGV[16] ~= '' then rec.errorCode = ARGV[16] end
    redis.call('HSET', KEYS[4], req_key, cjson.encode(rec))
  end
  clear_lease()
end
local listed = stamp(ARGV[1], ARGV[8], ARGV[9])
touch(tonumber(ARGV[2]), tonumber(ARGV[3]))
return { 0, seq, listed }`);
