/**
 * Shared Lua. Every script receives the same five keys of one session:
 * KEYS[1] meta hash, KEYS[2] events list, KEYS[3] idempotency hash, KEYS[4] turn requests hash,
 * KEYS[5] latest checkpoint. They share one hash tag, so a script is one atomic step on one slot.
 *
 * Time comes from `TIME` on the server: lease expiry compares instants written by different
 * replicas, and replica clock skew must not decide who owns a turn.
 */
export const LUA_COMMON = `
local R_IDEM, R_CAS, R_UNLEASED, R_LOST, R_OWNER, R_EXPIRED, R_NOSESSION = 1, 2, 3, 4, 5, 6, 7
local function now_ms()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local function head_seq()
  return tonumber(redis.call('HGET', KEYS[1], 'head') or '0')
end
local function collect(first)
  local out = {}
  for i = first, #ARGV do out[#out + 1] = ARGV[i] end
  return out
end
local function push_all(evs)
  local i = 1
  while i <= #evs do
    redis.call('RPUSH', KEYS[2], unpack(evs, i, math.min(i + 499, #evs)))
    i = i + 500
  end
end
-- The write that every path shares. Idempotency is judged before the compare-and-set, as in the
-- memory store, so a retry of an applied write returns its original result instead of a conflict.
local function apply(expected, fp, idem_key, evs, ckpt)
  local dup = redis.call('HGET', KEYS[3], idem_key)
  if dup then
    local d = cjson.decode(dup)
    if d.fp ~= fp then return R_IDEM, 0 end
    return 0, d.seq
  end
  local head = head_seq()
  if head ~= expected then return R_CAS, head end
  push_all(evs)
  local seq = head + #evs
  redis.call('HSET', KEYS[1], 'head', seq)
  if ckpt ~= '' then redis.call('SET', KEYS[5], ckpt) end
  redis.call('HSET', KEYS[3], idem_key, cjson.encode({ fp = fp, seq = seq }))
  return 0, seq
end
-- Records who owns the session and what the directory lists; returns the creation time when the
-- directory entry needs writing or refreshing (the session's first event, or a write carrying a
-- user input), and '' otherwise. A session is listed from its first event, as the SQL stores do.
local function stamp(actor, created, input)
  redis.call('HSETNX', KEYS[1], 'owner', actor)
  local fresh = 0
  if created ~= '' then fresh = redis.call('HSETNX', KEYS[1], 'created', created) end
  if input ~= '' then redis.call('HSETNX', KEYS[1], 'input', input) end
  local c = redis.call('HGET', KEYS[1], 'created')
  if c and (fresh == 1 or input ~= '') then return c end
  return ''
end
-- Idle expiry: every write refreshes the session, idempotency records may go sooner.
local function touch(sess_ttl, idem_ttl)
  for i = 1, 5 do redis.call('EXPIRE', KEYS[i], sess_ttl) end
  redis.call('EXPIRE', KEYS[3], idem_ttl)
end
local function owner_mismatch(actor)
  local owner = redis.call('HGET', KEYS[1], 'owner')
  return owner and owner ~= actor
end
local function clear_lease()
  redis.call('HDEL', KEYS[1], 'lease_turn', 'lease_owner', 'lease_token', 'lease_exp', 'lease_req')
end
`;
