/**
 * Types describing **how a server is installed and how it is launched** — the
 * two things that differ genuinely between server kinds and which therefore must
 * not hide inside a single `install()` branch (plan.md § Design Principles #4).
 *
 * No I/O, no UI, no provider imports: this module only *describes* shapes. The
 * concrete strategies are produced by `ServerProvider.resolveInstall()` in
 * `providers/server/` and executed by `core/server/install.ts`.
 *
 * **Scope note.** Phase 2 shipped `directJar` + the `jar` launch spec; Phase 3
 * adds `loaderJar` (Fabric), `installer` (Quilt, Forge, NeoForge) and the
 * `argFile` / `script` launch specs. `buildFromSource` (Spigot) is still absent
 * because no provider needs it yet — the union is written against real
 * implementations, not imagined ones (AGENTS.md § 3). Every consumer switches on
 * `kind` and fails to compile rather than silently mishandle a new member.
 * See plan.md § Server Installation.
 */

import { z } from "zod";

/**
 * One published Minecraft (or server-kind) version a provider can install.
 * A flat view model — the UI picks from these and never sees provider types.
 */
export interface VersionInfo {
	/** Version id as the upstream API spells it, e.g. `"1.21.4"`. */
	id: string;
	/** Release channel. `other` covers upstream values we don't model (old betas). */
	type: "release" | "snapshot" | "other";
	/** ISO-8601 publish time, when upstream reports one. */
	releaseTime?: string;
}

/** A loader build (Fabric/Forge/…) for a given Minecraft version. Phase 3. */
export interface LoaderVersion {
	/** Loader version string. */
	version: string;
	/** Whether upstream marks this build stable/recommended. */
	stable: boolean;
}

/** What the caller wants installed; handed to `ServerProvider.resolveInstall()`. */
export interface InstallRequest {
	/** Target Minecraft version. */
	minecraftVersion: string;
	/** Loader version, for kinds that have one. Absent ⇒ provider picks latest. */
	loaderVersion?: string;
	/**
	 * Directory the install writes into. During a create this is the **staging**
	 * directory, not the final server directory — the tree is moved into place
	 * only after the whole install succeeds.
	 */
	dir: string;
}

/**
 * How to obtain a server's runnable files.
 *
 * Members are added per roadmap phase; each carries only what its executor needs
 * so the executor never has to consult the provider again mid-install.
 */
