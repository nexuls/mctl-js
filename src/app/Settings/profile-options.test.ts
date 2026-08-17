/**
 * The profile picker's option list.
 *
 * Small, but it carries a decision worth pinning: the picker replaced a
 * *second* list — a "Default profile" radio group beside it, listing the same
 * names — so which profile new servers get is now shown **on** the profile,
 * in its own option description. If that marker stops being drawn, the default
 * becomes invisible in the UI that sets it.
 */

import { describe, expect, test } from "bun:test";
import { profileOptions } from "./index.tsx";
import { emptyProfile } from "./use-settings.ts";

describe("profileOptions", () => {
	test("describes each profile by its provider and marks the default", () => {
		const options = profileOptions(
			[
				emptyProfile("direct"),
				{ ...emptyProfile("cf"), provider: "cloudflared" },
			],
			"cf",
		);
		expect(options[0]).toEqual({
			label: "direct",
			value: "direct",
			description: "direct",
		});
		expect(options[1]?.description).toBe("cloudflared · default");
	});

	test("names a profile's DNS hostname alongside its provider", () => {
		const [option] = profileOptions(
			[
				{
					...emptyProfile("cf"),
					provider: "cloudflared",
					dnsEnabled: true,
					dnsHostname: "mc.example.com",
				},
			],
			"direct",
		);
		expect(option?.description).toBe("cloudflared · dns mc.example.com");
	});

	test("a freshly-added profile is listed before it has a name", () => {
		// `New profile` deliberately starts unnamed so the user names it rather
		// than deleting a generated one — but it still has to be findable in the
		// picker while they do, or the row they are editing is not in the list.
		const [option] = profileOptions([emptyProfile("")], "direct");
		expect(option?.label).toBe("(unnamed)");
		expect(option?.value).toBe("");
	});
});
