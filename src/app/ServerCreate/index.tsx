/**
 * ServerCreate — the TUI's create form, the peer of `mctl create`.
 *
 * Page-layer (AGENTS.md § 3): it collects a flat draft, hands it to
 * `ServerManager.createServer` through {@link useMctl}, and renders the job's
 * progress. Every decision that shapes the server — id derivation, version
 * resolution, Java resolution, staging — belongs to core, so a server made here
 * is byte-identical to one made from the CLI.
 *
 * The Minecraft-version field is a **picker over what the selected kind
 * actually publishes** (`app/VersionField.tsx` over
 * `hooks/use-server-versions.ts`), with snapshots and the old alpha/beta
 * versions hidden behind checkboxes. It used to be a free text input, because
 * listing versions costs a network round trip per kind — the fetch is
 * non-blocking now, so the form still renders (and still accepts "latest")
 * while the list is loading or when it cannot be loaded at all.
 *
 * The fields are laid out in a {@link FormGrid}: one column on a narrow
 * terminal, two once there is room, filled row-major in the same order as the
 * focus ring below — the form used to be a single tall column that ran off the
 * bottom of the screen while two thirds of a wide terminal sat empty.
 */

import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import {
	Button,
	Checkbox,
	FormGrid,
	Input,
	Select,
} from "../../components/index.ts";
import { useFocusRing, type FocusItem } from "../../hooks/use-focus-ring.ts";
import { useCaptureKeys } from "../../hooks/use-input-capture.tsx";
import { useHints } from "../../hooks/use-hints.tsx";
import { useIcons } from "../../hooks/use-icons.tsx";
import { useMctl } from "../../hooks/use-mctl.tsx";
import { useConfig } from "../../hooks/use-config.ts";
import { useRouter } from "../../hooks/use-router.tsx";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useToast } from "../../hooks/use-toast.tsx";
import { idFromName } from "../../core/server/manager.ts";
import type { Job } from "../../core/jobs/index.ts";
import { EventType } from "../../types/events.ts";
import { useEventBus } from "../../hooks/use-event-bus.tsx";
import type { RuntimeKind, ServerKind } from "../../types/config.ts";
import { PageHeader } from "../shared.tsx";
import { VersionField, versionFieldIds } from "../VersionField.tsx";
import { useServerVersions } from "../../hooks/use-server-versions.ts";
import { ProgressBar } from "../../components/index.ts";

/**
 * Field ids in the focus ring, in tab order — which is also the order the grid
 * lays them out in, so Tab and the eye agree. The version field's own ids are
 * spliced in after `kind` (it contributes a variable number — one per channel
 * the selected kind publishes), and the two buttons close the ring.
 *
 * The pairing is by **height**, not by topic: a grid row is as tall as its
 * tallest cell, so a three-row text input beside a ten-row dropdown leaves a
 * hole the size of the dropdown. The two one-line text fields go together, the
 * two list pickers go together, and the two small controls close the form.
 */
const FIELDS_BEFORE_VERSION = ["name", "memory", "kind"];
const FIELDS_AFTER_VERSION = ["runtime", "eula"];

/** Ids whose control is a text input — these hold the shell's key capture. */
const TEXT_FIELDS = new Set<string>(["name", "memory"]);

