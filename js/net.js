// Hosted-play client: realtime WebSocket transport with JSON control frames
// (lifecycle only) and compact binary gameplay frames (inputs out, snapshots
// in). Reconnects with the seat token and produces a "while you were away"
// summary from the server's resume payload.

const PHASE_NAMES = ['countdown', 'active', 'goalPause', 'terminal'];

export class HostedClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.room = null;
    this.seat = -1;
    this.token = null;
    this.name = 'Player';
    this.prevSnap = null;
    this.snap = null;
    this.snapAt = 0;
    this.prevSnapAt = 0;
    this.handlers = {};        // op -> fn(msg)
    this.onSnapshot = null;    // fn(snap, prevSnap, alphaInfo)
    this.onChat = null;
    this._reconnects = 0;
    this._awaySummary = null;
    this._sendTick = 0;
  }

  on(op, fn) { this.handlers[op] = fn; return this; }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return Promise.resolve();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.binaryType = 'arraybuffer';
      const fail = () => reject(new Error('connect-failed'));
      ws.onerror = fail;
      ws.onclose = () => {
        this.connected = false;
        if (this.room) this._scheduleReconnect();
      };
      ws.onopen = () => {
        this.connected = true;
        this._reconnects = 0;
        this.ws = ws;
        // hello doubles as resume when we hold a seat token.
        this.send({ op: 'hello', name: this.name, room: this.room, token: this.token });
        resolve();
      };
      ws.onmessage = (e) => this._onMessage(e);
    });
  }

  _scheduleReconnect() {
    if (this._reconnects >= 5) return this.handlers['disconnected']?.();
    const delay = Math.min(8000, 500 * 2 ** this._reconnects++);
    this.handlers['reconnecting']?.({ attempt: this._reconnects, delay });
    setTimeout(() => this.connect().catch(() => {}), delay);
  }

  send(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  createRoom() { this.send({ op: 'create' }); }
  joinRoom(code) { this.send({ op: 'join', room: code }); }
  startVsAI() { this.send({ op: 'start-vs-ai' }); }
  leave() {
    this.send({ op: 'leave' });
    this.room = null; this.seat = -1; this.token = null;
    this.snap = this.prevSnap = null;
    this.ws?.close();
  }
  sendChat(text) { this.send({ op: 'chat', text }); }

  /** Compact binary input frame: [u8 1][u32 tick][f32 x][f32 y]. */
  sendInput(x, y) {
    if (this.ws?.readyState !== 1) return;
    const buf = new ArrayBuffer(13);
    const v = new DataView(buf);
    v.setUint8(0, 1);
    v.setUint32(1, ++this._sendTick, true);
    v.setFloat32(5, x, true);
    v.setFloat32(9, y, true);
    this.ws.send(buf);
  }

  _onMessage(e) {
    if (typeof e.data === 'string') {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.op) {
        case 'created': case 'joined':
          this.room = msg.room; this.seat = msg.seat; this.token = msg.token;
          break;
        case 'resumed':
          this.room = msg.room; this.seat = msg.seat;
          this._awaySummary = msg.missed
            ? `While you were away: score ${msg.missed.scores[0]}–${msg.missed.scores[1]}, tick ${msg.missed.tick}.`
            : null;
          break;
        case 'chat':
          this.onChat?.(msg);
          break;
      }
      this.handlers[msg.op]?.(msg);
      return;
    }
    // Binary snapshot frame.
    const v = new DataView(e.data);
    if (v.byteLength !== 31 || v.getUint8(0) !== 2) return;
    this.prevSnap = this.snap;
    this.prevSnapAt = this.snapAt;
    this.snap = {
      tick: v.getUint32(1, true),
      puck: { x: v.getFloat32(5, true), y: v.getFloat32(9, true) },
      mallets: [
        { x: v.getFloat32(13, true), y: v.getFloat32(17, true) },
        { x: v.getFloat32(21, true), y: v.getFloat32(25, true) },
      ],
      scores: [v.getUint8(29), v.getUint8(30) & 0x0f],
      phase: PHASE_NAMES[v.getUint8(30) >> 4],
    };
    this.snapAt = performance.now();
    this.onSnapshot?.(this.snap, this.prevSnap, this.snapshotInterval());
  }

  /** Interpolation interval derived from observed snapshot cadence. */
  snapshotInterval() {
    const d = this.snapAt - this.prevSnapAt;
    return d > 10 && d < 500 ? d : 50;
  }

  takeAwaySummary() {
    const s = this._awaySummary;
    this._awaySummary = null;
    return s;
  }
}
