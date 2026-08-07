/**
 * Performance — the process behind the server: CPU, resident memory, threads,
 * and how those have moved while the page has been open.
 *
 * **What is here and why the rest is not.** Everything on this tab is read from
 * outside the JVM (procfs, or `ps` off Linux), which is all MCTL can do today.
 * TPS/MSPT need an RCON `/tps` or a mod; JVM *heap occupancy* needs JMX; and the
 * kernel exposes no per-process socket byte counters, so per-server network
 * traffic is not obtainable at all. Each is named as unavailable rather than
 * omitted — a gap where a number is expected reads as a bug, not as a limit.
 *
 * **The samples panel is a session-local observation, not state.** It summarises
 * the readings this page has taken since it was opened; it is thrown away on
 * navigation and is never written anywhere. Nothing is cached as truth
 * (architecture.md § Statelessness) — every reading still comes from a fresh
 * probe.
 */

import { useEffect, useRef, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useTheme } from "../../../hooks/use-theme.tsx";
import {
	formatBytes,
	formatDuration,
	parseMemorySize,
} from "../../../lib/format.ts";
import { uptimeOf } from "../../shared.tsx";
import {
	Columns,
	Detail,
	EmptyNote,
	Meter,
	Panel,
	TWO_COLUMN_WIDTH,
	javaLabel,
	type ServerTabProps,
} from "../panels.tsx";

/** How many readings the session summary keeps. At a 2 s poll this is ~2 min. */
const HISTORY = 60;

/** Running min / mean / max of a series of samples. */
interface Summary {
	min: number;
	mean: number;
	max: number;
	count: number;
}

/** Summarise a series, or `undefined` when nothing has been sampled yet. */
function summarise(values: number[]): Summary | undefined {
	if (values.length === 0) return undefined;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	let total = 0;
	for (const value of values) {
		if (value < min) min = value;
		if (value > max) max = value;
		total += value;
	}
	return { min, mean: total / values.length, max, count: values.length };
}

export function PerformanceTab({ server, insight }: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width } = useTerminalDimensions();
	const empty = icons.emptyValue;
	const usage = insight?.usage;
	const heapBytes = parseMemorySize(server.memory);
	const uptime = uptimeOf(server);

	// The window of readings this page has seen. Kept in state so the summary
	// re-renders, and reset whenever the process changes — samples from a
	// previous run would silently average two different servers together.
	const [cpuSamples, setCpuSamples] = useState<number[]>([]);
	const [rssSamples, setRssSamples] = useState<number[]>([]);
	const pid = server.session?.pid;
	const lastPid = useRef(pid);

	useEffect(() => {
		if (lastPid.current !== pid) {
			lastPid.current = pid;
			setCpuSamples([]);
			setRssSamples([]);
		}
	}, [pid]);

	// `usage` is a fresh object every poll, so this appends exactly one reading
	// per completed inspection round.
	useEffect(() => {
		if (!usage) return;
		setCpuSamples((previous) =>
			[...previous, usage.cpuPercent].slice(-HISTORY),
		);
		setRssSamples((previous) => [...previous, usage.rssBytes].slice(-HISTORY));
	}, [usage]);

	const cpu = summarise(cpuSamples);
	const rss = summarise(rssSamples);

	if (!usage) {
		return (
			<Panel title="Performance">
				<EmptyNote>
					{server.state === "running"
						? "The server is running but its process could not be sampled."
						: "No process to sample — the server is not running."}
				</EmptyNote>
			</Panel>
		);
	}

	const left = (
		<>
			<Panel title="Now">
				<Meter
					label="cpu"
					value={usage.cpuPercent}
					max={100 * usage.cores}
					readout={`${Math.round(usage.cpuPercent)}% of ${usage.cores} cores`}
					variant="info"
				/>
				<Meter
					label="memory"
					value={usage.rssBytes}
					max={heapBytes ?? usage.rssBytes}
					readout={
						heapBytes
							? `${formatBytes(usage.rssBytes)} / ${server.memory} heap`
							: formatBytes(usage.rssBytes)
					}
					variant="primary"
				/>
				<Detail
					label="of machine"
					value={`${usage.memoryPercent.toFixed(1)}% of system memory`}
				/>
				<Detail
					label="threads"
					value={usage.threads === undefined ? empty : String(usage.threads)}
				/>
				<Detail label="pid" value={pid === undefined ? empty : String(pid)} />
				<Detail
					label="uptime"
					value={uptime === undefined ? empty : formatDuration(uptime)}
				/>
				{usage.cpuIsLifetimeAverage ? (
					<box marginTop={1}>
						{/* Said out loud: on this platform the CPU figure is the process's
						    lifetime average, which on a server up for hours is a very
						    different number from what `top` would show. */}
						<EmptyNote>
							CPU here is a lifetime average, not a live rate — this platform
							has no procfs to sample twice.
						</EmptyNote>
					</box>
				) : null}
			</Panel>

			<Panel title="This session">
				{cpu && rss && cpu.count > 1 ? (
					<>
						<Detail
							label="cpu min/avg"
							value={`${Math.round(cpu.min)}% / ${Math.round(cpu.mean)}%`}
						/>
						<Detail
							label="cpu peak"
							value={`${Math.round(cpu.max)}%`}
							color={cpu.max > 90 * usage.cores ? colors.warning : undefined}
						/>
						<Detail label="memory avg" value={formatBytes(rss.mean)} />
						<Detail label="memory peak" value={formatBytes(rss.max)} />
						<Detail
							label="samples"
							value={`${cpu.count} since this page opened`}
							color={colors.muted}
						/>
					</>
				) : (
					<EmptyNote>Collecting readings…</EmptyNote>
				)}
			</Panel>
		</>
	);

	const right = (
		<>
			<Panel title="Runtime">
				<Detail label="java" value={javaLabel(server, empty)} />
				<Detail label="heap" value={server.memory} />
				<Detail label="runtime" value={server.runtime} />
				<Detail label="cores" value={String(usage.cores)} />
			</Panel>

			<Panel title="Not measurable yet" accent={colors.muted}>
				{/* These are the numbers people look for next to CPU. None can be read
				    from outside the JVM, so they are named rather than left as gaps. */}
				<Detail
					label="tps / mspt"
					value="needs RCON — Phase 4/5"
					color={colors.muted}
				/>
				<Detail
					label="heap used"
					value="needs JMX — only RSS is visible"
					color={colors.muted}
				/>
				<Detail
					label="network i/o"
					value="the kernel exposes no per-process counters"
					color={colors.muted}
				/>
				<Detail label="disk i/o" value="not sampled" color={colors.muted} />
			</Panel>
		</>
	);

	return <Columns wide={width >= TWO_COLUMN_WIDTH} left={left} right={right} />;
}
