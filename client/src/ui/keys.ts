/**
 * The control strip every screen prints (menu footer, lobby footer). ONE list:
 * the menu and the lobby used to print two different control lists.
 * DERIVED from the live keybindings (ui/keybinds.ts) — the same table
 * game.ts bindInput dispatches through and SETTINGS → CONTROLS rebinds — so a
 * rebound key shows its new keycap everywhere.
 * GAMEPAD: once a connected pad was touched most recently, the strip shows pad
 * buttons instead (ui/gamepad.ts padKeyline, last-input-wins) and repaints live
 * on every device flip.
 */
import { keyFor, moveLabel, onBinds } from "./keybinds";
import { onPadPrompts, padGlyph, padKeyline, padPromptsActive } from "./gamepad";

/** The keyline: [keycap, label] pairs — pad buttons or live keyboard bindings. */
export function keyline(): [string, string][] {
  if (padPromptsActive()) return padKeyline();
  return [
    [moveLabel(), "MOVE"],
    [keyFor("sprint"), "SPRINT"],
    [keyFor("crouch"), "SLIDE"],
    [keyFor("reload"), "RELOAD"],
    [keyFor("swap"), "SWAP"],
    [keyFor("frag"), "FRAG"],
    [keyFor("scoreboard"), "SCORES"],
    ["ESC", "MENU"],
    [keyFor("spray"), "SPRAY"],
    [keyFor("chat"), "CHAT"],
  ];
}

/** @deprecated read keyline(): kept for callers that imported the old constant. */
export const KEYLINE: readonly [string, string][] = keyline();

const boxes = new Set<HTMLElement>();
function repaint(): void {
  for (const b of boxes) {
    if (!b.isConnected) {
      boxes.delete(b);
      continue;
    }
    b.replaceChildren();
    paint(b);
  }
}
onBinds(repaint);
// Device flip (last input pad ↔ keyboard/mouse): same repaint, new keycaps.
onPadPrompts(repaint);

function paint(box: HTMLElement): void {
  // Pad mode: brand glyphs (Xbox letters / PlayStation shapes) instead of keycaps.
  if (padPromptsActive()) {
    for (const [btn, label] of padKeyline()) {
      const s = document.createElement("span");
      s.append(padGlyph(btn), document.createTextNode(label));
      box.append(s);
    }
    return;
  }
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