export type InstallStrategy =
	| {
			/**
			 * Download exactly one directly-runnable jar. Vanilla, Paper, Purpur and
			 * Velocity all publish such a jar, so nothing has to be executed at install
			 * time — the download *is* the install.
			 */
			kind: "directJar";
			/** Absolute URL of the jar. */
			url: string;
			/** Hex SHA-256 digest, when upstream publishes one (PaperMC does). */
			sha256?: string;
			/**
			 * Hex SHA-1 digest, when upstream publishes one instead (Mojang's piston-meta
			 * publishes SHA-1 only). Checked when `sha256` is absent.
			 */
			sha1?: string;
			/** Hex MD5 digest, for origins that publish only that (PurpurMC). */
			md5?: string;
			/** Destination path *relative to* {@link InstallRequest.dir}, e.g. `"server.jar"`. */
			dest: string;
			/** Expected size in bytes, when known — lets the UI show a real progress bar. */
			size?: number;
	  }
	| {
			/**
			 * Download a **pre-built launcher jar** produced by a loader's meta service.
			 *
			 * Mechanically identical to `directJar` — one GET, one file — and kept
			 * separate anyway because the two answer different questions. Fabric's
			 * `.../server/jar` endpoint *builds* a launcher on demand from a
			 * (game, loader, installer) triple, so there is no published digest to
			 * verify against and the artefact is not the server itself: it is a thin
			 * launcher that downloads the vanilla jar and the loader's libraries on
			 * **first boot**. A caller that wants to know "is this server ready to run
			 * offline?" needs to be able to tell the two apart.
			 *
			 * See `providers/server/fabric.ts` for the endpoint.
			 */
			kind: "loaderJar";
			/** Absolute URL of the launcher jar. */
			url: string;
			/** Destination path relative to {@link InstallRequest.dir}. */
			dest: string;
			/** Digest, on the rare occasion the meta service publishes one. */
			sha256?: string;
			/** Expected size in bytes, when known. */
			size?: number;
	  }
	| {
			/**
			 * Download an **installer jar and execute it**. Forge, NeoForge and Quilt
			 * all ship one: the artefact you download is a program that generates the
			 * real server tree (a library directory plus, for Forge 1.17+, an
			 * `@argfile` and a `run.sh`).
			 *
			 * Running the installer needs a JVM, which is why
			 * `executeInstall` takes a `javaPath` — this is the one strategy that
			 * cannot complete on a machine with no Java, and it is resolved *before*
			 * the download so that failure is immediate.
			 */
			kind: "installer";
			/** Absolute URL of the installer jar. */
			url: string;
			/** Where the installer jar is downloaded to, relative to the install dir. */
			dest: string;
			/** Digest, when upstream publishes one. */
			sha256?: string;
			/** Expected size in bytes, when known. */
			size?: number;
			/**
			 * Arguments after `java -jar <dest>`, e.g. `["--installServer"]`. The
			 * installer is run with its working directory set to the install directory,
			 * because every one of these installers writes relative to the cwd.
			 */
			args: string[];
			/**
			 * How the installed server will be launched. The installer's *output* layout
			 * is knowable from the versions alone (Forge's argfile path embeds them), so
			 * the provider states it here rather than the executor having to go and
			 * discover it afterwards.
			 */
			produces: LaunchSpec;
			/**
			 * Paths (relative to the install dir) to delete once the installer has run —
			 * the installer jar itself and the log it leaves beside it. Missing entries
			 * are ignored: what an installer leaves behind varies by version.
			 */
			cleanup: string[];
	  };

/**
 * How to launch an installed server.
 *
 * A **Zod schema, not a bare type**, because unlike {@link InstallStrategy} this
 * one is *persisted*: a launch spec that had to be derived from generated files
 * is recorded in `mctl.json` at create time (see `types/server.ts`), so it must
 * be validated on the way back off disk like everything else.
 */
export const LaunchSpec = z.discriminatedUnion("kind", [
	z.object({
		/** `java <jvmArgs> -jar <jar> nogui` — the classic runnable-jar launch. */
		kind: z.literal("jar"),
		/** Jar path relative to the server directory, e.g. `"server.jar"`. */
		jar: z.string().min(1),
	}),
	z.object({
		/**
		 * `java <jvmArgs> @<file…> nogui` — Forge and NeoForge from Minecraft 1.17
		 * onwards.
		 *
		 * Those versions ship **no runnable jar at all**. The installer generates
		 * `libraries/net/minecraftforge/forge/<mc>-<forge>/unix_args.txt` (NeoForge:
		 * `libraries/net/neoforged/neoforge/<version>/unix_args.txt`), an `@argfile`
		 * holding the module path and main class. Launching the *installer* jar
		 * directly — the obvious mistake — silently re-runs the installer instead of
		 * starting a server.
		 */
		kind: z.literal("argFile"),
		/** Argfile paths relative to the server directory, in JVM argument order. */
		files: z.array(z.string().min(1)).min(1),
	}),
	z.object({
		/**
		 * Delegate to a script the installer generated (`run.sh` / `run.bat`).
		 *
		 * The fallback for a generated layout MCTL cannot express as an argfile.
		 * **JVM arguments cannot be passed on the command line here** — Forge's
		 * `run.sh` reads them from `user_jvm_args.txt` — so a runtime launching a
		 * script writes the heap flags to that file first. That indirection is the
		 * reason `argFile` is preferred wherever it is available.
		 */
		kind: z.literal("script"),
		/** Script path relative to the server directory, e.g. `"run.sh"`. */
		path: z.string().min(1),
		/** File the heap flags are written to before launch, when the script reads one. */
		jvmArgsFile: z.string().min(1).optional(),
	}),
]);
export type LaunchSpec = z.infer<typeof LaunchSpec>;
