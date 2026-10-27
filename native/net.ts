// Hosted Play on StarHermit realtime rooms, refereed by server.js. The room is
// the lobby (a 1v1 table: two teams of one seat; create and open it, quick
// join an open one, join by its code, invite friends, accept their invites,
// chat over the room socket); when it starts — as soon as the second seat is
// taken, or at once with "Start vs AI", which gives the empty seat to the
// platform's AI participant — the platform binds a session to it and the
// match runs in server.js. This client then only sends its mallet target as
// realtime input on the session's game socket (`ws/v1/games`) and draws the
// script's snapshots (interpolated between the last two), events and result.
// The browser build's host-routed match (the host's browser ran the
// simulation and POSTed the room result) and its dev server.js's WebSocket
// rooms are gone: nothing a client says decides a hosted result.
// Reconnects are the runtime's (both sockets reconnect by themselves); a
// reconnection resyncs with { type: 'sync' }.
import { frame } from "starhermit:engine";
import type { JsonValue, Unsubscribe } from "starhermit:engine";
import { connectGame, friends as platformFriends, player, rooms, type GameSocket, type Room, type RoomSocket } from "starhermit:platform";

export interface Snap {
  k: number; ph: string; pt: number; p: number[]; m: number[]; s: number[]; at: number; tl: number; ot: boolean;
  ev: { type: string; [key: string]: unknown }[];
}
export interface Table { seats: { name: string; ai: boolean; userId: string | null }[]; seed: number; targetScore: number; timeLimitSeconds: number }
export interface Over { winner: number; reason: string; scores: number[]; breakdown: { winner: number; reason: string; players: Record<string, number>[] }; finalHash: string }
export interface ChatLine { from: string; text: string }
export interface Invite { id: string; name: string }
export interface FriendRow { userId: string; name: string; online: boolean; invited: boolean }

export interface HostedEvents {
  lobby(): void;
  start(): void;
  snap(s: Snap): void;
  over(o: Over): void;
  chat(line: ChatLine): void;
  toast(key: string, vars?: Record<string, string | number>): void;
  ended(reason: "signed-out" | "terms-required" | "unavailable" | "closed"): void;
}

const ROOM = { teamCount: 2, seatsPerTeam: 1 };

export class Hosted {
  room: Room | null = null;
  /** English status key (+ vars) the lobby shows. */
  status = "";
  statusVars: Record<string, string | number> = {};
  chat: ChatLine[] = [];
  friends: FriendRow[] | null = null;
  invites: Invite[] = [];
  seat = 0;
  table: Table | null = null;
  prev: Snap | null = null;
  cur: Snap | null = null;
  curAt = 0;
  interval = 1 / 30;
  over: Over | null = null;
  playing = false;
  busy = false;
  private socket: RoomSocket | null = null;
  private game: GameSocket | null = null;
  private subs: Unsubscribe[] = [];
  private gameSubs: Unsubscribe[] = [];
  private sessionId: string | null = null;
  private lastSent = { x: NaN, y: NaN, at: -1 };

  constructor(private readonly on: HostedEvents) {}

  get isHost(): boolean { return !!this.room && !!player() && this.room.hostUserId === player()!.userId; }
  get joined(): boolean { return !!this.room; }
  get joinCode(): string | null { return this.room?.joinCode ?? null; }

  private say(key: string, vars: Record<string, string | number> = {}): void { this.status = key; this.statusVars = vars; this.on.lobby(); }

  /** The lobby opened: an unfinished room of this player's is adopted (a match in progress resumes). */
  async enter(): Promise<void> {
    this.chat = [];
    this.say("Create a room and an opponent can quick-join it, or quick-join an open table yourself.");
    void this.loadInvites();
    try {
      const mine = await rooms.mine();
      if (mine && mine.status !== "closed" && !this.room) this.adopt(mine);
    } catch { /* none */ }
  }

  async create(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say("Creating room…");
    try {
      // A table waits for its opponent (the browser build's rooms never filled themselves); the host may start against the AI.
      const room = await rooms.create({ ...ROOM, backfillAfterSeconds: 3600, metadata: { mode: "1v1" } });
      this.adopt(room);
      try { this.adopt(await rooms.open(room.id)); } catch { /* still joinable by code and invites */ }
      void this.loadFriends();
    } catch (e) { this.fail(e); }
    finally { this.busy = false; }
  }

  async quickJoin(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say("Looking for an open table…");
    try {
      const room = await rooms.quickJoin({ ...ROOM });
      if (!room) this.say("No open tables right now. Create a room instead and an opponent can join you.");
      else this.adopt(room);
    } catch (e) { this.fail(e); }
    finally { this.busy = false; }
  }

