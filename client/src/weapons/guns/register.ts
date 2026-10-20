/**
 * Side-effect barrel (re-implemented).
 *
 * `viewmodel.ts` and `tp-gun.ts` statically import this module and expect the
 * gun registry to be populated afterwards. Every concrete gun module registers
 * itself at import time via `registerGun(...)` from `./index`; the list below
 * simply triggers each registration once.
 */
import "./ar";
import "./smg";
import "./pistol";
import "./sniper";
import "./frag";
import "./placeholder";
