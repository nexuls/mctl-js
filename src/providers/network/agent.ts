/**
 * Shared machinery for network providers whose work is **a long-lived agent
 * process**: start it detached, read the address it announces out of its own
 * output, record that in `~/.local/state/mctl/network/<id>.json`, and let any
 * later instance find, show and stop it.
 *
 * This sits *beside* the providers rather than inside one, the same way
 * `providers/server/mojang-meta.ts` does: cloudflared, playit and ngrok differ
 * only in which binary they run and which line of output carries the hostname,
 * and having each re-implement detached spawning and descriptor bookkeeping is
 * how three subtly different reaping bugs get written. It imports no provider,
 * so the "no provider imports another provider" rule is untouched.
 *
 * `lib/`, `core/session/`-free, `types/` only — no UI, no argv.
 *
 * **Why the address is scraped from stdout.** None of these agents has a local
 * API that MCTL can query for "what address did you get?" without also asking
 * the user to configure one (ngrok's local API is the closest, and it is opt-in
 * and port-bound). They all *print* it, once, at startup. So the output goes to
 * a file — durable, readable by every instance, and the only diagnosis available
 * when an agent refuses to come up — and the address is matched out of it.
 */

import { readTextIfExists, writeJsonAtomic } from "../../lib/fs.ts";
import { ensureDir } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { networkFile, networkLogFile, networkDir } from "../../lib/paths.ts";
import { spawnDetached } from "../../lib/shell.ts";
import {
	TunnelStartError,
	type Endpoint,
	type NetStatus,
	type TunnelSession,
} from "../../types/network.ts";
import { TunnelSession as TunnelSessionSchema } from "../../types/network.ts";

const logger = log("network:agent");

/** How long to wait for an agent to announce its address before giving up. */
export const DEFAULT_ANNOUNCE_TIMEOUT_MS = 30_000;

/** How often the agent's output is re-read while waiting for that address. */
const POLL_INTERVAL_MS = 200;

/** What one line of agent output yielded, if anything. */
export interface AnnouncedAddress {
	host: string;
	port: number;
	/** Overrides the default `host:port` join address (an SRV-style bare name). */
	joinAddress?: string;
}

/** Everything {@link startAgent} needs to run one provider's agent. */
export interface AgentSpec {
	/** Server this tunnel belongs to; the descriptor and log are keyed by it. */
	serverId: string;
	/** Network provider id, recorded so another instance knows who owns the agent. */
	provider: string;
	/** Profile name the tunnel was started from. */
	profile: string;
	/** Local port the agent forwards to. */
	localPort: number;
	/** Absolute path of the agent binary (already resolved by the provider). */
	command: string;
	/** Its arguments. */
	args: string[];
	/**
	 * Extra environment for the child — where credentials go. They are passed to
	 * the agent this way rather than on the command line because a command line
	 * is world-readable in `/proc`, and are never logged or recorded.
	 */
	env?: Record<string, string>;
	/** Working directory for the agent. */
	cwd?: string;
	/**
	 * Extract the announced address from one line of output, or `undefined` when
	 * that line says nothing about it. Pure and provider-specific — it is the only
	 * part of starting an agent that actually differs between providers.
	 */
	match: (line: string) => AnnouncedAddress | undefined;
	/** Wait this long for {@link match} to fire. Default 30 s. */
	timeoutMs?: number;
	/**
	 * Address to use when {@link match} never fires **but the agent is still
	 * alive** at the deadline.
	 *
	 * This exists for playit, whose tunnel address is assigned on its web
	 * dashboard rather than printed by the agent in any stable form. Without it,
	 * a perfectly healthy agent would be killed for failing to say something it
	 * was never going to say. A provider that can genuinely read its address from
	 * output leaves this unset, so silence stays a failure there.
	 */
	fallback?: AnnouncedAddress;
	/** Carried onto the endpoint — how a player is actually meant to connect. */
	note?: string;
}

/**
 * Start an agent and wait for it to announce an address.
 *
 * On success the descriptor is written before returning, so a crash between the
 * spawn and the caller's next step still leaves a reapable record. On any
 * failure the agent is killed and no descriptor survives — an agent MCTL has
 * forgotten about is worse than no tunnel, because nothing will ever stop it.
 *
 * @throws {TunnelStartError} when the agent exits early or stays silent.
 * @throws {CommandError} when the binary cannot be spawned.
 */
export async function startAgent(spec: AgentSpec): Promise<TunnelSession> {
	await ensureDir(networkDir());
	const logFile = networkLogFile(spec.serverId);
	// Truncate: the capture describes the *current* attempt, and a previous
	// failure's error lines are exactly the thing that would be misread as this
	// attempt's diagnosis.
	await Bun.write(logFile, "");

	const pid = spawnDetached(spec.command, spec.args, {
		cwd: spec.cwd,
		env: spec.env,
		logFile,
	});
	logger.info(
		{ id: spec.serverId, provider: spec.provider, pid },
		"started tunnel agent",
	);

	let announced: AnnouncedAddress | undefined;
	try {
		announced = await waitForAddress(
			logFile,
			pid,
			spec.match,
			spec.timeoutMs ?? DEFAULT_ANNOUNCE_TIMEOUT_MS,
		);
	} catch (err) {
		killAgent(pid);
		throw err;
	}

	if (!announced && spec.fallback && isAlive(pid)) {
		announced = spec.fallback;
	}
	if (!announced) {
		killAgent(pid);
		throw new TunnelStartError(
			spec.provider,
			spec.serverId,
			`${spec.provider} did not announce an address within ${
				(spec.timeoutMs ?? DEFAULT_ANNOUNCE_TIMEOUT_MS) / 1000
			}s`,
			await tailLog(spec.serverId),
		);
	}

	const endpoint: Endpoint = {
		host: announced.host,
		port: announced.port,
		joinAddress: announced.joinAddress ?? `${announced.host}:${announced.port}`,
		kind: "tunnel",
		provider: spec.provider,
		note: spec.note,
	};
	const session: TunnelSession = {
		provider: spec.provider,
		profile: spec.profile,
		pid,
		localPort: spec.localPort,
		endpoint,
		startedAt: new Date().toISOString(),
	};
	await writeTunnel(spec.serverId, session);
	return session;
}

