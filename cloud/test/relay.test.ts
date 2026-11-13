import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { b64url, canonical, digest, type Body, type Entry } from "../src/chain";
import { ISSUER_PRIVATE } from "./keys";

const ISSUER = "https://auth.odahcam.com";
const AUD = "https://hangar.odahcam.com";
const now = () => Math.floor(Date.now() / 1000);

// Each test gets accounts of its own: Durable Object storage and sockets outlive a test.
let SUB = "";
let OTHER = "";
// ...and an address of its own, as the connection rate limits count per address.
let IP = "";
beforeEach(() => {
	SUB = `user-${crypto.randomUUID()}`;
	OTHER = `user-${crypto.randomUUID()}`;
	IP = `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 256)).join(".")}`;
});

async function token(claims: Record<string, unknown> = {}, alg = "EdDSA"): Promise<string> {
	const key = alg === "HS256" ? new TextEncoder().encode("x".repeat(32)) : await importJWK(ISSUER_PRIVATE, "EdDSA");
	return new SignJWT({ azp: "hangar", ...claims })
		.setProtectedHeader({ alg, kid: "test" })
		.setIssuer((claims.iss as string) ?? ISSUER)
		.setAudience((claims.aud as string[]) ?? [AUD, `${ISSUER}/api/auth/oauth2/userinfo`])
		.setSubject((claims.sub as string) ?? SUB)
		.setExpirationTime((claims.exp as number) ?? now() + 3600)
		.sign(key);
}

interface Device {
	pub: string;
	dh: string;
	sign(data: string): Promise<string>;
}

