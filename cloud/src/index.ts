// hangar.odahcam.com: authenticates the WebSocket upgrade and hands it to the account's Durable Object.
import { bearer, verify } from "./auth";
import type { Env } from "./account";

export { Account } from "./account";

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname !== "/v1/connect") return new Response(null, { status: 404 });
		if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
		// Per address before the token is even read (Cloudflare sets the header; a client's own is overwritten), so
		// junk tokens can't burn CPU; per account after, so one stolen token can't churn the account's object.
		// The app reconnects with backoff (core/src/cloud/link.rs), which a 429 just lengthens.
		const ip = req.headers.get("cf-connecting-ip") ?? "";
		if (!(await env.CONNECT_PER_IP.limit({ key: ip })).success) return tooMany();
		const token = bearer(req);
		const id = token ? await verify(env, token) : null;
		if (!id) return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="hangar"' } });
		if (!(await env.CONNECT_PER_ACCOUNT.limit({ key: id.sub })).success) return tooMany();
		// Only this Worker reaches the object, so these headers can't come from the client: a fresh Request carries
		// the upgrade and nothing else of the original.
		const fwd = new Request("https://account/connect", {
			headers: { upgrade: "websocket", "x-relay-sub": id.sub, "x-relay-exp": String(id.exp) },
		});
		return env.ACCOUNT.get(env.ACCOUNT.idFromName(id.sub)).fetch(fwd);
	},
} satisfies ExportedHandler<Env>;

function tooMany(): Response {
	return new Response(null, { status: 429, headers: { "retry-after": "60" } });
}
