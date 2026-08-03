/**
 * JobScheduler — long-running work (downloads, installs, JDK fetches) modelled
 * as an observable {@link Job} rather than an awaited promise, so nothing blocks
 * the render path (AGENTS.md § 3, "No blocking I/O on the render path").
 *
 * Core service — no UI, no argv, no provider imports. It knows how to run an
 * async function, report its progress, and hold its result; it knows nothing
 * about what the function does.
 *
 * **Is an in-memory job list authoritative state?** No, and the distinction
 * matters here. MCTL must never cache *server* state (that is re-derived from
 * disk on every read). A job is different: it is **this process's own in-flight
 * work**, has no on-disk representation, and dies with the process — exactly
 * like a pending promise. What a job *produces* (a jar on disk, a `mctl.json`)
 * is the durable part, and that is written by the work function, not held here.
 *
 * **Two event tiers, deliberately asymmetric.** Progress fires many times a
 * second, so it is emitted on the **local bus only**; writing every tick to
 * `events.jsonl` would rotate the cross-instance log away in seconds. Only the
 * terminal transitions (`JobFinished`) are `publish`ed, which is what another
 * instance actually needs to know: "an install just completed, re-read the disk".
 */

import { randomUUID } from "node:crypto";
import { log } from "../../lib/logger.ts";
import { EventType, type MctlEvent } from "../../types/events.ts";
import { INSTANCE_ID } from "../events/instance.ts";
import { publish } from "../events/log.ts";
import type { EventBus } from "../events/bus.ts";

const logger = log("jobs");

/** Lifecycle of a job. Terminal states are `done`, `failed`, and `cancelled`. */
export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * A unit of long work, as the UI sees it. A plain data snapshot — the front-end
 * renders this and never touches the running function.
 */
export interface Job {
	/** Unique id for this run. */
	id: string;
	/** Machine-readable category, e.g. `"install"` or `"java"`. */
	kind: string;
	/** One-line human description, e.g. `"Installing paper 1.21.4"`. */
	title: string;
	/** The server this job acts on, when it acts on one. */
	serverId?: string;
	/** Current lifecycle state. */
	state: JobState;
	/** Current named phase, e.g. `"Downloading"` (plan.md § Download Manager). */
	step?: string;
	/** Progress within the job in `0..1`, when it is measurable. */
	fraction?: number;
	/** Latest human-facing detail line, e.g. `"41.2 MB / 56.9 MB"`. */
	message?: string;
	/** Failure message when `state === "failed"`. */
	error?: string;
	/** ISO-8601 time the job was created. */
	startedAt: string;
	/** ISO-8601 time it reached a terminal state. */
	finishedAt?: string;
}

/**
 * The handle a work function uses to report on itself. Every method is
 * fire-and-forget: reporting must never be able to fail the work it describes.
 */
export interface JobContext {
	/** Move to a named phase, optionally resetting progress. */
	step(name: string, fraction?: number): void;
	/** Report progress within the current phase, with an optional detail line. */
	progress(fraction: number | undefined, message?: string): void;
	/** Aborted when {@link JobScheduler.cancel} is called; pass to fetch/download. */
	readonly signal: AbortSignal;
}

/** What to run and how to describe it. */
export interface JobSpec {
	/** Machine-readable category, e.g. `"install"`. */
	kind: string;
	/** One-line human description. */
	title: string;
	/** The server this job acts on, when it acts on one. */
	serverId?: string;
}

/** A started job: its current snapshot plus the promise of its result. */
export interface StartedJob<T> {
	/** Snapshot at start; re-read via {@link JobScheduler.get} for later state. */
	job: Job;
	/**
	 * Resolves with the work function's return value, or rejects with its error.
	 * The rejection is *also* recorded on the job, so a caller that only wants
	 * fire-and-forget behaviour may ignore this — but must then attach a `catch`
	 * to avoid an unhandled rejection.
	 */
	result: Promise<T>;
}

/**
 * Runs jobs and reports their progress on an {@link EventBus}.
 *
 * One scheduler exists per process (created alongside the event system). It runs
 * work immediately — there is no queue depth limit — because the operations it
 * hosts are user-initiated and already serialized by per-server locks upstream.
 */
