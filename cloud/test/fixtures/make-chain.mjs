// Writes chain.json: device-chain cases that the relay (chain.ts) and every Hangar (core/src/cloud/chain.rs) must
// judge the same way. Each case is a list of entries and the error the last one gets (null: all accepted).
// Run with `node cloud/test/fixtures/make-chain.mjs`; keys are fresh each time.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { writeFileSync } from "node:fs";

const b64 = (b) => Buffer.from(b).toString("base64url");
function device() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const pub = b64(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
	return { pub, dh: b64(randomBytes(32)), sign: (text) => b64(sign(null, Buffer.from(text), privateKey)) };
}
const canonical = ({ v, seq, prev, op, device, dh, signer }) =>
	JSON.stringify(dh === undefined ? { v, seq, prev, op, device, signer } : { v, seq, prev, op, device, dh, signer });
const digest = (body) => b64(createHash("sha256").update(body).digest());
const entry = (signer, text) => ({ body: text, sig: signer.sign(text) });

const [a, b, c] = [device(), device(), device()];
const root = entry(a, canonical({ v: 1, seq: 0, prev: "", op: "root", device: a.pub, dh: a.dh, signer: a.pub }));
const addB = entry(a, canonical({ v: 1, seq: 1, prev: digest(root.body), op: "add", device: b.pub, dh: b.dh, signer: a.pub }));
const addCbyB = entry(b, canonical({ v: 1, seq: 2, prev: digest(addB.body), op: "add", device: c.pub, dh: c.dh, signer: b.pub }));
const removeA = entry(b, canonical({ v: 1, seq: 3, prev: digest(addCbyB.body), op: "remove", device: a.pub, signer: b.pub }));
const rootText = root.body;

const cases = {
	valid: { entries: [root, addB, addCbyB, removeA], error: null, members: [b.pub, c.pub].sort() },
	float_seq: { entries: [entry(a, rootText.replace('"seq":0', '"seq":0.0'))], error: "malformed" },
	duplicate_key: { entries: [entry(a, rootText.replace("{", '{"seq":5,'))], error: "malformed" },
	extra_field: { entries: [entry(a, rootText.replace(/}$/, ',"x":1}'))], error: "malformed" },
	whitespace: { entries: [entry(a, JSON.stringify(JSON.parse(rootText), null, 1))], error: "malformed" },
	key_order: { entries: [entry(a, JSON.stringify({ signer: a.pub, ...JSON.parse(rootText) }))], error: "malformed" },
	unicode_escape: { entries: [entry(a, rootText.replace('"root"', '"r\\u006fot"'))], error: "malformed" },
	wrong_sig: { entries: [{ body: rootText, sig: b.sign(rootText) }], error: "sig" },
	removed_signer: { entries: [root, addB, addCbyB, removeA, entry(a, canonical({ v: 1, seq: 4, prev: digest(removeA.body), op: "add", device: device().pub, dh: b.dh, signer: a.pub }))], error: "signer" },
	bad_prev: { entries: [root, entry(a, canonical({ v: 1, seq: 1, prev: digest("x"), op: "add", device: b.pub, dh: b.dh, signer: a.pub }))], error: "prev" },
	// The same 32 bytes with the last character's spare bits set: only the canonical spelling is a key.
	loose_key: (() => {
		const last = a.pub.at(-1);
		const i = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(last);
		const loose = a.pub.slice(0, -1) + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[i ^ 1];
		return { entries: [entry(a, canonical({ v: 1, seq: 0, prev: "", op: "root", device: loose, dh: a.dh, signer: loose }))], error: "malformed" };
	})(),
	second_root: { entries: [root, entry(b, canonical({ v: 1, seq: 1, prev: digest(root.body), op: "root", device: b.pub, dh: b.dh, signer: b.pub }))], error: "root" },
};
writeFileSync(new URL("./chain.json", import.meta.url), JSON.stringify(cases, null, "\t") + "\n");
