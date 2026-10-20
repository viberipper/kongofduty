/**
 * The control strip every screen prints (menu footer, lobby footer). ONE list:
 * the menu and the lobby used to print two different control lists.
 * DERIVED from the live keybindings (ui/keybinds.ts) — the same table
 * game.ts bindInput dispatches through and SETTINGS → CONTROLS rebinds — so a
 * rebound key shows its new keycap everywhere.
 */
import { keyFor, moveLabel, onBinds } from "./keybinds";

/** The keyline: [keycap, label] pairs, read off the current bindings. */
export function keyline(): [string, string][] {
  return [
    [moveLabel(), "MOVE"],
    [keyFor("sprint"), "SPRINT"],
    [keyFor("crouch"), "SLIDE"],
    [keyFor("reload"), "RELOAD"],
    [keyFor("swap"), "SWAP"],
    [keyFor("frag"), "FRAG"],
    [keyFor("scoreboard"), "SCORES"],
    ["ESC", "MENU"],
  ];
}

/** @deprecated read keyline(): kept for callers that imported the old constant. */
export const KEYLINE: readonly [string, string][] = keyline();

const boxes = new Set<HTMLElement>();
onBinds(() => {
  for (const b of boxes) {
    if (!b.isConnected) {
      boxes.delete(b);
      continue;
    }
    b.replaceChildren();
    paint(b);
  }
});

function paint(box: HTMLElement): void {
  for (const [k, label] of keyline()) {
    const s = document.createElement("span");
    const key = document.createElement("i");
    key.className = "key";
    key.textContent = k;
    s.append(key, document.createTextNode(label));
    box.append(s);
  }
}

/** Fill a container with the keyline (keycap + label pairs); repaints on a rebind. */
export function renderKeyline(box: HTMLElement): void {
  boxes.add(box);
  if (box.childElementCount) return;
  paint(box);
}
