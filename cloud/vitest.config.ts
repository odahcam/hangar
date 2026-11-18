import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { ISSUER_JWKS } from "./test/keys";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// The key set inline instead of the JWKS URL: the tests sign their own tokens.
			miniflare: { bindings: { JWKS: JSON.stringify(ISSUER_JWKS), ALLOWED_SUBS: "*" } },
		}),
	],
});
