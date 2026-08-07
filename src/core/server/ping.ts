/**
 * Minecraft Server List Ping (SLP) — ask a running server, over its own public
 * protocol, what it would tell a player's multiplayer screen: MOTD, version,
 * player count, and a sample of who is online.
 *
 * Core service — no UI, no provider imports, no filesystem. This is the only way
 * to learn the *live* player count without RCON or a mod: it is exactly what the
 * vanilla client does when it renders a server in the multiplayer list, so it
 * works against every server kind MCTL supports and needs no configuration,
 * credentials, or op status.
 *
 * Statelessness holds here too — nothing is cached; each call is a fresh socket
 * against a fresh probe (architecture.md § Statelessness).
 *
 * **Protocol** (1.7+, the "modern" JSON status path), documented at
 * https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping:
 *
 *   1. TCP connect.
 *   2. Send a **Handshake** packet (id `0x00`) with `nextState = 1` (status).
 *   3. Send an empty **Status Request** (id `0x00`).
 *   4. Read the **Status Response** (id `0x00`) — one JSON string.
 *
 * Every packet is `varint length | varint packet-id | payload`. Servers older
 * than 1.7 speak a different, incompatible handshake and simply drop this one;
 * that is reported as an absent status, not an error.
 */

import { connect, type Socket } from "node:net";
import { z } from "zod";

/** How long the whole exchange may take before it is abandoned. */
const PING_TIMEOUT_MS = 2_000;

/**
 * Protocol version sent in the handshake. `-1` is the conventional "unknown /
 * just pinging" value: the status path ignores it, and sending a real version
 * number would make MCTL look like a client that must be version-matched.
 */
const PROTOCOL_UNKNOWN = -1;

/** One player from the status response's sample list. */
export interface PlayerSample {
	/** Player name as the server reports it. */
	name: string;
	/** Player UUID. */
	id: string;
}

/** What a server answers a list ping with. */
export interface ServerStatus {
	/** MOTD, flattened to plain text with formatting codes stripped. */
	motd: string;
	/** Version string the server advertises, e.g. `"Paper 1.21.4"`. */
	versionName: string;
	/** Protocol version number. */
	protocol: number;
	/** Players currently connected. */
	playersOnline: number;
	/** Player slots. */
	playersMax: number;
	/**
	 * A *sample* of online players — typically up to 12, and servers may shuffle,
	 * truncate, or disable it entirely. Never treat its length as the player
	 * count; {@link playersOnline} is the count.
	 */
	sample: PlayerSample[];
	/** Round-trip time of the status exchange, in milliseconds. */
	latencyMs: number;
}

/**
 * A Minecraft chat component, as the MOTD arrives. Recursive: a component may
 * carry `extra` children, each of which is itself a component (or, in the
 * shorthand servers still emit, a bare string).
 */
type ChatComponent =
	| string
	| {
			text?: string;
			extra?: ChatComponent[];
			translate?: string;
	  };

/** The status response JSON. Validated at the boundary — this is network data. */
const StatusResponse = z.object({
	version: z
		.object({
			name: z.string().default("unknown"),
			protocol: z.number().default(0),
		})
		.prefault({}),
	players: z
		.object({
			max: z.number().default(0),
			online: z.number().default(0),
			sample: z
				.array(z.object({ name: z.string(), id: z.string() }))
				.default([]),
		})
		.prefault({}),
	// A chat component in any of its shapes; flattened by `flattenChat`.
	description: z.unknown().optional(),
});

/**
 * Flatten a chat component to plain text and strip legacy `§`-prefixed
 * formatting codes. Servers send the MOTD as a bare string, as `{text}`, or as a
 * `{text, extra: [...]}` tree with per-segment colours — all three appear in the
 * wild, so all three are handled.
 */
export function flattenChat(component: unknown): string {
	const walk = (node: ChatComponent | unknown): string => {
		if (typeof node === "string") return node;
		if (node === null || typeof node !== "object") return "";
		const value = node as Exclude<ChatComponent, string>;
		const own = value.text ?? value.translate ?? "";
		const children = (value.extra ?? []).map(walk).join("");
		return own + children;
	};
	// `§` plus one character is Minecraft's legacy colour/format escape; it is
	// meaningless outside a Minecraft client and would render as mojibake here.
	return walk(component).replace(/§./g, "");
}

/** Encode a signed 32-bit integer as a protocol varint. */
function varint(value: number): Buffer {
	const bytes: number[] = [];
	let rest = value >>> 0; // Two's complement, so -1 becomes the 5-byte max.
	do {
		let byte = rest & 0x7f;
		rest >>>= 7;
		if (rest !== 0) byte |= 0x80;
		bytes.push(byte);
	} while (rest !== 0);
	return Buffer.from(bytes);
}

