// The shared cases (fixtures/chain.json) that core/src/cloud/chain.rs judges too: the relay and every Hangar must agree.
import { describe, expect, it } from "vitest";
import { append, digest, type Entry, type Members } from "../src/chain";
import cases from "./fixtures/chain.json";

describe("shared chain cases", () => {
	for (const [name, c] of Object.entries(cases as Record<string, { entries: Entry[]; error: string | null; members?: string[] }>)) {
		it(name, async () => {
			let members: Members = new Map();
			let prev = "";
			let error: string | null = null;
			for (const [i, e] of c.entries.entries()) {
				const r = await append(members, prev, i, e);
				if (typeof r === "string") {
					error = r;
					expect(i).toBe(c.entries.length - 1);
					break;
				}
				members = r;
				prev = await digest(e.body);
			}
			expect(error).toBe(c.error);
			if (c.members) expect([...members.keys()].sort()).toEqual(c.members);
		});
	}
});