  async joinByCode(code: string): Promise<void> {
    const c = code.trim().toUpperCase();
    if (!c || this.busy) return;
    this.busy = true;
    this.say("Joining…");
    try { this.adopt(await rooms.joinByCode(c)); }
    catch (e) { this.fail(e, "That room code is not open."); }
    finally { this.busy = false; }
  }

  async acceptInvite(id: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say("Joining…");
    try { this.adopt(await rooms.acceptInvite(id)); }
    catch { this.invites = this.invites.filter((i) => i.id !== id); this.say("That invite is no longer valid."); }
    finally { this.busy = false; }
  }
  async declineInvite(id: string): Promise<void> {
    this.invites = this.invites.filter((i) => i.id !== id);
    this.on.lobby();
    try { await rooms.declineInvite(id); } catch { /* gone */ }
  }
  async inviteFriend(userId: string): Promise<void> {
    if (!this.room) return;
    try {
      await rooms.invite(this.room.id, userId);
      const f = this.friends?.find((x) => x.userId === userId);
      if (f) f.invited = true;
      this.on.lobby();
    } catch { this.on.toast("Invite not sent"); }
  }

  /** Host: start now; the empty seat becomes the platform's AI participant, played by server.js. */
  async startVsAI(): Promise<void> {
    if (!this.room || !this.isHost || this.busy) return;
    this.busy = true;
    this.say("Starting…");
    try { this.adopt(await rooms.start(this.room.id)); }
    catch (e) { this.fail(e); }
    finally { this.busy = false; }
  }

  sendChat(text: string): void {
    const clean = String(text ?? "").slice(0, 200).trim();
    if (!clean || !this.socket) return;
    if (this.socket.sendChat(clean)) this.chat.push({ from: player()?.displayName ?? "You", text: clean });
    else this.on.toast("Chat is limited to 10 messages a minute.");
    this.on.lobby();
  }

  /** Mallet target (table units) for the script; sent when it changes, at most 30 a second. */
  sendInput(x: number, y: number): void {
    if (!this.game || !this.playing || this.over) return;
    const t = frame().time;
    if (Math.abs(x - this.lastSent.x) < 0.05 && Math.abs(y - this.lastSent.y) < 0.05) return;
    if (t - this.lastSent.at < 1 / 30) return;
    try { if (this.game.sendInput({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 })) this.lastSent = { x, y, at: t }; }
    catch { /* paced */ }
  }

  /** Leave Match / Leave Room: a running match is conceded first; the seat is released. */
  async leave(): Promise<void> {
    const room = this.room;
    if (this.game && this.playing && !this.over) { try { this.game.sendCommand({ type: "forfeit" }); } catch { /* closing */ } }
    this.reset();
    if (room) { try { await rooms.leave(room.id); } catch { /* the room's TTL frees it */ } }
  }

  private reset(): void {
    for (const u of [...this.subs, ...this.gameSubs]) u();
    this.subs = []; this.gameSubs = [];
    try { this.socket?.close(); } catch { /* closed */ }
    try { this.game?.close(); } catch { /* closed */ }
    this.socket = null; this.game = null;
    this.room = null; this.sessionId = null;
    this.playing = false; this.table = null; this.prev = this.cur = null; this.over = null;
    this.friends = null;
  }

  private fail(e: unknown, fallback = "Online play is unavailable right now. Solo modes remain available."): void {
    const kind = (e as { kind?: string })?.kind;
    if (kind === "active-room-elsewhere" || kind === "conflict") this.say("You are already in another room. Leave it first.");
    else if (kind === "signed-out") this.say("Sign in to StarHermit to play hosted matches.");
    else this.say(fallback);
  }

  private adopt(room: Room): void {
    const first = !this.room || this.room.id !== room.id;
    this.room = room;
    if (first) {
      for (const u of this.subs) u();
      this.subs = [];
      try { this.socket?.close(); } catch { /* closed */ }
      const s = rooms.connect(room.id);
      this.socket = s;
      this.subs.push(
        s.on("roster", (r) => this.onRoster(r)),
        s.on("control", (from, kind, frame) => { if (kind === "chat") this.onChat(from, frame); }),
        s.on("stopped", (reason) => {
          if (this.playing) return; // the match lives on the game socket
          if (reason === "signed-out") this.on.ended("signed-out");
          else if (reason === "terms-required") this.on.ended("terms-required");
          else if (this.room) { this.reset(); this.on.ended("unavailable"); }
        }),
      );
    }
    this.onRoster(room);
  }