/**
 * Decode a varint at `offset`, or `undefined` when `buffer` does not yet hold a
 * complete one (the caller should wait for more bytes).
 */
function readVarint(
	buffer: Buffer,
	offset: number,
): { value: number; size: number } | undefined {
	let value = 0;
	let size = 0;
	for (;;) {
		if (offset + size >= buffer.length) return undefined;
		const byte = buffer[offset + size] as number;
		value |= (byte & 0x7f) << (7 * size);
		size += 1;
		if ((byte & 0x80) === 0) return { value, size };
		if (size > 5) return undefined; // Malformed: a varint is at most 5 bytes.
	}
}

/** Frame a payload as `varint length | payload`. */
function packet(...parts: Buffer[]): Buffer {
	const body = Buffer.concat(parts);
	return Buffer.concat([varint(body.length), body]);
}

/** Encode a protocol string: `varint byte-length | UTF-8 bytes`. */
function protocolString(value: string): Buffer {
	const bytes = Buffer.from(value, "utf8");
	return Buffer.concat([varint(bytes.length), bytes]);
}

/**
 * Ask the server at `host:port` for its status. Resolves `undefined` when the
 * server does not answer in time, refuses the connection, or speaks a protocol
 * this does not understand — all of which are ordinary for a server that is
 * still booting, and none of which should surface as an error in a UI that is
 * merely decorating a row.
 *
 * @param host hostname or IP to connect to; `127.0.0.1` for a local server.
 * @param port the server's TCP port (`server-port` in `server.properties`).
 */
export function pingServer(
	host: string,
	port: number,
	timeoutMs: number = PING_TIMEOUT_MS,
): Promise<ServerStatus | undefined> {
	return new Promise((resolve) => {
		const startedAt = performance.now();
		let socket: Socket;
		let settled = false;
		let buffer = Buffer.alloc(0);

		const finish = (status: ServerStatus | undefined) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(status);
		};

		try {
			socket = connect({ host, port });
		} catch {
			resolve(undefined);
			return;
		}

		socket.setTimeout(timeoutMs);
		socket.on("timeout", () => finish(undefined));
		socket.on("error", () => finish(undefined));
		// A close before a full response means the server hung up on us —
		// typically a pre-1.7 server, or one still initialising its listener.
		//
		// **Both** `end` and `close` are handled, and `end` is the load-bearing
		// one: with a `data` listener attached the socket is in flowing mode, and
		// a peer that sends FIN without a reply then leaves the connection
		// half-open — `close` does not arrive until the timeout, so listening for
		// it alone stalls the whole probe. `data` always precedes `end`, so a real
		// response is still decoded first.
		socket.on("end", () => finish(undefined));
		socket.on("close", () => finish(undefined));

		socket.on("connect", () => {
			socket.write(
				packet(
					varint(0x00), // Handshake
					varint(PROTOCOL_UNKNOWN),
					protocolString(host),
					(() => {
						const b = Buffer.alloc(2);
						b.writeUInt16BE(port);
						return b;
					})(),
					varint(1), // Next state: status
				),
			);
			socket.write(packet(varint(0x00))); // Status Request
		});

		// `chunk` is a Buffer because `setEncoding` is never called on this socket;
		// Node's overload widens it to `string | Buffer`, so it is named here.
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);

			// The response can arrive across several TCP segments, so decode only
			// once the declared packet length is fully buffered.
			const length = readVarint(buffer, 0);
			if (!length) return;
			const total = length.size + length.value;
			if (buffer.length < total) return;

			const id = readVarint(buffer, length.size);
			if (id?.value !== 0x00) return finish(undefined);
			const jsonLength = readVarint(buffer, length.size + id.size);
			if (!jsonLength) return finish(undefined);

			const start = length.size + id.size + jsonLength.size;
			const text = buffer
				.subarray(start, start + jsonLength.value)
				.toString("utf8");

			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				return finish(undefined);
			}
			const result = StatusResponse.safeParse(parsed);
			if (!result.success) return finish(undefined);

			finish({
				motd: flattenChat(result.data.description).trim(),
				versionName: result.data.version.name,
				protocol: result.data.version.protocol,
				playersOnline: result.data.players.online,
				playersMax: result.data.players.max,
				sample: result.data.players.sample,
				latencyMs: Math.round(performance.now() - startedAt),
			});
		});
	});
}
