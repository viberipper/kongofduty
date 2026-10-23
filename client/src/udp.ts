/**
 * THE UDP FAST LANE, browser side (server/udp-relay.ts has the why). A WebRTC
 * DataChannel — unordered, no retransmits — opened BESIDE the WebSocket once
 * the seat has its token. Every command also goes on it, bundled with the 3
 * before it so a lost packet costs nothing; a copy of every snapshot comes back
 * on it. The server dedupes commands on seq and the client takes each snapshot
 * tick from whichever copy lands first, so the lane is only ever an extra copy:
 * no answer within a few seconds, UDP blocked (offices, schools, hotels), the
 * relay restarting — it quietly gives up and the WebSocket carries everything.
 * Browser-native RTCPeerConnection, no ICE servers: the relay has a public
 * address and learns ours from our first packet.
 */
import type { InputCmd } from "../../shared/protocol";

export interface UdpStats { up: boolean; sent: number; recv: number; why: string }
export interface UdpLane {
  readonly stats: UdpStats;
  /** One command: sent as a bundle with the commands before it. */
  sendInput(cmd: InputCmd): void;
  close(): void;
}
/** Connect + answer + DataChannel open, all within this (ms) — or give up. */
const OPEN_MS = 6000;
/** Dead after this long without a packet (snapshots arrive at 32 Hz; keep-alives get an answer every second). */
const DEAD_MS = 4000;
const KEEPALIVE_MS = 1000;
/** Commands per bundle: the newest and the 3 before it. */
const BUNDLE = 4;
/** A channel this far behind is not worth adding to (a burst would only arrive late). */
const MAX_BUFFERED = 16 * 1024;
const KA = '{"t":"ka"}';

/** The relay's signalling URL for a game socket URL: wss://host/ws?map=x -> https://host/api/udp */
export function udpApiFor(wsUrl: string): string {
  const u = new URL(wsUrl, location.href);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = u.pathname.replace(/ws\/?$/, "") + "api/udp";
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * Open the lane. `onData`: a server message that came over UDP (a snapshot);
 * `onEnd`: the lane is gone (failed to open or died) — the caller may try again.
 */
export function openUdp(api: string, token: string, map: string, onData: (data: string) => void, onEnd: (why: string) => void): UdpLane {
  const stats: UdpStats = { up: false, sent: 0, recv: 0, why: "" };
  const recent: string[] = [];
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let ended = false;
  let rxAt = 0;
  let keep = 0;
  let openTimer = 0;
  const ctl = new AbortController();
  const end = (why: string) => {
    if (ended) return;
    ended = true;
    stats.up = false;
    stats.why = why;
    clearInterval(keep);
    clearTimeout(openTimer);
    try { ctl.abort(); } catch { /* */ }
    try { dc?.close(); } catch { /* */ }
    try { pc?.close(); } catch { /* */ }
    onEnd(why);
  };
  const lane: UdpLane = {
    stats,
    sendInput(cmd) {
      // Stringified once; the bundle is the last BUNDLE of these, oldest first.
      recent.push(JSON.stringify(cmd));
      if (recent.length > BUNDLE) recent.shift();
      if (!stats.up || !dc || dc.readyState !== "open" || dc.bufferedAmount > MAX_BUFFERED) return;
      try {
        dc.send(`{"t":"inb","c":[${recent.join(",")}]}`);
        stats.sent++;
      } catch {
        end("send failed");
      }
    },
    close() { end("closed"); },
  };
  if (typeof RTCPeerConnection === "undefined") {
    queueMicrotask(() => end("no webrtc"));
    return lane;
  }
  openTimer = window.setTimeout(() => end("timeout"), OPEN_MS);
  void (async () => {
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      dc = pc.createDataChannel("kong", { ordered: false, maxRetransmits: 0 });
      dc.onopen = () => {
        if (ended) return;
        clearTimeout(openTimer);
        stats.up = true;
        rxAt = performance.now();
        keep = window.setInterval(() => {
          if (performance.now() - rxAt > DEAD_MS) { end("silent"); return; }
          try { if (dc?.readyState === "open") dc.send(KA); } catch { /* the close follows */ }
        }, KEEPALIVE_MS);
      };
      dc.onmessage = (e) => {
        if (ended || typeof e.data !== "string") return;
        stats.recv++;
        rxAt = performance.now();
        if (e.data !== KA) onData(e.data);
      };
      dc.onclose = () => end("closed by relay");
      pc.onconnectionstatechange = () => {
        const s = pc?.connectionState;
        if (s === "failed" || s === "closed") end(`ice ${s}`);
      };
      await pc.setLocalDescription(await pc.createOffer());
      // Non-trickle: wait briefly for our candidates; the relay learns our address from our first packet anyway.
      await new Promise<void>((r) => {
        if (pc!.iceGatheringState === "complete") return r();
        const t = setTimeout(r, 400);
        pc!.onicegatheringstatechange = () => { if (pc?.iceGatheringState === "complete") { clearTimeout(t); r(); } };
      });
      if (ended) return;
      const res = await fetch(api, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, map, offer: pc.localDescription?.sdp }),
        credentials: "same-origin",
        signal: ctl.signal,
      });
      if (!res.ok) { end(`relay ${res.status}`); return; }
      const j = (await res.json()) as { answer?: string };
      if (ended) return;
      if (typeof j.answer !== "string") { end("no answer"); return; }
      await pc.setRemoteDescription({ type: "answer", sdp: j.answer });
    } catch (e) {
      end(`failed: ${String((e as Error)?.message ?? e).slice(0, 60)}`);
    }
  })();
  return lane;
}
