/**
 * Process resource sampling: how much CPU, memory, and how many threads a live
 * pid is using right now.
 *
 * Leaf helper (`lib/`) — UI-free, provider-free, server-free. It knows nothing
 * about Minecraft or runtimes; it is handed a pid and reports numbers. Nothing
 * here is cached: every call re-reads the kernel, which is what lets the UI show
 * a live figure without any instance holding state (architecture.md
 * § Statelessness).
 *
 * **Two backends, because there is no portable API.** On Linux everything comes
 * from `/proc/<pid>/`, which is exact and costs two small file reads. Everywhere
 * else we shell out to `ps`, which is portable but reports a *lifetime-average*
 * CPU share and cannot report a thread count — so those callers get a coarser
 * answer, and the shape says which one they got.
 */

import { readFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { run } from "./shell.ts";

/**
 * The kernel's clock-tick rate, used to turn `utime`/`stime` in
 * `/proc/<pid>/stat` into seconds. `sysconf(_SC_CLK_TCK)` is not exposed to
 * JavaScript, and it has been 100 on every Linux/glibc build since the 2.6 era —
 * the value is effectively part of the userspace ABI now.
 */
const CLOCK_TICKS_PER_SECOND = 100;

/** How long {@link sampleUsage} waits between its two CPU readings. */
const CPU_SAMPLE_INTERVAL_MS = 220;

/** A single point-in-time reading of a process's cumulative counters. */
interface ProcessSnapshot {
	/** Total CPU time consumed since the process started, in seconds. */
	cpuSeconds: number;
	/** Resident set size in bytes — physical memory actually held. */
	rssBytes: number;
	/** OS threads in the process, when the platform reports it. */
	threads?: number;
	/** Wall-clock time the snapshot was taken (`performance.now()` domain). */
	at: number;
}

/** Live resource usage of one process. */
export interface ProcessUsage {
	/**
	 * CPU share as a percentage of **one** core, the same convention `top` uses —
	 * so a JVM saturating four cores reads as `400`, not `100`. Divide by
	 * {@link ProcessUsage.cores} for a whole-machine figure.
	 */
	cpuPercent: number;
	/** Resident set size in bytes. */
	rssBytes: number;
	/** RSS as a percentage of total system memory. */
	memoryPercent: number;
	/** Logical cores on this machine, so a caller can scale `cpuPercent`. */
	cores: number;
	/** OS thread count, when the platform reports it (Linux only). */
	threads?: number;
	/**
	 * True when `cpuPercent` is a lifetime average rather than an instantaneous
	 * rate — the `ps` fallback cannot do better. A UI should label it as such
	 * instead of presenting an average as a live reading.
	 */
	cpuIsLifetimeAverage: boolean;
}

/**
 * Read one snapshot from `/proc/<pid>/`. Returns `undefined` when the process is
 * gone or the platform has no procfs.
 *
 * `/proc/<pid>/stat` puts the executable name in parentheses as field 2, and
 * that name may itself contain spaces or parentheses — so the fields are split
 * from *after the last* `)`, never by naively splitting the whole line. After
 * that cut, index 0 is field 3 (`state`), which puts `utime` at 11, `stime` at
 * 12, and `num_threads` at 17.
 * https://www.kernel.org/doc/html/latest/filesystems/proc.html
 */
async function snapshotProc(pid: number): Promise<ProcessSnapshot | undefined> {
	let stat: string;
	try {
		stat = await readFile(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
	const at = performance.now();
	const tail = stat.slice(stat.lastIndexOf(")") + 2);
	const fields = tail.split(" ");
	const utime = Number(fields[11]);
	const stime = Number(fields[12]);
	const threads = Number(fields[17]);
	if (!Number.isFinite(utime) || !Number.isFinite(stime)) return undefined;

	// VmRSS in `status` is in kB and explicitly labelled, which is less
	// error-prone than `stat`'s field-24 page count (whose unit depends on the
	// page size we would then have to assume).
	let rssBytes = 0;
	try {
		const status = await readFile(`/proc/${pid}/status`, "utf8");
		const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
		if (match?.[1]) rssBytes = Number(match[1]) * 1024;
	} catch {
		// The process exited between the two reads; report what we have.
	}

	return {
		cpuSeconds: (utime + stime) / CLOCK_TICKS_PER_SECOND,
		rssBytes,
		threads: Number.isFinite(threads) ? threads : undefined,
		at,
	};
}

/**
 * The portable fallback: `ps -o rss=,%cpu= -p <pid>`. RSS is in kilobytes and
 * `%cpu` is the process's **lifetime average** share of one core — POSIX `ps`
 * has no instantaneous rate, which is why the result is flagged.
 */
async function usageFromPs(pid: number): Promise<ProcessUsage | undefined> {
	try {
		const result = await run("ps", ["-o", "rss=,%cpu=", "-p", String(pid)], {
			timeoutMs: 2_000,
		});
		if (result.code !== 0) return undefined;
		const [rssKb, cpu] = result.stdout.trim().split(/\s+/);
		const rssBytes = Number(rssKb) * 1024;
		if (!Number.isFinite(rssBytes)) return undefined;
		return {
			cpuPercent: Number.isFinite(Number(cpu)) ? Number(cpu) : 0,
			rssBytes,
			memoryPercent: (rssBytes / totalmem()) * 100,
			cores: cpus().length,
			cpuIsLifetimeAverage: true,
		};
	} catch {
		return undefined;
	}
}

/**
 * Sample a process's live resource usage, or `undefined` when the pid is not
 * running (or cannot be inspected — a foreign-owned process on a hardened
 * kernel, say). Never throws: an unreadable process is an absent reading, not an
 * error, because the caller is decorating a UI row.
 *
 * On Linux this takes **two** procfs snapshots ~220 ms apart and reports the CPU
 * rate between them; a single cumulative reading could only ever yield a
 * lifetime average, which for a server that has been up for hours hides exactly
 * the spike the user opened the dashboard to see. Callers should sample every
 * server concurrently so the delay is paid once, not once per server.
 */
export async function sampleUsage(
	pid: number,
): Promise<ProcessUsage | undefined> {
	// On Linux an unreadable `/proc/<pid>/` means the process is gone, not that
	// the backend is wrong — falling through to `ps` there would spawn a child
	// per stopped server for an answer we already have.
	if (process.platform !== "linux") return usageFromPs(pid);

	const first = await snapshotProc(pid);
	if (!first) return undefined;

	await Bun.sleep(CPU_SAMPLE_INTERVAL_MS);
	const second = await snapshotProc(pid);
	// The process exited mid-sample: report the first reading's memory with no
	// rate rather than dropping the row to "unknown".
	if (!second) {
		return {
			cpuPercent: 0,
			rssBytes: first.rssBytes,
			memoryPercent: (first.rssBytes / totalmem()) * 100,
			cores: cpus().length,
			threads: first.threads,
			cpuIsLifetimeAverage: false,
		};
	}

	const elapsedSeconds = (second.at - first.at) / 1000;
	const cpuPercent =
		elapsedSeconds > 0
			? ((second.cpuSeconds - first.cpuSeconds) / elapsedSeconds) * 100
			: 0;

	return {
		cpuPercent: Math.max(0, cpuPercent),
		rssBytes: second.rssBytes,
		memoryPercent: (second.rssBytes / totalmem()) * 100,
		cores: cpus().length,
		threads: second.threads,
		cpuIsLifetimeAverage: false,
	};
}
