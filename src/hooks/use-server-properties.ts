/**
 * useServerProperties — the Server page's Properties tab bridge to core: the
 * whole of `server.properties` as an edit buffer, and the write that commits it.
 *
 * UI-layer hook (AGENTS.md § 3): it reads the raw key map off the
 * {@link ServerInsight} the page is already polling and writes through
 * `core/server/properties-write.ts`. No file access of its own.
 *
 * **The buffer follows disk while it is clean and never while it is dirty**, the
 * same rule `useServerSettings` and the Settings page follow. It matters more
 * here: the insight re-polls every two seconds, so without that rule every
 * keystroke would race a poll and lose. The mechanism is the same `adopted` ref —
 * a buffer still equal to the last value taken from disk may safely take a new
 * one; anything else is an edit in progress and is left alone.
 *
 * **The buffer is raw strings, never the coerced {@link ServerProperties} view
 * model.** That model applies interpretations (hardcore overrides the reported
 * difficulty, the MOTD is stripped of `§` codes) which are right for a read-out
 * and wrong for an editor: saving from them would write back values the user
 * never typed. `properties-catalogue.ts` says only how to render and validate
 * each string.
 *
 * **Only changed keys are written.** A field showing Minecraft's default because
 * the file does not mention it stays unmentioned; see `properties-write.ts` for
 * why materialising defaults would be the wrong kind of edit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ServerInsight } from "../core/server/inspect.ts";
import {
	normalizeProperty,
	propertyFieldsFor,
	validateProperty,
	type PropertyField,
} from "../core/server/properties-catalogue.ts";
import { writeServerProperties } from "../core/server/properties-write.ts";
import type { Server } from "../types/server.ts";

/** Key → the value currently in the editor, for every field it offers. */
export type PropertyDraft = Record<string, string>;

/**
 * Build the baseline buffer: every catalogued key at its on-disk value or
 * Minecraft's default, plus every key the file carries that the catalogue does
 * not know. Pure, and exported so the mapping can be tested without a server.
 */
export function propertiesToDraft(
	fields: readonly PropertyField[],
	raw: Readonly<Record<string, string>>,
): PropertyDraft {
	const draft: PropertyDraft = {};
	for (const field of fields) {
		const value = raw[field.key];
		draft[field.key] = normalizeProperty(field, value ?? field.fallback);
	}
	return draft;
}

/** What {@link useServerProperties} hands the tab. */
export interface UseServerProperties {
	/** Every editable field: the catalogue plus this file's unknown keys. */
	fields: PropertyField[];
	/** The edit buffer, or `undefined` until the first inspection lands. */
	draft: PropertyDraft | undefined;
	/** Set one key. */
	set: (key: string, value: string) => void;
	/** Keys whose buffered value differs from disk. */
	changed: ReadonlySet<string>;
	/** Per-key validation messages; empty when every field is acceptable. */
	issues: Readonly<Record<string, string>>;
	/** Discard edits and re-adopt what is on disk. */
	revert: () => void;
	/**
	 * Write the changed keys. Resolves `null` on success or the failure message —
	 * the caller reports it as a toast, so it needs the text, not a flag.
	 */
	save: () => Promise<string | null>;
	/** True while a write is in flight. */
	saving: boolean;
	/**
	 * Whether the file exists yet. A server that has never booted has none —
	 * Minecraft writes it on the first run — and the editor is still usable there,
	 * because a saved key is merged into the file the server then generates.
	 */
	present: boolean;
	/** True until the first inspection round resolves. */
	loading: boolean;
}

/**
 * Load one server's `server.properties` into an edit buffer and commit changes
 * back.
 *
 * @param server the server to edit, or `undefined` while it is still loading.
 * @param insight the page's live inspection, which carries the raw key map.
 */
export function useServerProperties(
	server: Server | undefined,
	insight: ServerInsight | undefined,
): UseServerProperties {
	const [draft, setDraft] = useState<PropertyDraft>();
	const [saving, setSaving] = useState(false);

	const raw = insight?.properties?.raw;

	// Keyed on the *content* of the map, not its identity: the insight is rebuilt
	// every poll, so an effect keyed on `raw` would re-run twice a second while
	// its membership almost never changes.
	const signature = raw ? JSON.stringify(raw) : undefined;

	const fields = useMemo(
		() => propertyFieldsFor(raw ?? {}),
		// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on content
		[signature],
	);

	const fromDisk = useMemo(
		() => (insight ? propertiesToDraft(fields, raw ?? {}) : undefined),
		[fields, raw, insight],
	);

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

	const set = useCallback((key: string, value: string) => {
		setDraft((current) => (current ? { ...current, [key]: value } : current));
	}, []);

	const revert = useCallback(() => {
		if (!fromDisk) return;
		adopted.current = JSON.stringify(fromDisk);
		setDraft(fromDisk);
	}, [fromDisk]);

	const changed = useMemo(() => {
		const set_ = new Set<string>();
		if (!draft || !fromDisk) return set_;
		for (const [key, value] of Object.entries(draft)) {
			if (value !== fromDisk[key]) set_.add(key);
		}
		return set_;
	}, [draft, fromDisk]);

	const issues = useMemo(() => {
		const out: Record<string, string> = {};
		if (!draft) return out;
		for (const field of fields) {
			const message = validateProperty(field, draft[field.key] ?? "");
			if (message) out[field.key] = message;
		}
		return out;
	}, [draft, fields]);

	const save = useCallback(async (): Promise<string | null> => {
		if (!server || !draft) return "this server is still loading";
		// Built here rather than passed in: only the changed keys are written, and
		// the field order is the catalogue's, so anything appended to the file
		// arrives in a sensible order rather than in `Object.keys` order.
		const patch: Record<string, string> = {};
		for (const field of fields) {
			if (changed.has(field.key)) patch[field.key] = draft[field.key] ?? "";
		}
		if (Object.keys(patch).length === 0) return null;
		setSaving(true);
		try {
			await writeServerProperties(server.path, patch);
			return null;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		} finally {
			setSaving(false);
		}
	}, [server, draft, fields, changed]);

	return {
		fields,
		draft,
		set,
		changed,
		issues,
		revert,
		save,
		saving,
		present: insight?.properties !== undefined,
		loading: insight === undefined,
	};
}
