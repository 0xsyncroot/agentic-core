import { defineScript } from "./core.js";
import { LUA_COMMON } from "./lua-common.js";

/**
 * Claim a turn. ARGV: 1 actor, 2 session ttl, 3 idempotency ttl, 4 expectedSeq (head the caller
 * saw), 5 fingerprint, 6 turnId, 7 ownerId, 8 request key, 9 request fingerprint, 10 profile,
 * 11 lease ttl ms, 12 checkpoint JSON, 13 created, 14 input JSON, 15 runtime snapshot id,
 * 16 correlation id, 17.. start event JSON.
 *
 * Replies {code, ...}: 0 acquired {seq, token, expiresMs, listed}; 2 head moved {head};
 * 10 an expired lease still has a running turn that must be repaired first {token, request JSON,
 * turnId}; 11 completed; 12 in progress; 13 failed; 14 request key reused; 5/8 denied.
 */
export const CLAIM = defineScript(`${LUA_COMMON}
local exists = redis.call('HEXISTS', KEYS[1], 'head') == 1
if exists then
  if owner_mismatch(ARGV[1]) then return { R_OWNER } end
  local bound = redis.call('HGET', KEYS[1], 'profile')
  if bound and bound ~= ARGV[10] then return { 8 } end
  redis.call('HSET', KEYS[1], 'profile', ARGV[10])
end
local now = now_ms()
local lease = redis.call('HMGET', KEYS[1], 'lease_turn', 'lease_exp', 'lease_req', 'lease_token')
if lease[1] and tonumber(lease[2]) <= now then
  local raw = lease[3] and redis.call('HGET', KEYS[4], lease[3])
  if raw and cjson.decode(raw).status == 'running' then return { 10, lease[4], raw, lease[1] } end
  clear_lease()
  lease = { false, false, false, false }
end
local prior = redis.call('HGET', KEYS[4], ARGV[8])
if prior then
  local rec = cjson.decode(prior)
  if rec.fp ~= ARGV[9] then return { 14 } end
  if rec.status == 'completed' then return { 11, rec.turnId, rec.resultSeq or head_seq() } end
  if rec.status ~= 'running' then return { 13, rec.turnId, rec.errorCode or rec.status } end
  local left = lease[2] and (tonumber(lease[2]) - now) or 0
  return { 12, rec.turnId, math.max(1, left) }
end
if lease[1] then return { 12, lease[1], math.max(1, tonumber(lease[2]) - now) } end
local code, seq = apply(tonumber(ARGV[4]), ARGV[5], 'turn-claim:' .. ARGV[8], collect(17), ARGV[12])
if code ~= 0 then return { code, seq } end
local fence = (tonumber(redis.call('HGET', KEYS[1], 'fence') or '0')) + 1
local expires = now + tonumber(ARGV[11])
redis.call('HSET', KEYS[1], 'fence', fence, 'profile', ARGV[10], 'lease_turn', ARGV[6], 'lease_owner', ARGV[7],
  'lease_token', string.format('%d', fence), 'lease_exp', string.format('%d', expires), 'lease_req', ARGV[8])
redis.call('HSET', KEYS[4], ARGV[8], cjson.encode({ turnId = ARGV[6], fp = ARGV[9], actorId = ARGV[1],
  correlationId = ARGV[16], runtimeSnapshotId = ARGV[15], status = 'running' }))
local listed = stamp(ARGV[1], ARGV[13], ARGV[14])
touch(tonumber(ARGV[2]), tonumber(ARGV[3]))
return { 0, seq, string.format('%d', fence), string.format('%d', expires), listed }`);

/**
 * Close the turn of an expired lease. ARGV: 1 actor, 2 session ttl, 3 idempotency ttl,
 * 4 expectedSeq, 5 fingerprint, 6 idempotency key, 7 stale lease token, 8.. event JSON.
 * Replies {16} when the lease is no longer the expired one the caller saw.
 */
export const REPAIR = defineScript(`${LUA_COMMON}
local lease = redis.call('HMGET', KEYS[1], 'lease_token', 'lease_exp', 'lease_req')
if lease[1] ~= ARGV[7] or tonumber(lease[2]) > now_ms() then return { 16 } end
local code, seq = apply(tonumber(ARGV[4]), ARGV[5], ARGV[6], collect(8), '')
if code ~= 0 then return { code, seq } end
local raw = lease[3] and redis.call('HGET', KEYS[4], lease[3])
if raw then
  local rec = cjson.decode(raw)
  rec.status = 'interrupted'
  rec.resultSeq = seq
  rec.errorCode = 'worker-lost'
  redis.call('HSET', KEYS[4], lease[3], cjson.encode(rec))
end
clear_lease()
touch(tonumber(ARGV[2]), tonumber(ARGV[3]))
return { 0, seq }`);

/** Renew a lease. ARGV: 1 actor, 2 session ttl, 3 ttl ms, 4 turnId, 5 ownerId, 6 token. Replies {code, expiresMs}. */
export const RENEW = defineScript(`${LUA_COMMON}
if redis.call('HEXISTS', KEYS[1], 'head') == 0 then return { R_NOSESSION, '0' } end
if owner_mismatch(ARGV[1]) then return { R_OWNER, '0' } end
local lease = redis.call('HMGET', KEYS[1], 'lease_turn', 'lease_owner', 'lease_token', 'lease_exp')
if not lease[1] or lease[1] ~= ARGV[4] or lease[2] ~= ARGV[5] or lease[3] ~= ARGV[6] then return { R_LOST, '0' } end
local now = now_ms()
if tonumber(lease[4]) <= now then return { R_EXPIRED, '0' } end
local expires = string.format('%d', now + tonumber(ARGV[3]))
redis.call('HSET', KEYS[1], 'lease_exp', expires)
for i = 1, 5 do redis.call('EXPIRE', KEYS[i], tonumber(ARGV[2])) end
return { 0, expires }`);
