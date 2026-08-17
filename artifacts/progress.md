# MCTL — Progress

Baseline state for the next session. What's done, what's half-done and where it stopped, what to pick
up next. Updated at the end of every session that changes code or decisions.

_Last updated: 2026-08-17 (network profile management + the Server settings form)_

---

## Done

- **Provider options are fields, not a `key=value` box (2026-08-17, user report).** "All those
  specific options are in the options field, for all the provider. It's not a good user experience."
  - `src/types/network.ts` (**new** `NetworkOption`, `NetworkOptionKind`, `NetworkOptionChoice`) +
    `src/types/provider.ts` — **`NetworkProvider.options`**, required. All five providers declare
    theirs: direct (host, publicAddress), cloudflared (mode + the three tunnel fields behind
    `showWhen`, timeout), playit (address, timeout), ngrok (region as a choice, remoteAddr, timeout),
    tailscale (preferIp).
  - `src/core/network/profiles.ts` — `visibleOptions` (drops a field whose condition is unmet),
    `optionValue` (unset ⇒ the provider's fallback), `withOption` (a value equal to the fallback, or
    empty, is stored as nothing) and `describeOptions` (the same declaration as help text).
  - `src/app/Settings/index.tsx` — the single Options input is gone; `OptionField` renders each
    declared option as an `Input`, `Checkbox` or `Select`, values stored **typed**. A fallback shows
    as the placeholder, a non-numeric number is flagged and holds Save (checked across every
    profile), and the ring splices in one id per visible option. `PROVIDER_OPTION_HINTS` deleted.
  - `src/app/Settings/use-settings.ts` — `ProfileDraft.options` is a `Record<string, unknown>`
    instead of `key=value` text; nothing is parsed on the way to disk, and undeclared keys are
    carried through untouched.
  - `src/cli/commands/network.ts` — the hand-written provider-options section of `--help` is now
    generated from the registry.
  - `src/components/Form.tsx` — `Select` gained `invalid`, which `Input` already had.
  - Tests (**618 total**, +12): the three core helpers and the help formatting (6), and an invariant
    over what the shipped providers declare — unique keys, every `showWhen` resolving to a
    choice/boolean, every choice having options (6).
  - Verified: `bunx tsc --noEmit` clean, `bun test` 618 pass / 0 fail, `bun run format` clean, biome
    clean bar the pre-existing `Table.tsx` warning. **In tmux at 140×44**: switching Provider swapped
    direct's two fields for cloudflared's; choosing *pre-defined* revealed tunnel id / hostname /
    name; a save wrote only `{"mode":"named"}` (the untouched timeout stayed absent) and
    `mctl network profile show` read it back; a typed `45` stored as the **number** 45; and `45x`
    flagged the field, marked the tab `Network !`, printed the reason and made Ctrl+S a no-op.

- **cloudflared profiles pick a mode, and can run a pre-defined tunnel by id (2026-08-17, user
  request).** "Add option for trycloudflare domain, and also using pre-defined tunnels using tunnel
  id."
  - `src/providers/network/cloudflared.ts` — new pure, exported
    **`planCloudflared(options, port, hasToken)`** turning a profile into argv. Options gained
    `mode` (`quick` | `named`, inferred when absent so existing profiles are unchanged) and
    **`tunnelId`** (validated as a UUID; `tunnel` stays as the name alias, and the id wins when both
    are set). A dashboard-managed tunnel runs on **`CLOUDFLARED_TOKEN`** from `secrets.json`, passed
    as `TUNNEL_TOKEN` in the child's environment — with a token, `run` takes no argument at all.
    `preflight` now reports a token the way ngrok's does.
  - `src/app/Settings/index.tsx` + `src/cli/commands/network.ts` — the Options field's hint names the
    new keys, and `mctl network profile --help` gained a provider-options section.
  - Tests (**606 total**, +9): `providers/network/matchers.test.ts` covers both modes, the id/name
    precedence, the token path, and all four refusals.
  - Verified: `bunx tsc --noEmit` clean, `bun test` 606 pass / 0 fail, `bun run format` clean, biome
    clean bar the pre-existing `Table.tsx` warning. **Against real cloudflared**: `mode=quick`
    brought up a live tunnel (`chancellor-requires-automobiles-distribute.trycloudflare.com`),
    reported `up`, and tore down cleanly; all four bad profiles were refused *before* anything was
    spawned; and a well-formed but unknown tunnel id failed inside its timeout leaving no descriptor,
    with `tunnel credentials file not found` in `network/<id>.log`.
  - **Not verified against a real account:** a named tunnel actually carrying traffic, and the token
    path end to end — both need a Cloudflare account this machine does not have. The argv and the
    environment are unit-tested; the `Registered tunnel connection` matcher is unchanged from the
    last session.

- **Network profiles are manageable, and the Server Settings tab is a form (2026-08-17, user
  request).** "The settings section in the Server is not done yet. There's no way of managing
  network settings." Both landed, with CLI parity; scope agreed with the user up front.
  - `src/core/network/profiles.ts` (**new**) — the write side of `config.network.profiles`, whose
    read side was already `NetworkManager.profiles()`. Pure `Config → Config` transforms
    (`withProfile` / `withoutProfile` / `withDefaultProfile`) plus one-line `writeConfig` wrappers,
    and the shared `parseOptions` / `formatOptions` `key=value` format both front-ends use.
    `direct` and the configured default may not be deleted.
  - `src/cli/commands/network.ts` — **`mctl network profile [list] | show | set | rm | default`**,
    with `--provider`, `--options`, the five `--dns-*` flags and `--no-dns`. A partial `set` merges
    over the profile it edits; an unknown provider id is refused with the list this build has; `rm`
    names the servers it just stranded.
  - `src/app/Settings/` — the Network group is now an editor: a profile picker and the three list
    actions (New profile / Make default / Delete <name>) above, then that profile's Name / Provider
    / Options / Cloudflare DNS (zone, hostname, TTL, SRV, proxied). The list actions were moved up
    out of the field stack after the user reported "Add profile" reading as part of the profile
    being edited; a new row starts **unnamed** with the cursor in its Name field; and the separate
    "Default profile" radio group was dropped for a `· default` marker on the profile itself.
    `Select` gained the `invalid` prop `Input` already had. `SettingsDraft` gained `profiles: ProfileDraft[]` (an array, not a record — a record
    cannot express a rename), `profileIssues` for per-field marks, and `validateDraft` rolls them up
    so the Network tab is flagged from any group. A save that strands a server raises a warning toast.
  - `src/app/Network/index.tsx` — a *Manage profiles* button and `p`, both navigating to
    `settings` with the new `RouteParams.group`. The page stays read-only; the editor has one home.
  - `src/app/Server/tabs/Settings.tsx` — rewritten from a read-only panel to a form over
    `ServerManager.editServer`: Name, Memory, Runtime, Network profile and the Java pin, with
    Revert/Save and Ctrl+S. Identity, kind, version and path stay read-only — changing kind or
    version is an *update*, which core does not have. `src/hooks/use-server-settings.ts` (**new**)
    is its bridge, buffering like `use-settings.ts` (a dirty buffer is never clobbered by a poll).
  - `src/app/Server/panels.tsx` + `index.tsx` — `ServerTabProps` gained `focus`, `onFormState` and
    `onRefresh`; the container splices `serverSettingsRingIds(state)` into its own ring while the
    tab is active, because only one ring may listen at a time.
  - Tests (**594 total**, +43): `core/network/profiles.test.ts` (19), the profile half of
    `app/Settings/use-settings.test.ts` (+11), `hooks/use-server-settings.test.ts` (8) and
    `app/Server/tabs/Settings.test.tsx` (5, real frames).
  - Verified: `bunx tsc --noEmit` clean, `bun test` 594 pass / 0 fail, `bun run format` clean, biome
    clean bar the pre-existing `Table.tsx` warning. **Driven for real in a sandbox `$HOME`**: the CLI
    created/edited/showed/removed profiles, refused an unknown provider (exit 2), a bad name,
    `rm direct` and `rm` of the default, and reported the stranded `survival`. **In tmux at 140×44**:
    `p` on the Network page landed on the Settings → Network group; switching profiles loaded each
    one's fields; Add wrote `profile-4` to `config.json` and Delete removed `cf-tunnel` from disk
    with the orphan warning toast; and on the Server page the form wrote `memory 2G → 6G`, a network
    profile change and a `{"pinned": 21}` Java pin to `mctl.json`, then cleared the pin on untick.
  - **One real defect found in the pty**, recorded in `memory.md`: switching the profile picker
    *renamed* the profile, because OpenTUI emits `onInput` when an `<input>`'s value prop is
    assigned and the same renderable was reused across rows. Fixed by keying the field grid.
  - **Not done, deliberately:** changing a server's kind or Minecraft version (an update operation
    core does not have), and per-provider typed option fields — the Options field is one `key=value`
    line with the provider's own keys named in its hint.

- **Plugins and zipped packs draw their icons too (2026-08-14, user request).** "The plugins /
  Datapack / Resource packs have icons too. Try to render them." Nothing in the UI or the extraction
  path needed changing — the one rule that decides *which* entry is the icon was root-only, and no
  plugin keeps its icon at the root.
  - `src/core/server/content-meta.ts` — `pickIconEntry` now also accepts a **nested** PNG whose
    basename is exactly `icon.png`/`logo.png`/`pack.png`, excluding anything under a `textures/`
    segment, shallowest first then alphabetically. Root entries still win, and the loose
    `icon|logo` name match stays root-only (nested, it would pick an item sprite). New
    `ICON_BASENAMES`.
  - This covers all three the user named: a Bukkit/Paper plugin (`plugin.yml` has no icon field at
    all, so `assets/<plugin>/icon.png` is the only way one is ever found), and a datapack or resource
    pack zipped by compressing its own folder (`<name>/pack.png`). Both go through the existing
    per-archive cache and the existing `<image>` column, which were already section-agnostic.
  - Tests (**550 total**, +8): five over `pickIconEntry` (the plugin path, the wrapped pack, exact
    basename vs `icons.png`, shallowest-then-alphabetical, root still winning) and three end-to-end
    over real archives in a real server directory (a plugin jar, a wrapped datapack zip, and a jar
    holding only sprites getting no icon).
  - Verified: `bunx tsc --noEmit` clean, `bun test` 550 pass / 0 fail, `bun run format` clean, biome
    clean bar the pre-existing `Table.tsx` warning. Against the user's **real** `first-paper-server`,
    `mctl content --json` extracted Geyser's `assets/geyser/icon.png` (a real 512×512 PNG) where it
    previously had none, and **in tmux at 120×45** the Plugins panel draws it beside the row.
  - **Not done, and it needs a decision:** the *Resource pack* panel has no icon, because it is not a
    file — `server.properties` holds a **URL**, and drawing its `pack.png` would mean downloading a
    user-configured archive (routinely tens of MB) on the render path. Ask before adding it.

