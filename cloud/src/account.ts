// One Durable Object per odahcam account: the WebSockets of that account's Hangar apps, its device chain, and nothing
// of the catalog. Frames between devices are Noise messages the relay can't read; it only checks who may send them.
//
// Protocol (text frames are JSON, binary frames carry device traffic):
//   relay → app  {t:"challenge", nonce}                     on connect
//   app → relay  {t:"prove", device, sig}                   Ed25519 over "hangar-relay-v1\n<sub>\n<nonce>"
//   relay → app  {t:"ready", epoch, chain, online, reset}   chain: every entry; online: proven device keys;
//                                                           reset: when a pending recovery reset runs, or null
//   app → relay  {t:"auth", token}                          a fresh access token before the current one expires
//   app → relay  {t:"chain.append", entry}                  signed by the sending device
//   app → relay  {t:"chain.reset", id_token}                recovery when every device is lost: id_token of a fresh
//                                                           sign-in with nonce = this socket's challenge; runs after
//                                                           a grace period, and only this device may root the new chain
//   app → relay  {t:"chain.veto"}                           a member cancels a pending reset
//   relay → app  {t:"chain", epoch, entries} | {t:"reset", epoch} | {t:"reset.pending", at, by} | {t:"reset.vetoed"}
//   relay → app  {t:"reset.claimed", by}                    after a reset, the root now belongs to device `by`
//   relay → app  {t:"presence", online} | {t:"offline", device} | {t:"error", code} | {t:"auth.ok", exp}
//   binary       app → relay: 32-byte recipient key ‖ payload;  relay → app: 32-byte sender key ‖ payload
import { DurableObject } from "cloudflare:workers";
import { freshLogin, verify, type AuthEnv } from "./auth";
import { append, b64url, bodyOf, digest, isKey, unb64url, verifySig, type Entry, type Members } from "./chain";

export interface Env extends AuthEnv {
	ACCOUNT: DurableObjectNamespace<Account>;
	CONNECT_PER_IP: RateLimit;
	CONNECT_PER_ACCOUNT: RateLimit;
}

interface Attachment {
	sub: string;
	/** Token expiry, seconds since the epoch. */
	exp: number;
	nonce: string;
	/** When the socket connected, ms. */
	at: number;
	device?: string;
}

export const MAX_MEMBER_SOCKETS = 32;
/** Unproven sockets and devices outside the chain: pairing needs one or two, a token holder can't crowd members out. */
export const MAX_GUESTS = 4;
export const PROVE_WITHIN_MS = 10_000;
export const MAX_TEXT = 64 * 1024;
export const MAX_BINARY = 1024 * 1024;
/** A device outside the chain may only reach a member with frames this small: enough for pairing, not for commands. */
export const MAX_PAIRING = 4096;
/** Adds per signing device per hour. Removes aren't counted: revoking must always be possible. */
export const ADDS_PER_HOUR = 30;
/** A recovery reset needs a sign-in this recent: a refreshed token, stolen or kept by a removed device, isn't one. */
export const RECENT_LOGIN_S = 10 * 60;
/** Members are told and may veto for this long before a recovery reset empties the chain. */
export const RESET_GRACE_MS = 24 * 3600_000;
const RESET_EVERY_MS = 3600_000;
const MEMBER_RATE = { perSec: 100, burst: 200 };
const GUEST_RATE = { perSec: 0.5, burst: 10 };

export const CLOSE = { unproven: 4000, expired: 4001, replaced: 4002, removed: 4003, evicted: 4005, rate: 4008, protocol: 4009 } as const;

interface Chain {
	epoch: number;
	entries: Entry[];
	members: Members;
	digest: string;
}

