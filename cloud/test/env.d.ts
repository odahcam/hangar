import type { Env as RelayEnv } from "../src/account";

declare global {
	namespace Cloudflare {
		interface Env extends RelayEnv {}
	}
}