- **An item with no icon draws a fallback (2026-08-14, user request).** "If still no image, then show
  a fallback image." Plenty of jars ship no logo at all — every `plugin.yml` declares none — so a
  blank box was the common case, not the exception.
  - `src/app/Server/tabs/content-placeholder.ts` (**new**) — `PLACEHOLDER_ICON`, a cardboard-box PNG
    inlined as a `data:` URL. A constant string is the stable `<image source>` identity a 15 s poll
    needs (the same reason `ContentItem.icon` is a path), and nothing has to be resolved at runtime.
    The user replaced the agent's first grey-frame asset with this one mid-session.
  - `src/app/Server/tabs/Content.tsx` — the row's `<image>` falls back to it, and the icon column is
    now reserved whenever `width >= ICON_ROW_WIDTH` rather than when something in the section has a
    picture. The box gained an explicit `backgroundColor`, without which transparent corners draw
    **black** (the block renderer blends alpha into an unpainted, i.e. black, buffer cell). `fit` is
    `cover` (the user's change), so a non-square logo fills the column instead of letterboxing.
  - Tests (**551 total**, +1 net): the "an icon indents the whole section" case was replaced — the
    column no longer depends on any jar having one — by two: names lining up whether or not a jar
    ships a logo, and a jar with none still drawing block glyphs in the icon cells. The parked-jar
    assertion stopped matching the whole line, which now leads with the picture.
  - Verified: `bunx tsc --noEmit` clean, `bun test` 551 pass / 0 fail, `bun run format` clean, biome
    clean bar the pre-existing `Table.tsx` warning. **In tmux at 120×45** against the real
    `first-paper-server`: Geyser draws its own icon, floodgate and the `bukkit` datapack draw the
    box, and the escape sequences confirm the corners now take the theme background rather than
    `#000000`.
  - **Known:** two dead ends worth not repeating are recorded in `memory.md` — a transparent-ground
    placeholder, and authoring one at 32×32 for a ~12×6 raster.

- **Content rows lead with the mod's own icon (2026-08-14, user request).** "Most of the mods or
  plugins has an icon with it. Use opentui image element… Display the icon on the begining of the
  row." Followed by: "Make the row hight 3. Let the description span to two row. Make the icons 3x3
  cell."
  - `src/lib/zip.ts` — **`readZipEntry(path, choose)`**: the chooser is handed the archive's own
    entry names and returns the one to read, so an icon whose name is not known in advance costs one
    open and one inflated entry.
  - `src/core/server/content-meta.ts` — `ContentMeta.icon`, filled from Forge/NeoForge `logoFile`,
    `mcmod.info` `logoFile`, Fabric `icon` and Quilt `quilt_loader.metadata.icon` (a sized
    `{"128": …}` map yields its largest). New pure, exported **`pickIconEntry(names)`** for the
    convention a jar that declares nothing still follows: a root-level PNG, never `assets/`.
  - `src/lib/paths.ts` — `contentIconCacheDir()` (`~/.cache/mctl/content-icons/`).
  - `src/core/server/content.ts` — `ContentItem.icon` is an absolute **path**, not bytes (a poll
    rebuilds the listing, and fresh arrays would reload every image on screen). Extracted once,
    cached by jar path + size + mtime, capped at 4 MB, never throwing; an unpacked datapack uses its
    own `pack.png` uncopied.
  - `src/app/Server/tabs/Content.tsx` — an `<image source={item.icon} fit="fit" />` at the head of
    each row in a **6×3** cell box (square: a cell is ~2:1, so a three-row picture needs six
    columns), the column reserved for the whole section when anything in it has one and dropped
    below `ICON_ROW_WIDTH` (64). Rows are a fixed three tall: name line plus a two-row description
    that **wraps** into the space instead of being truncated to one line.
  - **Two sizing corrections after the first cut** (`50fc1f6`): the box was 3×3, which draws every
    logo at half width; and the size was only on the wrapping box, so the image itself laid out
    `auto` and drew at a fraction of the cells the row had reserved. An `<image>` needs its own
    `width`/`height`.
  - Tests (**542 total**, +20): `pickIconEntry` and the four manifest icon fields, `readZipEntry`
    (3), extraction into the cache including the declared-but-absent logo, the cache actually being
    reused, and a datapack's own `pack.png` (6), plus rendered frames for the three-row height, the
    wrap onto the second row, the section-wide indent and the narrow-terminal drop (3). Both content
    test files now redirect `XDG_CACHE_HOME` — `paths.ts` resolves XDG at call time, so without it
    the suite wrote into the developer's real `~/.cache/mctl`.
  - Verified: `bunx tsc --noEmit` clean, `bun test` 542 pass / 0 fail, `bun run format` clean, biome
    clean bar the pre-existing `Table.tsx` warning. Against the user's **real** `create-server` all
    six mods extracted a valid PNG (128², 256², 1080², and JEI's 32² found only by the root-PNG
    fallback), and **in tmux at 120×45** every row draws its icon with three-row spacing and
    two-line descriptions; at 50 cells the column is dropped.
  - **Known:** under tmux `protocol="auto"` always resolves to Unicode blocks, so the logos are
    drawn as half-block glyphs — legible and correctly proportioned, but coarse. A Kitty- or
    Sixel-capable terminal outside tmux renders them as real graphics. Only the tmux path has been
    seen; the user's own terminal is unconfirmed.

- **Mods whose `mods.toml` annotates every line are named again (2026-08-14, user-reported defect).**
  "See the `create-server` server. Some mods are not properly displaying. like JEI and create
  aeronotics." Both showed their filename with no version, description or loader.
  - `src/core/server/content-meta.ts` — new pure `stripComment(line)`, quote-aware, used by both the
    `[[mods]]` header test and the value path. NeoForge's generated template writes
    `[[mods]] #mandatory`, so the reader never entered the block at all; and the old value stripper's
    `!raw.startsWith('"')` guard made `modId="jei" #mandatory` unstrippable and then unquotable.
    The `'''…'''` branch is untouched — it already ends at its closing fence.
  - Tests (**522 total**, +2): the fully-annotated NeoForge template parsed end to end, and a `#`
    inside a quoted value kept as content.
  - Verified: `bunx tsc --noEmit` clean, `bun test` 522 pass / 0 fail, `bun run format` clean, biome
    clean bar the pre-existing `Table.tsx` warning. Against the user's **real** `create-server`:
    `mctl content create-server` names all six mods (Cloth Config v15 API, Create, Create
    Aeronautics, Ferrite Core, Jade, Just Enough Items) with versions and descriptions, no
    `derivedName` left; confirmed in the Content tab **in tmux at 120×45**.
  - **Noticed, not changed:** every row's checkbox glyph renders blank in the user's working tree —
    `boxed` is commented out on the `Checkbox` in `app/Server/tabs/Content.tsx` (an uncommitted local
    edit), and without it the unticked/ticked state has no visible mark. See `memory.md` § The
    Content list lost its caret for why `boxed` was added.

- **A kind declares what content it loads (2026-08-14, user request).** "Every server type doesn't
  support mods or plugins. Add a field in the server registry for mods/plugins support and render
  them accordingly."
  - `src/types/content.ts` (**new**) — `ContentSectionId` (moved here from the content service, which
    re-exports it) and `ContentSupport`, a complete `Record` so a new section id is a compile error in
    every provider.
  - `src/types/provider.ts` — **`ServerProvider.content: ContentSupport`**, required. All eight
    providers carry one (`FillProvider` declares it abstract; Paper and Velocity differ), plus the two
    test stubs. Velocity is plugins-only (a proxy has no world, so no datapacks); Vanilla is
    datapacks-only; the four loaders are mods + datapacks.
  - `src/core/server/content.ts` — `ContentSection.supported`, and `readServerContent` takes an
    optional `ProviderRegistry`. Unsupported directories are **still read**; the exported
    `contentSupport(kind, providers?)` never throws and reports an unknown kind as supporting
    everything.
  - `src/hooks/use-server-content.ts` — resolves the registry from `useMctl()` and re-runs the poll
    once the context lands. `src/cli/commands/content.ts` — builds `createProviderRegistry()` and
    prints one line for an unsupported empty section, a warning header for one with files in it.
  - `src/app/Server/tabs/Content.tsx` — an unsupported *empty* section draws no panel at all; one with
    files draws a warning line and no marketplace button.
  - Tests (**520 total**, +3): the section-vs-directory distinction, files in an unsupported directory
    still being listed, and the unknown-kind/no-registry fallback.
  - Verified: `bunx tsc --noEmit` clean, `bun test` 520 pass / 0 fail, `bun run format` clean, biome
    clean bar the pre-existing `Table.tsx` warning. Driven for real in a sandbox `$HOME` holding four
    fabricated servers (paper/fabric/vanilla/velocity) with real fixture jars: `mctl content` printed
    the right line for each, and **in tmux at 120×40** the Paper server showed the Mods panel with its
    warning and no marketplace button, Vanilla showed only Datapacks, and Velocity only Plugins.
  - **Noticed, not changed:** the Resource pack panel is still drawn for Velocity, which has no
    `server.properties` at all. Same class of problem, different field — worth a look next.

- **The Content list is checkboxes in name order (2026-08-14, user request).** "Always order based on
  names, not by enabled/disabled. Remove the selection logic, render with a border between. Add
  checkbox component for enable/disable."
  - `src/core/server/content.ts` — a section's items sort by display name alone; the enabled-first
    grouping is gone (a toggled row used to jump out from under the pointer).
  - `src/components/Form.tsx` — `Checkbox` gained `noBorder` (drop the field frame for inline use),
    `boxed` (`[x]`/`[ ]`, needed because the `ascii` set's unchecked glyph is the empty string) and
    `captionColor`.
  - `src/app/Server/tabs/Content.tsx` — `ContentRow` is a `Checkbox` carrying the item's name, the
    facts right-aligned, and the description/filename lines indented under the name; rows are
    separated by a bottom-border rule, with none under the last. The caret, the selection state and
    effect, the keyboard handler and the context hints are all gone.
  - `src/app/Server/index.tsx` — `CONTENT_ID` removed from the page's focus ring; the tab takes no
    keys, so a stop there would be a Tab that lands on nothing.
  - Tests (**517 total, 53 files**, +2): the tab's name-ordering + one-rule-between-rows frame, and a
    **real mouse click** on a row's checkbox renaming `sodium.jar` to `.disabled` on disk. The core
    ordering test now asserts name order.
  - Verified: `bunx tsc --noEmit` clean, `bun test` 517 pass / 0 fail, `bun run format` clean,
    `bunx biome check src` clean bar the one pre-existing `Table.tsx` warning. Frames read at 100
    cells over four real jars (one parked, one corrupt).
  - **Known trade-off:** enabling/disabling is now **mouse-only in the TUI** — `mctl content
    enable|disable` is the keyboard path. Restoring keys means a focus ring over the checkboxes,
    which is the selection logic this removed.

Every entry is dated. Dates are the date of the commit that landed the work, not the order of this
list — the first six entries are the most recent, the rest run oldest-first below them. "user request"
/ "user report" marks work the user asked for mid-session; entries with neither were driven by the
roadmap in `plan.md`.

- **The Content tab lists what is installed, and can park it (2026-08-14, user request).**
  "Display the list of installed mods/plugins/resource packs. Load the files and display the metadata
  in a list view. Add option to enable or disable mods. Add a dummy button for market place."
  - `src/lib/zip.ts` (**new**) — a read-only ZIP reader (`readZipEntries` / `readZipText`), stored and
    deflated members, ZIP64 and encrypted entries throw `ZipError`. It **seeks**: EOCD from the tail,
    then the central directory, then only the wanted entries' local headers — a mod jar is tens of MB
    and its manifest is a few hundred bytes. `src/lib/zip.fixture.ts` (**new**, test-only) builds real
    archives (real CRC-32s, real deflate) so both test files can make fixtures without importing each
    other.
  - `src/core/server/content-meta.ts` (**new**) — pure manifest readers: `fabric.mod.json`,
    `quilt.mod.json`, `META-INF/neoforge.mods.toml`, `META-INF/mods.toml`, `mcmod.info`,
    `plugin.yml` / `paper-plugin.yml`, `pack.mcmeta`, plus `parseJarMeta` (the precedence) and
    `manifestVersion` (Forge's `${file.jarVersion}` resolved from `META-INF/MANIFEST.MF`). The TOML
    and YAML readers are deliberately narrow — MCTL still writes JSON only.
  - `src/core/server/content.ts` (**new**) — `readServerContent(server, levelName)` (the expensive
    twin of `inspect.ts`'s counts) and `setContentEnabled(server, item, enabled)`, which renames to
    and from `*.jar.disabled`. Refuses an existing target, a path outside the server directory, and
    datapacks (a world records which are on, so a rename would corrupt `level.dat`'s view).
  - `src/hooks/use-server-content.ts` (**new**) — 15 s self-chaining poll, immediate refresh on a
    toggle, `toggle` returning `null | message` like `usePlayers.act`.
  - `src/app/Server/tabs/Content.tsx` — rewritten: a section per list with its counts, its directory
    and a *Browse marketplace* placeholder (Phase 5), one row per item (checkbox, name, description,
    and version/loader/size above 72 cells), then the unchanged Resource pack and On disk panels.
    Joins the container's ring as `CONTENT_ID`: ↑/↓ select, Space toggles, `m` opens the placeholder.
  - `src/cli/commands/content.ts` (**new**) + router — `mctl content <id> [--json]` and
    `mctl content enable|disable <id> <file>`, the tab's CLI peer over the same core functions.
  - Tests (**515 total, 53 files**, +53): `lib/zip.test.ts` (9), `core/server/content-meta.test.ts`
    (23), `core/server/content.test.ts` (15, real jars in a real server directory — including the
    overwrite, outside-the-directory and datapack refusals), `app/Server/tabs/Content.test.tsx` (6,
    real frames over real jars).
  - Verified: `bunx tsc --noEmit` clean, `bun test` 515 pass / 0 fail, `bun run format` and
    `bunx biome check src` clean bar one pre-existing warning (`components/Table.tsx` unused import).
    Driven **in tmux at 120×42 and 70×30** against a sandbox `$HOME` holding real fixture jars: a
    Fabric mod, a Forge mod whose `${file.jarVersion}` resolved to `19.21.0.247`, a Bukkit plugin, a
    zipped datapack, a parked jar and a deliberately corrupt one. Space renamed `lithium-0.14.jar` to
    `.disabled` on disk, the row moved to the disabled group and the caret stayed on it; `m` and a
    datapack toggle both raised their toasts; at 70 cells the version column drops with no wrap. CLI
    exercised for list, `--json`, enable by display name, disable by filename, an unknown name (exit
    2), a datapack (exit 1) and the overwrite guard (exit 1).
  - **Not done, deliberately:** installing anything. The marketplace buttons report that they are
    Phase-5 placeholders rather than doing nothing silently.

- **Forms became a responsive grid; the version field spins (2026-08-14, user request).**
  - `src/components/FormGrid.tsx` (**new**) — `FormGrid` measures its own width and lays children out
    in as many columns as fit (two by default, from 94 cells), plus `FormGridItem span="full"` and
    the pure, exported `columnsFor` / `packRows`. Packing is row-major and order-preserving, so both
    pages' focus rings are unchanged.
  - `src/components/Spinner.tsx` (**new**) — the shared work-in-flight glyph over the active icon
    set's frames; self-ticking at 10 fps unless the caller supplies `frame`.
  - `src/components/Form.tsx` — `Select` gained `prefix`/`suffix`, forwarded to `FormField`; the
    tabs-vs-dropdown width test subtracts the cells an affix occupies.
  - `src/app/VersionField.tsx` — a `Spinner` sits in the field while the list is being fetched; the
    hint no longer spends its line on "loading versions…" and only names the wait when it has nothing
    else to say.
  - `src/app/ServerCreate/index.tsx` — the six fields moved into a `FormGrid`, paired **by height**
    after the user reported the first cut as badly organised: Name|Memory, Kind|Version,
    Runtime|EULA, with the ring order following. Kind dropped its per-option descriptions (halving
    a dropdown row's height; the line under the field already describes the highlighted kind) and
    both list fields cap at six rows. The version hint and EULA caption were shortened — an
    over-long `bottomTitle` is *dropped* by OpenTUI, not truncated.
  - `src/app/Settings/index.tsx` — Locations (the two overrides), Defaults (Kind/Version,
    Memory/Runtime, full-width EULA), Backups (full-width switch, then Provider/Compression) and
    Appearance (Theme/Icons) all grid; the hardcoded `width="50%"` fields are gone.
  - Tests (**462 total, 49 files**, +12): `components/FormGrid.test.tsx` (8 — the packing rules plus
    real frames proving the reflow at 90 and 40 cells), `components/Spinner.test.tsx` (3, including
    that it animates with no caller-supplied frame), and one more in `app/VersionField.test.tsx`
    (the field spins while loading and does not while idle; its mount now pins the `ascii` icon set).
  - Verified: `bunx tsc --noEmit` clean, `bun test` 462 pass / 0 fail, `bun run format` and
    `bunx biome check src` clean. Driven **in tmux against a sandbox `$HOME`**: the create form at
    140×40 (two columns, whole form on screen) and 70×30 (one column); all five Settings groups at
    140×40, including Backups with the switch on; and, with `~/.cache/mctl/api` cleared, the version
    field's spinner captured mid-animation on four consecutive frames.

- **The version field became a picker; kinds describe themselves (2026-08-14, user request).**
  - `src/types/install.ts` — `VersionInfo.type` gained `beta` and `alpha`;
    `providers/server/mojang-meta.ts` maps `old_beta`/`old_alpha` onto them instead of `other`.
  - `src/types/provider.ts` — **`ServerProvider.description`**, required. All eight providers (plus
    the abstract `FillProvider` and the manager test's stub) carry one.
  - `src/core/server/versions.ts` (**new**) — `listMinecraftVersions(providers, kind)` plus the pure
    `availableChannels` / `filterVersions`, `VERSION_CHANNELS`, `CHANNEL_LABELS`, `DEFAULT_CHANNELS`
    (releases only). Nothing cached; `lib/http.ts` already ETag-caches the manifests.
  - `src/hooks/use-server-versions.ts` (**new**) — fetches for the selected kind, holds the shown
    channels, never blocks a render. Per-kind memo in a ref so flipping the Kind select back does
    not blank the picker for a round trip.
  - `src/app/VersionField.tsx` (**new**) — the picker + the "also show" channel row, taking the
    fetched list as a prop (hence fully testable offline). `versionFieldIds(state)` is exported so
    each page splices the variable-length ring into its own.
  - `src/app/ServerCreate/index.tsx` — version input → `VersionField`; the Kind select's options
    carry the provider description and the selected kind's is drawn under the field.
  - `src/app/Settings/index.tsx` — same field in the Defaults group, which now leads with Kind
    (the version list belongs to it); `ringIds` takes the channel ids.
  - `src/cli/commands/versions.ts` (**new**) + router — `mctl versions [kind] [--channel …] [--all]
    [--json]`, the picker's CLI peer over the same core functions.
  - Tests (**450 total, 47 files**, +18): `core/server/versions.test.ts` (10, the channel rules +
    the registry delegation) and `app/VersionField.test.tsx` (8, real frames: which channels get a
    toggle, the hint's three states, a snapshot naming its channel, and a value that outlived its
    list staying selected).
  - Verified: `bunx tsc --noEmit` clean, `bun test` 450 pass / 0 fail, `bun run format` and
    `bunx biome check src` clean. Driven **in tmux at 120×40** against a sandbox `$HOME`: the create
    form's picker filled from the live APIs, Paper showed one toggle and Vanilla three, Space on
    *Snapshots* refilled the list (102 → 845 of 906), the kind description tracked the Kind tabs,
    and a version picked in Settings + Ctrl+S wrote `"minecraftVersion": "26.1.2"`. CLI checked
    against live upstream for vanilla/fabric/velocity, `--channel alpha`, an unknown channel
    (usage error) and an unknown kind.
  - **Not done, deliberately:** the setup wizard's Defaults step is still a text input — it runs
    before there is a config (so no `MctlContext`) and is the screen most likely to be met offline.
    A full TUI create with a picked version was not run (it is a real download); the value reaches
    `createServer` as the same string the input produced.

- **`Select` answers the mouse; the field label lost its caret (2026-08-14, user request).**
  - `src/components/support.ts` — `tabSelectHit` + `TabSelectHit`/`TabSelectGeometry` (new, pure and
    exported): a pointer offset inside a `<tab-select>` resolved to the tab or end arrow drawn there,
    reconstructing the scroll maths the renderable keeps private.
  - `src/components/Form.tsx` — `Select` gained the whole pointer vocabulary: wheel over the dropdown
    walks the selection (clamped, and consumed so the page does not scroll too), a click picks the tab
    under the pointer, and resting on an end arrow walks toward the hidden options at one per 180 ms.
    An effect pushes the controlled index into the `<tab-select>` renderable (it has no
    `selectedIndex` prop, so the strip could highlight a tab the value had moved off), and `pick` now
    ignores a pick that lands on the current value — otherwise that sync echoes back as an `onChange`.
  - `src/components/Form.tsx` — `FormField` no longer prefixes its label with `▸` while focused.
  - Tests (**432 total, 45 files**, +11): `components/support.test.ts` (7, the tab geometry: scroll
    offset, arrows winning over the tab beneath them, empty slots, a strip narrower than one tab) and
    `components/Form.mouse.test.tsx` (4, the real control driven with `harness.mockMouse`).
  - Verified: `bunx tsc --noEmit` clean, `bun test` 432 pass / 0 fail, `bun run format` and
    `bunx biome check src` clean. Driven in **tmux with real mouse escape sequences** against a
    sandbox `$HOME`: at 120 cols a click on *Fabric* selected it; at 60 cols (dropdown layout) three
    wheel-downs walked Paper→Forge and scrolled the list, two wheel-ups walked back, and the page
    behind it never scrolled; at 90 cols (strip overflowing) hovering `›` walked the strip to the end
    and stopped, `‹` walked it back, and moving off the cell froze it.

- **The standing gaps, closed (2026-08-13, user request: "implement all the gaps").** Everything in
  *Known gaps* that did not need credentials, RCON, or a whole phase behind it.
  - **`core/icons/detect.test.ts`** — the single-cell assertion exempts the four nerd meter glyphs
    (deliberately two cells, see the entry above) and a second test pins the pad, so a stray space
    still fails. The suite has no failing test for the first time since 2026-08-12.
  - **Biome is clean.** Unused imports in `setup/Welcome.tsx` and `components/Form.tsx`, an unused
    variable in `lib/png.test.ts`, and a documented suppression for the toast test's raise-once effect.
  - **`src/lib/colors.test.ts`** (new, 25 tests) — parse/format across all four hex lengths, the HSL
    round trip's one-channel tolerance, the transforms' clamping, `mix`'s weight direction (reading it
    as "how much of `to`" inverts every blended border and still looks plausible), and the WCAG
    reference ratios.
  - **`Table` row geometry is derived, not tuned** — `ROW_BORDER + ROW_PADDING_X` drives both the
    outer-width subtraction and the header's padding. The old `- 3` was one cell short: with a filled
    flexible column the gap before it collapsed and the row wrapped inside its own border.
    `components/Table.render.test.tsx` (new, 6 tests) drives real frames and fails 3-of-6 against the
    old constant.
  - **`core/server/sweep.ts`** (new) — `sweepDownloads(paths, {maxAgeMs, partialMaxAgeMs, now})`
    removes abandoned staging trees (6 h) and stale partial downloads (14 d). Called from
    `createContext`, deliberately **not awaited**. Age is the discriminator because another instance's
    in-flight create looks identical to a dead one, and the age is taken from the **newest file
    inside** the tree — a long download leaves every ancestor's mtime alone.
    `core/server/sweep.test.ts` (10 tests) includes the case that proves it never reaches into a
    sibling `servers/` directory.
  - **Theme files apply live.** `startWatchers` watches `~/.config/mctl/themes/` and emits
    `ThemesChanged`; `ThemeRegistry.reload()` re-reads from scratch so a *deleted* file stops
    resolving (`load()` only ever merges); `ThemeProvider` gained a `subscribeCatalogue` bridge,
    mirroring `subscribeThemeId`, wired in `App.tsx` by `catalogueSubscriber`.
    `core/theme/registry.test.ts` (new, 6 tests) + one watcher test.
  - **One real defect found on the way:** `readJsonIfExists` *throws* on a syntax error (it tolerates
    only an absent file), so a half-written `themes/*.json` took the whole catalogue down with it —
    harmless while the catalogue was read once at startup, a live crash the moment the directory is
    watched. `ThemeRegistry.load` now skips an unparsable file, as its doc comment always claimed.
  - Verified: `bunx tsc --noEmit` clean, `bun test` **421 pass / 0 fail** (43 files, +49),
    `bun run format` clean, `bunx biome check src` clean. **Not driven under a pty this session** —
    the theme-reload path is covered by unit tests over the real watcher and the real registry, but
    *saving a theme file and watching the app repaint* is unconfirmed on screen.

- **Hand-made UI passes by the user (2026-08-03 → 2026-08-13).** A dozen commits the artifacts never
  recorded, because they were the user's own work between agent sessions. They are *decisions*, not
  drift — do not revert them while "restoring" something an older entry below describes.
  - **`components/Table.tsx` — a row is now a bordered card, not a line** (`f442c93`, on top of
    `9a40104`): every row is a `rounded`-bordered box whose border turns `primary` when selected, the
    header keeps its bottom border **only when the table is empty**, header ink moved from `secondary`
    to `primary`, cells gained `paddingX`, and the outer width lost a hand-tuned `3` to pay for the
    row borders. (That subtraction was one cell short and is now derived — see the gap-closing entry
    below.)
  - **`components/Form.tsx` — `FormFieldProps` became `BoxProps & {…}`** with `...rest` passthrough,
    plus `prefix` / `suffix` / `noBorder` (`d9cae5e`), which is what lets a control be embedded
    chromeless (the console command line). `Select`'s tab layout now sizes `tabWidth` from the longest
    option label (`ea5e24b`).
  - **Colours** (`a71d9c7`): the terminal theme's `border` is derived at `alpha(…, 0.6)` and the
    NavRail / Tabs rules moved `0.6 → 0.8`; Nord's `muted` was lightened `#4c566a → #708abd` because
    nord3 was unreadable as body text. `src/lib/colors.ts` is the helper behind all of it.
  - **Dashboard** (`c233a97`, superseding the "uncommitted tweak" this file used to note): the
    expanded row dropped its left border and `marginLeft` for `paddingLeft={3}` over the tinted
    background.
  - **Server page**: identity row and action bar share one `space-between` row with a bottom border so
    the lifecycle buttons stay on one line (`29aa06b`); horizontal padding moved off the tab container
    into `Columns` (`paddingX` prop) so the console and table tabs own their own edges (`b9333c5`);
    the tab *description* line under the tab bar is gone and `players` joined `TAB_OWNS_SCROLL`
    (`ce8c680`).
  - **Players**: `CARD_MIN_WIDTH_WITH_HEAD` 36 → **52** (`4c0e56a`) — the head plus the six-row
    wireframe never fit 36 in practice, so the entry below describing 36 is history. The action menu
    is a wrapping **row** of `medium`/`outline` buttons instead of a left-aligned column of small
    ghosts (`de6fb7a`).
  - **The nerd meter glyphs are deliberately two cells** (`4c0e56a`): `heartFull`/`heartEmpty` carry a
    trailing space and `foodFull`/`foodEmpty` moved to `\u{f141f}`/`\u{f1420}`. This settles the open
    question below — `core/icons/detect.test.ts`'s single-cell assertion is what is now wrong, and the
    fix is to add these four to the test's `exempt` set, not to narrow the glyphs.
  - **`Hint`** gained `flexShrink={0}` (`5252344`); pages gained `paddingX={1}` (`2dc1c76`);
    `RouterProvider` accepts initial `params` (`315089e`) — which is what made the temporary
    "boot straight into a server" shortcut possible, since reverted (`ea5e24b`).

- **Phase 4a — networking (2026-08-13).** Roadmap bullets 1 and 2 of Phase 4 are done; bullet 3
  (backups, supervision) is **not started** — see *Next up*.
  - **Types.** `types/network.ts` (new): `RequiredBinary`, `Readiness` (a tagged union, because
    "missing binary" wants an install command and "logged out" wants a login command),
    `Endpoint` + `TunnelSession` (Zod — the descriptor is on-disk data), `NetState`, `NetStatus`,
    `ExposeRequest`. `types/provider.ts` gained **`NetworkProvider`**. `types/config.ts`:
    `NetworkProvider` → **`NetworkProviderId`** (picker only), `NetworkProfile.provider` and
    `NetworkConfig.defaultProfile` relaxed to strings, new `CloudflareDnsConfig` on a profile.
    `types/events.ts`: `TunnelUp` / `TunnelDown` / `DnsChanged`.
  - **`core/network/index.ts` — `NetworkManager`**: `profiles()`, `readiness()`, `expose()`,
    `teardown()`, `status()`, plus the exported pure `scopedSecrets`. Degrades to `direct` for five
    distinct reasons rather than ever failing a start.
  - **`core/network/cloudflare-dns.ts`**: A/CNAME + `_minecraft._tcp` SRV, zone-name or zone-id,
    idempotent, and deletion restricted to records tagged `mctl:<server id>`.
  - **Five providers** under `providers/network/`: `direct`, `cloudflared`, `playit`, `ngrok`,
    `tailscale`, over the shared `agent.ts` (detached spawn → scrape the announced address → write /
    read / reap `network/<id>.json`). `ProviderRegistry` gained `registerNetwork`/`network`/
    `networks`/`networkIds`; all five are wired in `providers/index.ts`.
  - **`lib/shell.spawnDetached`** (own process group, `unref`, output on an fd not a pipe),
    **`lib/net.publicAddress`** (two echo services, validated, 10-minute cache, never throws),
    **`lib/paths`** `networkDir`/`networkFile`/`networkLogFile`.
  - **Wiring**: `RuntimeManager` holds the `NetworkManager` and exposes after a successful start /
    tears down after a stop, swallowing failures both ways; `core/context.ts` builds it. Delete (CLI
    *and* TUI) tears networking down first.
  - **CLI**: `mctl network` (provider readiness + profiles), `network status [<id>]`, `network up <id>`,
    `network down <id>`, all with `--json`. `cli/format.renderTable` exported for it.
  - **TUI**: `hooks/use-network.ts` (`useNetworkOverview` 30 s, `useNetworkStatus` 5 s, both
    self-chaining); `app/Network/` is a real page (providers with install hints, profiles, per-server
    endpoints); the Server page's Network tab now shows the live profile/provider/state/endpoint plus
    provider readiness beside the unchanged direct picture.
  - Tests (**372 total, 39 files**, +47): `providers/network/agent.test.ts` (11, driving **real
    detached shell-script agents**: scraping, survival past the parent, a failing agent leaving no
    descriptor, a silent agent being reaped — proved via a pid the script writes — the `fallback`
    path, log truncation, descriptor reaping, pid-less descriptors surviving, `stopAgent`),
    `core/network/cloudflare-dns.test.ts` (13, against a **real local stand-in API**, including the
    two decoy records that prove tag-scoped deletion), `core/network/index.test.ts` (17, every
    degradation path + `scopedSecrets`), `providers/network/matchers.test.ts` (6, the real log lines).
  - **Verified for real, not just typed:** `bunx tsc --noEmit` clean; `bun test` 371 pass / 1
    pre-existing fail (`nerd.heartFull`); `bun run format` clean; `bunx biome check src` clean bar
    four pre-existing warnings (plus one from the user's own uncommitted Dashboard tweak). In a
    sandbox `$HOME`: `mctl network` listed all five providers with real readiness (tailscale
    correctly `unauthenticated — sudo tailscale up`); a **real Paper 1.21.4 server on the tmux
    runtime** was created and started, and the start brought up a **real cloudflared quick tunnel**
    (`supporters-freight-erik-monetary.trycloudflare.com`) which a **separate** `mctl network status`
    process then described, and `mctl stop` killed the agent and removed the descriptor; direct
    exposure reported LAN + real public address; degradation to direct was confirmed for both a
    logged-out tailscale and an unregistered provider; delete removed the descriptor. TUI driven
    under **tmux at 130×40**: the Network page and the Server page's Network tab both render.
  - **One real defect found in the pty**: the Network page's sections carried `flexGrow`/`flexBasis`
    inside a column parent and rendered as overlapping text — the same trap `memory.md` already
    recorded for the Dashboard's expanded panel.

- **The Console tab renders ANSI (2026-08-13, user-reported defect).** A modded server's output
  (NeoForge/Forge run log4j with a colouring console appender) reached the frame buffer with its
  escape bytes intact and drew as literal `[32m` mid-line.
  - **`src/lib/ansi.ts`** — new leaf helper: `parseAnsi` (SGR → styled spans, everything else
    dropped), `stripAnsi`, `needsParse`, `xterm256Hex`. Handles the bare `CSI m` reset, carriage
    returns (armed, not applied — the capture stores CRLF and `> stop\r\r`), and tab expansion to
    8-column stops.
  - **`src/components/AnsiText.tsx`** — new component: maps a palette index onto the theme's
    semantic roles and renders `<span>` children; plain lines take a string fast path. Exported from
    the components barrel alongside the pure `ansiColor`.
  - **`src/app/Server/tabs/Console.tsx`** — rows became a memoised `ConsoleLine`; `lineColor` now
    classifies the stripped text and is only the default for uncoloured runs.
  - Tests: `lib/ansi.test.ts` (17) + `components/AnsiText.test.tsx` (4, rendered frames). Suite is
    **324 pass / 1 pre-existing fail** (`nerd.heartFull`, see memory.md); `bunx tsc --noEmit` clean;
    verified in a tmux pty against the user's real NeoForge capture.

- **Phase 3 — loaders, installers, runtimes (2026-08-12).** All four roadmap bullets landed.
  - **Types.** `InstallStrategy` gained `loaderJar` (a meta service's pre-built launcher) and
    `installer` (download a program, run it); `LaunchSpec` gained `argFile` and `script` and became a
    **Zod schema**, because a launch spec is now *persisted* — `MctlJson.launch` records the one the
    install produced when the kind alone cannot imply it. `jar` gained optional `args` (Velocity takes
    no `nogui`). `buildFromSource` deliberately still absent — no provider needs it.
  - **`core/runtime/launch.ts`** — the pure `launchCommand(spec, javaPath, jvmArgs)` + `launchInputs`,
    shared by both runtimes. `core/runtime/console-log.ts` — the capture-file tail, likewise shared.
  - **`core/server/install.ts`** — runs installer jars (`javaPath` is a required input for that
    strategy), verifies what they produced, **falls back to the generated `run.sh`** when the predicted
    argfile is missing, cleans up the installer, and returns the resolved `LaunchSpec`.
  - **Six providers**: `fabric` (loaderJar), `quilt` + `forge` + `neoforge` (installer),
    `purpur` (directJar, MD5 only), `velocity` (directJar, a proxy). `providers/server/mojang-meta.ts`
    is the new shared upstream client — four of the six need Minecraft's own Java requirement, and
    reaching it through `VanillaProvider` would be provider→provider. `fill.ts` is the shared PaperMC
    v3 client behind Paper and Velocity; `forge-common.ts` holds the two facts Forge and NeoForge share.
  - **`providers/runtime/tmux.ts`** — detached, re-attachable, and the runtime where **`exec` and
    `stop` work from any instance**. `RuntimeManager` verifies the launch files exist before spawning
    and writes `user_jvm_args.txt` for a `script` launch.
  - **Install resume** — artefacts land in `$ROOT/downloads/partial/` (keyed by URL) and move into
    staging once verified; JDK downloads resume too. `lib/download.ts` gained `md5` and `resume`.
  - **UI**: the create form's Runtime select and the wizard/Settings Kind+Runtime pickers now come from
    the registry or one shared `app/choices.ts` table — there were **four** hand-kept lists, three of
    which still said "Vanilla only".
  - Tests (**303 total, 33 files**, +41): `core/runtime/launch.test.ts`, `core/server/install.test.ts`
    (installer stubbed by a shell script standing in for `java`; resume driven against a local server
    that honours `Range`), `lib/download.test.ts`, `providers/server/forge-family.test.ts`,
    `providers/runtime/tmux.test.ts` (including a quoted launch line round-tripped through a real `sh`).
  - **Verified end-to-end in a sandbox `$HOME`, not just typed:** `bunx tsc --noEmit` clean;
    `bun test` 302 pass / 1 pre-existing fail; `bun run format` clean; `bunx biome check` clean bar
    four pre-existing warnings. Created **and booted to `Done (…)`**: fabric 1.21.4, forge 1.21.4
    (via its generated argfile), neoforge 21.1.248, quilt 1.21.4, purpur 1.21.4 — five kinds, plus
    vanilla/paper/velocity resolution checked against the live APIs. Under tmux: `logs`, `exec`
    (`[Server] tmux exec works`) and a graceful `stop` all **from separate `mctl` processes**. The TUI
    driven at 120×40 shows every kind and both runtimes.
  - **Three real defects found by doing it for real**, all fixed: the tmux launch was originally
    `send-keys`'d into the user's interactive shell (zsh's first-run wizard ate the leading `e` and
    left `xec …: command not found`); a Java **pin** was triggering resolution at create time; and
    Quilt's meta service publishes a **wrong SHA-256** (see `memory.md`).

- **App-wide keyboard pass (2026-08-12, user request).** "Tab cycle is not properly done
  everywhere. Focused areas are not well highlighted (Tabs). Disabled buttons are also acquiring
  tabs."
  - **`src/hooks/use-focus-ring.ts`** — members are now `FocusItem = string | {id, disabled?}` and the
    hook takes `{enabled}`. Disabled members are skipped by `next`/`prev`, refused by `setFocus`, and
    never hold focus (including on the first render, and when a focused member becomes disabled);
    `enabled: false` stands the ring's keyboard down without losing its focused id, so only one ring
    answers Tab at a time.
  - **`src/hooks/use-modal.tsx`** — **new**, the input capture's sibling: a counted modal signal
    (`ModalProvider` mounted in `App.tsx`, `useModalOpen`, `useModalsOpen`, `useIsModalOpen`).
    `components/Dialog.tsx` raises it for every dialog in the app; `app/Router.tsx` returns early from
    its global keyboard while one is up — **Esc included** — and swaps its hint set for
    `Tab / Enter / Esc close`.
  - **Focus affordances**: `components/Tabs.tsx` (caret in the active pill's left padding cell, pill
    blended back when unfocused), `components/Button.tsx` (accent wash + bold label when focused;
    `focused` ignored while `disabled`), `components/Form.tsx` (`▸` before the field label).
  - **Rings audited**: `app/Server/index.tsx` (lifecycle buttons carry their live disabled state; a
    ring for the delete dialog with Cancel first; stands down for `confirmDelete` or a tab's modal),
    `app/Settings/index.tsx` (Revert/Save disabled in the ring — a clean form cycles three stops, not
    five), `app/ServerCreate/index.tsx` (Create disabled until valid, **Cancel joined the ring** — it
    was mouse-only), `app/setup/steps/DataRootStep.tsx` + `ReviewStep.tsx` (Continue/Create).
  - **`app/Server/PlayerActionsDialog.tsx` split into two stage components**, each mounted only while
    showing: the menu's ring skips actions that need a running server, the argument stage's ring is
    field → Back → run (disabled while a required argument is empty), and "every open starts at the
    top" now falls out of the tree instead of an effect. `ServerTabProps.onModal` +
    `tabs/Players.tsx` report the dialog upward so the container's ring stands down.
  - **`src/hooks/use-focus-ring.test.tsx`** — **new**, 6 tests through `createTestRenderer` +
    `createRoot` + real keypresses: cycling and wrapping, stepping over a disabled member, a disabled
    first member, an all-disabled ring, `setFocus` refusing a disabled id, and a disabled ring
    ignoring Tab.
  - Verified: `bunx tsc --noEmit` clean; `bun test` **261 pass / 1 pre-existing fail** (see below);
    `bun run format` clean. Driven under **tmux at 130x40** against the user's real config: the Server
    page cycles tabs → Start → Remove → tabs; Settings cycles three stops clean and five once dirty
    (Revert/Save join); the create form cycles seven stops empty and eight with a name (Create joins);
    the player action menu opened straight onto *Shadow ban* (the only action a stopped server can
    run); Tab inside both dialogs moved only the dialog's buttons; `5` no longer navigates behind an
    open dialog; and one `Esc` closes a dialog **without** quitting the app.
  - **Pre-existing failure, untouched:** `core/icons/detect.test.ts` fails on `nerd.heartFull` — four
    nerd glyphs in `core/icons/catalogue.ts` carry a trailing space, so they are two cells and the
    health/food meters are 20 cells wide in `nerd` mode. Fails on `master` too; left for the user to
    decide, since the space may be deliberate.

- **Player card redesigned to a wireframe (2026-08-12, user request).** Six interior rows: the
  4-row head beside `name ● status` / `<playtime> Played` / `Last Position: Overworld(x, y, z)` /
  `<GameMode> n Kills n Deaths`, then full-width `Health:` and `Food:` meters — ten game-style
  icons each with the exact percentage at the right edge. Standing (`OP`/`WL`/`SHADOW`) moved to
  the **top** border; the name moved into the body; game mode stopped being a badge.
  - `src/types/icons.ts` + `src/core/icons/catalogue.ts` — four new icons
    (`heartFull`/`heartEmpty`/`foodFull`/`foodEmpty`) in all three sets.
  - `src/app/Server/tabs/Players.tsx` — `PlayerCard` rewritten and **exported** for its test;
    `StatBar` (a `ProgressBar`) replaced by `StatMeter` + the pure `meterFill`; helpers
    `dimensionLabel`, `titleCase`, `counted`, `gameModeColor`.
  - `src/app/Server/tabs/Players.test.tsx` — **new**, 6 tests mounting the card through
    `createTestRenderer` + `createRoot`: the wireframe's fields, singular/plural counts, the
    meters' icons agreeing with their percentage, the both-ends fill bias, six rows with data /
    without data / without a head, and a banned player's card.
  - **Two real defects the tests caught:** every body line needed `truncate wrapMode="none"` (an
    unwrapped position line grew a 36-wide card to 10 rows), and the meter row's caption and icons
    needed `flexShrink={0}` beside the `flexGrow` spacer (they were being shrunk to nothing).
  - Verified: `bunx tsc --noEmit` clean; `bun test` **256/256** (+6); `bun run format` clean; the
    card rendered through `createTestRenderer` at widths 50/43/36 in the `unicode` and `ascii` sets
    (full player, a long-named creative player in the Nether, and a player with no data at all) —
    six rows in every case, meters aligned, long lines middle-ellipsised.
  - **Not verified:** the tab has not been driven in a real pty since the redesign — the card is
    checked frame-by-frame in tests, the *grid* around it is unchanged code.

- **Player heads are real skins (2026-08-08, user request).** "Fetch the head from the API, prefer
  8×8, convert it to the Head Skin type, then render it. Official Minecraft first, then TLauncher,
  then Ely.by; fall back to the defaults."
  - **`src/lib/png.ts`** — a hand-rolled, read-only PNG decoder (inflate → unfilter → expand to
    RGBA). Every colour type, bit depths 1–16, `tRNS`, multiple `IDAT`s; Adam7 interlacing throws.
    No new dependency. `src/lib/png.test.ts` — 14 tests over a minimal in-test encoder.
  - **`src/types/skin.ts`** — `HeadSkin` (palette + 8×8 code grid) + `HeadSkinSchema` + `HEAD_SIZE`.
    Now the single face shape: `components/MinecraftHead.tsx`'s built-in `SKINS` are typed as
    `HeadSkin` and the component accepts `MinecraftSkin | HeadSkin`.
  - **`src/core/skins/`** — `head.ts` (`headSkinFromPng`/`headSkinFromImage`: crop (8,8)–(16,16),
    composite the hat overlay as a mask, nearest-neighbour centre sampling for HD skins),
    `sources.ts` (`SKIN_SOURCES` = Mojang → TLauncher → Ely.by, each returning bytes or
    `undefined`, never throwing), `index.ts` (`resolveHeadSkin` + the hit/miss disk cache under
    `~/.cache/mctl/skins/` + in-flight dedupe). `src/lib/paths.ts` gained `skinCacheDir()`.
    `src/core/skins/head.test.ts` — 11 tests.
  - **`src/hooks/use-player-heads.ts`** — `usePlayerHeads(players, enabled)`: display order, 64
    players max, 4 concurrent, once per session, inert below the 84-cell head threshold.
  - **`src/components/MinecraftHead.tsx`** — exported `faceSignature` so the draw effect keys on
    face *content* (a fetched face is a fresh object every poll).
    `src/components/MinecraftHead.test.tsx` — 5 tests against real rendered spans.
  - **`src/app/Server/tabs/Players.tsx`** — `PlayerCard` takes a `head`, falling back to `skinFor`.
  - Verified: `bunx tsc --noEmit` clean; `bun test` **250/250** (+25); `bun run format` clean.
    The decoder cross-checked byte-for-byte against an independent Python implementation on jeb_'s
    real skin. End-to-end in a sandbox `$HOME`: Mojang resolved jeb_'s skin (first lookup 3.7 s,
    cached 3 ms), a nonexistent name resolved to a cached miss (0 ms), eight concurrent asks made
    one lookup. Under **tmux at 140×40** against a fabricated server with five `usercache.json`
    players: four heads resolved through Mojang (including one whose uuid was fake but whose *name*
    is a real account, proving the name fallback) and the fifth fell back to a built-in; jeb_'s skin
    tone and eye colour verified in the raw escape sequences. At 70×30 the heads drop as before.
  - **Known upstream flakiness:** Ely.by served one skin then answered `500` for every subsequent
    request — treated as a miss, as designed. No TLauncher hit was observed in testing (its endpoint
    is live and 404s for names it does not own), so **that source is wired and reached but not
    confirmed against a real TLauncher account**.

- Repo scaffolded from `create-tui`: Bun + `@opentui/core` + `@opentui/react` + React 19.
- `opentui` skill available and vendored under `.claude/skills/opentui/`.
- Planning artifacts written for the TypeScript/OpenTUI stack (plan/architecture/memory/AGENTS).
- **Phase 1 foundation groundwork (2026-07-25):**
  - Deps added: `zod` (4.x), `eventemitter3`, `pino` (+ `pino-pretty` dev). `typecheck` script added.
  - `src/lib/paths.ts` — XDG + `$ROOT` resolution. Config/cache/state path helpers (known before
    config loads) + `rootPaths(root, overrides)` for data dirs. **All path building goes through here.**
  - `src/lib/fs.ts` — `writeFileAtomic`/`writeJsonAtomic` (temp + `rename`), `readJsonIfExists`,
    `pathExists`, `ensureDir`, `appendLine` (for `events.jsonl`). Atomic writes support `mode` (0600).
  - `src/lib/logger.ts` — Pino to `~/.local/state/mctl/logs/mctl.log` (NOT stdout — OpenTUI owns the
    terminal). Redacts token/secret/password/*key keys. `log(mod)` for tagged child loggers.
  - `src/types/config.ts` — Zod schemas (source of truth) for `config.json` + `secrets.json`;
    `CONFIG_VERSION = 1`. Composite sections use `.prefault({})` (see memory).
  - `src/core/config/index.ts` — `configExists` (first-run = `config.json` absent), `loadConfig`,
    `loadSecrets` (+ `MCTL_*` env overrides), `writeConfig`, `writeSecrets` (0600, mode verified),
    `resolveRootPaths`, `ensureDirTree`. Typed `ConfigNotFoundError` / `ConfigValidationError`.
  - `src/index.tsx` — argv dispatch: no args → `app/App.tsx renderApp()`; `mctl <cmd>` →
    `cli/router.ts runCli()` (lazy imports keep the paths independent).
  - `src/app/App.tsx` — minimal OpenTUI shell (`renderApp()` owns renderer creation; quit on q/Esc).
  - `src/cli/router.ts` — `help`/`version` real; other commands are honest "not implemented (Phase N)"
    stubs. No fake functionality.
  - Verified: `tsc --noEmit` clean; CLI dispatch paths exercised; a runtime smoke test round-tripped
    config write/reload, first-run detection, 0600 secrets + env override, and the full dir tree.

- **Theming — light/dark schemes (2026-07-25):**
  - `Theme.colors`/`ThemeFile.colors` is now a `ThemeColorScheme` = `{ default }` **or** `{ dark, light }`.
    Removed `appearance` from `Theme`/`ThemeSummary`/`ThemeFile`. `resolveColors(scheme, mode)` added.
  - Built-ins `github` + `nord` ship both light and dark palettes. Terminal theme is a `{ default }`.
  - Current mode from `terminalAppearance(palette)` (exported); `use-theme` exposes `colors` (resolved
    flat) + `appearance` (current mode) on the context. `App.tsx` reads `useTheme().colors`.
  - Verified: `tsc --noEmit` clean; headless smoke (both builtins differ light vs dark; terminal default
    resolves identically both modes; appearance light/dark from bg luminance).

- **Theming system (2026-07-25, earlier the same day):**
  - `src/types/theme.ts` — Zod `ThemeFile`/`ThemeColors` (11 semantic roles, hex-only) + `Theme`,
    `ThemeSummary`, neutral `TerminalPalette` types.
  - `src/core/theme/` — `builtin.ts` (GitHub Dark + Nord, `FALLBACK_THEME`), `terminal.ts`
    (`themeFromTerminalColors`, pure, no OpenTUI import; `TERMINAL_THEME_ID`), `registry.ts`
    (`ThemeRegistry`: built-ins + `~/.config/mctl/themes/*.json`; `load/get/has/list/isDynamic`;
    reserved-id + invalid-file skipping).
  - `config.theme` field (default `"terminal"`) added to `types/config.ts`; read at startup.
  - `src/hooks/use-terminal-colors.ts` — implemented: adapts `renderer.getPalette()` + `theme_mode`/
    `palette` events into `TerminalPalette`; 5s poll fallback that self-cancels on first live event.
  - `src/hooks/use-theme.tsx` — `ThemeProvider` + `useTheme()`; resolves active id (terminal=live,
    else registry, fallback chain). `App.tsx` themed; `t` cycles themes, persists to `config.theme`.
  - `src/lib/fs.ts` — added `readDirIfExists(dir, ext?)`. Dep added: `@types/react@19` (dev).
  - Verified: `tsc --noEmit` clean; headless smoke test (registry list/get, custom+reserved+broken
    files, terminal mapping + null fallbacks, config default/override); TUI mounts and renders themed.

- **Component library — shared UI kit (2026-07-25):**
  - `src/components/` now holds the full primitive set, all pure-UI (no I/O), theme-driven
    via `useTheme().colors`, and controlled (value + onChange + `focused`):
    - `support.ts` — `Variant`/`SemanticColor` types, `variantColor`/`onAccent`, `clamp`,
      `optionsFitAsTabs` (the tabs-vs-dropdown width heuristic).
    - `Label.tsx`, `Kbd.tsx` (1-row filled keycap), `Hint.tsx` (row of `[key] label`).
    - `Button.tsx` — variants (primary/secondary/success/warning/error/info/neutral) ×
      kinds (solid/outline/ghost); outline fills on `focused`; Enter/Space when focused.
    - `ProgressBar.tsx` — determinate block bar, `showPercent`.
    - `Breadcrumb.tsx`, `Tabs.tsx` (page tabs, underline marker, ←/→ when focused).
    - `Form.tsx` — `FormField`/`Field` (the rounded frame: **label on top border via
      `title`, hint on bottom border via `bottomTitle`, accent border when focused**),
      `FormGroup`, `Input`, `TextArea`, `Select` (**adaptive: `<tab-select>` when options
      fit, scrollable `<select>` dropdown when not**), `Toggle` (segmented), `Checkbox`,
      `RadioGroup`/`Radio`.
    - `Dialog.tsx` — modal overlay (absolute backdrop with `opacity` + centred box, Esc/
      backdrop-click closes).
    - `index.ts` — barrel for all of the above (+ re-exports MinecraftHead).
    - `Gallery.tsx` — living showcase of every component with a Tab focus ring; mounted in
      `App.tsx` (replaced the MinecraftHead placeholder demo).
  - Verified: `tsc --noEmit` clean; `bun run src/index.tsx` mounts and renders the gallery
    (breadcrumb/tabs/buttons/form frames all draw; terminal theme active).
  - **Mouse focus (2026-07-25):** every focusable control gained an `onFocused?: () => void` prop,
    fired on mouse-down so a click moves the page's focus ring to it (`Button`, `Tabs`, `Input`,
    `TextArea`, `Select`, `Toggle`, `Checkbox`, `RadioGroup`). Form controls forward it to `FormField`,
    which owns the `onMouseDown` on its frame (clicks bubble). `Button` fires `onFocused` then `onClick`.
    Gallery wires each ring member's `onFocused → setFocus(id)`. `tsc --noEmit` clean. See `memory.md`
    § Component library for the convention.

- **Leaf helpers the artifacts never listed (2026-07-25):**
  - `src/lib/colors.ts` (`c020c32`) — pure colour maths, the layer every theme and component builds on:
    `parseHex`/`toHex` (`#rrggbb` and `#rrggbbaa`), `alpha`, `fade`, `mix`, `lighten`/`darken`,
    `saturate`/`desaturate`/`grayscale`, `rotateHue`/`setHue`, `luminance`, `contrastRatio`,
    `readableOn`. HSL transforms are lossy at 8-bit, so the doc comment tells callers to compose one
    call rather than chain many. **No test file** — the largest untested pure module in `lib/`, and the
    easiest to test (see Known gaps).
  - `src/hooks/use-quit.ts` (`f4efa62`) — `useQuit()`: destroy the renderer *before* `process.exit`, or
    the terminal is left in the alternate screen in raw mode. Used by `Router.tsx` and the setup
    wizard. Its comment still mentions releasing "the public port" / a proxy listener — that subsystem
    does not exist; the comment is stale, the code is right.
  - `scripts/png-to-skin.ts` (`1eca01f`) — dev tool, outside `src/`: samples an 8×8 grid of cells out
    of a PNG into the `HeadSkin` palette + code-grid shape. Zero dependencies (`node:zlib`), 8-bit
    colour types 2/3/6 only. Not part of the app and not covered by `bun test`.

- **First-run setup wizard + `mctl init` (2026-07-26):**
  - `src/lib/format.ts` — `formatBytes` (binary units). `src/lib/fs.ts` — `diskFree(path)` →
    `{free,total}` via `statfs`, walking up to the nearest existing ancestor (root may not exist yet).
  - `src/hooks/use-focus-ring.ts` — reusable `useFocusRing(ids)`: tracks the focused id, Tab/Shift-Tab
    (and `backtab`) cycle; `isFocused`/`setFocus`/`next`/`prev`. The one focus primitive pages reuse
    (wizard now, Dashboard later). `src/hooks/use-disk-free.ts` — debounced hook over `diskFree`.
  - `src/app/setup/` — the wizard flow:
    - `types.ts` — `SetupDraft` (flat view model), `StepProps`, `STEP_TITLES`, `initialDraft()`.
    - `use-setup.ts` — `draftToConfig()` (pure map, reused by Review preview) + `commitSetup()` +
      `useSetup()` hook (`commit`/`committing`/`error`). Commit = `writeConfig` → `writeSecrets({})` →
      `ensureDirTree`. **The wizard's ONLY I/O goes through this hook** (pages stay UI-free).
    - `Welcome.tsx` (branded splash, `ascii-font font="block"` hero + preview panel), `Stepper.tsx`
      (left progress rail ○/●/✔), `WizardFooter.tsx` (Hint + Back/Continue, buttons own their Enter),
      `StepScaffold.tsx` (title/desc/fields/footer layout).
    - `steps/` — DataRoot (path + live free-space + permanence warning), Paths (optional
      servers/backups overrides, ring adapts to toggles), Defaults (mc/kind/memory/runtime/eula),
      Backup (enable + provider + compression), Network (direct only + pointer to Network page),
      Review (summary panel + Create, shows commit error inline).
    - `SetupWizard.tsx` — container: welcome→6 steps, owns draft + step index + stage keys (Enter
      begins, Esc backs/quits). `index.ts` barrel.
  - `src/app/App.tsx` — split into `App({firstRun})` router + `Dashboard` placeholder; first run
    (config absent, decided in `renderApp`) routes to `<SetupWizard onComplete>` which flips to the
    dashboard in-place. Dropped the MinecraftHead demo grid from the shell.
  - `src/cli/commands/init.ts` + router dispatch — `mctl init` (flags mirror the wizard;
    `--force`/`--json`/`--help`; unknown flag → exit 1; refuses to clobber existing config). Lazy-
    imported so the CLI stays cheap.
  - `src/lib/logger.ts` — pino destination flipped to **`sync: true`** (was async): a fast-failing
    CLI command's `process.exit` was tearing down the async sonic-boom stream before its fd opened
    ("sonic boom is not ready yet"). Sync file writes remove the race (tiny volume, never render path).
  - Verified: `tsc --noEmit` clean; `mctl init` round-trip in a sandbox HOME (config written, secrets
    0600, full dir tree, re-run refused, bad flag → exit 1, `--help`/`--json`); TUI under a pty renders
    the Welcome screen and Enter→step-1 with no runtime errors.

- **Phase 1 completion — registry, session, events, CLI, router (2026-07-26):**
  - `src/types/server.ts` — `MctlJson` (`z.looseObject`, future-key safe), `ServerRegistryFile`/
    `ServerRegistryEntry`, `RuntimeSession`, `ServerState` enum, `JavaPin`, and the `Server` view model
    (plain TS interface — `state`/`available` are derived, not stored).
  - `src/types/events.ts` — `MctlEvent` envelope (`{v,id,ts,instance,type,payload}`; `type` open string
    for forward-compat) + `EventType` reference object.
  - `src/core/session/session-manager.ts` — `probe(id)` (pid liveness via `kill(pid,0)`, reaps dead/
    invalid/corrupt descriptors) + `reapStaleLocks()` (sweeps `runtime/*.lock` with dead owner pid).
  - `src/core/registry/server-registry.ts` — `loadRegistry(serversDir)` (read/verify `servers.json`,
    fold in `servers_dir` drop-ins, persist additions atomically, mark unavailable never delete) +
    `addServer`/`removeServer` + `mctlJsonPath`.
  - `src/core/server/discover.ts` — **the shared read path**: `listServers`/`getServer` → `Server[]`
    view models (registry + `mctl.json` + probe). Read-only; `ServerManager` mutations are Phase 2.
  - `src/core/events/` — `bus.ts` (`EventBus`), `instance.ts` (`INSTANCE_ID`), `log.ts`
    (`publish` = append+emit-local; `startTail` re-emits remote lines, skips self), `watch.ts`
    (directory watchers → local `ConfigChanged`/`RegistryChanged`/`ServerStateChanged`), `index.ts`
    (`startEventSystem() → {bus, stop}`).
  - `src/lib/http.ts` — ETag/conditional-GET cache under `~/.cache/mctl/api/`; `fetchText`/`fetchJson`
    (returns `unknown`), TTL fast-path, stale-on-failure, `HttpError`.
  - `src/cli/` — real `list` and `status` (+ `format.ts` table/`--json`), wired in `router.ts`
    (removed from the PLANNED stubs). First-run steers to `mctl init`.
  - **TUI router** — `app/routes.ts` (`NAV`, digits 1–6), `hooks/use-router.tsx` (`RouterProvider`/
    `useRouter`, back-stack), `app/Router.tsx` (shell: top bar + `NavRail` + page host + `Hint`;
    owns global keyboard), `app/NavRail.tsx`, and pages `Dashboard`/`Servers`/`Server`/`Settings` (real)
    + `Jobs`/`Backups`/`Network` (`Placeholder`). Data hooks `use-servers`/`use-config`/
    `use-event-bus`. `App.tsx` now: `renderApp` reaps stale locks + starts the event
    system + injects the bus (`EventBusProvider`), and routes to `<AppRouter/>` post-setup.
  - Verified: `tsc --noEmit` clean; CLI e2e in a sandbox HOME (first-run steer→init, empty list,
    drop-in auto-discovery folded into `servers.json`, `list`/`status`/`--json`); headless smoke (8/8:
    probe alive/dead + reap, unavailable server, stale-vs-live lock reaping, local-publish-once +
    foreign-event-tailed); TUI mounts under a pty (router + Servers nav + quit, no stderr) and the
    first-run wizard still mounts with no config.

- **Box border clipping fix (2026-07-26):**
  - `src/components/box-clip-patch.ts` — `installBoxClipPatch()` works around an upstream
    `@opentui/core` 0.4.5 bug where the native `bufferDrawBox` ignores the scissor stack, so bordered
    boxes inside a `<scrollbox>` painted their borders over the top bar / nav rail / hint strip when
    scrolled. Partially-clipped boxes now render through a scratch buffer blitted with
    `drawFrameBuffer` (which respects the scissor); fully-visible boxes keep the native fast path.
    Installed first thing in `renderApp()` (`src/app/App.tsx`).
  - `src/components/box-clip-patch.test.ts` — **first tests in the repo** (`bun test`, script added to
    `package.json`): unclipped boxes render byte-identically (glyphs *and* colours, via `captureSpans`)
    before vs after patching across 10 border/title/background configs; bordered boxes in a scrollbox
    paint nothing outside the viewport at 5 scroll offsets. Verified the second test fails without the
    patch (not vacuous).
  - Verified: `tsc --noEmit` clean; `bun test` 2/2; real app under a pty at 14×80 — Settings scrolled
    with the mouse wheel leaks a stray `│` into the hint strip without the patch, clean with it.

- **NavRail redesign — horizontal tab bar (2026-07-27):**
  - `src/app/NavRail.tsx` rewritten to match a user-supplied reference: a row of tabs where the active
    route is a filled primary pill (on-accent bold ink) and the rest are muted text with a faint hover
    wash; digit shortcuts stay as a DIM prefix. Local `NavTab` component owns hover state (a `Button`
    can't do a two-ink chip with a muted resting look). Dividers (`|`) and the inline `MCTL` label are
    gone; the row still scrolls horizontally on narrow terminals.
  - The underline is a **second row of per-tab `<text>` segments** (accent only under the active tab,
    plain elsewhere) rather than a bottom border, which can only be one colour. `tabWidth(item)` sizes
    both the tab and its segment, and segments are `flexShrink={0}`; see `memory.md` for the alignment
    traps. A `flexGrow` + `overflow="hidden"` tail carries the plain rule to the right edge, its run
    length computed from `useTerminalDimensions().width` minus the cells the tabs consume.
  - `src/app/Router.tsx` — the shell frame now carries the screen name on its **top border**
    (`title`, right-aligned, via the existing `titleFor(route)`) and `bottomTitle=" mctl "`, replacing
    the commented-out top-bar block (deleted, along with the then-unused `TextAttributes` import).
  - Verified: `bunx tsc --noEmit` clean; app rendered under a pty at 100×24 and 60×14 and the frames
    replayed — active pill emits a real background SGR, rule and border titles draw, tabs scroll rather
    than wrap when narrow.

- **Phase 1 tail — Settings, key gating, log rotation, watcher fix (2026-07-27):**
  - `src/hooks/use-input-capture.tsx` — `InputCaptureProvider` + `useCaptureKeys(active)` +
    `useKeysCaptured()` / `useIsCapturing()`. A counted capture; `isCaptured` is a getter because a
    `useKeyboard` handler closes over its render. Mounted inside `RouterProvider` in `Router.tsx`.
  - `src/app/Router.tsx` — `Esc` handled first (always live), then all character shortcuts
    (digits/`q`/`t`) return early while captured. The hint strip swaps to typing hints. The
    `TODO(phase-1)` is resolved and removed.
  - `src/app/Settings/use-settings.ts` — `SettingsDraft` + `configToDraft`/`draftToConfig` (merge, not
    replace) / `validateDraft` (pure) + the `useSettings` hook (buffered edits, dirty tracking that a
    background `ConfigChanged` can't clobber, `writeConfig` → `ensureDirTree`).
  - `src/app/Settings/index.tsx` — rewritten as the editable form: read-only `root`/`configVersion`,
    servers/backups override toggles + path fields, server defaults, backup policy, network profile,
    theme picker (applies instantly), Revert/Save + **Ctrl+S**, inline validation and save errors.
  - `src/core/events/log.ts` — `trimEventLog()` (>512 KB ⇒ keep the last ~128 KB of whole lines,
    atomic rewrite), called from `startEventSystem()` and opportunistically in the tail's drain; the
    tail's shrink branch now resumes at the new end instead of replaying history.
  - **Watcher fix (real defect):** Bun's `fs.watch` reports a rename under the *source* name only, so
    our atomic writes never matched `config.json` / `servers.json` and **the hard-state watchers never
    fired at all**. `lib/fs.writeFileAtomic` now names its temp file `.<target>.<pid>-<rand>.tmp`
    (`tempNameFor`) and `core/events/watch.ts` resolves it back (`targetOfTempName`).
  - `src/components/Form.tsx` — `FormField` no longer paints the literal `undefined` on its bottom
    border when a field has no hint.
  - Tests added (now 22, 4 files): `core/events/watch.test.ts` (the watcher regression + a negative
    case), `core/events/log.test.ts` (rotation keeps whole lines / tail doesn't replay / self-events
    emit once), `app/Settings/use-settings.test.ts` (draft mapping, merge-not-replace, validation).
  - Verified: `bunx tsc --noEmit` clean; `bun test` 22/22; CLI e2e in a sandbox HOME (first-run steer →
    `init --json` → drop-in discovery → `list` / `status --json` / `help`); TUI under a pty at 120×40
    and 60×20 — Settings renders, Tab reaches the fields, typing `6`/`q` edits instead of navigating or
    quitting, Ctrl+S writes `config.json` (schedule/retention and the extra network profile preserved)
    and the header flips to "saved" via the watcher's `ConfigChanged`.

- **Theme reactivity fix (2026-07-31):**
  - `src/hooks/use-theme.tsx` — new `subscribeThemeId` prop (mirror of `onThemeChange`): a bridge for
    theme ids changed outside the provider. Its effect updates local state only, never re-persists.
  - `src/app/App.tsx` — `themeIdSubscriber(bus)` built once in `renderApp()` and passed in: on
    `ConfigChanged` it re-reads `config.theme` and applies it. `persistThemeId` rewritten to serialize
    and coalesce writes (one in-flight write, latest id wins, skip when unchanged) — otherwise a rapid
    `t` cycle's out-of-order write feeds back through the bridge and snaps the theme backwards.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 22/22; pty run in a sandbox HOME — an external
    atomic `terminal`→`nord` edit repaints in Nord, and the same run with the fix stashed produces zero
    new output (non-vacuous). Rapid `t` cycling lands correctly with no snap-back.
  - (The catalogue's restart requirement was closed on 2026-08-13 — see the gap-closing entry.)

- **Settings regrouped into tabs with a pinned action bar (2026-07-31):**
  - `src/app/Router.tsx` — added `OWN_SCROLL` (a `ReadonlySet<RouteId>`, currently `{settings}`):
    those routes render in a plain padded box instead of the shell's `<scrollbox>`, so a page can
    pin its own chrome and own its scrolling. Every other route is unchanged.
  - `src/app/Settings/index.tsx` — restructured to `PageHeader → Tabs → scrollbox(panel) → action
    bar`. Five groups (`GroupId`): Locations / Defaults / Backups / Network / Appearance; the panel
    is `key={group}` so a tab switch resets scroll. Focus ring is now per-group via
    `ringIds(group, draft)` with the tab bar first (←/→ switch groups). `GROUP_OF_ISSUE` flags a
    group's tab with `" !"` when one of its fields fails validation, so a hidden invalid field can't
    silently disable Save. Section headings dropped (the tab names the group); the config-file path
    moved into Locations as a read-only row. Revert/Save are 1-row `size="small" kind="ghost"`
    buttons in the bottom bar.
  - `src/components/Tabs.tsx` — **restyled to `NavRail`'s design** (2026-07-31): 2-row scrollbox,
    `|` separators, filled-pill active tab with hover wash, per-tab rule segments with `╸`/`╺` caps
    and a counted-out tail to the right edge. Focus still shows as underline weight (`━`/`─`), now
    with the accent blending toward the rule when unfocused. Details in `memory.md`.
    Type-checks clean; **not yet driven in a pty since the restyle** — worth a visual pass on
    Settings at a narrow width (the bar scrolls horizontally rather than wrapping).
  - Verified: `bunx tsc --noEmit` clean; `bun test` 22/22; driven under a pty in a sandbox HOME at
    100×30 and 100×24 — tabs render and ←/→ switch groups, the panel scrolls while the tab bar and
    action bar stay pinned, the focus underline thickens/thins with the ring, emptying *Memory*
    flags `Defaults !` from another tab, toggling EULA + Ctrl+S writes `eula: true` and the header
    flips to "saved", and Dashboard (the scrollbox path) still renders.

- **Toast notifications (2026-07-31):**
  - `src/components/Toast.tsx` — pure UI: `ToastCard` (variant-tinted bordered card: icon or
    spinner, bold title, wrapped description, optional action chip with a keycap, optional
    time-to-live meter) and `ToastViewport` (an absolutely-positioned, **content-sized** stack for
    one of six screen anchors). `wrapText` wraps by hand and marks truncation with `…` — terminal
    text does not reflow. Exported from the components barrel.
  - `src/hooks/use-toast.tsx` — `ToastProvider` + `useToast()`. API: `show` (message or options
    object), `info`/`success`/`warning`/`error`/`loading`, `update`, `dismiss`, `dismissAll`, and
    `promise(work, {loading, success, error})`. Per-toast options: `description`, `variant`, `icon`,
    `duration` (0/∞ = sticky; errors and warnings default longer), `delay`, `position`,
    `dismissible`, `progress`, `loading`, `action {label, key, onAction}`, `width`, `onDismiss(reason)`,
    and `id` (re-raising a live id updates it in place). Provider defaults: `position`, `duration`,
    `maxVisible`, `width`, `margin`, `dismissible`, `progress`. Hovering a card pauses its countdown;
    overflow queues rather than evicting; an action key stands down while an input capture is held.
  - `src/app/App.tsx` — `InputCaptureProvider` moved up here from `Router.tsx` (so the wizard is
    covered too) and `ToastProvider` mounted below it, wrapping `<App/>` at the root.
  - `src/app/Settings/` — `save` now resolves the failure message (`string | null`) instead of a
    boolean, and the page's `commit()` toasts "Settings saved" (with the config path) or "Settings
    not saved" with the error and an `r` Retry action.
  - Tests (34 total, 6 files): `components/Toast.test.ts` (wrapping/truncation edge cases) and
    `hooks/use-toast.test.tsx` — the provider mounted in `createTestRenderer` + `createRoot`,
    asserting on real frames: TTL expiry, delay, sticky, queueing past `maxVisible`, description,
    dismissal reasons, and `mockInput.pressKey` driving an action key.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 34/34; a rendered-frame preview of three stacked
    toasts (spinner, wrapped description + action, progress meter) at two positions; and the real
    app under a pty in a sandbox HOME — toggling a Settings field and pressing Ctrl+S wrote
    `config.json` and painted the "Settings saved / Written to …" toast, no errors.

- **ProgressBar styles & variations (2026-07-31):**
  - `src/components/ProgressBar.tsx` rewritten around a glyph table: eight track styles
    (`blocks | smooth | shaded | line | smooth-line | dots | segments | ascii`, `PROGRESS_STYLES`;
    `smooth-line` steps the thin rule in halves via `╸`), `value` + `max`
    (default `1`, so old fraction callers are unchanged), `readout` (`none|percent|fraction`) with a
    `format` override and `readoutFirst`, a `label` caption, `brackets`, `tintTrack`, `bold`, `thick`
    (a second `▄` row), colour `thresholds` (a bar that goes success→warning→error as it fills), and
    an `indeterminate` sweep that self-animates at 12 fps unless the caller supplies `frame`.
    `showPercent` stays as a deprecated alias. Layout maths is exported and pure: `fillGlyphs`,
    `indeterminateGlyphs`, `thresholdVariant`.
  - `src/components/index.ts` — the new types and helpers are re-exported from the barrel.
  - `src/components/ProgressBar.test.ts` — 13 new tests (47 total, 7 files): runs always total the
    track width for every style/fraction/frame, sub-cell steps for `smooth` and `smooth-line` (with
    the whole-cell `line` rounding the same fractions up as the contrast), the started/unfinished
    rounding rules, clamping, the sweep bouncing rather than wrapping, and threshold selection.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 46/46; every style rendered through
    `createTestRenderer` and read back from `captureCharFrame()` (the preview script was temporary and
    is deleted). No existing caller changed — Toast's TTL meter still passes `value`/`width`/`variant`.

- **`Select` width measurement fixed (2026-07-31):**
  - `src/components/Form.tsx` — the adaptive `Select` never measured itself: the `ref` it watched was
    attached only in the *tabs* branch, which the initial `w = 0` never selects, so a flex-sized
    (`width="100%"`/`"auto"`) Select was permanently a dropdown. It also listened for the wrong thing
    via a stray `console.log` (swallowed under OpenTUI).
  - Added module-local `useBoxWidth(ref)` (documented: `"resize"` is the *renderable's* event;
    `"resized"` is the root's) and rewrote `Select` to render **one** `FormField` — ref always
    attached — branching only on the child control. While unmeasured it falls back to a numeric
    `width` prop, so fixed-width fields pick the right layout on frame one.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 47/47; rendered through `createTestRenderer` at
    outer widths 60 and 30 — 60 ⇒ tabs, 30 ⇒ dropdown, for both a fixed-width and a flex-sized field.
    Non-vacuous: with the fix stashed, the flex-sized field at width 60 still rendered as a dropdown.

- **`ScrollBox` wrapper + shell scroll acceleration (2026-08-01):**
  - `src/components/ScrollBox.tsx` (+ barrel export) — a pass-through wrapper around the
    `<scrollbox>` intrinsic: every prop and the `ref` are forwarded untouched, and it adds one prop,
    `enableAccel`, which supplies a stable `MacOSScrollAccel`. **Every `<scrollbox>` in `src/` was
    replaced by it** — `Router.tsx`, `NavRail.tsx`, `Settings/index.tsx`, `components/Tabs.tsx`, and
    both in `setup/SetupWizard.tsx`. Nothing renders the intrinsic directly any more.
  - **Acceleration is enabled only on the shell page host** in `src/app/Router.tsx`; the tab strips,
    the Settings panel and the wizard stay linear (see `memory.md` § Scroll acceleration for why).
  - `src/components/ScrollBox.test.tsx` — 3 tests (50 total, 8 files): props/children/`ref` reach the
    real `ScrollBoxRenderable`, the default is `LinearScrollAccel` vs `MacOSScrollAccel` with
    `enableAccel`, and a 30-notch synthetic wheel burst travels 30 rows linear vs ~175 accelerated.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 50/50; driven under a pty at 100×30 in two sandbox
    HOMEs — the first-run wizard's welcome renders, and with a config the NavRail bar, Servers, and
    Settings (its `Tabs` strip + scrolling panel) all draw with no errors.

- **Icon sets — Nerd / Unicode / ASCII (2026-08-03):**
  - `src/types/icons.ts` — `IconSet` (`nerd | unicode | ascii`), `ICON_SETS`, the `IconName` union
    (~40 semantic names: status, server state, selection controls, stepper, chrome, arrows, rules,
    domain), `IconMap`.
  - `src/core/icons/` — `catalogue.ts` (`ICONS`, the exhaustive `IconName × IconSet` glyph table;
    `SPINNERS`; memoized `iconsFor` / `spinnerFor`), `detect.ts` (`resolveIconSet(mode, env)` —
    pure over an env record; `detectIconSet`, `hasNerdFont`, `hasUtf8Locale`, `parseIconSet`;
    `MCTL_ICONS` override), `index.ts` barrel. Nerd glyphs are `\u{…}` escapes with their upstream
    Font Awesome names in comments, so the table is readable without a patched font.
  - `src/types/config.ts` — `IconMode` (`auto | nerd | ascii`) + `config.icons` (default `"auto"`),
    sitting beside `theme`. `core/config/index.ts` — `MCTL_ICONS`/`MCTL_NERD_FONT` added to
    `RESERVED_ENV` so they are settings, not secrets.
  - `src/hooks/use-icons.tsx` — `IconProvider` + `useIcons()`, mirroring `use-theme`'s
    `onModeChange` / `subscribeMode` prop pair. `useIcons()` returns the auto-detected set instead
    of throwing when no provider is mounted (see `memory.md` for why it diverges from `useTheme`).
  - `src/app/App.tsx` — `IconProvider` mounted beside `ThemeProvider`; `loadThemeId` →
    `loadAppearance()`, `themeIdSubscriber` → generic `configSubscriber(bus, select)`, and
    `persistThemeId` → **`persistAppearance(patch)`: one shared write queue for theme + icons**
    (each is a read-modify-write of the whole config, so separate queues would clobber).
  - `src/app/Settings/` — Appearance group gains an Icons `RadioGroup` (auto/nerd/ascii), a hint
    naming the *resolved* set, a live glyph preview row, and an honest note about panel borders in
    ascii mode. `save(themeId, iconMode)` now carries both live provider-owned values.
  - Call sites converted off hardcoded glyphs: `Toast` (variant icons → `TOAST_ICON_NAMES`, close,
    spinner, `wrapText` ellipsis param), `use-toast` (spinner frames from the set), `Form`
    (Checkbox/RadioGroup/Radio markers, option-description separator), `Hint`, `Tabs` + `NavRail`
    (the rule/cap glyphs — `BORDER_CHARS` deleted from both), `Stepper`, `Welcome` (feature icons
    are `IconName`s now), `WizardFooter`, `DefaultsStep`, `ReviewStep`, `SetupWizard`, `Router`,
    `Dashboard`, `Servers` (+ `cell()` takes the ellipsis), `Server`, and `shared.tsx`
    (new `serverStateIcon(state)` beside `serverStateColor`).
  - Tests (76 total, 9 files): `core/icons/detect.test.ts` — 26 tests over locale/font heuristics,
    override precedence, and catalogue invariants (every set defines every name; ASCII is 7-bit;
    every glyph is single-cell bar the two documented exceptions; nothing is East-Asian Wide;
    `iconsFor` is memoized). `Settings/use-settings.test.ts` updated for the new `save` arity plus
    a case proving the icon mode comes from the argument, not a stale config.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 76/76; the real app driven under a pty at
    110×30 in a sandbox HOME at all three sets — `unicode` draws `━╸╺` rules / `▸ survival` /
    `○ stopped` / `1 … 6 · Enter`, `ascii` draws `==-==` rules / `> survival` / `. stopped` /
    `1 ... 6 | Enter` / `^/v move`, and `nerd` emits the PUA codepoints. `mctl init` writes
    `"icons": "auto"`.
  - **Not verified:** the Settings Appearance picker itself was never driven to completion under a
    pty — the scripted run hung and was killed, so `config.icons` was still `"auto"` afterwards.
    The wiring type-checks and the persist path is shared with the theme picker, but *picking a
    mode in the UI and seeing it written* is unconfirmed. Do this first next session.

- **Phase 2 — server lifecycle (2026-08-03):** all four roadmap bullets landed.
  - **Types:** `types/install.ts` (`InstallStrategy` — `directJar` today, tagged for Phase 3;
    `LaunchSpec`; `VersionInfo`/`LoaderVersion`/`InstallRequest`), `types/java.ts`
    (`JavaRequirement`, `JavaInstallation`, `LTS_MAJORS = [25,21,17,11,8]`), `types/provider.ts`
    (`ServerProvider`, `RuntimeProvider`, `LaunchContext`). `MctlJson.kind` **relaxed to a free
    string** (the registry is the authority); `ServerKind` enum grew `paper` and now bounds only the
    settings/wizard picker. New event types: `ServerCreated/Deleted/Edited`, `JobProgress`,
    `JobFinished`, `JavaInstalled`.
  - **`core/registry/provider-registry.ts`** — `ProviderRegistry` (instance, not singleton) +
    typed `UnknownProviderError`. **`providers/index.ts`** `createProviderRegistry()` is the single
    wiring point, called by both front-ends.
  - **Providers:** `providers/server/vanilla.ts` (Mojang manifest → per-version package JSON; sha1;
    no server jar before 1.2.5) and `providers/server/paper.ts` (**`fill.papermc.io/v3`** — not
    `api.papermc.io`; sha256; the only Phase-2 kind declaring a real Java *range*).
  - **`lib/shell.ts`** (`run`, `which`) and **`lib/download.ts`** (streaming download → sibling temp
    file, sha256+sha1 hashed in one pass, `rename` only after the digest matches, throttled progress).
  - **`core/java/`** — `detect.ts` (probes every candidate with
    `java -XshowSettings:properties -version`; managed/`$JAVA_HOME`/`$PATH`/system; memoized incl.
    failures), `adoptium.ts` (Temurin resolve + download + `tar --strip-components=1` into
    `$ROOT/java/temurin-<major>`), `java-manager.ts` (`resolveJava`, plus the **pure, exported**
    policy `chooseInstalled`/`preferredMajor`).
  - **`core/jobs/`** — `JobScheduler`: `run(spec, work)` → `{job, result}`, `list`/`active`/`cancel`,
    `JobContext.step/progress/signal`. Progress local-bus only; `JobFinished` published.
  - **`core/server/install.ts`** (`executeInstall` + `writeEulaAcceptance`) and
    **`core/server/manager.ts`** (`ServerManager`: staged create, merge-not-replace edit, guarded
    delete; `idFromName`; typed `ServerOperationError`).
  - **`core/session/lock.ts`** — `withServerLock` via atomic `open(…, "wx")`, stale-owner reclaim.
  - **`providers/runtime/foreground.ts`** + **`core/runtime/index.ts`** — spawn with `cwd` = server
    dir, capture to `~/.local/state/mctl/console/<id>.log`, descriptor write, three-tier stop
    (console `stop` → SIGTERM → SIGKILL), cross-instance `logs`/`stop`/`status`,
    `SessionNotOwnedError` for foreign `exec`. `RuntimeManager` owns provider+Java resolution, the
    lock, `heapArgs`, and `restart`.
  - **`core/context.ts`** — `createContext(providers, bus)`, the shared object graph.
  - **CLI:** `cli/args.ts` (flag parser), `cli/context.ts`, and commands `create`, `edit`, `delete`,
    `start`, `stop`, `restart`, `logs`, `exec`, `java list|install`. Router rewired; only
    `backup`/`restore` remain honest Phase-4 stubs.
  - **TUI:** `hooks/use-mctl.tsx` (the mutating-core bridge, rebuilt on `ConfigChanged`),
    `hooks/use-jobs.ts`, `hooks/use-console.ts`; pages `app/ServerCreate/` (form + live job progress)
    and `app/Console/` (auto-scrolling output + command input); `app/Server/` gained a
    focus-ringed action bar (Start/Stop/Restart/Console/Remove) and a delete confirmation `Dialog`;
    `app/Jobs/` is now real; the server list gained `n` (new) and `c` (console) — that list now lives
    on the Dashboard, see the entry above. Routes `create`/`console` added (not in `NAV`); `console`
    joined `OWN_SCROLL`.
  - Tests (**127 total, 13 files**, +51): `core/java/java-manager.test.ts` (selection policy incl.
    the LTS ceiling), `cli/args.test.ts` (incl. the `--java 21` / `--no-java` regression),
    `core/session/lock.test.ts` (exclusion, stale reclaim, release-on-throw),
    `core/server/manager.test.ts` (19 cases: create/edit/delete end-to-end against a temp `$HOME`
    with a stub provider over `file://` — no network).
  - **Verified for real, not just typed:** `bunx tsc --noEmit` clean; `bun test` 127/127.
    In a sandbox `$HOME`: `mctl create --kind paper --mc 1.21.4` downloaded and sha256-verified the
    51 MB Paper jar, wrote `mctl.json` + `eula.txt`, and registered the location; `mctl start`
    booted Paper to `Done (16.955s)`; `mctl logs -n` tailed it; `mctl exec` **from a second
    instance** correctly refused with `SessionNotOwnedError`; `mctl stop` **from a second instance**
    stopped it gracefully in 7.4 s; `mctl java install 21` fetched, verified and extracted Temurin
    21.0.12. Guards checked: duplicate id, `--files` without `--yes` (exit 2), unknown flag (exit 2),
    `exec` on a stopped server, idempotent `stop`. Under a pty at 120×44: the create form filled and
    submitted, painted `Resolving · paper 1.21.4` / `Writing configuration` with a progress bar,
    toasted `Created tui-made`, and navigated to the detail page; **Start** (keyboard) launched it on
    the *managed* Java 21, the Console page streamed live output, and **Stop** brought it down.

- **Drag-selection made opt-in (2026-08-03).** `src/components/selection-opt-in.ts` →
  `installSelectionOptIn()`, called in `renderApp()` next to `installBoxClipPatch()`. Replaces the
  blanket `renderer.startSelection = () => {}`, which had disabled selection everywhere including
  where it was wanted. Now `<text selectable>` (the console log lines) selects and everything else
  ignores drag. Verified at runtime against the real catalogue: `text` → `false` by default, `true`
  with the prop, `false` with `selectable={false}`; `box`/`input` unaffected. `bunx tsc --noEmit` clean.

- **Dashboard absorbed the Servers screen (2026-08-03, user request).**
  - `src/app/Dashboard/index.tsx` rewritten: summary tiles → column header → server rows, with the
    **selected row expanding in place** (name/loader/java/memory/network/path + pid/port/startedAt when
    running, and an `Enter/c/n` hint). Keeps the old list's keyboard (↑/↓ or j/k, Enter open, `c`
    console, `n` new). The Recent Activity feed is gone.
  - **Deleted:** `src/app/Servers/` and `src/hooks/use-recent-events.ts` (its only consumer).
  - `app/routes.ts` — `servers` removed from `RouteId` and `NAV`; digits renumbered **1–5**.
    `app/Router.tsx` — page switch + import dropped, hint strip now `1 … 5`. `app/NavRail.tsx` —
    `server`/`console`/`create` all light the **Dashboard** tab. `navigate("servers")` →
    `navigate("dashboard")` in `app/Server/` and `app/ServerCreate/`.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 127/127 (no test referenced the Servers page);
    driven under a pty at 110×40 in a sandbox `$HOME` with two discovered servers — the rail shows the
    five renumbered tabs, the table renders, `j` moves the caret and the expansion follows it, `2`
    reaches Jobs and `1` returns to the Dashboard.

- **Terminal-relative dimensions — negative width/height (2026-08-03, user request).**
  - `src/components/negative-dimension-patch.ts` → `installNegativeDimensionPatch()`, installed in
    `renderApp()` beside the other two patches. A negative `width`/`height` on any JSX element now
    means `terminal size - n` (`<box width={-4}>` = terminal width minus 4), clamped at 0 and
    **re-resolved on every terminal resize**. Two seams: the React component catalogue (upstream's
    constructor `validateOptions` *throws* on a negative before any prototype method runs) and the
    `Renderable.prototype` `width`/`height` accessors (the reconciler applies prop updates as plain
    assignments). Tracked renderables are dropped on `"destroyed"` or when set to a non-negative.
  - `src/components/selection-opt-in.ts` — now wraps `getComponentCatalogue()` instead of
    `baseComponents`, so the two catalogue patches compose in either order instead of the second
    `extend()` silently replacing the first. **This is a rule for any future catalogue patch.**
  - `src/components/negative-dimension-patch.test.tsx` — 7 tests (134 total, 14 files) mounting real
    JSX through `createRoot` + `createTestRenderer`: construction, prop-update assignment, resize
    tracking in both directions, opting back out, the positive/`auto`/`%` control, the clamp, and an
    unmounted renderable leaving the sweep. Installs both catalogue patches together, so it also
    guards their composition.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 134/134; **non-vacuous** — with the install
    commented out 6 of the 7 fail (the untouched-dimensions control still passes, as it should).
    A runtime check through the real reconciler confirmed both patches at once
    (`width={-4}` → 36 at a 40-cell terminal, `<text>` non-selectable, `<text selectable>` selectable).
    The real app driven under a pty at 100×30 in a sandbox `$HOME` renders the rail, tiles and table
    with no stderr.

- **Server inspection + a responsive Table; richer Dashboard and Server pages (2026-08-03, user
  request).** "Make the table look good (full width), make it responsive, add more columns and info."
  - **New core read path — `src/core/server/inspect.ts`** (read-only twin of `discover.ts`):
    `inspectServer(server)` (cheap tier: `server.properties`, roster JSONs, `mods/`+`plugins/` jar
    counts, process sample, list ping) and `measureSize(server)` (expensive tier: the directory
    walk). Nothing cached; every field optional.
    - `src/core/server/properties.ts` — Java `.properties` parser + coercion to a typed
      `ServerProperties` with Minecraft's documented defaults (numeric pre-1.13 gamemode/difficulty,
      `\uXXXX` escapes, line continuation, hardcore's effective difficulty, `§` codes stripped for
      display and kept in `raw`).
    - `src/core/server/ping.ts` — **Server List Ping** (1.7+ JSON status): varint framing, handshake
      → status request → JSON response, chat-component MOTD flattening, 2 s timeout. The only way to
      a live player count without RCON.
    - `src/lib/proc.ts` — `sampleUsage(pid)`: two procfs snapshots ~220 ms apart for a real CPU rate,
      RSS, thread count; `ps` fallback off Linux (flagged as a lifetime average).
    - `src/lib/fs.ts` — `dirSize(dir, {maxEntries, exclude})`: level-by-level concurrent walk, does
      not follow symlinks, never throws, reports `truncated`.
    - `src/lib/net.ts` — `lanAddress()` for the suggested join address.
    - `src/lib/format.ts` — `formatDuration`, `parseMemorySize`.
  - **`src/hooks/use-server-insights.ts`** — `useServerInsights(servers)` / `useServerInsight(server)`:
    self-chaining polls (4 s cheap, 60 s sizes; 2 s on the detail page) keyed on a server
    id/state/pid signature, holding a derived projection only.
  - **`src/components/Table.tsx`** (+ barrel, + `use-box-width.ts` extracted from `Form.tsx`) — the
    responsive table: pure `layoutColumns` (priority dropping → iterative flex distribution with
    `max` caps → last-resort shedding), `fitCell`, selection, click-to-select/activate, an expanded
    row slot, and `scrollRows` with a reserved scrollbar cell.
  - **Dashboard rewritten** — 4–7 responsive stat tiles (servers/running/players/cpu/memory/on
    disk/unavailable-when-nonzero) and a full-width table of ID, STATE, PLAYERS, CPU, MEM, UPTIME,
    KIND, MC, PORT, SIZE, RUNTIME, JAVA, MOTD, shedding columns as the terminal narrows. The
    expanded row panel now has three groups (Server / Live / World) that stack when narrow. Route
    added to `OWN_SCROLL` in `Router.tsx`.
  - **Server page rewritten** — six panels (Status, Resources with CPU/memory meters, Players with
    the online sample and rosters, World & rules with the full `server.properties` read, Storage &
    content, Configuration), two columns at ≥96 cells and one below. TPS/MSPT/network traffic/heap
    occupancy are named as unavailable rather than omitted.
  - Tests (**182 total, 19 files**, +48): `components/Table.test.ts` (the never-overflow invariant at
    every width 1–200, drop order, `max` capping, `fitCell` truncation incl. the multi-cell ASCII
    ellipsis), `core/server/ping.test.ts` (**driven against a real TCP server** speaking the
    protocol: decode, segmented response, no listener, immediate hang-up, garbage, timeout),
    `core/server/properties.test.ts`, `lib/format.test.ts`, `lib/fs.test.ts` (symlinks, truncation,
    exclusions).
  - **Two real defects found by those tests and fixed:** the ping never resolved when a peer hung up
    without replying (needed an `end` listener — see `memory.md`), and `layoutColumns` could return a
    row wider than the terminal when only required columns were left.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 182/182; and driven under **tmux** at 140×44,
    140×32, 96×26, 90×30, 70×30 and 62×24 against a sandbox `$HOME` holding three fabricated servers
    (one registered-but-missing) plus a stand-in "running" server — a live pid that answers a real
    list ping on 25565. Confirmed on screen: players `3/40` with names, CPU 5% of 8 cores, RSS
    against the 4G heap, uptime, 1 ms latency, advertised version, mods/plugins/datapacks counts,
    world vs total size, the full rules panel, columns dropping in priority order as the terminal
    narrowed, and header/row alignment holding once the scrollbar appeared.

- **Server page became a tabbed multi-screen page (2026-08-07, user request).** "Start with the
  scaffolding and implement the basics now."
  - `src/app/Server/tabs.ts` — the tab model (`ServerTabId`, `SERVER_TABS` with label + description,
    `DEFAULT_SERVER_TAB`, `serverTab`, `isServerTabId`).
  - `src/app/Server/panels.tsx` — the page's shared vocabulary: `Panel`, `Detail`, `Meter`,
    `EmptyNote`, `Columns`, `LABEL_WIDTH`, `TWO_COLUMN_WIDTH`, `ServerTabProps`, `javaLabel`.
  - `src/app/Server/tabs/` — nine screens: **Overview** (status, live meters, connection, server
    facts), **Console**, **Players** (online sample + the four rosters), **World** (world, difficulty,
    rules, load), **Content** (mods/plugins/datapacks, resource pack, on-disk), **Backups** (honest
    Phase-4 note + the configured policy), **Performance** (now, a session sample window, runtime,
    and the not-measurable list), **Network** (join address, profile, listeners), **Settings**
    (identity, execution, location, and the `mctl edit` commands — read-only for now).
  - `src/app/Server/index.tsx` rewritten as the container: identity header + lifecycle action bar +
    `Tabs` + tab body + hint + delete dialog, with a focus ring of `[tabs, …actions, console?]`.
  - `src/app/Console/ConsoleView.tsx` — the console pane extracted so the `console` route and the
    Console tab share one implementation; its input capture follows `focused`.
  - `src/app/Router.tsx` — `server` added to `OWN_SCROLL`.
  - **One real defect found in the pty:** the 1-row action bar had no `flexShrink={0}` beside the
    `flexGrow` tab body, so at 74×24 yoga shrank it away and Start/Stop disappeared. Fixed on both
    pinned rows.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 182/182 (no new tests — the tabs are presentation
    over already-tested read paths); driven under **tmux** at 120×40 and 74×24 against a sandbox
    `$HOME` with a fabricated Paper server — all nine tabs render, ←/→ switch them, the tab bar
    scrolls when narrow, panels stack to one column at 74, typing in the Console tab inserts
    characters instead of navigating, and pointing a runtime descriptor at a live pid showed real CPU
    (99% of 8 cores), RSS against the 4G heap, threads, a 3 h uptime and the session min/avg/peak
    summary, with the action bar flipping to Stop/Restart. No stderr in any run.

- **Global hint provider — one strip for the whole app (2026-08-07, user request).** "The hints are
  showing in two places. Create a provider to update the global hints rendered from `Router.tsx`."
  - `src/hooks/use-hints.tsx` — `HintProvider` + `useHints(items, {scope, active})` +
    `useHintItems()` + the pure, exported `composeHints`. Scopes `context`/`page`/`global`, merge by
    key signature (most specific wins the key), and a `when` (`always`/`idle`/`typing`) that drops
    character shortcuts while an input capture is held. Two contexts so contributors don't re-render.
  - `src/app/Router.tsx` — mounts `HintProvider` inside `RouterProvider`, registers the shell's
    global hints, and renders the single `HintBar`. Its own typing/idle branch is gone (the provider
    owns that rule now), and the global set no longer claims `Enter open` (a page's key) or a typing
    `Tab` (the page's keyboard, not the shell's).
  - **`<Hint>` removed from every page**: Dashboard (and its bottom border row), Console, Server,
    Settings (its action bar keeps only the save-error text), ServerCreate (which also lost the
    duplicate key list in its `PageHeader` subtitle — that screen had *three* copies). The setup
    wizard keeps its own footer: it renders outside the router and has no strip to merge into.
  - Hints now follow the **focus ring**, not just the route — Settings shows `←→ group` only on the
    tab bar and `Ctrl+S save` only when a save is possible; the Server page swaps to
    `Enter send command` while the Console tab's command line holds the ring.
  - `src/hooks/use-hints.test.ts` — 7 tests (189 total, 20 files) over scope order, key-signature
    de-duplication, chord equivalence, the typing filter, and a suppressed hint freeing its key.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 189/189; `bunx biome check src` clean bar three
    pre-existing warnings. Driven under **tmux** at 120×36 against a sandbox `$HOME` — one strip on
    every screen, the Dashboard/Server/Settings/Create keys merging ahead of the shell's, `Esc cancel`
    replacing `Esc back` on the create form, and the character shortcuts disappearing the moment a
    text field or the console command line takes the capture. No stderr in any run.

- **The `console` route removed (2026-08-08, user request).** "We should only be able to see the
  console from inside the server page."
  - `app/routes.ts` — `console` dropped from `RouteId`; `RouteParams.serverId` now serves `server`
    alone. `app/Router.tsx` — the `Console` import, the `Page` case, the `OWN_SCROLL` entry and the
    `titleFor` line are gone. `app/NavRail.tsx` — the Dashboard tab lights for `server`/`create`.
  - `app/Dashboard/index.tsx` — the `c` key, its hint, and the `c console` line in the expanded row
    panel are gone; `Enter` (details) and `n` (new) are unchanged.
  - **`app/Console/` deleted**: `index.tsx` (the page) removed and `ConsoleView.tsx` moved to
    `app/Server/ConsoleView.tsx` — the Server page's Console tab is now its only host. Same directory
    depth, so only `Server/tabs/Console.tsx`'s import specifier changed.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 189/189; `bun run format` clean.

- **The Players tab became a real screen (2026-08-08, user request).** "Display all players
  together in list or grid format, online first then offline, banned below; add ban / kick / shadow
  ban / teleport / feed / kill; show every worthwhile stat; a random head per player, hidden on
  small screens; responsive and modern."
  - **`src/lib/nbt.ts`** — a read-only NBT decoder (no writer: MCTL never modifies world data).
    Gzip/zlib detected by magic number; 64-bit tags decode to `bigint`; `nbtGet`/`nbtNumber`/
    `nbtString` for the version-varying shapes. `src/lib/fs.ts` gained `readBytesIfExists` and
    `fileMtime`.
  - **`src/core/server/players.ts`** — `readPlayers(server, {online, onlineCount, levelName})`
    merges `usercache.json`, the four roster files, `<world>/stats/<uuid>.json` and
    `<world>/playerdata/<uuid>.dat` with the ping sample into `PlayerProfile[]` (online first, then
    last seen). Detail reads capped at 64 files; `onlineUnnamed` reports connected players the
    sample did not name.
  - **`src/core/server/player-admin.ts`** — the action catalogue (`PLAYER_ACTIONS`, 15 actions with
    `applies` / `needsRunning` / argument), the pure `commandFor`, and `runPlayerAction`. Everything
    is a console command through `RuntimeManager.exec`; MCTL never edits the server's roster files.
  - **Shadow ban** is an MCTL-side marker: `MctlJson.shadowBans` (new `ShadowBan` schema),
    `EditServerOptions.shadowBans`, and `ServerManager.shadowBans(id)`. It enforces nothing —
    `TODO(phase-5)` in `player-admin.ts`, and both the dialog and the toast say so.
  - **`src/hooks/use-players.ts`** — 5 s self-chaining poll keyed on the online sample, plus `act`.
  - **UI:** `app/Server/tabs/Players.tsx` rewritten (summary strip → Online / Offline / Banned /
    Banned addresses card grids, health + hunger meters, playtime/kills/deaths, badges on the card's
    bottom border) and `app/Server/PlayerActionsDialog.tsx` added (two-stage menu → argument).
    `MinecraftHead` gained `skinFor(seed)` — deterministic, so a head does not change face on every
    poll. The tab joins the container's focus ring as `PLAYERS_ID`.
  - Tests (**217 total, 23 files**, +28): `lib/nbt.test.ts` (every tag type, gzip, the empty-list
    trap, truncation), `core/server/player-admin.test.ts` (every command's wording, `gamemode`'s
    reversed argument order, `applies`), `core/server/players.test.ts` (the five-source merge
    against a real temp directory with real gzipped NBT, unit rescaling, a name-only ban folding in,
    a non-default level name, a malformed entry).
  - Verified: `bunx tsc --noEmit` clean; `bun test` 217/217; `bunx biome check src` clean bar the
    three pre-existing warnings. Driven under **tmux** at 140×44, 74×40 and 52×30 against a
    fabricated `$HOME` (8 players, real gzipped player data, a real list-ping responder on a live
    pid): cards/badges/bars render, heads drop below 84 cells and the grid falls to one column at
    52, the action menu filters by `applies`, a shadow ban round-tripped through `mctl.json` and
    came back as a badge, typing a reason containing `5` did not navigate (input capture), and a
    kick failed with the foreground runtime's real `SessionNotOwnedError`. Killing the fake server
    moved every player to Offline with the "not answering a status ping yet" note.

- **Player cards are fitted to the row, not fixed-width (2026-08-08, user request).** "Instead of
  using fixed width, calculate to fit. Like if 2 column, make the width 50% and so on."
  - `app/Server/tabs/Players.tsx` — `CARD_WIDTH_WITH_HEAD`/`CARD_WIDTH_PLAIN` replaced by
    `CARD_MIN_WIDTH_WITH_HEAD` (36, nine less without a head) plus the pure `fitCards(available,
    minimum)`, which takes as many columns as fit at the minimum and then gives every card an equal
    share of the row. `CARD_MAX_WIDTH` (60) stops a lone card stretching across a wide terminal;
    leftover cells are left unused rather than making one card in a row wider than its neighbours.
  - `available` is now the **measured** interior of a `Section` — the section wraps its children in a
    box it measures with `useBoxWidth` and reports through a new `onWidth` prop, because only the
    layout engine knows what the shell frame, tab padding, section border and scrollbar took. The old
    `width - 4` terminal estimate survives as `SECTION_CHROME = 9`, used only until the first layout.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 217/217; `bun run format` clean. Driven under
    **tmux** at 140/100/84/83/70/60 columns against a fabricated `$HOME` (12 players, one op, one
    ban) — 3 columns of 43 filling all 131 available cells at 140, 3 at 100, 2 at 84 and 83 (where
    the heads drop), 2 at 70, 1 at 60, with no card overflowing or wrapping at any width.

- **Fix: the Players tab showed no player data on a Minecraft 26.x server (2026-08-08, user
  report).** Every card read `seen —` / `— played` / `no player data`.
  - **Cause:** Minecraft **26.1** regrouped the world's per-player directories under `players/` —
    `<world>/playerdata` → `<world>/players/data`, `<world>/stats` → `<world>/players/stats`
    (`advancements` moved too). `core/server/players.ts` only knew the pre-26.1 paths, so the stats
    and NBT reads found nothing. **File formats are unchanged**; `lib/nbt.ts` and `readStats` needed
    no edit.
  - **Fix:** exported `resolvePlayerDirs(worldDir)` in `core/server/players.ts`, which picks the
    layout by **directory existence** (`<world>/players/data`) rather than by version string — see
    `memory.md` for why the version is not a reliable discriminator. `readPlayers` calls it.
  - Tests (**220 total, 23 files**, +3): a 26.1+-layout fixture reading state, stats and `lastSeen`;
    `.dat_old` siblings not being mistaken for players; and the legacy/never-booted fallbacks of
    `resolvePlayerDirs`.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 220/220; a direct `readPlayers` call against the
    user's real 26.2 Paper server returned playtime, deaths, health, hunger, game mode, position and
    distance for both players; and the app driven under **tmux** at 120×40 rendered the Offline cards
    with real values (`seen 6m ago` / `6m played` / `1 deaths` / `lvl 0 · survival`), no stderr.

## In progress

- Nothing mid-implementation. All the above compiles, tests, and runs.
- **The dev shortcuts are gone** — `app/Router.tsx` boots to the Dashboard again and
  `DEFAULT_SERVER_TAB` is `"overview"`.
- **The working tree is clean** as of 2026-08-13; the Dashboard tweak this file used to list as
  uncommitted is committed (`c233a97`, see the hand-made UI passes entry).

### Current state of the checks (re-run 2026-08-13, after the gap-closing pass)

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bun test` | **421 pass / 0 fail**, 43 files |
| `bun run format` | clean |
| `bunx biome check src` | 220 files, clean |

Nothing is failing and nothing is suppressed without a stated reason. The two suppressions in the
tree are `hooks/use-toast.test.tsx` (raise-once effect) and `hooks/use-theme.tsx` (the catalogue
invalidation counter); both name why. **A Biome suppression has to be the last comment before the
node and sit above the hook call, not above its dependency array** — prose after it silently voids it.

## Next up (Phase 4 — the operations half)

Networking (bullets 1 and 2) is done. What remains of Phase 4:

1. **Backup providers + scheduling.** `BackupProvider` joins `types/provider.ts` with its first real
   implementation (filesystem), not before. `config.backup` already carries provider / schedule /
   retention / compression and the setup wizard collects them; the Backups page and the Server page's
   Backups tab are honest scaffolding waiting for it. `mctl backup` / `mctl restore` are still the
   only Phase-4 stubs left in `cli/router.ts`.
2. **Supervision behind the supervisor lock**: auto-restart, health checks, resource monitoring —
   *and tunnel keepalive*, which networking deliberately does not have yet (see Known gaps).
3. A **profile editor**. Network profiles can only be created by hand-editing `config.json` today;
   Settings picks a default among them and the Network page lists them read-only.

Carried over from Phase 3, deliberately not done:

- **The Server page's Settings tab is still read-only** (`TODO(phase-3)` in `tabs/Settings.tsx`).
  Making it a form over `ServerManager.editServer` was the one Phase-3-marked item outside the
  roadmap's four bullets; `mctl edit` remains the way to change these values.
- **`mctl update <id>`** — changing a server's `kind` or `minecraftVersion` is a re-install, not an
  edit, and `editServer` still refuses it. The install machinery it needs now exists.

## Demo / scratch

- **`components/MinecraftHead.tsx`** — Renders a Minecraft head into an 8×4-cell FrameBuffer via
  half-block glyphs. A FrameBuffer showcase, not dashboard code; **no longer mounted anywhere** (App now
  routes wizard-or-`Dashboard` placeholder) but still exported from the barrel. Technique in `memory.md`.
- **`Gallery.tsx` no longer exists** — the component showcase was removed; verify the UI kit by running
  the wizard (it exercises Input/Select/Toggle/Checkbox/RadioGroup/Button/Hint/FormField in anger).

## Known gaps / carried forward

The self-contained ones were closed on 2026-08-13 (see the entry at the top of *Done*). What is left
falls into three buckets, and the bucket is the reason it is still here:

1. **Needs something MCTL cannot supply itself** — a Cloudflare zone and token, a playit account, an
   RCON client. Listed below as unverified rather than unimplemented.
2. **Is a roadmap phase wearing a gap's clothes** — backups, supervision/keepalive, the profile
   editor, Modrinth/CurseForge. These belong in *Next up*, not here; building them opportunistically
   under "close the gaps" would scaffold half a phase.
3. **A deliberate product decision** recorded so nobody re-opens it: no version picker, the recorded
   port on re-expose, NeoForge 1.20.1 steering to `--kind forge`.

- **Phase 4a gaps (2026-08-13):**
  - **No tunnel keepalive.** An agent that dies takes the tunnel with it and nothing brings it back;
    `mctl network status` reports `down` and `mctl network up <id>` restores it by hand. Keepalive
    needs the supervisor lock, which is the operations half of Phase 4 — that is where it belongs,
    not bolted onto `NetworkManager`.
  - **Network profiles are hand-edited JSON.** There is no UI or CLI to *create* one; Settings only
    picks the default among existing profiles.
  - **playit is wired but never confirmed against a real account.** Its binary was present on the
    test machine, but no tunnel was claimed, so the `options.address` path and the scraper were
    exercised only by unit tests. cloudflared was confirmed end to end with a real quick tunnel;
    ngrok and tailscale were confirmed only as far as preflight (no account / logged out).
  - **Cloudflare DNS was never run against the real API** — only against a local stand-in speaking
    the v4 envelope. The shapes come from Cloudflare's docs; a live run needs a zone and a token.
  - **A named cloudflared tunnel is not created by MCTL**, only run. Creating one is `cloudflared`'s
    own browser login flow.
  - **`mctl network up` on a server whose port changed since it booted uses the recorded port.** That
    is deliberate (the running server did not re-read `server.properties` either), but it means an
    edited port needs a restart, not just a re-expose.

- **Phase 3 gaps:**
  - **Velocity is installable but not really *managed*.** It is a proxy: no world, no
    `server.properties`, no players of its own, and its `minecraftVersion` holds a *Velocity* version.
    The inspection screens find nothing and say nothing about why. Its config is `velocity.toml` —
    the one place a TOML file legitimately exists inside a server directory, written by Velocity, not
    by MCTL.
  - **NeoForge for Minecraft 1.20.1 is not offered** — those builds were published under the
    `net/neoforged/forge` artefact with a Forge-style version. `--kind forge` covers it; the error
    message says so.
  - **Fabric servers need network on their first boot** (the launcher downloads the game then), and
    **Forge/NeoForge/Quilt creates need a JVM** even with `--no-java`, because the install *is* a
    program. Both are stated in the provider docs; neither is surfaced in the UI.
  - **`launchSpec(dir)` is now vestigial for the installer kinds.** They record their spec in
    `mctl.json` at create time and their `launchSpec()` returns the `run.sh` fallback, which is only
    reached by a hand-written `mctl.json`. Widening the interface to take a `Server` would let it go.
- **The Server page's Settings tab is read-only.** Editing goes through `mctl edit` today; making it
  a form over `ServerManager.editServer` (buffered draft + validation + Ctrl+S, mirroring
  `app/Settings/use-settings.ts`) is marked `TODO(phase-3)` in `tabs/Settings.tsx` — **not done in
  Phase 3**, carried into Phase 4.
- **The Backups tab is honest scaffolding**, not a feature: it shows the configured policy and says
  archives arrive with the backup subsystem, with a `TODO(phase-4)` naming the provider call that
  fills it in. (The Network tab is now real — see Phase 4a above.)
- **Shadow ban is recorded but not enforced.** `mctl.json.shadowBans` is an MCTL-side marker —
  Minecraft has no shadow ban, so nothing happens on the server. Real enforcement needs the
  RCON/plugin subsystem (`TODO(phase-5)` in `core/server/player-admin.ts`).
- **Player actions require the server to be running**, because they are console commands. Under the
  **foreground** runtime `exec` additionally only works from the owning instance — a second MCTL gets
  `SessionNotOwnedError`, which the tab surfaces as a toast. **Under tmux this is gone** (verified):
  the console is addressed by session name, so any instance can send a command. Running a server on
  the tmux runtime is now the answer to that limitation.
- **Per-player ping and current session length are unavailable** and are named as such on the
  Players tab; both need RCON or a plugin.
- **Content counts jars; it does not list them.** A real mod/plugin list needs the Modrinth/CurseForge
  integration (`TODO(phase-5)`).

- **TPS / MSPT, per-server network traffic, and JVM heap occupancy are still unavailable** and are
  labelled as such in the Resources panel. TPS needs an RCON client (Phase 4/5) — that is the single
  highest-value addition to the Server page once RCON lands, and `server.properties` already tells
  us whether RCON is enabled and on which port.
- **The disk walk has no cross-instance sharing or cache.** Every open TUI re-walks every server
  directory once a minute. Fine for a handful of servers; if it ever bites, the answer is a cached
  measurement under `~/.cache/mctl/` with an mtime check, not a longer interval.
- **`ServerProvider` fixtures still absent** (below) — the new `ping.ts` *is* tested against a real
  socket, which is the pattern to copy for them.

- **The Settings → Appearance icon picker still has not been driven to completion under a pty**
  (carried from last session; the scripted run hung and was killed). The wiring type-checks and
  shares the theme picker's persist path, but *picking a mode in the UI and seeing `config.icons`
  written* remains unconfirmed.
- **`mctl create` has no version picker in either front-end.** Both take a free-text version and fall
  back to the kind's newest release. Listing versions is a network round-trip per kind and would make
  the form unusable offline; revisit if users ask.
- **The TUI create form does not offer a Java pin.** If nothing installed satisfies the requirement it
  downloads a JDK inside the create job, which can be a ~200 MB step with only a progress bar to show
  for it. The CLI has `--java <major>` / `--no-java`; the form does not.
- **A `{pinned}` Java that is not installed is fetched silently** during create/start. That is the
  right default, but there is no "ask first" prompt in the TUI (the `autoInstall: false` path exists
  in `resolveJava` and is unused by the UI).
- **`ServerProvider` implementations are still not tested against recorded fixtures.** AGENTS.md asks
  for this and it is now the largest untested surface: **eight** providers, verified live rather than
  against fixtures. Their *pure* parts are covered (`decodeNeoVersion`, `compareMinecraftVersions`,
  the install executor), but no test would catch an upstream schema change or a wrong URL. Recording
  one endpoint set per origin is the obvious next test, and Quilt's bad digest (see `memory.md`) is
  the case that shows why a fixture is not a substitute for the occasional live run.

## Notes for the next agent

- **Do not scaffold empty phase-3+ folders** (backups, network). Build per roadmap phase.
- **Statelessness is non-negotiable:** never cache an authoritative server set; recompute from disk +
  `runtime/<id>.json` probes. Cross-instance sync = `fs.watch` + `events.jsonl` tail, no IPC/daemon.
- **JSON/JSONL only** — no TOML anywhere. `mctl.json`, `config.json`, `secrets.json`, `events.jsonl`.
- Pages live in `src/app/`, not `src/pages/`. CLI in `src/cli/`.
- Registry + statelessness invariants live in `architecture.md` — read before touching discovery/session.
- Verify with `bunx tsc --noEmit` (or `bun run typecheck`), `bun test`, and `bun run dev`. Tests must
  live **inside `src/`** (a file outside it resolves a different copy of `@opentui/core`). The
  location registry itself still has no direct unit test, though `core/server/manager.test.ts` now
  exercises it end to end.
- **Isolating state in a test is just XDG env vars** — `lib/paths` reads them on every call, so
  pointing `XDG_STATE_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME` at a temp dir in `beforeEach` isolates
  the whole tree (see `core/server/manager.test.ts`, `core/session/lock.test.ts`).
- **Driving the TUI under a pty:** prefix with `stty rows N cols M`; `script` ignores `COLUMNS`/`LINES`
  and inherits the parent's size, silently hiding anything below the fold.
- **Adding a provider is one file plus one line** in `providers/index.ts`. Nothing in `core/` changes.
  `executeInstall`'s exhaustiveness guard will fail the build until the new strategy has a case.
- **Path discipline:** never build an MCTL path by hand — call a `lib/paths.ts` helper. Never read/write
  a shared JSON file directly — go through `lib/fs.ts` (atomic) and validate with Zod.
- Config service already exposes everything the wizard/`init` need: `writeConfig`, `writeSecrets`,
  `ensureDirTree`, `resolveRootPaths`. Don't re-implement writing in the front-end.
