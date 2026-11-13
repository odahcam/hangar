// hangar.odahcam.com: authenticates the WebSocket upgrade and hands it to the account's Durable Object.
import { bearer, verify } from "./auth";
import type { Env } from "./account";

export { Account } from "./account";

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname !== "/v1/connect") return new Response(null, { status: 404 });
		if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
		const token = bearer(req);
		const id = token ? await verify(env, token) : null;
		if (!id) return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="hangar"' } });
		// Attempts per address are limited at the edge (a rate limiting rule of the zone, before this runs); the
		// edge can't read the token, so attempts per account are limited here, so one stolen token can't churn the
		// account's object. Per account and address first, so that token spends its own address's budget and not the
		// one the account's machines reconnect on; per account alone, higher, as the ceiling.
		// The app reconnects with backoff (core/src/cloud/link.rs), which a 429 just lengthens.
		const where = addressKey(req.headers.get("cf-connecting-ip") ?? "");
		if (!(await env.CONNECT_PER_ACCOUNT_ADDRESS.limit({ key: `${id.sub} ${where}` })).success) return tooMany();
		if (!(await env.CONNECT_PER_ACCOUNT.limit({ key: id.sub })).success) return tooMany();
		// Only this Worker reaches the object, so these headers can't come from the client: a fresh Request carries
		// the upgrade and nothing else of the original.
		const fwd = new Request("https://account/connect", {
			headers: { upgrade: "websocket", "x-relay-sub": id.sub, "x-relay-exp": String(id.exp) },
		});
		return env.ACCOUNT.get(env.ACCOUNT.idFromName(id.sub)).fetch(fwd);
	},
} satisfies ExportedHandler<Env>;

/** An IPv6 address counts by its /64, which one host usually gets whole; IPv4 as is. */
export function addressKey(ip: string): string {
	if (!ip.includes(":")) return ip;
	const [head, tail = ""] = ip.toLowerCase().split("::");
	const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
	const groups = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
	return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

function tooMany(): Response {
	return new Response(null, { status: 429, headers: { "retry-after": "60" } });
}