/**
 * Poll the agent's output until `match` fires, the agent dies, or time runs out.
 *
 * The whole file is re-read each pass rather than tracking an offset: an agent's
 * startup banner is a few kilobytes, the poll lasts seconds, and matching against
 * the complete text removes a class of bug where the announcement straddles two
 * reads. Lines are re-matched from the start each time for the same reason —
 * `match` is pure, so re-running it is free.
 */
async function waitForAddress(
	logFile: string,
	pid: number,
	match: (line: string) => AnnouncedAddress | undefined,
	timeoutMs: number,
): Promise<AnnouncedAddress | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const text = (await readTextIfExists(logFile)) ?? "";
		for (const line of text.split("\n")) {
			const hit = match(line);
			if (hit) return hit;
		}
		if (!isAlive(pid)) {
			// One last read: the agent may have printed and exited between the two
			// checks above, and an agent that announces then quits (a misconfigured
			// one-shot) should still report *why* rather than "no address".
			const last = (await readTextIfExists(logFile)) ?? "";
			for (const line of last.split("\n")) {
				const hit = match(line);
				if (hit) return hit;
			}
			return undefined;
		}
		await Bun.sleep(POLL_INTERVAL_MS);
	}
	return undefined;
}

/** Read the tunnel descriptor for a server, reaping it when its agent is gone. */
export async function readTunnel(
	serverId: string,
): Promise<TunnelSession | undefined> {
	const file = networkFile(serverId);
	const raw = await readTextIfExists(file);
	if (raw === undefined) return undefined;

	let session: TunnelSession;
	try {
		session = TunnelSessionSchema.parse(JSON.parse(raw));
	} catch (err) {
		// A descriptor MCTL cannot read is worse than none: it would make the
		// server look tunnelled forever while nothing can act on it.
		logger.warn(
			{ id: serverId, err },
			"discarding unreadable tunnel descriptor",
		);
		await removeTunnel(serverId);
		return undefined;
	}

	if (session.pid !== undefined && !isAlive(session.pid)) {
		logger.info(
			{ id: serverId, provider: session.provider, pid: session.pid },
			"reaping tunnel descriptor for a dead agent",
		);
		await removeTunnel(serverId);
		return undefined;
	}
	return session;
}

/** Write (or replace) a server's tunnel descriptor atomically. */
export async function writeTunnel(
	serverId: string,
	session: TunnelSession,
): Promise<void> {
	await ensureDir(networkDir());
	await writeJsonAtomic(networkFile(serverId), session);
}

/** Delete a server's tunnel descriptor, ignoring "already gone". */
export async function removeTunnel(serverId: string): Promise<void> {
	await Bun.file(networkFile(serverId))
		.delete()
		.catch(() => {});
}

/**
 * Stop the agent recorded for a server and forget it.
 *
 * SIGTERM only, with no escalation: a tunnel agent holds no user data and every
 * one of these exits promptly, so the SIGKILL ladder the *server* stop needs
 * would be ceremony. A no-op when nothing is recorded.
 */
export async function stopAgent(serverId: string): Promise<void> {
	const session = await readTunnel(serverId);
	if (!session) return;
	if (session.pid !== undefined) {
		killAgent(session.pid);
		logger.info(
			{ id: serverId, provider: session.provider, pid: session.pid },
			"stopped tunnel agent",
		);
	}
	await removeTunnel(serverId);
}

/**
 * Build a {@link NetStatus} from a server's descriptor, when this provider owns
 * it. Returns `undefined` when there is nothing recorded, or when the record
 * belongs to a different provider — a profile that was switched from ngrok to
 * cloudflared must not make cloudflared claim ngrok's live tunnel.
 */
export async function agentStatus(
	serverId: string,
	provider: string,
	providerName: string,
): Promise<NetStatus | undefined> {
	const session = await readTunnel(serverId);
	if (!session || session.provider !== provider) return undefined;
	return {
		profile: session.profile,
		provider,
		providerName,
		state: "up",
		readiness: { kind: "ready" },
		endpoint: session.endpoint,
		since: session.startedAt,
	};
}

/** The last few kilobytes of an agent's output, for an error message. */
export async function tailLog(serverId: string, lines = 12): Promise<string> {
	const text = (await readTextIfExists(networkLogFile(serverId))) ?? "";
	return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/** Whether a pid is still running. Mirrors `core/session/session-manager`'s probe. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means it exists but belongs to another user — alive for our purposes.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Send SIGTERM, ignoring "already gone". */
function killAgent(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// ESRCH: it exited on its own, which is the outcome we wanted.
	}
}
