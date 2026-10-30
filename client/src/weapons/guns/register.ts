/**
 * Side-effect barrel (re-implemented).
 *
 * `viewmodel.ts` and `tp-gun.ts` statically import this module and expect the
 * gun registry to be populated afterwards. Every concrete gun module registers
 * itself at import time via `registerGun(...)` from `./index`; the list below
 * simply triggers each registration once.
 *
 * IMPORT ORDER IS LOAD-BEARING: `registerGun()` in `./index` is last-wins
 * (`builders.set`), and `./placeholder` registers grey box dummies for every
 * gun id. It MUST come first so the real builders (ar/smg/pistol/sniper)
 * overwrite the placeholders — never the other way round (all first-person
 * guns would render as grey boxes). `./placeholder` goes through
 * `registerPlaceholderGun()`, so that intended hand-off is quiet, while a
 * real-builder collision still warns.
 */
import "./placeholder";
import "./ar";
import "./smg";
import "./pistol";
import "./sniper";
import "./frag";
