// Access tokens from auth.odahcam.com. Only a JWT issued for this relay's resource (RFC 8707) is accepted: a token
// without our audience (opaque, or for another client of the identity service) and an id_token are refused, never
// looked up at /userinfo as a fallback.
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AuthEnv {
	ISSUER: string;
	AUDIENCE: string;
	CLIENT_ID: string;
	/** The JWKS URL; tests pass the key set itself as JSON. */
	JWKS: string;
	/**
	 * Accounts (sub) the relay serves, comma-separated; "*" serves every account. Sign-up at auth.odahcam.com is open
	 * and every account's traffic counts against the same Cloudflare Free quota, so it is a list while use is personal.
	 */
	ALLOWED_SUBS: string;
}

function allowed(env: AuthEnv, sub: string): boolean {
	const list = (env.ALLOWED_SUBS ?? "").split(",").map((s) => s.trim());
	return list.includes("*") || list.includes(sub);
}

export interface Identity {
	sub: string;
	/** Seconds since the epoch. */
	exp: number;
}

// Asymmetric only: "none" and HS* would let anyone holding the JWKS (it is public) mint tokens.
const ALGORITHMS = ["EdDSA", "ES256", "ES384", "RS256", "PS256"];

let keys: { src: string; get: JWTVerifyGetKey } | undefined;

function keySet(env: AuthEnv): JWTVerifyGetKey {
	if (keys?.src !== env.JWKS) {
		const get = env.JWKS.trimStart().startsWith("{") ? createLocalJWKSet(JSON.parse(env.JWKS)) : createRemoteJWKSet(new URL(env.JWKS));
		keys = { src: env.JWKS, get };
	}
	return keys.get;
}

export async function verify(env: AuthEnv, token: string): Promise<Identity | null> {
	try {
		const { payload } = await jwtVerify(token, keySet(env), {
			issuer: env.ISSUER,
			audience: env.AUDIENCE,
			algorithms: ALGORITHMS,
			requiredClaims: ["sub", "exp"],
		});
		// An id_token carries aud = client_id, which the audience check above already refuses; azp pins the client.
		if ((payload.azp ?? payload.client_id) !== env.CLIENT_ID) return null;
		if (typeof payload.sub !== "string" || !payload.sub || typeof payload.exp !== "number") return null;
		if (!allowed(env, payload.sub)) return null;
		return { sub: payload.sub, exp: payload.exp };
	} catch {
		return null;
	}
}

/**
 * Proof of a fresh interactive sign-in for one request: an id_token for the Hangar client whose nonce is the socket's
 * challenge, so an old id_token can't be replayed, and whose auth_time is recent. Access tokens never carry auth_time
 * (the identity service treats it as reserved there), hence the id_token for this one purpose.
 */
export async function freshLogin(env: AuthEnv, idToken: string, sub: string, nonce: string, maxAgeS: number): Promise<boolean> {
	try {
		const { payload } = await jwtVerify(idToken, keySet(env), {
			issuer: env.ISSUER,
			audience: env.CLIENT_ID,
			algorithms: ALGORITHMS,
			requiredClaims: ["sub", "exp", "nonce", "auth_time"],
		});
		return payload.sub === sub && payload.nonce === nonce && typeof payload.auth_time === "number" && Date.now() / 1000 - payload.auth_time <= maxAgeS;
	} catch {
		return false;
	}
}

export function bearer(req: Request): string | null {
	const h = req.headers.get("authorization");
	const m = h && /^Bearer ([\w.~+/-]+=*)$/.exec(h);
	return m?.[1] ?? null;
}
