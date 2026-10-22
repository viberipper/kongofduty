import type { PlayerSnap, ServerMsg } from './protocol';

// Append-only field order for compact-v1. Negotiated at join so already-open
// clients and tools keep the original object format during a rolling deploy.
const fields = ['id','seq','name','op','team','x','y','z','vx','vy','vz','yaw','pitch',
  'hp','armor','weapon','ads','sprint','crouch','slide','reload','firing','alive',
  'protect','kills','deaths','streak','ping','ammo','reserve','nades','nadeUp',
  // weapons stream (appended): holstered weapon + its ammo, raise timer, frag cook
  'alt','altAmmo','altRes','swap','cook',
  // gun game (appended): ladder progress
  'gun'] as const satisfies readonly (keyof PlayerSnap)[];
type Complete = Exclude<keyof PlayerSnap, typeof fields[number]> extends never ? true : never;
const complete: Complete = true;
void complete;

export function packPlayers(players: PlayerSnap[]): unknown[][] {
  return players.map(p => fields.map(key => p[key]));
}

/** Lossless field-name removal; precision and owner prediction are unchanged. */
export function decodeServerMessage(value: unknown): ServerMsg {
  const msg = value as { t?: string; packed?: number; players?: unknown[][] };
  if (msg?.t === 'snap' && msg.packed === 1 && Array.isArray(msg.players)) {
    (msg as unknown as {players: PlayerSnap[]}).players = msg.players.map(row => {
      const p: Record<string, unknown> = {};
      for (let i=0;i<fields.length;i++) p[fields[i]!] = row[i];
      return p as PlayerSnap;
    });
    delete msg.packed;
  }
  return msg as ServerMsg;
}