export class Account extends DurableObject<Env> {
	private sql: SqlStorage;
	/** Per-socket token buckets. Lost when the object hibernates, which only ever forgives a quiet socket. */
	private buckets = new WeakMap<WebSocket, { tokens: number; at: number; member: boolean }>();
	/** The chain as stored, rebuilt after waking and after every change. */
	private cached?: Chain;
	/** Bumped on every change, so a read that straddled one isn't cached. */
	private gen = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`create table if not exists chain (seq integer primary key, body text not null, sig text not null);
			create table if not exists meta (key text primary key, value text not null);`);
		// Pings are answered without waking the object, so idle machines cost no duration.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
	}

	async fetch(req: Request): Promise<Response> {
		const sub = req.headers.get("x-relay-sub");
		const exp = Number(req.headers.get("x-relay-exp"));
		if (!sub || !Number.isFinite(exp)) return new Response(null, { status: 400 });
		// A new socket starts as a guest. Past the guest quota the oldest guest goes, so a member's reconnect always
		// gets in: it proves itself within milliseconds and stops being one.
		const { members } = await this.chain();
		const guests = this.ctx.getWebSockets().filter((s) => !this.isMember(s, members));
		if (guests.length >= MAX_GUESTS) {
			guests.sort((x, y) => this.att(x).at - this.att(y).at);
			for (const g of guests.slice(0, guests.length - MAX_GUESTS + 1)) this.close(g, CLOSE.evicted, "evicted");
		}
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
		const att: Attachment = { sub, exp, nonce, at: Date.now() };
		server.serializeAttachment(att);
		server.send(JSON.stringify({ t: "challenge", nonce }));
		await this.schedule();
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
		const c = await this.chain();
		if (!this.take(ws, this.isMember(ws, c.members))) return this.close(ws, CLOSE.rate, "rate");
		const att = this.att(ws);
		if (typeof msg !== "string") return this.forward(ws, att, msg, c.members);
		if (msg.length > MAX_TEXT) return this.close(ws, CLOSE.protocol, "too_big");
		let m: Record<string, unknown>;
		try {
			m = JSON.parse(msg);
		} catch {
			return this.close(ws, CLOSE.protocol, "json");
		}
		if (m.t === "prove") return this.prove(ws, att, m);
		if (!att.device) return this.close(ws, CLOSE.protocol, "unproven");
		switch (m.t) {
			case "auth":
				return this.reauth(ws, att, m.token);
			case "chain.append":
				return this.appendEntry(ws, att, m.entry as Entry);
			case "chain.reset":
				return this.requestReset(ws, att, m.id_token);
			case "chain.veto":
				return this.veto(ws, att);
			default:
				return this.error(ws, "unknown");
		}
	}

	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		this.close(ws, code === 1005 || code === 1006 ? 1000 : code, "");
		this.presence();
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.close(ws, 1011, "");
		this.presence();
	}

	/** Closes unproven sockets past their deadline and sockets whose token expired; runs a due recovery reset. */
	async alarm(): Promise<void> {
		const now = Date.now();
		let dropped = false;
		for (const ws of this.ctx.getWebSockets()) {
			const a = this.att(ws);
			if (!a.device && now - a.at >= PROVE_WITHIN_MS) this.close(ws, CLOSE.unproven, "unproven");
			else if (a.exp * 1000 <= now) (this.close(ws, CLOSE.expired, "expired"), (dropped = true));
		}
		if (dropped) this.presence();
		const due = Number(this.meta("reset_due") ?? 0);
		if (due && due <= now) await this.runReset();
		await this.schedule();
	}

	private async schedule(): Promise<void> {
		let next = Number(this.meta("reset_due") ?? 0) || Infinity;
		for (const ws of this.ctx.getWebSockets()) {
			const a = this.att(ws);
			next = Math.min(next, a.exp * 1000, a.device ? Infinity : a.at + PROVE_WITHIN_MS);
		}
		if (next === Infinity) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
	}

	private async prove(ws: WebSocket, att: Attachment, m: Record<string, unknown>): Promise<void> {
		if (att.device || !isKey(m.device) || typeof m.sig !== "string") return this.close(ws, CLOSE.protocol, "prove");
		const signed = new TextEncoder().encode(`hangar-relay-v1\n${att.sub}\n${att.nonce}`);
		if (!(await verifySig(m.device, m.sig, signed))) return this.close(ws, CLOSE.protocol, "prove");
		const c = await this.chain();
		// The device's own previous socket doesn't count: it is about to be replaced.
		const others = this.ctx.getWebSockets().filter((s) => this.isMember(s, c.members) && this.att(s).device !== m.device);
		if (c.members.has(m.device) && others.length >= MAX_MEMBER_SOCKETS) {
			return this.close(ws, CLOSE.evicted, "full");
		}
		// One socket per device: a reconnect replaces the old one instead of splitting its traffic.
		for (const other of this.sockets(m.device)) this.close(other, CLOSE.replaced, "replaced");
		att.device = m.device;
		ws.serializeAttachment(att);
		const due = Number(this.meta("reset_due") ?? 0) || null;
		ws.send(JSON.stringify({ t: "ready", epoch: c.epoch, chain: c.entries, online: this.online(), reset: due }));
		this.presence();
		await this.schedule();
	}

	private async reauth(ws: WebSocket, att: Attachment, token: unknown): Promise<void> {
		const id = typeof token === "string" ? await verify(this.env, token) : null;
		if (!id || id.sub !== att.sub) return this.error(ws, "auth");
		att.exp = id.exp;
		ws.serializeAttachment(att);
		ws.send(JSON.stringify({ t: "auth.ok", exp: id.exp }));
		await this.schedule();
	}

	private async appendEntry(ws: WebSocket, att: Attachment, entry: Entry): Promise<void> {
		if (typeof entry?.body !== "string" || typeof entry.sig !== "string") return this.error(ws, "malformed");
		const c = await this.chain();
		const after = await append(c.members, c.digest, c.entries.length, entry);
		if (typeof after === "string") return this.error(ws, after);
		const body = bodyOf(entry);
		// The sender signs what it sends: a member can't replay another member's signed entry as its own decision.
		if (body.signer !== att.device) return this.error(ws, "signer");
		// After a recovery reset only the device that asked for it may root the new chain: a stolen refresh token
		// can't ask (no fresh sign-in), so it mustn't win the race for the root either.
		if (body.op === "root" && c.epoch > 0 && body.device !== this.meta("reset_by")) return this.error(ws, "root");
		if (body.op === "add" && !this.countAdd(body.signer)) return this.error(ws, "rate");
		// The awaits above let another append (or a reset) run in between: the epoch and the primary key settle it.
		if ((await this.chain()).epoch !== c.epoch) return this.error(ws, "seq");
		try {
			this.sql.exec("insert into chain (seq, body, sig) values (?, ?, ?)", body.seq, entry.body, entry.sig);
		} catch {
			return this.error(ws, "seq");
		}
		this.invalidate();
		this.broadcast({ t: "chain", epoch: c.epoch, entries: [entry] });
		if (body.op === "remove") for (const s of this.sockets(body.device)) this.close(s, CLOSE.removed, "removed");
	}

	/** Adds signed by `signer` in the current hour; false once its quota is spent. */
	private countAdd(signer: string): boolean {
		const hour = String(Math.floor(Date.now() / 3600_000));
		const key = `adds:${signer}`;
		const [h, n] = (this.meta(key) ?? "").split(":");
		const count = h === hour ? Number(n) : 0;
		if (count >= ADDS_PER_HOUR) return false;
		this.setMeta(key, `${hour}:${count + 1}`);
		return true;
	}

	/**
	 * Recovery when no device of the chain is left. A member has nothing to recover: it removes devices instead. The
	 * request needs a recent interactive sign-in and only runs after RESET_GRACE_MS, during which any member online
	 * is told and can veto. Each Hangar still refuses the new root until paired from scratch, in person.
	 */
	private async requestReset(ws: WebSocket, att: Attachment, idToken: unknown): Promise<void> {
		const c = await this.chain();
		if (c.members.has(att.device!)) return this.error(ws, "member");
		if (!c.entries.length && c.epoch === 0) return this.error(ws, "empty");
		if (typeof idToken !== "string" || !(await freshLogin(this.env, idToken, att.sub, att.nonce, RECENT_LOGIN_S))) return this.error(ws, "login_required");
		// Reset already ran but its device never rooted the new chain (it lost its key, say): with no member left to
		// veto, a fresh sign-in just hands the root to this device.
		if (!c.entries.length) {
			this.setMeta("reset_by", att.device!);
			return void ws.send(JSON.stringify({ t: "reset.claimed", by: att.device }));
		}
		if (this.meta("reset_due")) return this.error(ws, "reset_pending");
		if (Date.now() - Number(this.meta("reset_requested") ?? 0) < RESET_EVERY_MS) return this.error(ws, "reset_soon");
		const due = Date.now() + RESET_GRACE_MS;
		this.setMeta("reset_due", String(due));
		this.setMeta("reset_requested", String(Date.now()));
		this.setMeta("reset_by", att.device!);
		this.broadcast({ t: "reset.pending", at: due, by: att.device });
		await this.schedule();
	}

	private async veto(ws: WebSocket, att: Attachment): Promise<void> {
		if (!(await this.chain()).members.has(att.device!)) return this.error(ws, "not_member");
		if (!this.meta("reset_due")) return this.error(ws, "no_reset");
		this.sql.exec("delete from meta where key = 'reset_due'");
		this.broadcast({ t: "reset.vetoed" });
		await this.schedule();
	}

	private async runReset(): Promise<void> {
		const epoch = (await this.chain()).epoch + 1;
		this.sql.exec("delete from chain");
		this.sql.exec("delete from meta where key = 'reset_due'");
		this.setMeta("epoch", String(epoch));
		this.invalidate();
		this.broadcast({ t: "reset", epoch });
	}

	/** Device traffic. A member reaches any proven socket; anyone else only reaches members, with pairing-sized frames. */
	private forward(ws: WebSocket, att: Attachment, msg: ArrayBuffer, members: Members): void {
		if (!att.device) return this.close(ws, CLOSE.protocol, "unproven");
		if (msg.byteLength < 33 || msg.byteLength > MAX_BINARY + 32) return this.close(ws, CLOSE.protocol, "size");
		const to = b64url(new Uint8Array(msg, 0, 32));
		if (!members.has(att.device) && (!members.has(to) || msg.byteLength > MAX_PAIRING + 32)) return this.error(ws, "not_member");
		const targets = this.sockets(to);
		if (!targets.length) return void ws.send(JSON.stringify({ t: "offline", device: to }));
		// The sender is stamped from the proven socket, never taken from the frame.
		const out = new Uint8Array(msg.byteLength);
		out.set(unb64url(att.device), 0);
		out.set(new Uint8Array(msg, 32), 32);
		for (const t of targets) t.send(out);
	}

	private async chain(): Promise<Chain> {
		if (this.cached) return this.cached;
		const gen = this.gen;
		const entries = this.sql.exec<{ body: string; sig: string }>("select body, sig from chain order by seq").toArray().map((r) => ({ body: r.body, sig: r.sig }));
		const members: Members = new Map();
		for (const e of entries) {
			const b = bodyOf(e);
			if (b.op === "remove") members.delete(b.device);
			else members.set(b.device, b.dh!);
		}
		const last = entries.at(-1);
		const c = { epoch: Number(this.meta("epoch") ?? 0), entries, members, digest: last ? await digest(last.body) : "" };
		// Another change may have landed while the digest was computed; only a still-current read is kept.
		if (gen === this.gen) this.cached = c;
		return c;
	}

	private invalidate(): void {
		this.cached = undefined;
		this.gen++;
	}

	private att(ws: WebSocket): Attachment {
		return ws.deserializeAttachment() as Attachment;
	}

	private isMember(ws: WebSocket, members: Members): boolean {
		const d = this.att(ws).device;
		return !!d && members.has(d);
	}

	private sockets(device: string): WebSocket[] {
		return this.ctx.getWebSockets().filter((s) => this.att(s).device === device);
	}

	private online(): string[] {
		const set = new Set<string>();
		for (const s of this.ctx.getWebSockets()) {
			const d = this.att(s).device;
			if (d && s.readyState === WebSocket.OPEN) set.add(d);
		}
		return [...set];
	}

	private presence(): void {
		this.broadcast({ t: "presence", online: this.online() });
	}

	private broadcast(m: unknown): void {
		const s = JSON.stringify(m);
		for (const ws of this.ctx.getWebSockets()) {
			if (this.att(ws).device && ws.readyState === WebSocket.OPEN) ws.send(s);
		}
	}

	private error(ws: WebSocket, code: string): void {
		ws.send(JSON.stringify({ t: "error", code }));
	}

	private close(ws: WebSocket, code: number, reason: string): void {
		try {
			ws.close(code, reason);
		} catch {
			// already closing
		}
	}

	private take(ws: WebSocket, member: boolean): boolean {
		const r = member ? MEMBER_RATE : GUEST_RATE;
		const now = Date.now();
		let b = this.buckets.get(ws);
		// Becoming a member (or ceasing to be one) starts a bucket of the new kind.
		if (!b || b.member !== member) b = { tokens: r.burst, at: now, member };
		b.tokens = Math.min(r.burst, b.tokens + ((now - b.at) / 1000) * r.perSec);
		b.at = now;
		this.buckets.set(ws, b);
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	}

	private meta(key: string): string | undefined {
		return this.sql.exec<{ value: string }>("select value from meta where key = ?", key).toArray()[0]?.value;
	}

	private setMeta(key: string, value: string): void {
		this.sql.exec("insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value", key, value);
	}
}
