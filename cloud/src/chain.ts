// The account's device chain: an append-only log of signed entries, rooted at the first device's key. Every Hangar
// verifies the whole chain itself and pins its root and length; the relay verifies it too, so a socket that isn't a
// member can't send commands even before the peers refuse them. Devices are named by their Ed25519 public key.
//
// An entry is the exact JSON text that was signed (`body`) plus the Ed25519 signature over its UTF-8 bytes (`sig`), so
// nobody has to agree on a canonical serialization. Device names stay out of it: the relay sees keys, not labels.

export interface Entry {
	body: string;
	sig: string;
}

export interface Body {
	v: 1;
	seq: number;
	/** SHA-256 of the previous entry's body, base64url; "" for the root. */
	prev: string;
	op: "root" | "add" | "remove";
	/** Ed25519 public key of the device added or removed, base64url (32 bytes). */
	device: string;
	/** X25519 public key the device uses for Noise, base64url (32 bytes); root and add only. */
	dh?: string;
	/** Ed25519 public key of the member that signed this entry; the device itself for the root. */
	signer: string;
}

export const MAX_MEMBERS = 32;
/** Adds per epoch: add/remove cycles can't grow the log, and the ready frame that carries it, without bound. */
export const MAX_ENTRIES = 256;

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const B64URL_64 = /^[A-Za-z0-9_-]{86}$/;

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
	let s = "";
	for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
	return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function unb64url(s: string): Uint8Array {
	const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// atob ignores the last character's spare bits, so two spellings decode to the same bytes; the Hangar core decodes
// strictly. Only the spelling that re-encodes to itself is accepted, so both sides read every key and signature alike.
function strict(s: string): boolean {
	try {
		return b64url(unb64url(s)) === s;
	} catch {
		return false;
	}
}

export function isKey(s: unknown): s is string {
	return typeof s === "string" && B64URL_32.test(s) && strict(s);
}

export async function verifySig(pub: string, sig: string, data: Uint8Array): Promise<boolean> {
	if (!isKey(pub) || typeof sig !== "string" || !B64URL_64.test(sig) || !strict(sig)) return false;
	try {
		const key = await crypto.subtle.importKey("raw", unb64url(pub), { name: "Ed25519" }, false, ["verify"]);
		return await crypto.subtle.verify("Ed25519", key, unb64url(sig), data);
	} catch {
		return false;
	}
}

export async function digest(body: string): Promise<string> {
	return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
}

function parse(body: string): Body | null {
	let b: unknown;
	try {
		b = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof b !== "object" || b === null) return null;
	const o = b as Record<string, unknown>;
	if (o.v !== 1 || !Number.isSafeInteger(o.seq) || typeof o.prev !== "string" || !isKey(o.device) || !isKey(o.signer)) return null;
	if (o.op !== "root" && o.op !== "add" && o.op !== "remove") return null;
	if ((o.op === "remove") !== (o.dh === undefined) || (o.dh !== undefined && !isKey(o.dh))) return null;
	const b2 = o as unknown as Body;
	// Only the canonical text is valid: duplicate keys, extra fields, 1.0 for 1 and other spellings that two JSON
	// parsers could read differently would let the relay and a Hangar disagree on what was signed.
	return body.length <= 1024 && body === canonical(b2) ? b2 : null;
}

/** The one accepted serialization: fields in this order, dh only for root and add, no whitespace. */
export function canonical(b: Body): string {
	const { v, seq, prev, op, device, dh, signer } = b;
	return JSON.stringify(dh === undefined ? { v, seq, prev, op, device, signer } : { v, seq, prev, op, device, dh, signer });
}

/** Members (device key → Noise key) after the given entries. */
export type Members = Map<string, string>;

/**
 * Checks `next` against the chain so far (`members`, the previous body's digest and length) and returns the members
 * after it, or the reason it is refused.
 */
export async function append(members: Members, prevDigest: string, length: number, next: Entry): Promise<Members | string> {
	if (typeof next?.body !== "string" || next.body.length > 1024) return "malformed";
	const b = parse(next.body);
	if (!b) return "malformed";
	if (b.seq !== length) return "seq";
	// Only adds are capped: a remove needs a member to remove, so removes never outnumber adds, and revoking a device
	// must work on a full log too.
	if (b.op === "add" && length >= MAX_ENTRIES) return "full";
	if (b.prev !== prevDigest) return "prev";
	if (b.op === "root") {
		if (length !== 0 || b.signer !== b.device || b.prev !== "") return "root";
	} else if (length === 0) {
		return "root";
	} else if (!members.has(b.signer)) {
		return "signer";
	}
	if (b.op === "add" && members.has(b.device)) return "member";
	if (b.op === "add" && members.size >= MAX_MEMBERS) return "full";
	if (b.op === "remove" && !members.has(b.device)) return "not_member";
	if (!(await verifySig(b.signer, next.sig, new TextEncoder().encode(next.body)))) return "sig";
	const after = new Map(members);
	if (b.op === "remove") after.delete(b.device);
	else after.set(b.device, b.dh!);
	return after;
}

export function bodyOf(e: Entry): Body {
	return JSON.parse(e.body) as Body;
}