async function device(): Promise<Device> {
	const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const pub = b64url((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
	const dh = b64url(crypto.getRandomValues(new Uint8Array(32)));
	return { pub, dh, sign: async (data) => b64url(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(data))) };
}

class Conn {
	queue: (string | ArrayBuffer)[] = [];
	waiters: (() => void)[] = [];
	closed?: number;
	nonce = "";
	constructor(public ws: WebSocket) {
		ws.accept();
		ws.addEventListener("message", (e) => (this.queue.push(e.data as string | ArrayBuffer), this.waiters.splice(0).forEach((w) => w())));
		ws.addEventListener("close", (e) => ((this.closed = e.code), this.waiters.splice(0).forEach((w) => w())));
	}
	async next(): Promise<string | ArrayBuffer> {
		for (let i = 0; !this.queue.length; i++) {
			if (this.closed !== undefined) throw new Error(`closed ${this.closed}`);
			await new Promise<void>((r) => (this.waiters.push(r), setTimeout(r, 200)));
			if (i > 25) throw new Error("timeout");
		}
		return this.queue.shift()!;
	}
	/** The next JSON frame of type t, skipping presence updates. */
	async json(t?: string): Promise<Record<string, any>> {
		for (;;) {
			const m = await this.next();
			if (typeof m !== "string") throw new Error("binary");
			const j = JSON.parse(m);
			if (!t ? j.t !== "presence" : j.t === t) return j;
			if (j.t === "error") throw new Error(`expected ${t}, got error ${j.code}`);
		}
	}
	async binary(): Promise<Uint8Array> {
		for (;;) {
			const m: unknown = await this.next();
			if (m instanceof Blob) return new Uint8Array(await m.arrayBuffer());
			if (m instanceof ArrayBuffer) return new Uint8Array(m);
		}
	}
	async closedWith(): Promise<number> {
		for (let i = 0; this.closed === undefined && i < 25; i++) await new Promise<void>((r) => (this.waiters.push(r), setTimeout(r, 200)));
		return this.closed!;
	}
	send(m: unknown) {
		this.ws.send(typeof m === "string" || m instanceof Uint8Array ? m : JSON.stringify(m));
	}
}

async function upgrade(tok?: string, ip = IP): Promise<Response> {
	const headers: Record<string, string> = { upgrade: "websocket", "cf-connecting-ip": ip };
	if (tok) headers.authorization = `Bearer ${tok}`;
	return SELF.fetch("https://hangar.odahcam.com/v1/connect", { headers });
}

async function connect(tok?: string): Promise<Conn> {
	const r = await upgrade(tok ?? (await token()));
	expect(r.status).toBe(101);
	return new Conn(r.webSocket!);
}

/** Connects and proves `d`; returns the connection and its ready frame. */
async function online(d: Device, tok?: string, sub = SUB): Promise<[Conn, Record<string, any>]> {
	const c = await connect(tok);
	const { nonce } = await c.json("challenge");
	c.nonce = nonce;
	c.send({ t: "prove", device: d.pub, sig: await d.sign(`hangar-relay-v1\n${sub}\n${nonce}`) });
	return [c, await c.json("ready")];
}

/** An id_token of an interactive sign-in, as the Hangar client gets it from the authorize endpoint. */
async function idToken(claims: Record<string, unknown>): Promise<string> {
	return token({ aud: ["hangar"], auth_time: now() - 30, ...claims });
}

async function entry(signer: Device, body: Omit<Body, "v" | "signer">): Promise<Entry> {
	const text = canonical({ v: 1, signer: signer.pub, ...body });
	return { body: text, sig: await signer.sign(text) };
}

async function signedText(signer: Device, text: string): Promise<Entry> {
	return { body: text, sig: await signer.sign(text) };
}

function stub(sub = SUB) {
	return env.ACCOUNT.get(env.ACCOUNT.idFromName(sub));
}

async function root(d: Device): Promise<Entry> {
	return entry(d, { seq: 0, prev: "", op: "root", device: d.pub, dh: d.dh });
}

function frame(to: string, payload: Uint8Array): Uint8Array {
	const k = Uint8Array.from(atob(to.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
	const out = new Uint8Array(32 + payload.length);
	out.set(k);
	out.set(payload, 32);
	return out;
}

describe("upgrade", () => {
	it("refuses a request without a valid access token for this relay", async () => {
		const bad = [
			undefined,
			"opaque-token-without-dots",
			await token({ aud: ["https://other.odahcam.com"] }),
			await token({ aud: ["hangar"] }), // an id_token's audience is the client id
			await token({ iss: "https://evil.example" }),
			await token({ azp: "another-client" }),
			await token({ exp: now() - 10 }),
			await token({}, "HS256"),
		];
		for (const t of bad) expect((await upgrade(t)).status).toBe(401);
	});

	it("accepts a JWT whose audience contains the relay and challenges the socket", async () => {
		const c = await connect();
		expect((await c.json("challenge")).nonce).toMatch(/^[\w-]{43}$/);
	});

	it("limits connection attempts per address, junk tokens included, and per account", async () => {
		const codes = [];
		for (let i = 0; i < 31; i++) codes.push((await upgrade("junk")).status);
		expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
		const r = await upgrade(await token());
		expect(r.status).toBe(429);
		expect(r.headers.get("retry-after")).toBe("60");
		// Another address still gets in; the account's own limit holds whatever the address.
		const tok = await token({ sub: OTHER });
		const fresh = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 256)).join(".")}`;
		for (let i = 0; i < 30; i++) expect((await upgrade(tok, fresh())).status).toBe(101);
		expect((await upgrade(tok, fresh())).status).toBe(429);
	});

	it("never takes the account from the client", async () => {
		const r = await SELF.fetch("https://hangar.odahcam.com/v1/connect", {
			headers: { upgrade: "websocket", "cf-connecting-ip": IP, authorization: `Bearer ${await token()}`, "x-relay-sub": OTHER },
		});
		const c = new Conn(r.webSocket!);
		const d = await device();
		const { nonce } = await c.json("challenge");
		// Signed for the header's account: refused, because the socket belongs to the token's.
		c.send({ t: "prove", device: d.pub, sig: await d.sign(`hangar-relay-v1\n${OTHER}\n${nonce}`) });
		expect(await c.closedWith()).toBe(4009);
	});
});

describe("proof of the device key", () => {
	it("closes a socket whose proof is signed by another key", async () => {
		const [a, b] = [await device(), await device()];
		const c = await connect();
		const { nonce } = await c.json("challenge");
		c.send({ t: "prove", device: a.pub, sig: await b.sign(`hangar-relay-v1\n${SUB}\n${nonce}`) });
		expect(await c.closedWith()).toBe(4009);
	});

	it("refuses anything but the proof before it", async () => {
		const c = await connect();
		await c.json("challenge");
		c.send({ t: "chain.reset" });
		expect(await c.closedWith()).toBe(4009);
	});

	it("past the guest quota the oldest guest goes, and a member still gets in", async () => {
		const a = await device();
		const [ca] = await online(a);
		ca.send({ t: "chain.append", entry: await root(a) });
		await ca.json("chain");
		const guests: Conn[] = [];
		for (let i = 0; i < 5; i++) guests.push(await connect());
		expect(await guests[0]!.closedWith()).toBe(4005);
		const [again] = await online(a);
		expect(await ca.closedWith()).toBe(4002);
		expect(again.closed).toBeUndefined();
	});

	it("drops a socket that doesn't prove itself in time", async () => {
		const c = await connect();
		await c.json("challenge");
		await runInDurableObject(stub(), async (_o, state) => {
			for (const ws of state.getWebSockets()) ws.serializeAttachment({ ...ws.deserializeAttachment(), at: 0 });
		});
		await runDurableObjectAlarm(stub());
		expect(await c.closedWith()).toBe(4000);
	});

	it("a reconnect of the same device replaces the old socket", async () => {
		const a = await device();
		const [first] = await online(a);
		await online(a);
		expect(await first.closedWith()).toBe(4002);
	});
});

describe("device chain", () => {
	it("the first device roots the chain and every proven socket hears it", async () => {
		const [a, b] = [await device(), await device()];
		const [ca, ready] = await online(a);
		expect(ready.chain).toEqual([]);
		const [cb] = await online(b);
		const r = await root(a);
		ca.send({ t: "chain.append", entry: r });
		expect((await cb.json("chain")).entries).toEqual([r]);
		const [, again] = await online(await device());
		expect(again.chain).toEqual([r]);
	});

	it("refuses a second root, an add by a non-member and an entry its sender didn't sign", async () => {
		const [a, b, c] = [await device(), await device(), await device()];
		const [ca] = await online(a);
		const [cb] = await online(b);
		const r = await root(a);
		ca.send({ t: "chain.append", entry: r });
		await ca.json("chain");
		cb.send({ t: "chain.append", entry: await root(b) });
		expect((await cb.json("error")).code).toBe("seq");
		const prev = await digest(r.body);
		cb.send({ t: "chain.append", entry: await entry(b, { seq: 1, prev, op: "add", device: b.pub, dh: b.dh }) });
		expect((await cb.json("error")).code).toBe("signer");
		// Signed by member a, but sent by b: b can't push a's decisions.
		cb.send({ t: "chain.append", entry: await entry(a, { seq: 1, prev, op: "add", device: c.pub, dh: c.dh }) });
		expect((await cb.json("error")).code).toBe("signer");
	});

	it("refuses an entry whose signature or link to the previous one is wrong", async () => {
		const [a, b] = [await device(), await device()];
		const [ca] = await online(a);
		const r = await root(a);
		ca.send({ t: "chain.append", entry: r });
		await ca.json("chain");
		const good = await entry(a, { seq: 1, prev: await digest(r.body), op: "add", device: b.pub, dh: b.dh });
		ca.send({ t: "chain.append", entry: { body: good.body, sig: (await root(b)).sig } });
		expect((await ca.json("error")).code).toBe("sig");
		ca.send({ t: "chain.append", entry: await entry(a, { seq: 1, prev: "x", op: "add", device: b.pub, dh: b.dh }) });
		expect((await ca.json("error")).code).toBe("prev");
	});

	it("accepts only the canonical text of an entry", async () => {
		const a = await device();
		const [ca] = await online(a);
		const body = { seq: 0, prev: "", op: "root", device: a.pub, dh: a.dh } as const;
		const c = canonical({ v: 1, signer: a.pub, ...body });
		const variants = [
			c.replace('"seq":0', '"seq":0.0'),
			c.replace("{", '{"seq":5,'), // duplicate key: JSON.parse keeps the last
			c.replace("}", ',"extra":1}'),
			JSON.stringify(JSON.parse(c), null, 1),
			JSON.stringify({ signer: a.pub, v: 1, ...body }),
		];
		for (const v of variants) {
			ca.send({ t: "chain.append", entry: await signedText(a, v) });
			expect((await ca.json("error")).code).toBe("malformed");
		}
	});

	it("caps adds per signer per hour, but never a remove", async () => {
		const [a, b, c] = [await device(), await device(), await device()];
		const [ca] = await online(a);
		let last = await root(a);
		ca.send({ t: "chain.append", entry: last });
		await ca.json("chain");
		const push = async (body: Omit<Body, "v" | "signer" | "seq" | "prev">) => {
			const e = await entry(a, { seq: JSON.parse(last.body).seq + 1, prev: await digest(last.body), ...body } as Omit<Body, "v" | "signer">);
			ca.send({ t: "chain.append", entry: e });
			const m = await ca.json();
			if (m.t !== "error") last = e;
			return m;
		};
		await push({ op: "add", device: c.pub, dh: c.dh });
		let adds = 1;
		for (;;) {
			const m = await push({ op: "add", device: b.pub, dh: b.dh });
			if (m.t === "error") {
				expect(m.code).toBe("rate");
				break;
			}
			adds++;
			await push({ op: "remove", device: b.pub });
		}
		expect(adds).toBe(30);
		expect((await push({ op: "remove", device: c.pub })).t).toBe("chain");
	});

	it("removing a device closes its socket", async () => {
		const [a, b] = [await device(), await device()];
		const [ca] = await online(a);
		const [cb] = await online(b);
		const r = await root(a);
		ca.send({ t: "chain.append", entry: r });
		await ca.json("chain");
		const add = await entry(a, { seq: 1, prev: await digest(r.body), op: "add", device: b.pub, dh: b.dh });
		ca.send({ t: "chain.append", entry: add });
		await ca.json("chain");
		ca.send({ t: "chain.append", entry: await entry(a, { seq: 2, prev: await digest(add.body), op: "remove", device: b.pub }) });
		expect(await cb.closedWith()).toBe(4003);
	});
});

describe("device traffic", () => {
	async function paired(): Promise<[Device, Conn, Device, Conn, Device, Conn]> {
		const [a, b, x] = [await device(), await device(), await device()];
		const [ca] = await online(a);
		const [cb] = await online(b);
		const [cx] = await online(x);
		const r = await root(a);
		ca.send({ t: "chain.append", entry: r });
		await ca.json("chain");
		ca.send({ t: "chain.append", entry: await entry(a, { seq: 1, prev: await digest(r.body), op: "add", device: b.pub, dh: b.dh }) });
		await ca.json("chain");
		return [a, ca, b, cb, x, cx];
	}

	it("delivers a member's frame stamped with the sender's key", async () => {
		const [a, ca, b, cb] = await paired();
		ca.send(frame(b.pub, new Uint8Array([1, 2, 3])));
		const got = await cb.binary();
		expect(b64url(got.slice(0, 32))).toBe(a.pub);
		expect([...got.slice(32)]).toEqual([1, 2, 3]);
	});

	it("a device outside the chain reaches members only with pairing-sized frames, and no one else", async () => {
		const [, , b, cb, x, cx] = await paired();
		cx.send(frame(b.pub, new Uint8Array(4096)));
		expect((await cb.binary()).length).toBe(32 + 4096);
		cx.send(frame(b.pub, new Uint8Array(4097)));
		expect((await cx.json("error")).code).toBe("not_member");
		const y = await device();
		await online(y);
		cx.send(frame(y.pub, new Uint8Array(8)));
		expect((await cx.json("error")).code).toBe("not_member");
	});

	it("never crosses accounts", async () => {
		const [a, ca] = await paired();
		const z = await device();
		const [cz] = await online(z, await token({ sub: OTHER }), OTHER);
		cz.send({ t: "chain.append", entry: await root(z) });
		await cz.json("chain");
		cz.send(frame(a.pub, new Uint8Array(8)));
		expect((await cz.json("offline")).device).toBe(a.pub);
		ca.send(frame(z.pub, new Uint8Array(8)));
		expect((await ca.json("offline")).device).toBe(z.pub);
	});
});

describe("token lifetime", () => {
	it("closes a socket when its token expires", async () => {
		const a = await device();
		const [c] = await online(a, await token({ exp: now() + 2 }));
		await new Promise((r) => setTimeout(r, 2100));
		await runDurableObjectAlarm(env.ACCOUNT.get(env.ACCOUNT.idFromName(SUB)));
		expect(await c.closedWith()).toBe(4001);
	});

	it("takes a fresh token for the same account only", async () => {
		const a = await device();
		const [c] = await online(a);
		c.send({ t: "auth", token: await token({ sub: OTHER }) });
		expect((await c.json("error")).code).toBe("auth");
		const exp = now() + 7200;
		c.send({ t: "auth", token: await token({ exp }) });
		expect((await c.json("auth.ok")).exp).toBe(exp);
	});
});

describe("recovery reset", () => {
	async function rooted(): Promise<[Device, Conn]> {
		const a = await device();
		const [ca] = await online(a);
		ca.send({ t: "chain.append", entry: await root(a) });
		await ca.json("chain");
		return [a, ca];
	}

	it("a member can't reset, and neither can anyone without a fresh sign-in bound to the socket", async () => {
		const [, ca] = await rooted();
		ca.send({ t: "chain.reset", id_token: await idToken({ nonce: ca.nonce }) });
		expect((await ca.json("error")).code).toBe("member");
		const [cx] = await online(await device());
		const bad = [
			undefined,
			await token({ nonce: cx.nonce, auth_time: now() - 30 }), // an access token, not an id_token
			await idToken({ nonce: cx.nonce, auth_time: now() - 3600 }),
			await idToken({ nonce: "another-socket" }),
			await idToken({ nonce: cx.nonce, sub: OTHER }),
		];
		for (const id_token of bad) {
			cx.send({ t: "chain.reset", id_token });
			expect((await cx.json("error")).code).toBe("login_required");
		}
	});

	it("only the device that asked for it roots the next chain", async () => {
		const [, ca] = await rooted();
		const x = await device();
		const [cx] = await online(x);
		cx.send({ t: "chain.reset", id_token: await idToken({ nonce: cx.nonce }) });
		// Everyone is told who asked: only that device treats the reset as its own.
		expect((await ca.json("reset.pending")).by).toBe(x.pub);
		await runInDurableObject(stub(), async (_o, state) => {
			state.storage.sql.exec("update meta set value = '1' where key = 'reset_due'");
		});
		await runDurableObjectAlarm(stub());
		await cx.json("reset");
		const y = await device();
		const [cy] = await online(y);
		cy.send({ t: "chain.append", entry: await root(y) });
		expect((await cy.json("error")).code).toBe("root");
		// x lost its key before rooting: a fresh sign-in on another device takes the root over, with no grace period.
		cy.send({ t: "chain.reset", id_token: await idToken({ nonce: cy.nonce, auth_time: now() - 3600 }) });
		expect((await cy.json("error")).code).toBe("login_required");
		cy.send({ t: "chain.reset", id_token: await idToken({ nonce: cy.nonce }) });
		expect((await cy.json("reset.claimed")).by).toBe(y.pub);
		cx.send({ t: "chain.append", entry: await root(x) });
		expect((await cx.json("error")).code).toBe("root");
		cy.send({ t: "chain.append", entry: await root(y) });
		expect((await cy.json("chain")).epoch).toBe(1);
	});

	it("is announced to members, who can veto it", async () => {
		const [, ca] = await rooted();
		const [cx] = await online(await device());
		cx.send({ t: "chain.reset", id_token: await idToken({ nonce: cx.nonce }) });
		expect((await ca.json("reset.pending")).at).toBeGreaterThan(Date.now() + 23 * 3600_000);
		ca.send({ t: "chain.veto" });
		await ca.json("reset.vetoed");
		await runDurableObjectAlarm(stub());
		const [, ready] = await online(await device());
		expect(ready.chain.length).toBe(1);
		expect(ready.reset).toBeNull();
	});

	it("empties the chain only once the grace period is over", async () => {
		const [, ca] = await rooted();
		const [cx] = await online(await device());
		cx.send({ t: "chain.reset", id_token: await idToken({ nonce: cx.nonce }) });
		await ca.json("reset.pending");
		await runDurableObjectAlarm(stub());
		expect((await online(await device()))[1].chain.length).toBe(1);
		await runInDurableObject(stub(), async (_o, state) => {
			state.storage.sql.exec("update meta set value = '1' where key = 'reset_due'");
		});
		await runDurableObjectAlarm(stub());
		expect((await ca.json("reset")).epoch).toBe(1);
		expect((await online(await device()))[1].chain).toEqual([]);
	});
});

describe("allowed accounts", () => {
	it("serves only the accounts listed", async () => {
		const { verify } = await import("../src/auth");
		const base = { ISSUER, AUDIENCE: AUD, CLIENT_ID: "hangar", JWKS: env.JWKS };
		expect(await verify({ ...base, ALLOWED_SUBS: "" }, await token())).toBeNull();
		expect(await verify({ ...base, ALLOWED_SUBS: `a, ${SUB}` }, await token())).not.toBeNull();
		expect(await verify({ ...base, ALLOWED_SUBS: "a,b" }, await token())).toBeNull();
	});
});
