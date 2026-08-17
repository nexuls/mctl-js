/**
 * useServerSettings — the Server page's Settings tab bridge to core, the
 * per-server peer of `app/Settings/use-settings.ts`.
 *
 * UI-layer hook (AGENTS.md § 3): every read is the `Server` view model the page
 * already holds, and the single write goes through `ServerManager.editServer`
 * via {@link useMctl} — the same call `mctl edit` makes, so the two front-ends
 * cannot drift.
 *
 * **The buffer follows disk while it is clean and never while it is dirty**,
 * exactly like the Settings page: `useServer` re-reads on every relevant event,
 * and an edit landing from another instance must not eat what the user is
 * halfway through typing.
 *
 * **What it deliberately cannot change.** Only {@link EditServerOptions} — name,
 * memory, runtime, network profile, Java pin. `kind` and `minecraftVersion` are
 * an *update*: a different jar, possibly a re-run installer, a staged download
 * and a rollback story. That is a separate operation core does not have yet, and
 * offering it as a text field here would be a form that quietly corrupts a
 * server directory.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeKind } from "../types/config.ts";
import type { Server } from "../types/server.ts";
import { useMctl } from "./use-mctl.tsx";

/** The editable view of one server's `mctl.json`. */
export interface ServerSettingsDraft {
	/** Display name. Does **not** rename the directory or change the id. */
	name: string;
	/** JVM heap, e.g. `"4G"`. */
	memory: string;
	/** Runtime provider id. */
	runtime: RuntimeKind;
	/** Network profile name. */
	network: string;
	/**
	 * Whether a Java major is pinned. The config expresses "not pinned" as an
	 * absent key or a resolved number, neither of which a text field can bind to.
	 */
	javaPinned: boolean;
	/** The pinned major, as typed; only meaningful while `javaPinned`. */
	javaMajor: string;
}

/** Build the edit buffer from a server view model. Pure. */
export function serverToDraft(server: Server): ServerSettingsDraft {
	const pinned =
		typeof server.java === "object" ? server.java.pinned : undefined;
	return {
		name: server.name,
		memory: server.memory,
		runtime: server.runtime as RuntimeKind,
		network: server.network,
		javaPinned: pinned !== undefined,
		// Pre-filled with the *resolved* major when there is no pin, so ticking the
		// box starts from the version the server actually runs on rather than an
		// empty box the user has to guess at.
		javaMajor: String(
			pinned ?? (typeof server.java === "number" ? server.java : ""),
		),
	};
}

/**
 * Field-level validation, run on every keystroke so Save can be disabled before
 * the write is attempted. The schema stays the authority at the disk boundary.
 */
export function validateServerDraft(
	draft: ServerSettingsDraft,
): Partial<Record<keyof ServerSettingsDraft, string>> {
	const issues: Partial<Record<keyof ServerSettingsDraft, string>> = {};
	if (draft.name.trim() === "") issues.name = "required";
	if (draft.memory.trim() === "") issues.memory = "required";
	// Free-form upstream (the runtime validates it), but the two shapes a JVM
	// accepts are worth catching here rather than at the server's next start.
	else if (!/^\d+[kKmMgG]?$/.test(draft.memory.trim())) {
		issues.memory = "a JVM heap size, e.g. 4G or 2048M";
	}
	if (draft.javaPinned) {
		const major = Number.parseInt(draft.javaMajor, 10);
		if (!Number.isInteger(major) || major <= 0) {
			issues.javaMajor = "a Java major version, e.g. 21";
		}
	}
	return issues;
}

/** What {@link useServerSettings} hands the tab. */
export interface UseServerSettings {
	/** The edit buffer, or `undefined` until the server has loaded. */
	draft: ServerSettingsDraft | undefined;
	/** Apply a partial edit. */
	set: (patch: Partial<ServerSettingsDraft>) => void;
	/** Whether the buffer differs from what is on disk. */
	dirty: boolean;
	/** Per-field validation messages; empty when the draft is valid. */
	issues: Partial<Record<keyof ServerSettingsDraft, string>>;
	/** Discard edits and reload from the server view model. */
	revert: () => void;
	/**
	 * Write the changed fields. Resolves `null` on success or the failure message
	 * — the caller reports it as a toast, so it needs the text, not a flag.
	 */
	save: () => Promise<string | null>;
	/** True while a write is in flight. */
	saving: boolean;
}

/**
 * Load one server's settings into an edit buffer and commit changes back.
 *
 * @param server the server to edit, or `undefined` while it is still loading.
 * @param onSaved called after a successful write, so the page can re-read (the
 *   view model is not patched optimistically — `mctl.json` is the truth).
 */
export function useServerSettings(
	server: Server | undefined,
	onSaved?: () => void,
): UseServerSettings {
	const { context } = useMctl();
	const [draft, setDraft] = useState<ServerSettingsDraft>();
	const [saving, setSaving] = useState(false);

	const fromDisk = useMemo(
		() => (server ? serverToDraft(server) : undefined),
		[server],
	);

	const dirty =
		draft !== undefined &&
		fromDisk !== undefined &&
		JSON.stringify(draft) !== JSON.stringify(fromDisk);

	// The last buffer adopted from disk. One still equal to it is clean and may
	// safely follow a new value; anything else is a user edit in progress.
	const adopted = useRef<string | undefined>(undefined);

	useEffect(() => {
		if (!fromDisk) return;
		const serialized = JSON.stringify(fromDisk);
		setDraft((current) => {
			if (current !== undefined) {
				const buffered = JSON.stringify(current);
				// Already matches (the usual case right after our own save): re-baseline
				// so a *later* external change is still adopted.
				if (buffered === serialized) {
					adopted.current = serialized;
					return current;
				}
				if (buffered !== adopted.current) return current;
			}
			adopted.current = serialized;
			return fromDisk;
		});
	}, [fromDisk]);

	const set = useCallback((patch: Partial<ServerSettingsDraft>) => {
		setDraft((current) => (current ? { ...current, ...patch } : current));
	}, []);

	const revert = useCallback(() => {
		if (!fromDisk) return;
		adopted.current = JSON.stringify(fromDisk);
		setDraft(fromDisk);
	}, [fromDisk]);

	const save = useCallback(async (): Promise<string | null> => {
		if (!context) return "MCTL is still starting up";
		if (!server || !draft) return "this server is still loading";
		setSaving(true);
		try {
			await context.servers.editServer(server.id, {
				name: draft.name.trim(),
				memory: draft.memory.trim(),
				runtime: draft.runtime,
				network: draft.network,
				// `undefined` means "leave the Java field alone" and `null` means "clear
				// the pin and resolve again" — the distinction `EditServerOptions` draws,
				// and the reason unticking the box is not the same as never touching it.
				javaPin: draft.javaPinned
					? Number.parseInt(draft.javaMajor, 10)
					: typeof server.java === "object"
						? null
						: undefined,
			});
			onSaved?.();
			return null;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		} finally {
			setSaving(false);
		}
	}, [context, server, draft, onSaved]);

	return {
		draft,
		set,
		dirty,
		issues: draft ? validateServerDraft(draft) : {},
		revert,
		save,
		saving,
	};
}
