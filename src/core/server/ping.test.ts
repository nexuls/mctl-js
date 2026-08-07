/**
 * Tests for the Server List Ping client, driven against a **real TCP server**
 * that speaks the protocol back.
 *
 * Mocking the socket would test nothing worth testing here: the risk in this
 * module is the wire format — varint framing, the length prefix, a response
 * split across segments — so the fixture encodes a genuine status packet and the
 * client has to decode it. The one thing not covered is a real Minecraft server,
 * which is a live-network dependency and stays out of the default run.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server as TcpServer } from "node:net";
import { flattenChat, pingServer } from "./ping.ts";

/** Encode a value as a protocol varint (the mirror of the client's encoder). */
function varint(value: number): Buffer {
	const bytes: number[] = [];
	let rest = value >>> 0;
	do {
		let byte = rest & 0x7f;
		rest >>>= 7;
		if (rest !== 0) byte |= 0x80;
		bytes.push(byte);
	} while (rest !== 0);
	return Buffer.from(bytes);
}

/** Frame a JSON document as a Status Response packet. */
function statusPacket(json: unknown): Buffer {
	const text = Buffer.from(JSON.stringify(json), "utf8");
	const body = Buffer.concat([varint(0x00), varint(text.length), text]);
	return Buffer.concat([varint(body.length), body]);
}

let server: TcpServer | undefined;

afterEach(() => {
	server?.close();
	server = undefined;
});

/**
 * Start a fake server on an ephemeral port, handing each connection to
 * `respond`. Resolves the port once it is listening.
 */
function listen(
	respond: (socket: import("node:net").Socket) => void,
): Promise<number> {
	return new Promise((resolve) => {
		server = createServer(respond);
		server.listen(0, "127.0.0.1", () => {
			const address = server?.address();
			resolve(typeof address === "object" && address ? address.port : 0);
		});
	});
}

const STATUS = {
	version: { name: "Paper 1.21.4", protocol: 769 },
	players: {
		max: 20,
		online: 2,
		sample: [
			{ name: "alice", id: "0-0-0-0-1" },
			{ name: "bob", id: "0-0-0-0-2" },
		],
	},
	description: { text: "A ", extra: [{ text: "§aFancy" }, " Server"] },
};

describe("pingServer", () => {
	test("decodes a status response", async () => {
		const port = await listen((socket) => {
			// Wait for the handshake + request before answering, as a server does.
			socket.once("data", () => socket.write(statusPacket(STATUS)));
		});

		const status = await pingServer("127.0.0.1", port);
		expect(status).toBeDefined();
		expect(status?.versionName).toBe("Paper 1.21.4");
		expect(status?.protocol).toBe(769);
		expect(status?.playersOnline).toBe(2);
		expect(status?.playersMax).toBe(20);
		expect(status?.sample.map((p) => p.name)).toEqual(["alice", "bob"]);
		// The MOTD is flattened and its colour codes stripped.
		expect(status?.motd).toBe("A Fancy Server");
		expect(status?.latencyMs).toBeGreaterThanOrEqual(0);
	});

	test("reassembles a response split across TCP segments", async () => {
		const packet = statusPacket(STATUS);
		const port = await listen((socket) => {
			socket.once("data", () => {
				// Split mid-JSON: the client must buffer until the declared length
				// arrives instead of parsing the first chunk it sees.
				socket.write(packet.subarray(0, 12));
				setTimeout(() => socket.write(packet.subarray(12)), 25);
			});
		});

		expect((await pingServer("127.0.0.1", port))?.playersOnline).toBe(2);
	});

	test("resolves undefined when nothing is listening", async () => {
		// Port 1 is privileged and unbound in every sane environment.
		expect(await pingServer("127.0.0.1", 1, 500)).toBeUndefined();
	});

	test("resolves undefined when the server hangs up (pre-1.7 protocol)", async () => {
		const port = await listen((socket) => socket.destroy());
		expect(await pingServer("127.0.0.1", port, 500)).toBeUndefined();
	});

	test("resolves undefined on a garbage payload rather than throwing", async () => {
		const port = await listen((socket) => {
			socket.once("data", () =>
				socket.write(
					Buffer.concat([varint(6), varint(0x00), Buffer.from("]not{")]),
				),
			);
		});
		expect(await pingServer("127.0.0.1", port, 500)).toBeUndefined();
	});

	test("times out on a server that accepts but never answers", async () => {
		const port = await listen(() => {
			/* accept and stay silent */
		});
		const startedAt = performance.now();
		expect(await pingServer("127.0.0.1", port, 300)).toBeUndefined();
		expect(performance.now() - startedAt).toBeLessThan(2_000);
	});
});

describe("flattenChat", () => {
	test("accepts all three MOTD shapes servers send", () => {
		expect(flattenChat("plain")).toBe("plain");
		expect(flattenChat({ text: "object" })).toBe("object");
		expect(flattenChat({ text: "a", extra: [{ text: "b" }, "c"] })).toBe("abc");
	});

	test("strips legacy formatting codes", () => {
		expect(flattenChat("§lBold§r plain")).toBe("Bold plain");
	});

	test("yields an empty string for a shape it does not understand", () => {
		expect(flattenChat(undefined)).toBe("");
		expect(flattenChat(42)).toBe("");
	});
});