export class JobScheduler {
	readonly #jobs = new Map<string, Job>();
	readonly #controllers = new Map<string, AbortController>();
	readonly #bus: EventBus;
	/** Newest-first ids, so `list()` is cheap and stable. */
	readonly #order: string[] = [];

	constructor(bus: EventBus) {
		this.#bus = bus;
	}

	/**
	 * Start `work` as a job. The job is created in `queued`, flips to `running`
	 * synchronously, and reaches a terminal state when `work` settles.
	 */
	run<T>(
		spec: JobSpec,
		work: (context: JobContext) => Promise<T>,
	): StartedJob<T> {
		const id = randomUUID();
		const job: Job = {
			id,
			kind: spec.kind,
			title: spec.title,
			serverId: spec.serverId,
			state: "queued",
			startedAt: new Date().toISOString(),
		};
		this.#jobs.set(id, job);
		this.#order.unshift(id);

		const controller = new AbortController();
		this.#controllers.set(id, controller);

		const context: JobContext = {
			signal: controller.signal,
			step: (name, fraction) => {
				this.#update(id, { step: name, fraction, message: undefined });
			},
			progress: (fraction, message) => {
				this.#update(id, { fraction, message });
			},
		};

		this.#update(id, { state: "running" });

		const result = (async () => {
			try {
				const value = await work(context);
				await this.#finish(id, { state: "done", fraction: 1 });
				return value;
			} catch (err) {
				const aborted = controller.signal.aborted;
				await this.#finish(id, {
					state: aborted ? "cancelled" : "failed",
					error: aborted ? "cancelled" : errorMessage(err),
				});
				throw err;
			} finally {
				this.#controllers.delete(id);
			}
		})();

		return { job: { ...job }, result };
	}

	/** Current snapshot of one job, or `undefined` if the id is unknown. */
	get(id: string): Job | undefined {
		const job = this.#jobs.get(id);
		return job ? { ...job } : undefined;
	}

	/** Every job this process has run, newest first. */
	list(): Job[] {
		return this.#order.map((id) => ({ ...this.#jobs.get(id)! }));
	}

	/** Jobs that have not yet reached a terminal state, newest first. */
	active(): Job[] {
		return this.list().filter(
			(job) => job.state === "queued" || job.state === "running",
		);
	}

	/**
	 * Request cancellation. The job only ends when its work function honours the
	 * abort signal, so this is a request, not a guarantee — a download stops
	 * promptly, a `tar` extraction runs to completion.
	 */
	cancel(id: string): void {
		this.#controllers.get(id)?.abort();
	}

	/** Apply a patch and emit `JobProgress` on the local bus only (see module doc). */
	#update(id: string, patch: Partial<Job>): void {
		const job = this.#jobs.get(id);
		if (!job) return;
		Object.assign(job, patch);
		this.#bus.emit(localEvent(EventType.JobProgress, { ...job }));
	}

	/** Apply the terminal patch, then announce it to the other instances too. */
	async #finish(id: string, patch: Partial<Job>): Promise<void> {
		this.#update(id, { ...patch, finishedAt: new Date().toISOString() });
		const job = this.#jobs.get(id);
		if (!job) return;
		logger.info(
			{ id, kind: job.kind, state: job.state, error: job.error },
			"job finished",
		);
		// Cross-instance: only the outcome, and only the fields another instance can
		// act on. No payload from the work function ever reaches the shared log.
		await publish(this.#bus, EventType.JobFinished, {
			id: job.id,
			kind: job.kind,
			serverId: job.serverId,
			state: job.state,
			error: job.error,
		});
	}
}

/** Build a local-only envelope (no `events.jsonl` line — see the module doc). */
function localEvent(type: string, payload: unknown): MctlEvent {
	return {
		v: 1,
		id: randomUUID(),
		ts: new Date().toISOString(),
		instance: INSTANCE_ID,
		type,
		payload,
	};
}

/** Best-effort human message from an unknown throw. */
function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