export function ServerCreate() {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { navigate } = useRouter();
	const bus = useEventBus();
	const toast = useToast();
	const { context } = useMctl();
	const { config } = useConfig();

	const [name, setName] = useState("");
	const [kind, setKind] = useState<string>(config?.defaults.kind ?? "paper");
	const [minecraftVersion, setMinecraftVersion] = useState("");
	const [memory, setMemory] = useState(config?.defaults.memory ?? "2G");
	const [runtime, setRuntime] = useState<RuntimeKind>(
		config?.defaults.runtime ?? "foreground",
	);
	const [eula, setEula] = useState(config?.defaults.eula ?? false);
	const [job, setJob] = useState<Job>();

	// The versions the selected kind publishes, re-fetched when the kind changes.
	// Never awaited by the render path: the form is fully usable while it loads.
	const versions = useServerVersions(kind);

	const kindProvider = context?.providers
		.servers()
		.find((provider) => provider.id === kind);

	const id = idFromName(name);
	const busy =
		job !== undefined && (job.state === "queued" || job.state === "running");
	const invalid = name.trim() === "" || id === "";

	// Create is in the ring but marked disabled until the form is valid, so Tab
	// never parks on a button that ignores Enter — it wraps back to the Name field
	// the user still has to fill in. Cancel is always live, and is in the ring so
	// the escape hatch is reachable by keyboard as well as by Esc.
	const buttons: FocusItem[] = [
		{ id: "create", disabled: invalid || busy },
		"cancel",
	];
	const ring = useFocusRing([
		...FIELDS_BEFORE_VERSION,
		...versionFieldIds(versions),
		...FIELDS_AFTER_VERSION,
		...buttons,
	]);
	// While a text field owns the ring, the shell's digit/q/t shortcuts stand down
	// so typing "2" edits the field instead of navigating to Jobs.
	useCaptureKeys(ring.focus !== undefined && TEXT_FIELDS.has(ring.focus));

	// The shell draws these in its strip. `Esc` is relabelled from the shell's
	// "back" to what leaving this page actually means — the same key, so the more
	// specific label wins the slot rather than adding a second one. While a job is
	// running the form is inert, so only the escape hatch is advertised.
	useHints(
		busy
			? [{ keys: "Esc", label: "cancel" }]
			: [
					{ keys: "Tab", label: "next field" },
					{ keys: "Enter", label: "create" },
					{ keys: "Esc", label: "cancel" },
				],
	);

	const submit = async () => {
		if (!context || invalid || busy) return;

		let started: Awaited<ReturnType<typeof context.servers.createServer>>;
		try {
			started = await context.servers.createServer({
				name: name.trim(),
				kind: kind as ServerKind,
				minecraftVersion: minecraftVersion.trim() || undefined,
				memory: memory.trim() || undefined,
				runtime,
				eula,
			});
		} catch (err) {
			// Pre-flight failures (id taken, unknown kind, path in use) never become a
			// job, so they are reported here rather than through the progress panel.
			toast.error("Could not create server", {
				description: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		setJob(started.job);
		const unsubscribe = bus.subscribe((event) => {
			if (event.type !== EventType.JobProgress) return;
			const update = event.payload as Job;
			if (update.id === started.job.id) setJob({ ...update });
		});

		try {
			const server = await started.result;
			toast.success(`Created ${server.id}`, {
				description: `${server.kind} ${server.minecraftVersion} at ${server.path}`,
			});
			navigate("server", { serverId: server.id });
		} catch (err) {
			toast.error("Create failed", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			unsubscribe();
			setJob(undefined);
		}
	};

	// Enter submits from any field except the buttons, which own their own Enter.
	useKeyboard((key) => {
		if (key.name !== "return" || busy) return;
		if (ring.focus === "create" || ring.focus === "cancel") return;
		if (ring.focus === undefined) return;
		void submit();
	});

	return (
		<box flexDirection="column" flexGrow={1} paddingX={1}>
			<PageHeader
				title="New server"
				// The keys are in the shell's hint strip; repeating them here was the
				// third copy of the same three shortcuts on one screen.
				subtitle={busy ? "creating…" : "Fills in from your defaults"}
			/>

			{/* Row-major and in ring order, so Tab and the eye agree. One column on a
			    narrow terminal, two once there is room for both. The pairs are chosen
			    so the two cells of a row are about as tall as each other. */}
			<FormGrid>
				<Input
					label="Name"
					hint={id === "" ? "required" : `id: ${id}`}
					value={name}
					onChange={setName}
					focused={ring.isFocused("name")}
					onFocused={() => ring.setFocus("name")}
					width="100%"
				/>
				<Input
					label="Memory"
					hint="JVM heap, e.g. 2G or 4096M"
					value={memory}
					onChange={setMemory}
					focused={ring.isFocused("memory")}
					onFocused={() => ring.setFocus("memory")}
					width="100%"
				/>
				{/* Kind and its explanation are one cell: the line belongs to the field
				    above it, and letting the grid place it separately would strand it
				    beside a different field. */}
				<box flexDirection="column">
					<Select
						label="Kind"
						hint="the server implementation"
						// No per-option description: `Select`'s dropdown gives *every* row
						// two lines as soon as one option has one, which made this field
						// twice the height of the version picker beside it. Nothing is
						// lost — moving the highlight changes the selection, so the line
						// below the field already explains whichever kind is under the
						// cursor.
						options={(context?.providers.servers() ?? []).map((provider) => ({
							value: provider.id,
							label: provider.displayName,
						}))}
						value={kind}
						onChange={setKind}
						focused={ring.isFocused("kind")}
						onFocused={() => ring.setFocus("kind")}
						width="100%"
						// Matched to the version picker's, so the two list fields sharing a
						// row are the same height.
						maxVisible={6}
					/>
					{kindProvider ? (
						<text fg={colors.muted} paddingX={2} truncate wrapMode="none">
							{kindProvider.description}
						</text>
					) : null}
				</box>
				<VersionField
					state={versions}
					value={minecraftVersion}
					onChange={setMinecraftVersion}
					focus={ring}
					// Short on purpose: a bottom-border title that does not fit the
					// field is dropped by OpenTUI, not truncated, so a long hint on a
					// half-width field is a hint nobody ever sees.
					latestHint="newest release, resolved at create time"
				/>
				<Select
					label="Runtime"
					// From the registry, like Kind above it: the runtimes this build ships
					// are whatever `providers/index.ts` registered, and a hand-kept copy
					// here is a list that silently stays a phase behind.
					options={(context?.providers.runtimes() ?? []).map((provider) => ({
						value: provider.id,
						label: provider.displayName,
					}))}
					value={runtime}
					onChange={(value) => setRuntime(value as RuntimeKind)}
					focused={ring.isFocused("runtime")}
					onFocused={() => ring.setFocus("runtime")}
					width="100%"
				/>
				<Checkbox
					label="EULA"
					hint="required before a server will start"
					caption="I accept the EULA (minecraft.net/eula)"
					checked={eula}
					onChange={setEula}
					focused={ring.isFocused("eula")}
					onFocused={() => ring.setFocus("eula")}
				/>
			</FormGrid>

			{job ? (
				<box flexDirection="column" marginTop={1} gap={0}>
					<text fg={colors.secondary}>
						{job.step ?? job.title}
						{job.message ? ` ${icons.separator} ${job.message}` : ""}
					</text>
					<ProgressBar
						value={job.fraction ?? 0}
						indeterminate={job.fraction === undefined}
						width={40}
						readout="percent"
					/>
				</box>
			) : (
				<box flexDirection="row" gap={1} marginTop={1}>
					<Button
						kind="solid"
						variant="primary"
						size="small"
						focused={ring.isFocused("create")}
						onFocused={() => ring.setFocus("create")}
						onClick={() => void submit()}
						disabled={invalid || busy}
					>
						Create
					</Button>
					<Button
						kind="ghost"
						variant="neutral"
						size="small"
						focused={ring.isFocused("cancel")}
						onFocused={() => ring.setFocus("cancel")}
						onClick={() => navigate("dashboard")}
					>
						Cancel
					</Button>
				</box>
			)}
		</box>
	);
}