  private nameOf(participantId: string): string {
    const p = this.room?.participants.find((x) => x.id === participantId);
    return p ? p.displayName || p.username : "Opponent";
  }
  private onChat(from: string, frame: JsonValue): void {
    const f = frame as { text?: unknown } | null;
    const text = typeof f?.text === "string" ? f.text.slice(0, 200) : "";
    if (!text) return;
    const line = { from: this.nameOf(from), text };
    this.chat.push(line);
    if (this.chat.length > 30) this.chat.shift();
    this.on.chat(line);
  }

  /** Lobby rows: [name, role] per seat. */
  players(): { name: string; you: boolean; ai: boolean; host: boolean }[] {
    const me = player()?.userId;
    return [...(this.room?.participants ?? [])].sort((a, b) => a.team - b.team || a.slot - b.slot)
      .map((p) => ({ name: p.displayName || p.username, you: !!me && p.userId === me, ai: p.isAi, host: p.isHost }));
  }

  private onRoster(room: Room): void {
    this.room = room;
    const me = player()?.userId;
    const mine = room.participants.find((p) => p.userId === me);
    this.seat = mine?.team === 1 ? 1 : 0;
    if (room.status === "closed") {
      if (!this.playing) { this.reset(); this.say("The room closed."); }
      return;
    }
    if (room.status === "playing" && room.gameSessionId && room.gameSessionId !== this.sessionId) {
      this.connectGame(room.gameSessionId);
      return;
    }
    if (room.status === "playing" && !room.gameSessionId) { this.say("This table could not start its match. Leave and try again."); return; }
    if (!this.playing) {
      const others = room.participants.filter((p) => p.userId !== me);
      if (this.isHost) this.say(others.length ? "{name} joined. Match starting…" : "Room open. Waiting for an opponent to quick-join, or start against the AI.", others.length ? { name: others[0]!.displayName || others[0]!.username } : {});
      else this.say("Joined. Waiting for the match to start…");
    }
  }

  private connectGame(sessionId: string): void {
    this.sessionId = sessionId;
    for (const u of this.gameSubs) u();
    this.gameSubs = [];
    const g = connectGame(sessionId);
    this.game = g;
    this.playing = true;
    this.over = null;
    this.prev = this.cur = null;
    this.lastSent = { x: NaN, y: NaN, at: -1 };
    this.on.start();
    let away: number | null = null;
    this.gameSubs.push(
      g.on("open", () => { g.sendCommand({ type: "sync" }); }),
      g.on("resumed", (lostMs) => { away = lostMs; this.prev = null; g.sendCommand({ type: "sync" }); }),
      g.on("game", (data) => {
        const d = data as { type?: string } | null;
        if (!d) return;
        if (d.type === "table") this.table = d as unknown as Table;
        else if (d.type === "snap") {
          const s = d as unknown as Snap;
          const t = frame().time;
          if (this.cur) { const dt = t - this.curAt; if (dt > 0.005 && dt < 0.5) this.interval = this.interval * 0.8 + dt * 0.2; }
          this.prev = this.cur;
          this.cur = s;
          this.curAt = t;
          if (away != null) {
            this.on.toast("While you were away: score {a}–{b}, tick {tick}.", { a: s.s[0]!, b: s.s[1]!, tick: s.k });
            away = null;
          }
          this.on.snap(s);
        } else if (d.type === "over") {
          if (this.over) return;
          this.over = d as unknown as Over;
          this.on.over(this.over);
        }
      }),
      g.on("stopped", (reason) => {
        if (reason === "signed-out") this.on.ended("signed-out");
        else if (reason === "terms-required") this.on.ended("terms-required");
        else if (!this.over) this.on.ended(reason === "ended" || reason === "forbidden" || reason === "build-mismatch" ? "unavailable" : "closed");
      }),
      g.on("disconnected", (_code, retry) => { if (!this.over) this.on.toast("Reconnecting (attempt {n})…", { n: Math.max(1, Math.round(retry / 500)) }); }),
    );
  }

  /** The match is over (results shown): release the sockets and the seat. */
  finish(): void {
    const room = this.room;
    this.reset();
    if (room) void rooms.leave(room.id).catch(() => undefined);
  }

  async loadFriends(): Promise<void> {
    try {
      const list = await platformFriends.list();
      this.friends = list.map((f) => ({ userId: f.userId, name: f.username, online: f.online, invited: false }));
    } catch { this.friends = []; }
    this.on.lobby();
  }
  async loadInvites(): Promise<void> {
    try { this.invites = (await rooms.invites()).map((i) => ({ id: i.id, name: i.fromUsername })); }
    catch { this.invites = []; }
    this.on.lobby();
  }
}
