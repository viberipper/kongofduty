import type { PlayerSnap, ServerMsg } from './protocol';

// Append-only field order for compact-v1. Negotiated at join so already-open
// clients and tools keep the original object format during a rolling deploy.
const fields = ['id','seq','name','op','team','x','y','z','vx','vy','vz','yaw','pitch',
  'hp','armor','weapon','ads','sprint','crouch','slide','reload','firing','alive',
  'protect','kills','deaths','streak','ping','ammo','reserve','nades','nadeUp',
  // weapons stream (appended): holstered weapon + its ammo, raise timer, frag cook
  'alt','altAmmo','altRes','swap','cook',
  // gun game (appended): ladder progress
  'gun',
  // bot flag (appended): true for AI bodies
  'bot',
  // lean (appended): corner lean, view-only
  'lean'] as const satisfies readonly (keyof PlayerSnap)[];
type Complete = Exclude<keyof PlayerSnap, typeof fields[number]> extends never ? true : never;
const complete: Complete = true;
void complete;

export function packPlayers(players: PlayerSnap[]): unknown[][] {
  return players.map(p => fields.map(key => p[key]));
}

/** Strict bot-flag read: only `true` (packed: `1`) is a bot — anything else
 * (absent, null, 0, "false", …) is human. Never use truthiness here. */
function asBotFlag(v: unknown): boolean {
  return v === true || v === 1;
}

/** Lossless field-name removal; precision and owner prediction are unchanged. */
export function decodeServerMessage(value: unknown): ServerMsg {
  const msg = value as { t?: string; packed?: number; players?: unknown };
  if (msg?.t === 'snap' && Array.isArray(msg.players)) {
    if (msg.packed === 1) {
      (msg as unknown as {players: PlayerSnap[]}).players = (msg.players as unknown[][]).map(row => {
        const p: Record<string, unknown> = {};
        for (let i=0;i<fields.length;i++) p[fields[i]!] = row[i];
        p['bot'] = asBotFlag(p['bot']);
        return p as PlayerSnap;
      });
      delete msg.packed;
    } else {
      // Object format (old servers, replays, tools): normalise in place so a
      // missing/legacy flag never reads truthy — absent (or null) is human.
      for (const p of msg.players as Record<string, unknown>[])
        if (p && typeof p === 'object') p['bot'] = asBotFlag(p['bot']);
    }
  }
  return msg as ServerMsg;
}
