# MCTL — Cross-Session Memory

Decisions, gotchas, and user preferences that don't live in the code. Append-light, prune-heavy —
delete entries that stop being true. Newest-relevant first.

---

## Select answers the mouse; the field label lost its caret (2026-08-14, user request)

User: "For the Select Component enable mouse wheel to select back and forth for dropdown mode. For
tab-select enable mouse click, and also on mouse hover on ending arrow should move the options in
view. Remove the leading carate in the label in form elements. Its looking awefull."

- **`<select>` and `<tab-select>` are keyboard-only in `@opentui/core` 0.4.5.** Neither registers a
  single mouse listener, so every pointer behaviour here is `Select`'s own: `onMouseScroll` on the
  dropdown, `onMouseDown`/`onMouseMove`/`onMouseOut` on the tab strip.
- **Both controls derive their scroll offset from the selection**, so "scroll the list" and "move the
  selection" are the same act — there is no viewport to move independently. That is why hovering an
  end arrow *changes the value*, which is worth knowing before someone reads it as a bug.
- **`<tab-select>` takes no `selectedIndex` prop** — only a `setSelectedIndex` method — so it was
  never actually controlled. The value was already able to drift from the highlighted tab; a mouse
  pick made it obvious (the callback reported the right kind while the strip still highlighted the
  old one). An effect now pushes the controlled index into the renderable whenever the two differ.
  - Consequence, and the reason `pick` gained a `opt.value !== value` guard: `setSelectedIndex`
    **emits `selectionChanged`**, which the React binding maps to `onChange` — so the sync echoed
    back as a second `onChange` for the value the page had just set.
- **The tab strip's geometry has to be reconstructed** (`components/support.tabSelectHit`, pure +
  tested): `scrollOffset` is private and derived as `clamp(selected - floor(visible/2), 0, count -
  visible)` with `visible = floor(width / tabWidth)`; tabs are `tabWidth` apart from that offset; and
  the `‹`/`›` arrows are painted **over** the first and last cell of the row, so they win over the tab
  beneath them. All of it mirrors `TabSelectRenderable.refreshFrameBuffer` — recheck it on an OpenTUI
  bump.
  - **The arrows only exist in the gap between two width tests**: `optionsFitAsTabs` (≈ `label + 3`
    per option) decides the strip is used at all, while the strip itself gives each tab `label + 6`.
    A test needs labels short enough for the first and numerous enough to overflow the second.
- **The hover repeat is a `useEffect` with no dependency array on purpose.** Each step re-renders,
  which restarts the interval, so the repeat is paced at one option per 180 ms and always reads the
  current selection. The first step is fired by the pointer handler so entering the arrow is instant.
- **`createRoot(renderer).render()` a second time remounts the tree** (already recorded under player
  heads) — which silently defeats any test of a *repeating* interaction, since the hover state is
  thrown away after the first step. Feed the value back through `useState` inside the tree instead.
- **`harness.mockMouse` (from `@opentui/core/testing`) drives real clicks, moves and wheels**, and
  `MouseEvent.x/y` are absolute terminal cells, so a handler converts them with the renderable's
  `screenX`/`screenY` (not `x`/`y`, which are parent-relative).
- **A pty can be driven with the mouse too**: `tmux send-keys -l $'\033[<0;36;11M'` (press),
  `…m` (release), `35;x;y` for a bare motion, `64`/`65` for wheel up/down — 1-based coords. That is
  how the three behaviours were confirmed in the real app.
- The wheel **consumes** the event (`stopPropagation`), otherwise the shell's scrollbox scrolls under
  the pointer at the same time, and it **clamps** instead of wrapping the way the keyboard does — a
  wheel is a continuous gesture and flipping last→first mid-flick reads as the list jumping.

## Closing the standing gaps (2026-08-13, user request: "implement all the gaps")

- **"Fill in the gaps in progress.md" meant *implement* them**, not document them. The first pass
  wrote them up; the user corrected it. When a request names an artifact's gap list, assume the code
  is the deliverable.
- **`readJsonIfExists` throws on a syntax error.** It tolerates only an *absent* file. Every caller
  that reads a user-editable file has to wrap it — `ThemeRegistry.load` did not, so a half-written
  `themes/*.json` took the whole catalogue (built-ins included) down with it. That was harmless while
  the catalogue was read once at startup and became a live crash the moment the directory was watched:
  an editor saving a file *is* a truncated file for a few milliseconds.
- **A Biome `// biome-ignore` must be the last comment before the node**, and it must sit above the
  *hook call*, not above the dependency array. A prose comment placed after it silently voids the
  suppression (`suppressions/unused`), and Biome reports `useExhaustiveDependencies` for an
  **extra** dependency too, not just a missing one — the invalidation-counter pattern
  (`catalogue`/`version` state that nothing in the body reads) always needs one.
- **The nerd-set meter glyphs are two cells on purpose** (the user's `4c0e56a`): a patched font draws
  them wider than one cell, so each carries a trailing space. The catalogue test's single-cell
  assertion was the wrong half; it exempts those four now and pins the pad separately. Do not
  "fix" the glyphs.
- **`Table`'s row geometry is derived, not tuned.** A row draws inside a rounded border with its own
  padding, so it can paint `ROW_BORDER + ROW_PADDING_X` fewer cells per side than the table's box; the
  header draws outside that border and pays the same cells as padding. The old hand-tuned `- 3` was
  one short, and the symptom only appears with a **filled flexible column**: the gap before it
  collapses and the row wraps onto a second line inside its own border. `Table.render.test.tsx`
  catches it; `layoutColumns` never could, because both halves agreed on widths and disagreed on room.
- **A staging sweep must key on the newest mtime *inside* the tree.** A long download rewrites one
  file and leaves every ancestor's mtime alone, so the directory's own timestamp calls a live install
  abandoned. And age is the only usable discriminator at all: the create lock covers the server id,
  not the staging uuid, so another instance's in-flight create is indistinguishable from a dead one.

## Phase 4a — networking: providers, tunnels, Cloudflare DNS (2026-08-13)

- **`mctl.json.network` is a *profile name*, not a provider id**, and the code now says so. The old
  `config.NetworkProvider` enum (typed as both) was renamed to **`NetworkProviderId`**, and both
  `NetworkProfile.provider` and `NetworkConfig.defaultProfile` became free **strings**: a config
  written by a newer MCTL naming a provider this build lacks must still load, or one unknown profile
  takes every other setting down with it. Same lesson as `mctl.json.kind` in Phase 2.
  - Settings' default-profile picker is now built from `config.network.profiles` — profiles are
    user-defined, so a hand-kept list could not name the `cf-tunnel` the user just added.
- **Networking never fails a start.** `NetworkManager.expose` degrades to `direct` for *five* distinct
  reasons (binary missing, provider unregistered, provider unready, profile deleted, agent failed to
  come up) and reports `degradedReason`; `RuntimeManager` additionally swallows anything that escapes.
  A running server the user can reach on the LAN beats no server. Verified for the last four paths.
- **A tunnel is a descriptor, not a handle** — `~/.local/state/mctl/network/<id>.json`, the exact
  analogue of `runtime/<id>.json`, re-probed and reaped on every read. Verified end to end: `mctl start`
  in one process brought a real cloudflared quick tunnel up, a *separate* `mctl network status` named
  it, and `mctl stop` from a third killed the agent and removed the descriptor.
  - **`pid` is optional and its absence must not mean "dead".** `direct` and `tailscale` announce an
    address with no process behind them; a naive "no live pid ⇒ reap" erases them on the next read.
    Pinned by a test.
- **Three mechanics make a detached agent real** (`lib/shell.spawnDetached`), and all three are load-
  bearing: `detached: true` (its own process group, so Ctrl-C on MCTL does not take the tunnel),
  `unref()` (MCTL can exit), and stdout/stderr on a **file descriptor** rather than a pipe — a pipe
  dies with the parent and no other instance can read it. `node:child_process` is used because
  `Bun.spawn` has no detach option.
- **The address is scraped from the agent's own output because none of these agents can be asked.**
  Hence a durable capture file per server, and hence `AgentSpec.match` being the only genuinely
  provider-specific part of starting a tunnel. Real shapes, worth not re-deriving:
  - **cloudflared** quick tunnel prints `https://<words>.trycloudflare.com` (matched on the URL, not
    the ASCII box around it, which has changed between releases). A *named* tunnel prints no address
    at all — wait for `Registered tunnel connection` and take the hostname from the profile.
  - **cloudflared TCP is not directly joinable.** Cloudflare terminates TLS at the HTTPS edge; every
    **player** must run `cloudflared access tcp --hostname <host> --url localhost:<port>` and then
    join `localhost`. This is the product, not a bug, and it reads as a broken tunnel if unsaid — so
    it rides on `Endpoint.note` and is printed by both front-ends.
  - **ngrok** needs `--log stdout --log-format logfmt` or it draws a full-screen UI and prints nothing
    parseable; the line is `msg="started tunnel" … url=tcp://4.tcp.eu.ngrok.io:19132`. The HTTP form
    must **not** match — that tunnel is not joinable.
  - **playit assigns addresses on its dashboard, not in its output.** So `options.address` is the
    supported path and `AgentSpec.fallback` exists for it: an agent that is alive but silent is kept,
    not killed for failing to say something it was never contracted to say.
  - **tailscale owns no per-service tunnel.** The machine is already on the tailnet, so `expose` only
    discovers `Self.DNSName` (trailing dot stripped — the MC client rejects the FQDN form) and
    reports it. `tailscale status --json` is answered by the **local daemon**, so unlike the tunnel
    agents its auth state is cheap to check; a logged-out node exits non-zero but still prints usable
    JSON, so the exit code is ignored and only a parse failure means "no answer".
- **The Cloudflare DNS module's load-bearing safety property is the `comment` tag.** Records are
  tagged `mctl:<server id>` and **only tagged records are ever deleted** — a user's own `A` record on
  the same hostname and another server's records both survive. Tested against a real local stand-in
  API with exactly those two decoys present.
  - Filtering happens **locally** after listing the zone, not through the API's `comment` filter,
    which is not on every plan. `proxied` defaults false and must stay there: the orange cloud speaks
    HTTP(S) and would make a Minecraft server unreachable rather than protected. An IP is an `A`, a
    tunnel hostname must be a `CNAME`.
  - This bypasses `lib/http.ts` deliberately — that helper is an ETag cache for public GETs, and
    caching an authenticated response into `~/.cache/mctl/` would be wrong on both counts.
- **Secrets are scoped by provider id prefix** (`scopedSecrets`: `ngrok` sees `NGROK_*` and nothing
  else), and travel in the child's **environment**, never argv — a command line is world-readable in
  `/proc`. The UPPER_SNAKE secret-key convention is what makes the prefix rule exact.
- **`flexGrow`/`flexBasis` on a section inside a column parent overlaps the text** — the Network page
  hit exactly the trap `memory.md` already recorded for the Dashboard's expanded panel, and rendered
  as garbage on its first pty run. Sections size to content; only the two *halves* grow, and only
  when laid out as a row.
- **Delete now tears networking down first** (both front-ends). `deleteServer` refuses a running
  server, so this only ever cleans a stopped one — but a `direct` descriptor outlives a stop and would
  otherwise keep answering `mctl network status` for a server that no longer exists.

## The console renders ANSI now (2026-08-13, real defect)

User: "The ansi part of the line is not being rendered properly." Seen on
`my-first-neoforge-server` — 62 of its 143 captured lines carry escapes.

- **Modded servers colour their output; vanilla and Paper do not.** NeoForge/Forge run log4j with a
  console appender that emits SGR, so a captured line is
  `\x1b[32m[03:21:16] [main/INFO] …\x1b[m`. OpenTUI draws into a **frame buffer**, so escape bytes in
  a `<text>` child are painted as the literal characters `[32m` — colour has to arrive as styled
  child nodes (`<span fg=… attributes=…>`) instead. There is no ANSI parser in `@opentui/core`
  (`stringToStyledText` only wraps a plain string); `ansi.d.ts` is an *emitter*, not a parser.
- **`lib/ansi.ts` (new leaf) parses, `components/AnsiText.tsx` (new) paints.** The split is the
  layering rule doing real work: the parser yields *neutral* colours (`{kind:"index"}` /
  `{kind:"rgb"}`) and the component maps an index onto the **theme's semantic roles** — green→
  `success`, yellow→`warning`, red→`error`, per log4j's default pattern. A literal `#00ff00` would be
  the one thing on screen ignoring the user's theme. Indices 16–255 *are* fixed (the xterm cube /
  grey ramp, `xterm256Hex`) and are used literally, as is a 24-bit colour.
- **Three parsing facts that were each found in the real capture, not guessed:**
  - **`CSI m` with no parameters means reset.** It is how log4j ends every coloured line; reading it
    as "no change" leaves every following line stuck in the previous colour.
  - **A carriage return must be *armed*, not applied.** The tmux capture stores the pty's CRLF and
    the echo of a typed command arrives as `\x1b[m> stop\r\r`, so "a CR erases the line" blanks real
    lines. The rule that works: the *printable text after* a CR overwrites; a CR with nothing after
    it erases nothing. Mid-line `\r\x1b[K` (prompt redraw before a log line) then works out right.
  - **Tabs must be expanded here** (8-column stops). OpenTUI renders `\t` as **two** cells, so a Java
    stack trace's `\tat …` continuation lines lost their alignment. That is why the fast path is
    `needsParse` (escape *or* tab *or* CR), not "has an escape".
- **`lineColor` classifies the *stripped* line** — an escape before the `#` defeated the JVM
  crash-banner test — and is only the default for runs the line does not colour itself.
- **The console's rows are a memoised `ConsoleLine`.** Up to 2000 of them, re-rendered every 100 ms
  while a server boots; without the memo every row re-classified and re-parsed its text each time.
  `AnsiText` is memoised for the same reason and takes a plain-string fast path.
- Verified under tmux at 150×45 against the user's real NeoForge capture: zero escape residue across
  all 143 lines, INFO lines painted `#3fb950` (github-dark `success`), `> stop` intact, stack-trace
  indentation restored. `mctl logs` in a terminal is deliberately untouched — there the escapes are
  correct output.

## Phase 3 — loaders, installers, the tmux runtime (2026-08-12)

- **A launch spec is now *data on disk*, not just a provider's answer.** `MctlJson.launch`
  (Zod-validated, hence `LaunchSpec` moved from a bare TS type to a schema in `types/install.ts`)
  records what an install *produced* when the kind cannot imply it. Forge is the reason: its argfile
  path is `libraries/net/minecraftforge/forge/<mc>-<forge>/unix_args.txt`, which embeds the loader
  version, and `ServerProvider.launchSpec(dir)` only receives a directory.
  - **How to apply:** `RuntimeManager` uses `server.launch ?? provider.launchSpec(path)`. A new kind
    with a generated layout returns it from `resolveInstall().produces`; it does **not** go looking
    on disk at start time.
- **Forge/NeoForge 1.17+ ship no runnable jar at all.** Verified by running the real installer:
  `java -jar forge-installer.jar --installServer` generates `run.sh`, `user_jvm_args.txt` and the
  argfile above, whose contents for 1.21.4 are `-jar forge-<ver>-shim.jar`. Launching the *installer*
  jar re-runs the installer instead of starting a server. `run.sh` is `java @user_jvm_args.txt
  @libraries/…/unix_args.txt "$@"` — which is why the `script` launch spec must write the heap flags
  into `user_jvm_args.txt` rather than passing them on the command line.
  - The executor **verifies the prediction and falls back to `run.sh`** if the argfile is not where
    the provider said. Cheap insurance against an upstream layout change; the alternative is a JVM
    usage dump at the user's first Start.
- **`sleep 0.2; exec …` in the tmux launch line is two fixes, not a hack.** Both were real:
  - The command must be **given to tmux**, never `send-keys`'d into the pane. Typing it into the
    user's *interactive* shell put the launch at the mercy of that shell — observed: zsh's first-run
    configuration wizard swallowed the keystrokes and the pane held `xec '…/java'` (leading `e`
    eaten) → `command not found`. tmux hands its command string to `/bin/sh`, so no rc file runs.
  - **`exec` keeps the pid** (it replaces the shell in place), so `pane_pid` *is* the JVM's pid. Read
    it immediately after `new-session` — same number before and after the exec. Without `exec`,
    every liveness probe would report a dead server as running while its shell lived.
  - The **`sleep` exists because `pipe-pane` captures only what is printed after it attaches**, and a
    server that dies instantly prints its only useful line before that.
- **tmux removes `SessionNotOwnedError`** — `exec`/`stop` go through a *named* session, so any
  instance can drive the console. Verified: `say` from a second `mctl` process reached the server,
  and a `stop` from a third brought it down gracefully in 1.1 s.
- **Quilt's meta service publishes a WRONG sha256.** `meta.quiltmc.org/v3/versions/installer` says
  `2bd88a14…` for installer 0.15.1; the artefact is `0a229138…`, and Maven's own
  `…/quilt-installer-0.15.1.jar.sha256` sidecar agrees with the artefact. MCTL correctly refused the
  install until the provider was changed to read the **sidecar** instead.
  - **How to apply:** for a Maven-hosted artefact, prefer `<url>.sha256` over a digest copied into
    some other service's index. The repository verifies uploads against the sidecar; the index is a
    copy that can rot.
- **Quilt is an `installer`, Fabric is a `loaderJar`** — they only look alike. Quilt has no
  `/server/jar` route (404) and ships a CLI installer whose **`--install-dir=.` is mandatory**:
  without it the default is a `server/` *subdirectory* (verified by running it). Fabric's
  `/v2/versions/loader/<game>/<loader>/<installer>/server/jar` builds a launcher on demand, publishes
  no digest, and downloads the game on **first boot** — so a fresh Fabric directory looks nearly
  empty and its first start needs network.
- **Upstream shapes worth not re-deriving:** Forge and NeoForge have **no versions API** — both mavens
  are Reposilite, so `…/api/maven/versions/releases/<group path>` returns `{versions: […]}`
  oldest-first (`maven-metadata.json` 404s; the `.xml` exists). Forge's versions are the composite
  `<mc>-<forge>`, split on the **first** hyphen only. NeoForge encodes the Minecraft version in its
  own: three parts → `1.<a>.<b>` (a `0` minor dropped), **four** parts → Minecraft's calendar version
  `<a>.<b>.<c>` (a `0` patch dropped) since MC 26.1. Purpur's v2 API returns build numbers as
  **strings** and publishes **MD5 only** (hence `md5` in `lib/download.ts`).
- **`ServerProvider.javaRequirement` for every loader is Minecraft's own**, via the new shared
  `providers/server/mojang-meta.ts`. That module exists specifically so Fabric/Quilt/Forge/NeoForge
  do not import `VanillaProvider` — a shared *upstream client* beside the providers is not the
  provider→provider dependency the rule forbids, and the rule's purpose (a backup provider must not
  reach into a runtime) is untouched.
- **A Java `{pinned}` must not trigger resolution at create time.** Adding one broke
  `manager.test.ts` by timing out (it tried to fetch a JDK). The rule: a pin *is* the answer; it is
  only *located* when an installer has to be run with it.
- **Hand-kept option lists rot silently.** Four existed (create form kinds, create form runtimes,
  wizard Defaults, Settings) and three still said "Vanilla only" a whole phase later. Kinds/runtimes
  in `ServerCreate` now come from the **`ProviderRegistry`**; the two *defaults* pickers share
  `app/choices.ts`, typed `Record<ServerKind, …>` so a new enum member is a **compile error** rather
  than a quietly missing entry. The wizard cannot use the registry — it runs before there is a config.
- **`Bun.file().writer()` truncates**, so it cannot append: a resumed download uses a `node:fs`
  handle opened `"a"`. A resumed transfer must also **re-hash the bytes already on disk** (they were
  written by a previous process), and must treat a `200` answer to a `Range` request as "start over"
  — appending a full body to a partial file is how you get a corrupt jar that fails its digest.

## Keyboard: rings skip disabled, modals own the keyboard, focus is drawn (2026-08-12, user request)

User: "Tab cycle is not properly done everywhere. Focused areas are not well highlighted (Tabs).
Disabled buttons are also acquiring tabs."

- **`useFocusRing` takes `FocusItem = string | {id, disabled?}` and a `{enabled}` option.** Two rules
  now hold everywhere:
  - **A disabled member is never focused** — `next`/`prev` step over it, `setFocus` refuses it, and a
    member that *becomes* disabled hands focus to the next enabled one. Expressing it as a flag rather
    than by omitting the id is deliberate: omission renumbers the ring under the user's fingers, and
    the disabled condition is live data (a running server, a clean form) that changes between renders.
    An all-disabled ring reports `focus === undefined`, which is a legitimate state, not a bug.
  - **Only one ring may listen at a time.** Every mounted ring installs a `useKeyboard` handler and
    OpenTUI delivers a key to *all* of them, so a page ring and a dialog ring both moved on one Tab —
    the page's focus travelled *behind* the modal. Whichever ring is not interactive passes
    `{enabled: false}`; it keeps its focused id and only stops moving.
  - **How to apply:** a ring member's `disabled` must be the *same expression* as its Button's
    `disabled` prop. Drift between the two is exactly the bug this fixes.
- **`hooks/use-modal.tsx` is the input capture's sibling, and `Dialog` raises it itself.** Same counted
  shape (`ModalProvider` in `App.tsx` beside `InputCaptureProvider`, `useModalOpen(active)`,
  `useModalsOpen()` getter, `useIsModalOpen()` reactive). **The difference that matters: `Esc` is NOT
  exempt here.** A text field cannot consume Esc, so the capture leaves it to the shell; a modal
  exists to consume it. Before this, **one Esc in a confirmation dialog closed the dialog *and* quit
  the app** (verified in tmux), and a digit navigated to another page behind the overlay.
  - Because `Dialog` calls `useModalOpen(open)`, every modal in the app is covered without its caller
    remembering — put new modals in a `Dialog` rather than hand-rolling an absolute overlay.
  - The shell swaps its whole global hint set for `Tab / Enter / Esc close` while a modal is up; a
    page whose own hints would contradict that (the Server page's `←→ switch tab`) stands them down.
- **A tab that owns a modal must tell its container**: `ServerTabProps.onModal` exists for the Players
  tab's action dialog, because only the tab knows its modal state and only the container owns the ring.
- **Focus is now *drawn*, not implied by a colour shift.** One vocabulary, three places, none of which
  costs a row or shifts layout:
  - `Tabs` — the active pill's **left padding cell is rendered as text**, so `icons.caret` can occupy
    it when the bar holds the ring without changing `tabWidth` (which the rule segment beneath is
    aligned to). Unfocused, the pill is blended toward the background (`mix(primary, background,
    0.62)`); focused it goes to full accent. The heavy/light rule stayed.
  - `Button` — a focused button gets an `alpha(accent, 0.18)` wash *only when the state colours left
    the background empty*, plus a BOLD label. A borderless `ghost`/`small` chip previously differed
    from rest by a colour shift alone, which is invisible unless you know to look.
  - `FormField` — **reverted 2026-08-14**: the label used to become `▸ Label` while focused; the user
    called it "awful" and it is gone. The border and title colour carry focus on their own.
  - `Button` also treats `focused` as false while `disabled`, so a page that forgets to update its ring
    cannot make a dead button look live.
- Rings audited and given disabled members: Server (start/stop/restart/remove + its delete dialog,
  Cancel first so Enter on arrival is the harmless one), Settings (Revert/Save — a clean form now
  cycles three stops, not five), ServerCreate (Create, plus **Cancel joined the ring** — it was
  mouse-only), the setup wizard's DataRoot (Continue) and Review (Create while committing), and the
  player action menu (actions needing a running server).
- **`PlayerActionsDialog` is now two components, one per stage.** A closed dialog has no stage mounted,
  so "every open starts at the top of the menu" falls out of the tree instead of needing an effect to
  reset an index — and exactly one ring listens for Tab. The menu's arrows and Tab are the same
  movement (it is a wrapping grid, so "the one above" has no meaning).
- **`mockInput.pressKey("tab")` types the letters t-a-b.** Use `mockInput.pressTab()`; Shift-Tab has no
  helper — send the raw `\x1b[Z` (CSI Z), which is how terminals actually spell backtab and why the
  hook handles both `tab+shift` and `backtab`. A ring test also needs a **settle** (render → sleep →
  render) before reading a frame, like every other rendered-frame test here.
- **Pre-existing, still failing, NOT keyboard-related:** `nerd.heartFull` / `heartEmpty` / `foodFull` /
  `foodEmpty` in `core/icons/catalogue.ts` carry a **trailing space**, so they are two cells and break
  the catalogue's single-cell invariant (`core/icons/detect.test.ts` fails on `nerd.heartFull`, on
  `master` too). Left alone because the space may be a deliberate spacing choice for the user's Nerd
  Font — but the health/food meters are 20 cells wide in `nerd` mode, not 10.

## The player card was redesigned to a wireframe (2026-08-12, user request)

- **The card is six interior rows, always**: four beside the 4-row head (name + status, playtime,
  last position, game mode + kills/deaths) and two full-width meters (health, food) under it.
  A player with no `playerdata` on disk still draws six rows — it says "No player data on disk"
  plus a blank line — because **one taller card makes the whole grid row ragged**.
  - Only *standing* (`OP`/`WL`/`SHADOW`) rides the border now, on the **top** border right-aligned;
    the name moved into the body because it shares its row with the player's status and a border
    side holds one run of text. Game mode is no longer a badge — it names line 4.
- **Every body `<text>` needs `truncate wrapMode="none"`.** OpenTUI text *wraps* by default, and a
  wrapped line grows the card by a row: the position line (`Last Position: Overworld(-2, 56, 105)`,
  ~37 cells) turned a 36-wide card into 10 rows instead of 8. `overflow="hidden"` on the parent does
  **not** prevent the wrap, it only clips what the wrap produced. `truncate` gives a *middle*
  ellipsis (`Last Posit..., 56, 105)`), which is the app's existing convention (Settings, Form).
- **A `flexGrow` spacer eats its siblings unless they are `flexShrink={0}`.** The meter row is
  caption + icons + spacer + percentage; without the guard yoga took the row's slack out of the
  caption and the icons and the meter rendered as a **blank gap** between `Health:` and `50%`.
  Same rule as the `Tabs`/`NavRail` segments.
- **Meters are ten discrete icons, not a `ProgressBar`** — that is how the game's own HUD draws them.
  Ten icons cannot express 20 half-units (a whole heart is two points), so the exact percentage is
  printed at the card's right edge. `meterFill` biases both ends the way `ProgressBar` does: a live
  player never shows an empty meter, and one point short of full never shows a full one.
  - New icons `heartFull`/`heartEmpty`/`foodFull`/`foodEmpty`. **No food emoji**: 🍖/🍗 are
    East-Asian Wide and the catalogue bars two-cell glyphs, so unicode food is `▰`/`▱`.
- **`PlayerCard` is exported and `Players.test.tsx` mounts it** (6 tests). The suite must **not**
  hardcode `♥` — `useIcons` without a provider resolves `auto` off the *runner's* environment, and
  a Nerd Font terminal renders PUA hearts that look like blanks in a captured frame (which is how
  the first run's failures read as "the meter renders nothing"). It resolves the same set the
  component will and builds the expected run from that.

## Player heads are real skins now (2026-08-08, user request)

- **`core/skins/` fetches a player's actual skin and crops the head; `skinFor` is the fallback,
  not the source.** The chain is **Mojang → TLauncher → Ely.by**, in that order, and it is a
  *fallback chain, not a search*: Mojang is authoritative for a licensed account, and the other two
  only know their own (offline-mode launcher) users — exactly the population Mojang cannot answer
  for. An offline-mode server has players in all three groups at once.
  - **A miss is the normal answer, not an error.** Two of three sources 404 on nearly every lookup,
    so `SkinSource.fetchSkin` returns `undefined` and never throws. **Ely.by rate-limits hard** —
    it served a skin on the first request of the session and then `500`d every request for minutes.
    Treat any non-200 as "not my player" and move on.
  - **Mojang is two hops and needs the *name* fallback, not just the uuid.** `sessionserver`
    `/session/minecraft/profile/<uuid>` returns `204` for an **offline-mode uuid** (a locally
    derived v3 uuid Mojang has never seen), so the source also resolves the name through
    `api.mojang.com/users/profiles/minecraft/<name>`. Verified: a fabricated uuid for a name that
    *is* a real account still resolved its skin. The skin URL arrives base64'd inside a `textures`
    property and is spelled `http://textures.minecraft.net/...` — the same host serves https.
  - No `SKIN` in the textures payload means a default Steve/Alex; MCTL draws its own built-in
    rather than fetching Mojang's copy.
- **Misses are cached, and that is the load-bearing part.** The Players tab re-reads every 5 s; with
  no negative entry, twenty offline-mode players would be 60 upstream requests per poll and all
  three sources would start refusing MCTL. `~/.cache/mctl/skins/<sha256(key)>.json` holds the
  resolved face for 24 h and an absence for 6 h; in-flight lookups are deduped by key. Measured:
  first lookup ~3.7 s, cached 3 ms, cached miss 0 ms.
- **The head is a *crop*, not a downscale.** Every skin — legacy 64×32 and modern 64×64 alike — puts
  the front of the head at (8,8)–(16,16) and its hat overlay at (40,8)–(48,16), which is already
  exactly the 8×8 grid `MinecraftHead` renders. HD skins (128×128, …) are the same layout at an
  integer scale and sample the **centre** of each scale×scale block: nearest neighbour, never an
  average, because Minecraft art is flat colour blocks and averaging smears the eyes into mud.
  - **The hat layer is a mask, not a blend** (`alpha >= 128` wins outright). Real skins use 254 for
    "opaque"; blending would render no skin the way its author drew it.
  - **A test fixture skin must have a *transparent* hat layer.** An all-opaque synthetic texture
    renders every face as a black square, which is how the first four head tests failed.
- **`lib/png.ts` is a hand-rolled decoder, no dependency.** ~150 lines for inflate + unfilter +
  expand covers every colour type and bit depth; **Adam7 interlacing throws** rather than decoding
  wrongly. Cross-checked byte-for-byte against an independent Python implementation on jeb_'s real
  skin. `Buffer.concat` over multiple `IDAT` chunks is required — real encoders split them.
- **`HeadSkin` (palette + 8×8 code grid) lives in `types/skin.ts`** and is now the single face
  shape: the built-ins in `SKINS` and a fetched face are the same type, so `MinecraftHead` takes
  `MinecraftSkin | HeadSkin`. Zod-validated on the way out of the cache — a face referencing a
  missing palette code would paint `undefined` into the frame buffer. 64 pixels ⇒ at most 64
  distinct colours ⇒ the 64-char code alphabet is exactly enough (pinned by a test).
- **`faceSignature()` is exported for one reason: the draw effect must key on face *content*.** A
  fetched face is a fresh object every poll, so keying on identity rebuilds every frame buffer on
  screen several times a minute. Palette keys are sorted into the signature — code order is an
  artefact of extraction order, not of the picture.
  - **This cannot be tested through the renderer.** `createRoot(renderer).render()` called twice
    *remounts* the component (`useId` goes `_r_0_` → `_r_1_`), so a "did not rebuild" assertion
    fails for reasons that have nothing to do with the component. Test the pure signature instead.
- **`usePlayerHeads` never blocks a card.** A card draws its built-in face immediately and swaps
  when a real one arrives; lookups are capped at 64 players, 4 concurrent, attempted once per
  session, and skipped entirely below the 84-cell head threshold.

## Minecraft 26.1 moved the per-player files (2026-08-08, real defect)

- **The Players tab showed every card as "no player data" on a 26.2 server.** Minecraft **26.1**
  regrouped the world's per-player directories under a single `players/`:

  | | ≤ 25.x (and every 1.x) | ≥ 26.1 |
  |---|---|---|
  | player data | `<world>/playerdata/` | `<world>/players/data/` |
  | statistics | `<world>/stats/` | `<world>/players/stats/` |
  | advancements | `<world>/advancements/` | `<world>/players/advancements/` |

  The **file formats are unchanged** — the NBT decoder and the stats reader needed nothing. Only the
  paths are version-dependent, and `core/server/players.ts` hardcoded the old two.
- **`resolvePlayerDirs(worldDir)` (exported, in `players.ts`) detects the layout by directory
  existence, not by version.** `mctl.json.minecraftVersion` records what MCTL *installed*, not what
  last opened the world, and a world carried across an upgrade keeps whichever layout wrote it — so
  the version string is not a reliable discriminator. A never-booted world resolves to the legacy
  paths and reads as empty, which is the same answer either way.
  - **How to apply:** any future read of a per-player file goes through `resolvePlayerDirs`, never
    `join(worldDir, "playerdata")`. `<world>/datapacks/` did **not** move (`inspect.ts` is fine).
- **`.dat_old` is why `readDirIfExists(dataDir, ".dat")` must keep its extension filter.** The server
  writes one beside every save; a looser match doubles every card and keys the copy by a uuid ending
  in `_old`. Pinned by a test.
- Verified against the user's real 26.2 Paper server: both players now render playtime, deaths,
  health, hunger, game mode, position and distance, and "seen" resolves off the data file's mtime.

## The Players tab became a real screen (2026-08-08, user request)

- **Per-player data comes from three places the server writes, none of them a roster count.**
  `core/server/players.ts` (`readPlayers`) merges five sources into one `PlayerProfile[]`:
  `usercache.json` + the four roster files (ops/whitelist/banned-players/banned-ips),
  `<world>/stats/<uuid>.json` (playtime, deaths, kills, distance, blocks mined), and
  `<world>/playerdata/<uuid>.dat` (**gzipped NBT** — health, hunger, XP, game mode, dimension,
  position), plus the live ping sample for "who is online".
  - **`lib/nbt.ts` is a new leaf helper** — a read-only NBT decoder (no writer, deliberately: MCTL
    never modifies world data). Gzip/zlib is detected by **magic number**, not by the caller.
    64-bit tags decode to `bigint` (a Paper `LastSeen` is a ms timestamp and does not survive a
    double); `nbtNumber` narrows at the point of use.
  - **A `TAG_List` of `TAG_End` is how an empty list is written** and its declared length must not
    be trusted — the first thing that breaks a naive decoder on a real inventory.
  - Stat units are not what they look like: `play_time` is **ticks** (÷20 for seconds), every
    `*_one_cm` is **centimetres** (their *sum* is total distance travelled), and `damage_dealt` is
    **tenths** of a half-heart. `play_one_minute` is the pre-1.13 name of `play_time` and also
    counts ticks.
  - **Detail reads are capped at 64 files** (online players first, then most recent), because a
    long-lived public server has thousands of `playerdata` files and each is a read + a gunzip.
    `PlayerRoster.detailsTruncated` says so in the UI.
- **Merging is by uuid *or* lower-cased name, and must never re-key.** `banned-players.json` can
  carry a name with no uuid (an offline-mode ban), and a `playerdata` file carries a uuid with no
  name — one player, two identifications. A later source may *adopt* a uuid the first lacked, but
  the map key stays put or earlier references break.
- **Every action is a console command; MCTL never edits the server's rosters.** Two reasons, both
  load-bearing: `mctl.json` is the only file MCTL owns in a server directory, and **a running
  server holds those rosters in memory and rewrites them**, so an edit underneath it is simply
  overwritten. Consequence: **actions need the server running**, `PlayerActionDef.needsRunning`
  says which, and the UI disables the rest rather than failing them.
  - `feed`/`heal` are **not Minecraft commands** (they are Essentials'), so they are expressed as
    `effect give … saturation` / `instant_health` and work on a plugin-free vanilla server.
  - **`gamemode <mode> <player>` — the argument order is reversed** relative to every other command
    here. Pinned by a test; getting it backwards targets a player named "creative".
  - Commands are emitted **without** a leading `/` (a console takes bare commands).
- **Shadow ban is an MCTL-side marker, not a feature — Minecraft has no such thing.** Recorded in
  `mctl.json.shadowBans` (`ServerManager.editServer({shadowBans})` + `.shadowBans(id)` to read),
  it changes the badge on a card and **nothing on the server**. The dialog and the success toast
  both say so. `TODO(phase-5)`: real enforcement needs RCON or a plugin.
- **What is genuinely unavailable and is *stated* rather than faked:** per-player ping and current
  session length. The list ping publishes neither; `status.latencyMs` is MCTL's own round trip and
  the summary labels it `"… ms to MCTL"` for exactly that reason.
- **A gap on a `flexWrap="wrap"` row is a cross-axis gap too.** The summary strip left a blank line
  between its wrapped rows at 52 cells until the gap came off and each item carried its own
  trailing separator.
- **The card grid is chunked by hand**, not left to wrap, and cards are **fitted, not fixed**: the
  pure `fitCards(available, minimum)` takes as many columns as fit at the minimum
  (`CARD_MIN_WIDTH_WITH_HEAD = 36`, nine less without a head) and then widens every card to an equal
  share of the row — two columns are half each, three a third. **Heads are dropped below 84 cells**
  (a head is 8 cells). See the redesign entry at the top of this file for the card's own layout.
  - **`available` is the *measured* interior of a `Section`, not the terminal width.** `Section`
    wraps its children in a box it measures with `useBoxWidth` and reports through `onWidth`; only
    the layout engine knows what the shell frame, the tab padding, the section border and the
    scrollbar already took. The terminal-derived `width - SECTION_CHROME` is a deliberately narrow
    first-frame fallback (measuring returns 0 until yoga's first pass — a reported 0 is ignored).
    Every section is the same width, so only the always-rendered *Online* one reports.
  - **Leftover cells are left unused rather than handed to one card**: a row where one card is a
    cell wider than its neighbours reads as a rendering fault. Verified under tmux at 140/100/84/83/
    70/60 — 3 columns of 43 exactly filling 131 cells at 140, 2 at 84, 1 at 60, no overflow at any
    width.
- **The tab joins the container's focus ring (`PLAYERS_ID`)**, same shape as the console's command
  line, so ←/→ reach the tab bar whenever the grid does not hold focus. When it *does*, the tab
  registers `←→` as a **context hint with the same key signature** the container uses for "switch
  tab", which replaces that entry instead of contradicting it.
- **`skinFor(seed)` (FNV-1a over uuid) is deterministic, not random.** The roster re-reads every
  five seconds; a genuinely random head would change face on every poll and read as a glitch.
- Verified under tmux at 140/74/52 columns against a fabricated `$HOME` (8 players, real gzipped
  NBT, a real list-ping responder): cards, badges, bars, the action menu's `applies` filtering, a
  shadow ban written to `mctl.json` and reappearing as a badge, and a kick correctly failing with
  the foreground runtime's `SessionNotOwnedError`.

## The `console` route is gone (2026-08-08, user request)

- **A server's console is reachable only from the Server page's Console tab.** `RouteId` no longer
  has `console`; `Router.tsx` lost the case, the import, the `OWN_SCROLL` entry and the title, and
  the Dashboard lost its `c` shortcut (plus the hint and the expanded row's key line). `NavRail`
  lights the Dashboard tab for `server`/`create` only.
  - **Why:** the same output had two homes, and the standalone route said nothing the tab does not —
    a console makes no sense addressed without the server it belongs to.
- **`ConsoleView` moved to `app/Server/ConsoleView.tsx`** and `app/Console/` is deleted. The move was
  free on imports (`src/app/Console/` and `src/app/Server/` are the same depth); only
  `Server/tabs/Console.tsx` changed its specifier. A folder named after a page that no longer exists
  is a trap for the next agent, which is why the file moved rather than staying put.
- `hooks/use-console.ts` is untouched and still the single bridge to `RuntimeManager`; the CLI's
  `logs`/`exec` are unaffected — they were never the route's peers, they are the console's.

## One hint strip, contributed to from anywhere (2026-08-07, user request)

- **The strip is rendered exactly once, in `Router.tsx`.** Every page now *registers* its shortcuts
  through `useHints` (`hooks/use-hints.tsx`) instead of drawing a `Hint` of its own — the shell's
  strip plus a page's strip meant the same keys appeared twice and could contradict each other.
  `Hint`/`HintItem` in `components/` are unchanged (still pure UI); the hook is the new layer above.
  - **Rule going forward: a page must never render `<Hint>`.** The only remaining callers are the
    setup wizard (`Welcome`, `WizardFooter`), which lives *outside* the router and has no strip to
    merge into. `useHints` is deliberately inert without a provider, so the wizard is safe either way.
- **Merge is by key signature, not label** (`keySignature` joins multi-key hints, so `["Ctrl","S"]`
  and `"Ctrl+S"` are one key). Scope order `context` → `page` → `global`, first occurrence wins ⇒ a
  page *overrides* a shell hint on the same key rather than adding a second: `ServerCreate` turns
  `Esc back` into `Esc cancel` without knowing what the shell said.
- **`when: "idle" | "typing" | "always"` (default `always`) centralises the typing rule.** The shell
  used to swap its own strip on `useIsCapturing()`; now the *provider* filters, so character
  shortcuts (`q`/`t`/digits/`c`/`n`) vanish the moment any text field captures, on every page, for
  free. The shell's global set has **no** typing hints left — moving through a form is the page's
  keyboard, not the shell's, and a global `Tab next field` read as nonsense on the Console route.
- **Hints follow the focus ring, not just the route** — that is the part worth copying. Settings only
  advertises `←→ group` while the ring is on the tab bar (elsewhere ←/→ are the text cursor) and only
  advertises `Ctrl+S save` while a save would actually do something; the Server page swaps its whole
  set for `Enter send command` when the ring sits on the Console tab's command line.
- **Two contexts on purpose** (`RegisterContext` stable + `ItemsContext` reactive): with one, every
  contributing page would re-render each time any hint changed — which is on every focus move.
  Registrations live in a **ref** keyed by serial id with a counter in state as the change signal; a
  `Map` in state would make the registering effect feed its own dependency.
- **`useHints` compares `items` by value (`JSON.stringify`)**, so callers need no `useMemo`. Requiring
  one would be a trap that fails as an infinite re-register loop rather than a type error.
- `composeHints` is pure + exported and covered by `hooks/use-hints.test.ts` (7 cases) — including
  the one non-obvious interaction: a hint suppressed by `when` frees its key for a lower scope.

## Server page became a tabbed multi-screen page (2026-08-07, user request)

- **`src/app/Server/` is now a container + nine tab bodies**, not one file. `tabs.ts` holds the tab
  model (`ServerTabId`, `SERVER_TABS` with a label *and* a one-line description), `panels.tsx` the
  shared presentation vocabulary (`Panel`/`Detail`/`Meter`/`EmptyNote`/`Columns`, `LABEL_WIDTH`,
  `TWO_COLUMN_WIDTH`, `ServerTabProps`, `javaLabel`), and `tabs/*.tsx` one screen each.
  - **Adding a screen is three edits:** a row in `SERVER_TABS`, a file under `tabs/`, a `case` in the
    container's switch. The `ServerTabId` union makes a missing case a *compile* error, not a blank
    screen — same trick `executeInstall` uses for install strategies.
  - The container fetches `useServer` + `useServerInsight` **once** and passes `{server, insight,
    size}` down; no tab does its own I/O or polling.
- **Route `server` joined `OWN_SCROLL`** — header, action bar and tab bar are pinned chrome and only
  the tab body scrolls. `TAB_OWNS_SCROLL` (currently just `console`) is the same rule one level down:
  the Console tab pins a command line under its own scrolling pane, so the container hosts it in a
  plain box. Never nest one page scrollbox inside another.
- **A pinned 1-row action bar MUST carry `flexShrink={0}`.** Found in a pty at 74×24: the tab body is
  `flexGrow`, so yoga shrank the button row **to nothing** and the Start/Stop buttons silently
  vanished at small terminal sizes while rendering fine at 120×40. The identity header has the same
  guard now. Check this on any page that pins a short row above a growing one.
- **`ConsoleView` lives at `app/Server/ConsoleView.tsx`** and the Console tab is its only host (see
  the console-route entry at the top of this file).
  - **Its key capture follows `focused`, not mounting** (`useCaptureKeys(focused)`). The standalone
    page passes `focused` always; inside the Server page the ring owns it, so ←/→ still reach the tab
    bar when the ring is elsewhere. Verified in a pty: typing `say 3 hi` in the tab inserts the `3`
    instead of navigating to Backups, and the shell's hint strip flips to typing hints.
  - `onLineCount` is reported from a `useEffect`, not the render body — the host stores it in state,
    and setting a parent's state while rendering a child is the update-during-render React refuses.
- **Every `Detail` label must fit `LABEL_WIDTH` (13).** `"everything else"` overflowed the padded
  column and pushed its value out of alignment on the Content tab; renamed to `"rest"`.
- **Tab focus ring:** `[TABS_ID, ...actions, CONSOLE_ID?]` — the tab bar is first so ←/→ switch tabs
  the moment the page opens, and the console's command line joins the ring only while its tab is
  active. Same shape as Settings' per-group ring.
- **The Console *button* is gone from the action bar** — the Console tab replaced it.
- **What each tab is honest about, deliberately:** Backups says "Phase 4" and shows the configured
  policy (resolved through `resolveRootPaths`, so an unset `backups_dir` shows the real default);
  Network shows the direct picture and says tunnels/DNS are Phase 4; Settings is read-only and prints
  the `mctl edit` commands that do change these values; Performance names TPS/MSPT, heap occupancy
  and network I/O as unmeasurable rather than leaving gaps.
- **Performance keeps a session-local sample window** (last 60 readings → min/avg/peak), reset when
  the pid changes. It is a derived observation of this page's own polls, never persisted, and does
  not violate statelessness — every reading still comes from a fresh probe.

## Server inspection + responsive Table (2026-08-03, user request)

- **Everything a server "is doing" now comes from `core/server/inspect.ts`**, the read-only twin of
  `discover.ts`: `inspectServer(server)` (cheap tier) and `measureSize(server)` (expensive tier).
  Sources: `server.properties`, the four roster JSONs, `mods/`+`plugins/` jar counts, a procfs
  sample, and a **Server List Ping**. Nothing cached; re-derived per call like everything else.
  - **The tiers are split because their costs differ by orders of magnitude.** Cheap ≈ 250 ms
    (dominated by the CPU sample, below); the directory walk is thousands of `stat`s. The hook polls
    them at 4 s and 60 s respectively.
- **Live player count comes from the Minecraft Server List Ping, not RCON** (`core/server/ping.ts`).
  It is the protocol the vanilla multiplayer screen uses, so it needs no op, no credentials, and no
  config, and it works for every server kind. 1.7+ JSON status path only; a pre-1.7 server just
  drops the handshake and reports as "not responding".
  - **`socket.on("end")` is load-bearing, not belt-and-braces.** With a `data` listener attached the
    socket is in flowing mode, and a peer that sends FIN without replying leaves it half-open —
    `"close"` does not fire until the timeout, so listening for `close` alone stalls every probe of a
    booting server by the full 2 s. Found by the test that hangs up immediately.
  - MOTD arrives as a bare string, `{text}`, or a `{text, extra:[…]}` tree; all three are flattened,
    and legacy `§x` codes are stripped (they render as mojibake in a terminal). `server.properties`
    strips them too, but keeps the original in `properties.raw`.
- **CPU% is sampled twice ~220 ms apart** (`lib/proc.ts`), because a single cumulative
  `/proc/<pid>/stat` reading can only yield a *lifetime average* — useless on a server up for hours,
  which is exactly when you look. `/proc/<pid>/stat`'s fields are split from after the **last** `)`
  (the comm field can contain spaces and parens). Non-Linux falls back to `ps -o rss=,%cpu=`, which
  *is* a lifetime average — hence the `cpuIsLifetimeAverage` flag. On Linux an unreadable
  `/proc/<pid>` means "dead", so it does **not** fall through to `ps` (that spawned a child per
  stopped server).
- **What is deliberately NOT shown, and why:** TPS/MSPT (needs RCON `/tps` or a mod), per-server
  network traffic (the kernel exposes no per-process socket byte counters), and JVM heap
  *occupancy* (needs JMX). The Resources panel says so in a row rather than leaving a gap — a
  mysterious absence reads as a bug. `memory` is RSS against the *configured* heap.
- **`components/Table.tsx` is the new responsive table** and the first user of `layoutColumns`, which
  is pure and exported. **A terminal row cannot reflow**, so responsiveness is column *dropping*:
  natural widths → drop by `priority` (lowest first, rightmost among equals, `required` never) →
  distribute the leftover to `flex` columns, iteratively so a column hitting its `max` hands its
  share back → last resort, shed from the right until even one cell per column fits.
  - **The invariant the tests pin: the widths plus gaps never exceed the available width**, at every
    width from 1 to 200. A row that overflows by one cell wraps and destroys the alignment.
  - **`max` on a flex column is not cosmetic.** Without it the id column ate every spare cell on a
    140-wide terminal and the row read as one name in a field of whitespace. The Dashboard caps id
    at 24 and gives the real slack to a low-priority `motd` column, so a wide terminal shows more
    information rather than more padding.
  - **A `scrollRows` table must reserve a cell for the scrollbar** (`SCROLLBAR_RESERVE`, matched by
    the header's `paddingRight`). The scrollbox draws it *inside* its own width, so without the
    reserve the rows sit one cell left of the header — and only once the list outgrows the viewport,
    i.e. a misalignment that appears out of nowhere.
- **`flexGrow`/`flexBasis` share the parent's MAIN axis.** The three groups in the Dashboard's
  expanded panel carry them only when laid out as a row; keeping them in the stacked (column) layout
  made the groups fight over the panel's *height* and rendered as **overlapping text**. `DetailGroup`
  takes a `columned` prop for exactly this.
- **`useBoxWidth` moved out of `Form.tsx` into `components/use-box-width.ts`** (Table needs it too).
  Same rule as before: attach the ref on every render path, never gate the measured element behind
  the branch the measurement decides.
- **`dashboard` joined `OWN_SCROLL`** so the tiles and the column header stay pinned while the rows
  scroll. A table whose header scrolls away is unreadable past one screen of servers.
- Dashboard tiles: the `unavailable` tile is rendered **only when non-zero** (it is 0 for every
  healthy fleet and cost a tile to say nothing), the resource tiles drop below 112 cells, and its
  label shortens to `missing` below 76 — measured thresholds, from the width at which the label
  wraps and grows the whole strip by a row.
- The players tile counts slots of **responding** servers only; summing every stopped server's
  `max-players` advertised a fleet capacity nobody could join.
- **`formatDuration` caps at two units and drops the hours past 100 days** — nine cells would not fit
  the 8-cell uptime column. Column widths are a real constraint on the humanizers, and the test
  asserts it.

## Dashboard absorbed the Servers screen (2026-08-03, user request)

- **There is no Servers page any more.** `src/app/Servers/` is deleted and the `servers` route is gone
  from `RouteId`/`NAV`; the Dashboard is the summary **and** the server table. Rail digits renumbered
  to **1–5** (Dashboard/Jobs/Backups/Network/Settings) — the shell's hint strip (`1 … 5`) and every
  `navigate("servers")` call site (`Server`, `ServerCreate`) moved with it.
  - **How to apply:** nothing may navigate to `"servers"`; go to `"dashboard"`. `NavRail` lights the
    Dashboard tab for the rail-less routes (`server`/`create`), not just `server`.
- **Selection *is* the expansion** — the selected row renders a detail panel directly beneath itself
  (left-border accent, two columns + path + a key hint). No separate expand/collapse key: one panel is
  open at all times, so the page cannot grow into a wall of detail and there is no second piece of
  state to keep in sync with the selection.
- **A mouse click on an unselected row selects it; a click on the selected row opens it.** That makes
  the pointer agree with the keyboard (Enter opens the row the caret is on) instead of the old
  list's click-always-navigates, which would have made the expansion unreachable by mouse.
- **Recent activity was dropped** (user: "I don't think we need any section for Recent Activity").
  `hooks/use-recent-events.ts` had no other consumer and was deleted with it — `events.jsonl` is the
  cross-instance sync mechanism, not a user-facing log.
- The full `server` detail page **stays** (Enter): it owns the lifecycle action bar and the delete
  confirmation. The inline panel is read-only by design — duplicating the action bar into a list row
  would mean a second focus ring competing with the row selection.

## Stack & direction

- **Stack is TypeScript + OpenTUI on Bun**, not Rust/Ratatui. The Rust plan's *architecture* (provider
  separation, filesystem-as-truth, event bus, jobs) carries over; the language and crate layout do not.
  UI is React-style via `@opentui/react`.
- Use the **`opentui` skill** before any TUI work. No Rust/Ratatui skill is in play.
- Dependencies today: `@opentui/core`, `@opentui/react`, `react` 19. Bun runtime; `bun run dev` only
  script so far. Codebase is still the starter template.

## Phase 1 implementation decisions (2026-07-25)

- **Zod is v4** (`zod@4.x`). In v4, `z.object(...).default({})` type-checks the argument against the
  schema's **output** type, so `.default({})` fails when nested fields have their own defaults. Use
  **`.prefault({})`** (input-side default) for composite sections instead — see
  `types/config.ts` (`defaults`/`backup`/`network`).
  - **How to apply:** for any object field whose sub-fields all have defaults, wrap with `.prefault({})`,
    not `.default({})`.
- **Config JSON key naming:** `servers_dir` and `backups_dir` stay **snake_case** because `plan.md`
  documents them verbatim as `config.servers_dir` / `config.backups_dir` (a published contract).
  Everything else in config is camelCase (`configVersion`, `defaultProfile`, …). Intentional exception,
  not drift.
- **Secrets + env override convention:** secret keys are **UPPER_SNAKE** (e.g. `CLOUDFLARE_TOKEN`); the
  env override is `MCTL_<KEY>` (`MCTL_CLOUDFLARE_TOKEN`). `loadSecrets()` overlays *all* `MCTL_*` env
  vars except a reserved set (`MCTL_LOG_LEVEL`). `secrets.json` is written `0600` and the mode is
  re-`stat`'d and enforced after writing.
- **Logger writes to a FILE, never stdout** (`~/.local/state/mctl/logs/mctl.log`) because OpenTUI owns
  the terminal in TUI mode — console output corrupts the render. Level via `MCTL_LOG_LEVEL`. Pino
  `redact` masks credential keys as defence-in-depth (real rule: don't pass secrets to the log at all).
- **argv dispatch uses lazy `import()`** in `src/index.tsx` so the CLI path never loads OpenTUI and the
  TUI path never loads the CLI router.
- **CLI stubs are honest:** unimplemented commands print "not implemented yet (Phase N)" and exit 1 —
  no silent no-ops. `help`/`version` are the only real commands so far.
- `renderApp()` in `app/App.tsx` owns renderer creation + mount; `index.tsx` stays a pure dispatcher.

## First-run wizard + `mctl init` (2026-07-25)

- **Focus is page-owned via `useFocusRing(ids)`** (`hooks/use-focus-ring.ts`) — OpenTUI has no global
  focus manager, so a page tracks the active control id and cycles it. **Tab / Shift-Tab** move the ring
  (handle both `name:"tab"`+`shift` *and* a distinct `name:"backtab"`); the hook exposes
  `isFocused/setFocus/next/prev`. Convention: pass `focused={ring.isFocused(id)}` + `onFocused={()=>ring.setFocus(id)}`
  to each control, and `<Input onSubmit={()=>ring.next()}>` so Enter advances fields. This is THE focus
  primitive for pages going forward (Dashboard/Settings reuse it). Ring `ids` may change between renders
  (conditional fields) — index is clamped, so a step whose ids depend on a toggle (`PathsStep`,
  `BackupStep`) just recomputes the array.
  - **How to apply:** buttons already own their Enter/Space (guarded by `focused`), so the ring needs no
    button-key logic — just give the focused Button `focused` + `onClick`.
- **Wizard = welcome splash + 6 steps** in `src/app/setup/` (`SetupWizard.tsx` container). Container owns
  the `SetupDraft` (a **flat view model**, NOT the config shape — paths carry explicit override toggles,
  optional fields are "" = use default), the step index, and stage keys (**Enter begins on welcome only;
  Esc quits from welcome, else steps back**). Steps are self-contained: each owns its ring + renders its
  fields + a `WizardFooter`. Container renders `<box key={step}>` so each step **remounts fresh** (ring
  resets to field 0).
- **The wizard's only I/O is `useSetup().commit`** (`app/setup/use-setup.ts`): `draftToConfig` (pure,
  also used by the Review step to preview) → `writeConfig` (Zod fills defaults + validates) →
  `writeSecrets({})` (empty 0600) → `ensureDirTree`. Pages never call `core/config` directly; only this
  hook does. `commit` carries the **current `themeId`** into config so a theme cycled during setup sticks.
- **App routing:** `renderApp()` decides `firstRun = !(await configExists())` once and passes it to
  `<App firstRun>`. `App` renders `<SetupWizard onComplete={()=>flip}>` until setup writes config, then
  the `Dashboard` placeholder — **in-place, no restart**. The old MinecraftHead demo grid is gone.
- **`mctl init` mirrors the wizard headlessly** (`cli/commands/init.ts`, lazy-imported from the router).
  Flags map 1:1 to draft fields; unset → schema defaults (so bare `mctl init` writes a full default
  config at `~/.mctl`). `--force` to overwrite, `--json`, `--help`; unknown flag → exit 1. Validation is
  the schema's job (bad kind/relative root → typed `ConfigValidationError`), not the parser's.
- **Logger flipped to `sync: true`** (`lib/logger.ts`): a fast-failing CLI command's `process.exit`
  (index.tsx:19) tore down the **async** sonic-boom stream before its fd opened → "sonic boom is not
  ready yet" stack dump on stderr. Sync file writes remove the race; volume is tiny and it's never the
  render path, so sync is fine. (Supersedes the earlier `sync:false`.)
- **`ascii-font` font names** are `tiny | block | shade | slick | huge | grid | pallet` (from
  `@opentui/core/lib/ascii.font.d.ts`). Welcome hero uses `font="block"` with a 2-colour gradient
  (`color={[primary, secondary]}`). `<ascii-font>` colours via `color`, not `fg` (already in gotchas).
- **`lib/fs.diskFree(path)`** walks up to the nearest existing ancestor before `statfs` (the chosen root
  usually doesn't exist yet) → `{free,total}` bytes; `undefined` on failure (never throws). `useDiskFree`
  hook debounces it 150ms. `lib/format.formatBytes` humanizes (binary units, "—" for non-finite).

## Phase 1 completion — registry, session, events, router (2026-07-26)

- **`core/server/discover.ts` is THE shared server read path** — `listServers(serversDir)` /
  `getServer(id, serversDir)` combine registry + each `mctl.json` + a live session probe into
  `Server` view models. Both the CLI (`list`/`status`) and the TUI (`useServers`/`useServer`) call
  it, so neither front-end holds logic the other lacks. **Read-only**; the mutating `ServerManager`
  (create/delete/edit + install strategies) is Phase 2. Re-derived from disk every call — no cache.
  - One bad server never breaks the list: unreadable/invalid `mctl.json` or missing path → a minimal
    `unavailable` view model (kind/mc/etc = "—"), not a throw.
- **`types/server.ts`:** `MctlJson` is a **`z.looseObject`** (unknown/future keys preserved so a
  server made by a newer MCTL survives a read round-trip). `RuntimeSession` (`runtime/<id>.json`) and
  the `servers.json` file schemas are strict `z.object`. `ServerState` = `running|stopped|unavailable|
  unknown`. The `Server` **view model is a plain TS interface** (derived), not Zod — `state`/`available`
  are computed, never stored.
- **Session probe (`core/session/session-manager.ts`):** liveness via `process.kill(pid, 0)` —
  no-throw or `EPERM` = alive, `ESRCH` = dead. `probe(id)` reaps dead/invalid/corrupt descriptors so a
  crashed server never lingers "running". `reapStaleLocks()` sweeps `runtime/*.lock` whose owner pid is
  dead (lock body is JSON `{pid}` or a bare int); called once in `renderApp()` before any read. tmux/
  docker session-existence check is a `TODO(phase-3)` — pid is the only signal today.
- **Event system (`core/events/`), 4 files + barrel:**
  - `EventBus` (EventEmitter3, single `"event"` channel, `emit`/`subscribe→unsub`/`clear`).
  - `INSTANCE_ID` = one `randomUUID()` per process (not persisted; identity is per-run).
  - `publish(bus, type, payload)` = **append to `events.jsonl` + emit locally**; the tail then skips
    lines whose `instance === INSTANCE_ID`, so an instance never double-processes its own events.
  - `startTail(bus)` records the current EOF and re-emits only *new remote* lines (no history replay);
    `fs.watch` for immediacy + a 1 s poll fallback; detects truncation by size shrink.
  - **Watchers watch DIRECTORIES, not files** (`configDir`/`stateDir`/`runtimeDir`) — atomic writes
    (`temp+rename`) change the inode, so a file-bound watch goes stale after the first write. They emit
    **local-only** `ConfigChanged`/`RegistryChanged`/`ServerStateChanged{id}` (not `publish` — the
    change was already made by whoever caused it). Debounced 60 ms per filename.
  - `startEventSystem()` → `{ bus, stop }`, wired in `renderApp()`; `EventBusProvider` injects the bus.
    Stopped on the renderer's `"destroy"` event.
  - **Wizard/`init`/Settings config writes need no explicit emit** — the config-dir watcher fires
    `ConfigChanged` automatically, so `useConfig`/`useServers` refresh. (True only since the
    2026-07-27 temp-name fix below; before it the watcher never fired at all.)
  - `MctlEvent` envelope (`types/events.ts`): `{v,id,ts,instance,type,payload}`. `type` is an **open
    string** (forward-compat: an unknown event type from a newer instance must not break the tail);
    `EventType` is a reference object, not a closed union.
- **TUI Router (`src/app/`):** in-memory router (no URL). `hooks/use-router.tsx` = `RouterProvider` +
  `useRouter()` (route + params + `navigate`/`back`/`canBack`, with a back-stack). `app/routes.ts` =
  `RouteId` + `NAV` (dashboard/servers/jobs/backups/network/settings, digits 1–6; `server` detail is
  NOT in NAV — reached from Servers with a `serverId` param). `app/Router.tsx` = the shell (top bar +
  `NavRail` + page host + `Hint` strip) and owns the **global keyboard**: digit→route, `Esc`=back-else-
  quit, `q`=quit, `t`=cycle theme. `App.tsx` renders `<AppRouter/>` post-setup.
  - **Digit-nav (plus `q`/`t`) is gated by the input capture** — see the 2026-07-27 entry above. The
    `TODO(phase-1)` in `Router.tsx` is resolved and gone.
  - Real pages: `Dashboard` (summary tiles + the server table with an expanding selected row —
    see the Dashboard entry at the top of this file), `Server` (detail + lifecycle actions via
    `useServer`), `Settings` (**editable config form**). `Jobs`/`Backups`/`Network` = honest
    `Placeholder`.
  - **NavRail is a horizontal tab bar, not a left rail** (redesigned 2026-07-26 to a user-supplied
    reference): a 2-row scrollbox — tabs on row 1, the rule on row 2 — whose active tab is a **solid
    pill** (`backgroundColor: colors.primary`, ink `onAccent(colors)`, BOLD) and whose inactive tabs
    are `colors.muted`, lifting to `colors.foreground` on an `alpha(foreground, 0.12)` wash. The digit
    prefix is DIM off the pill and `mix(onAccent, primary, 0.55)` on it.
  - **The rule is per-tab `<text>` segments, NOT a `border={["bottom"]}`** — only the segment under the
    active tab is accented, and a border paints one colour for its whole side. Two rules keep the rows
    aligned: (1) `tabWidth(item)` is the single width source, set as an explicit `width` on **both** the
    tab box and its underline text; (2) every segment is `flexShrink={0}`. Without (2) yoga shrank the
    segments (their total + the tail exceeds the viewport) and the accent came out 9 cells under a
    13-cell tab. The rule reaches the right edge via a tail `<text>` **sized from
    `useTerminalDimensions().width`** minus the cells the tabs consume (a `<text>` can't stretch, so it
    must be counted out), inside a `flexGrow` + `overflow="hidden"` box. Deliberately an *over*estimate
    — the terminal width ignores the shell frame's inset, and surplus is clipped, whereas undershooting
    leaves a visible gap before the right border. Re-renders on SIGWINCH (verified by resizing a pty).
    - **Tabs are deliberately NOT `Button`s.** `Button` colours its label from its own variant matrix
      and only when `children` is a plain string, so a chip needing *two* inks (dim digit + label) with
      a *muted* resting look has no matching kind — the local `NavTab` owns its hover state instead.
    - The **screen name rides the shell's top border** (`title` + `titleAlignment="right"`, the
      reference's "Request" placement) and the brand rides `bottomTitle` — neither costs a row. The
      old commented-out top-bar block in `Router.tsx` is gone; `titleFor(route)` now feeds the title.
  - Data hooks (`hooks/`): `use-servers` (`useServers`/`useServer`), `use-config`,
    `use-event-bus` — all re-run the core read path on invalidating bus events, holding no authoritative
    state. `use-event-bus`/`use-router` are `.tsx` (they hold JSX providers).
- **`lib/http.ts` — ETag cache** (Phase-1 tail; first real use is Phase-2 downloads). One JSON file per
  URL under `~/.cache/mctl/api/<sha256(url)[:32]>.json` = `{url,etag,lastModified,fetchedAt,body}`.
  Within `ttlMs` (default 5 min) serves cache with **no** network call; else conditional GET
  (`If-None-Match`/`If-Modified-Since`), `304` refreshes the timestamp, `200` restores body+validators.
  Serves **stale on network failure**; throws `HttpError` only when nothing is cached. `fetchJson`
  returns `unknown` — caller Zod-validates.

## Phase 1 tail — editable Settings, key capture, log rotation (2026-07-27)

- **Bun's `fs.watch` reports a rename under the SOURCE name only** — the destination
  never appears. Our atomic writes are temp+`rename`, so `config.json` / `servers.json`
  writes produced **no** matching watch event and the hard-state watchers were silently
  dead (the earlier note claiming "the config-dir watcher covers wizard/init writes" was
  wrong — it never fired). Verified on Bun 1.3.14.
  - **Fix:** `lib/fs.writeFileAtomic` now names its temp file after the target —
    `.<basename>.<pid>-<rand>.tmp` (`tempNameFor`) — and `core/events/watch.ts` maps it
    back with `targetOfTempName()` before filtering. Debouncing keys on the resolved
    target, so the temp-write and the rename coalesce into one event.
  - **How to apply:** never filter watch events by a bare filename again; go through
    `targetOfTempName(name) ?? name`. `src/core/events/watch.test.ts` is the regression
    guard (ConfigChanged / RegistryChanged / ServerStateChanged + a negative case).
- **Global character shortcuts are gated by an input capture**, not by page identity.
  `hooks/use-input-capture.tsx` = `InputCaptureProvider` (mounted inside `RouterProvider`,
  above `AppShell`) + `useCaptureKeys(active)` for pages + `useKeysCaptured()` for the
  shell. Capture is a **count**, and `isCaptured` is a **getter** — a `useKeyboard`
  handler closes over its render, so a boolean would go stale. `Esc` is deliberately
  exempt (it can't be part of what's being typed); digits/`q`/`t` stand down while a text
  field owns the ring. The hint strip swaps to typing hints via `useIsCapturing()`.
  - **How to apply:** any future page with a text input calls
    `useCaptureKeys(ring.focus !== undefined && TEXT_FIELDS.has(ring.focus))`.
- **Settings is the wizard's peer, not its clone.** `app/Settings/use-settings.ts` owns a
  flat `SettingsDraft` (no `root` — permanent) + `configToDraft`/`draftToConfig`/
  `validateDraft` (pure, unit-tested) and commits with `writeConfig` → `ensureDirTree`
  (a relocated `servers_dir` must exist immediately). `draftToConfig` is **merge, not
  replace**: it spreads the loaded config so `backup.schedule`/`retention`, named
  `network.profiles`, and future keys survive an edit. Edits are buffered; **Ctrl+S** or
  Save writes; the watcher's `ConfigChanged` then refreshes every instance.
  - The buffer follows the file while clean and is never clobbered while dirty — tracked
    by an `adopted` ref holding the last serialization taken off disk.
  - **Theme is NOT in the draft.** The theme provider owns it and persists on change, so
    the Settings theme picker applies instantly (like `t`); a save just carries the
    currently-active id.
- **`events.jsonl` rotation exists now** (`trimEventLog`, log.ts): >512 KB ⇒ rewrite the
  last ~128 KB of *whole* lines atomically. Called once in `startEventSystem()` before the
  tail records its offset, and opportunistically from the tail's drain. The tail's
  shrink branch now **resumes at the new end** (`offset = size`) instead of restarting at
  0 — restarting replayed the surviving history into the activity feed.
- **`FormField` painted the literal string `undefined` on its bottom border** when no
  `hint` was passed (`bottomTitle={` ${hint} `}`). Only showed up once a page used
  hint-less fields (Settings' checkboxes). Now conditional.

## Settings grouped into tabs + a pinned action bar (2026-07-31)

- **A page whose chrome must stay put cannot live inside the shell's scrollbox.** `Router.tsx` now
  keeps a set `OWN_SCROLL: ReadonlySet<RouteId>` (currently just `"settings"`): those routes are
  hosted in a plain `<box flexGrow={1} flexDirection="column" padding={1}>`, everything else keeps
  the scrollbox. The host is what gives such a page a **definite height**, which is what lets an
  inner `<scrollbox flexGrow={1}>` know when to scroll.
  - **How to apply:** any future page with pinned chrome (a toolbar, a console input row, a wizard
    footer) adds its route to `OWN_SCROLL` and puts a scrollbox around its *scrolling region only*.
    Don't nest a page-level scrollbox inside the shell's — the outer one has no definite height for
    the inner one to resolve against.
- **Settings is `PageHeader → Tabs → scrollbox(panel) → action bar`.** Groups are Locations /
  Defaults / Backups / Network / Appearance (`GroupId`, `GROUPS`). The panel is `key={group}` so
  switching tabs remounts it and scroll starts at the top.
  - The **focus ring is per-group**: `ringIds(group, draft)` = `[__tabs, …visible fields…, __revert,
    __save]`. `TABS_ID` is first, so the ring starts on the tab bar and ←/→ switch groups
    immediately. Conditional fields (path inputs, backup provider/compression) are still added by
    their toggle — `useFocusRing` clamps its index, so this stays safe.
  - **A validation issue on a hidden group would be invisible** (Save disabled for no visible
    reason), so `GROUP_OF_ISSUE` maps each validatable draft field to its group and the offending
    tab's label gets a trailing `" !"`. Add an entry whenever `validateDraft` learns a new field.
  - Section headings were **dropped** — the active tab already names the group; only the muted
    description line remains. The `Written to <config path>` footnote became a `ReadOnlyRow` in
    Locations rather than a page-bottom line (the action bar owns that row now).
  - Action-bar buttons are `size="small" kind="ghost"` (1 row, no border). **`size="small"` +
    `kind="outline"` is unusable**: its focused/hover recipe sets `fg: onAccent` with **no**
    background, so the label vanishes into the page. Small chips must be `ghost` (which does fill).
- **`Tabs` was restyled to `NavRail`'s language (2026-07-31, user request)** — one tab vocabulary in
  the app, not two. Same 2-row scrollbox: `|` separators, active tab a **solid pill**
  (`backgroundColor: primary`, ink `onAccent`, BOLD), inactive `muted` lifting to
  `alpha(foreground, 0.12)` on hover, and a per-tab rule row with `╸`/`╺` caps around the active
  segment plus a counted-out tail run to the right edge. `tabWidth(item) = 1 + 2*pad + label.length`
  is the single width source, set as an explicit `width` on **both** rows, every segment
  `flexShrink={0}` (see the NavRail entry above for why both are load-bearing).
  - **Keyboard focus is still the underline weight** (`━` focused, `─` not) *plus* the accent
    blending toward the rule when unfocused (`mix(primary, rule, 0.75)`). The pill is unchanged by
    focus, so "which tab is active" stays legible when the ring is elsewhere. A border or background
    would cost a row or fight the pill.
  - Tabs carry **no digit hint** (unlike NavRail) — page tabs have no digit shortcut.
  - Optional **`initials` prop** = NavRail's brand slot: a short accent caption before the first tab
    (rendered as `` `${initials} ` ``). Settings passes `"Settings"`.
  - Optional **`paddingX` prop** insets the *tabs row only* — the rule row is deliberately not inset,
    so it spans the page like a divider. **Pad with this prop, never with a wrapper box**: a wrapper's
    padding pushes the rule in too (Settings' wrapper lost its `paddingX={1}` for this).
  - `leadCells = paddingX + caption.length` is the one number tying it together: it is drawn as a
    plain rule run at the start of row 2 *and* subtracted from the tail. Miss either and the rows
    stop lining up.

## Toasts — component + provider (2026-07-31)

- **Two files, split on the pure-UI line.** `components/Toast.tsx` is rendering only (`ToastCard`,
  `ToastViewport`, `wrapText`, `TOAST_ICONS`, `SPINNER_FRAMES`); `hooks/use-toast.tsx` is the
  scheduler (`ToastProvider` + `useToast`). The card can be rendered with no timers running, which
  is what makes it testable.
- **`ToastProvider` is mounted at the ROOT in `App.tsx`, not in `Router.tsx`** — it renders its
  viewports as *siblings of `children`*, and a viewport is `position="absolute"` against its parent,
  so "parent" must be the screen. Mounting it at the root also gives the setup wizard toasts.
  - **`InputCaptureProvider` moved up to `App.tsx` too** (it was inside `RouterProvider`), so the
    toast layer sits *below* it and a toast's `action.key` can stand down while a text field is
    being typed into. `Router.tsx` still reads the capture through context — nothing else changed.
  - The ticker (`tick` state, 100 ms, only while a spinner/meter is on screen) re-renders the
    provider but **not** `{children}`: the children element reference is stable across the
    provider's own state updates, so React bails out of that subtree. Animation is not an app-wide
    re-render.
- **Viewports are content-sized, never full-screen.** A full-screen overlay would sit over the page
  and eat its mouse events (`Dialog` does exactly that *on purpose*). Centred positions set `left`
  **and** `right` and centre their children, since a content-sized box can't centre itself.
- **Overflow queues, it does not evict.** `visible` keeps `slice(0, maxVisible)` per position
  (oldest first) and a queued toast has **no countdown until it reaches the screen** — a burst of
  five toasts loses none. Slicing `-maxVisible` (newest-wins) was the first cut and is wrong here:
  an evicted toast would later reappear when the newer ones expired.
- **Countdowns live in a ref, not state** (`Map<id, {timer, expiresAt, remaining, paused}>`), and a
  `useEffect` reconciles them against the visible list. Keeping `expiresAt` in state would make the
  effect that starts the timer feed its own dependency and loop.
- `remove()` **dedupes by id** (`removed` ref): a countdown can fire in the same frame the user
  clicks the card, and `latest.current` only refreshes on the next render — without the guard
  `onDismiss` fires twice.
- **Terminal text does not reflow** — `wrapText(text, width, maxLines)` does it by hand and marks
  truncation with `…` rather than dropping words. Unit-tested in `components/Toast.test.ts`.
- **`useEffect(() => raise(toast), [])` silently breaks**: the arrow returns the toast *id*, which
  React takes as a cleanup function ("destroy is not a function"). Always brace the body.
- **`Settings.save` now resolves `string | null`** (the failure message) instead of a boolean — the
  toast needs the message itself, and `saveError` state is stale in the closure right after the
  await. Settings' `commit()` toasts success (with the config path) or failure (with a `r` Retry
  action).
- Rendering is verified for real, not just in state: `hooks/use-toast.test.tsx` mounts the provider
  in `createTestRenderer` + `createRoot` and asserts on `captureCharFrame()` — TTL expiry, delay,
  sticky, queueing, description, and `mockInput.pressKey` driving an action key. That combination
  (`@opentui/core/testing` + `@opentui/react`'s `createRoot`) works and is the pattern to reuse for
  any future component test that needs a live React tree.

## ProgressBar styles & variations (2026-07-31)

- **The glyph table is the whole visual vocabulary.** `PROGRESS_STYLES: Record<ProgressBarStyle,
  ProgressGlyphs>` in `components/ProgressBar.tsx` holds `{fill, empty, partials?}` for
  `blocks | smooth | shaded | line | smooth-line | dots | segments | ascii`. Adding a style = one row
  there; nothing else in the component branches on the style name.
- **Sub-cell precision is `partials`, and `n` partials mean `n + 1` steps per cell.** `smooth` carries
  the seven eighth-blocks `▏▎▍▌▋▊▉` (U+258F..U+2589) → eighths; `smooth-line` carries the single
  `╸` (U+2578 HEAVY LEFT) → halves, because that is the *only* sub-cell step the heavy rule `━` has
  in Unicode. Styles without `partials` round to whole cells.
  - Consequence for tests: the "an unfinished bar always leaves an empty cell" rule holds for
    whole-cell styles only; a sub-cell style can occupy every cell and still read as unfinished
    because its last glyph is a partial. Assert `!filled.endsWith(fill)` there instead.
- **Layout maths is exported and pure** — `fillGlyphs(fraction, width, glyphs)`,
  `indeterminateGlyphs(frame, width, glyphs)`, `thresholdVariant(fraction, base, thresholds)`. That is
  what makes the component testable without a renderer (`components/ProgressBar.test.ts`). The
  invariant every test leans on: **the runs always total the track width**, at every fraction and
  every frame — a short run would shift the layout around it.
- **Rounding is deliberately biased at both ends:** a non-zero fraction always inks ≥1 cell (a started
  download must not look idle) and a fraction < 1 never fills the last cell (only "done" looks done).
  This slightly changes what the toast TTL meter draws near its ends; that is intended.
- **`value` + `max` replaced the bare fraction**, with `max = 1` so every existing caller (Toast) is
  unaffected. `readout` = `none | percent | fraction`; `format` overrides it. `showPercent` is kept as
  a `@deprecated` alias for `readout="percent"` because Toast and the first callers were written
  against it — the destructure raises a TS *hint* (6385), not an error.
- **An indeterminate bar drives its own frame counter** (`setInterval` at 12 fps in the component)
  unless the caller passes `frame`. This is the one place a component in this kit owns a timer; it is
  UI-only animation, and the state lives on the bar so an animating bar never re-renders the page.
  Callers that already have a ticker (the toast provider) should pass `frame` instead, exactly like
  `ToastCard`'s `spinner` prop.
- **`thick` cannot mean a taller cell** — a terminal has no cell height — so it renders a second row
  of `▄` beneath the track in the same runs. With `brackets` on, that row starts with a leading space
  to stay aligned under the `[`.
- Verified by rendering all styles through `createTestRenderer` + `createRoot` and reading
  `captureCharFrame()`. **A preview script must `renderOnce()` → `await Bun.sleep(…)` → `renderOnce()`
  again**: one render returns a blank frame (React's commit hasn't reached the renderer yet). Also
  `console.log` is swallowed under OpenTUI — write the frame to a file with `Bun.write`.

## Measuring a renderable's width (2026-07-31)

- **A renderable's `width` is 0 until yoga lays it out**, which happens on the render loop's next
  frame — *after* React's effects. So an effect can only seed the value and then listen. The event a
  **child** renderable emits is **`"resize"`** (`Renderable.onResize`, fired from `updateFromLayout`
  only when the computed size actually changes). Do not confuse it with `"resized"` (emitted by the
  **root** renderable with `{width,height}`) or the `CliRenderer`'s `"resize"` (the terminal itself).
- **The ref must be attached on EVERY render path.** `Select` measured its `FormField` to decide
  tabs-vs-dropdown but passed `ref` only in the *tabs* branch — and the branch starts at `w = 0`
  (⇒ dropdown), so the ref was never attached, the listener never installed, and a flex-sized
  (`width="100%"`/`"auto"`) Select was **stuck as a dropdown forever**. Self-reinforcing: the width
  that would flip the branch is exactly the width that is never observed.
  - **Fix:** `useBoxWidth(ref)` in `components/Form.tsx` (module-local), and `Select` now renders
    **one** `FormField` with the ref always attached, branching only on its *child*.
  - **How to apply:** never gate the measured element behind the condition the measurement decides.
    Measure the stable wrapper, branch inside it.
- **Falling back to the `width` prop while unmeasured** (`measured || (typeof width === "number" ?
  width : 0)`) means a fixed-width Select picks its layout correctly on frame one and never flips.
  Only a flex-sized one starts as a dropdown and switches when the real width arrives.
- **`console.log` is swallowed under OpenTUI** — it is not a debugging channel here (and CLAUDE.md
  bans stdout writes outright). Use `lib/logger.ts` or write a captured frame to a file.

## Phase 2 — providers, Java, install, foreground runtime (2026-08-03)

### Upstream APIs (verified live this session)

- **PaperMC v3 is served from `fill.papermc.io`, NOT `api.papermc.io`.** The legacy host fronts v2
  and its Cloudflare rules reject unknown clients outright (an HTML challenge page, not a 4xx), so a
  v3 path there looks like a schema failure rather than a wrong host. Endpoints used:
  `/v3/projects/paper` (versions grouped by minor line, an **object** — insertion order is the only
  ordering signal), `/v3/projects/paper/versions/<v>` (→ `version.java.version.{minimum,maximum?}`),
  `/v3/projects/paper/versions/<v>/builds/latest` (→ `downloads["server:default"]` with a **sha256**).
  - The artefact key is `server:default`; a build without it is not a runnable server (error, not a
    fallback). Builds carry a `channel` (`STABLE`/`ALPHA`) which `latest` does not filter — logged.
- **Mojang is two hops:** `version_manifest_v2.json` → per-version package JSON at piston-meta, which
  holds `downloads.server {url,sha1,size}` **and** `javaVersion.majorVersion`. Two consequences:
  `downloads.server` is **absent before 1.2.5**, and `javaVersion` is a **floor with no max** (so
  Vanilla reports `{min}` only). Mojang publishes **sha1**, Paper **sha256** — `lib/download.ts`
  hashes both in one pass and checks whichever was supplied.
- **Adoptium** `/v3/assets/latest/<major>/hotspot?architecture&image_type=jdk&os&vendor=eclipse`
  returns an **array**; `binary.package.{link,checksum,size}`. Every Temurin archive has exactly one
  top-level dir, so extraction needs `tar -xf … --strip-components=1` or the managed JDK lands one
  level too deep for `detect.ts`.

### Java selection

- **`LTS_MAJORS = [25, 21, 17, 11, 8]`, and an unbounded requirement is capped at the newest LTS.**
  `{min: 21}` with only a system Java **26** present resolves to *nothing installed* and fetches
  Temurin 25 rather than launching on 26. This is not theoretical: launching Paper 1.21.4 on Arch's
  Java 26 booted fine but **segfaulted in Paper's bundled `libasyncProfiler.so` during shutdown**
  (`Recording::finishChunk`). Exception to the cap: `requirement.max` from upstream always wins, and
  a `min` above the newest LTS raises the ceiling to `min` (else nothing would be valid).
- **A bare `java: N` in `mctl.json` is a *preference*, `{pinned: N}` is *authoritative*.** The bare
  form keeps a server on the JVM it was resolved with so a newly installed JDK doesn't silently
  change it; the pinned form is never re-derived and is installed on demand if absent.
- **Detection runs `java -XshowSettings:properties -version` on every candidate** and reads
  `java.version`/`java.home`/`java.vendor` off **stderr**. Directory names lie (`java-17-openjdk`
  symlinked to 21, `$JAVA_HOME` upgraded in place). Java 8 reports `1.8.0_412` — the major is the
  *second* component. Probes are memoized per exe path, including **failures** (`cache.has()`, not a
  truthiness check), and the cache is cleared after an install.

### Statelessness under Phase 2

- **Console capture lives in `~/.local/state/mctl/console/<id>.log`, not the server dir.** Two
  reasons: MCTL owns exactly one file inside a server dir, and the capture must be readable by *any*
  instance — `mctl logs -f` from a second terminal tails the same file the TUI shows. Truncated on
  start (a follower must not replay the previous run's shutdown). New path helpers `consoleDir()` /
  `consoleLogFile(id)`.
- **The foreground runtime's one real limitation: `exec` only works from the owning process.** A Unix
  pipe has no name, so a second instance cannot reach the child's stdin → typed
  `SessionNotOwnedError` rather than a silently dropped command. Everything else *is* cross-instance:
  `status` probes the descriptor, `logs` tails the shared file, and `stop` sends **SIGTERM** to the
  recorded pid — which Minecraft's shutdown hook handles by saving the world, so a foreign stop is
  still graceful (verified: 7.4 s, clean save).
- **`withServerLock(id, fn)` (`core/session/lock.ts`) uses `open(path,"wx")`** — the atomic
  check-and-create; a `pathExists` + write pair would race. A lock whose owner pid is dead is
  **reclaimed**, not respected, or one crash wedges a server until the next startup sweep.
- **`JobScheduler` holds jobs in memory, and that is not a violation.** A job is this process's own
  in-flight work with no on-disk form (like a pending promise); what it *produces* is the durable
  part. `JobProgress` is **local-bus only** (it fires ~10×/s and would rotate `events.jsonl` away in
  seconds); only `JobFinished` is `publish`ed cross-instance.

### Design decisions worth remembering

- **`mctl.json.kind` was relaxed from the `ServerKind` enum to `z.string().min(1)`.** The
  authoritative list of kinds is the runtime `ProviderRegistry`; duplicating it in a schema would
  make a server created by a newer MCTL parse-fail and show as *unavailable* instead of "this build
  has no `fabric` provider". `config.defaults.kind` keeps the enum — it only bounds a **picker**.
- **`eula.txt` is the one deliberate exception to "MCTL writes only `mctl.json`".** Written **once,
  at create, only on explicit opt-in**, into the *staging* dir; never read, rewritten, or deleted
  after. Without it an opted-in create produces a server that refuses to boot.
- **Deviations from `plan.md` § Runtime, both documented in `types/provider.ts`:** `start` takes a
  `LaunchContext` (a runtime cannot spawn without the resolved java binary + JVM args, and
  re-resolving inside each provider would duplicate `core/java/`), and **`restart` is not on the
  interface** — it is `stop` + `start` with a *freshly resolved* context and lives on
  `RuntimeManager`, so every runtime gets identical semantics.
- **`core/context.ts` (`createContext(providers, bus)`) is the shared object graph.** `cli/context.ts`
  and `hooks/use-mctl.tsx` are its two thin adapters — that is the mechanism that stops the front-ends
  drifting. The registry is built at the front-end edge (`providers/index.ts`) and injected, so
  nothing under `core/` or `hooks/` imports a concrete provider.
- **`heapArgs` sets `-Xms` and `-Xmx` to the same value** — pre-committing the heap avoids the
  stop-the-world resizes that read as lag spikes in the first hour; it is what every MC launch script
  does.
- **`lib/download.ts` is deliberately separate from `lib/http.ts`.** `http` caches small manifest
  *bodies* on disk, which is exactly wrong for a 60 MB jar; `download` streams to a sibling temp file,
  hashes as it goes, and `rename`s only after the digest matches — so a corrupt download never leaves
  a plausible-looking jar behind.

### Gotchas hit this session

- **`parseArgs` must check `valued` before `boolean`.** `--java 21` (pin) and `--no-java` (skip) share
  one flag name, so the name is in **both** sets; checking `boolean` first swallowed `--java 21` as a
  bare boolean and left `21` in the positionals — `mctl edit x --java 26` reported success and changed
  nothing. Regression-tested in `cli/args.test.ts`.
  - And the negation is stored as the **boolean `false`**, not the string `"false"`, so `stringFlag`
    (hence `intFlag`) skip it. Otherwise `--no-java` threw "must be a positive integer (got false)".
- **`Button` only honours Enter/Space when `focused` is passed**, so an action bar without a focus
  ring is **mouse-only**. The Server detail page owns a `useFocusRing` over its visible actions (the
  set changes with the probed state; the ring clamps, so that is safe). Check this on any new page
  with buttons.
- **`Bun.spawn`'s `Subprocess` generic follows the stdio options**, so a helper that passes
  `stdin: "ignore" | Uint8Array` cannot be typed `Subprocess<"pipe",…>` (`lib/shell.ts`).
- **`FileSink.end()` may return a `number`, not a promise** — `await` it, don't `.catch()` it.
- **A pty opened via `script` ignores `COLUMNS`/`LINES` env**; it inherits the parent size (24 rows
  here), which silently hides anything below the fold. Prefix the command with `stty rows N cols M`
  when driving the TUI — the create form's progress panel looked missing until that was fixed.

## Icon sets — Nerd / Unicode / ASCII (2026-08-03)

- **Icons are theming's twin, and are built the same way**: pure catalogue in `core/icons/`, React
  adapter in `hooks/use-icons.tsx`, one persisted key in `config.json` (`icons`). Components ask for
  a **semantic name** (`icons.success`, `icons.caret`, `icons.ruleLine`) and never a literal glyph —
  the same rule colour already follows. `core/icons/catalogue.ts` is the single glyph table; adding
  an icon = one row there.
- **Three rendering sets, three config modes, and they are NOT the same three.** `IconSet` =
  `nerd | unicode | ascii`; `config.icons` = `auto | nerd | ascii`. `unicode` is the middle tier
  `auto` lands on and is deliberately not offered as a mode — "the plain symbols every UTF-8
  terminal has" is what auto-detection should be trusted to decide. It is still reachable via
  `MCTL_ICONS=unicode` for debugging.
  - **Why not fall straight from `nerd` to `ascii`:** that would downgrade the majority of
    terminals (which draw `●`/`✔` fine without a patched font) and would have visibly regressed
    the app's existing look for everyone on the default.
- **There is no way to ask a terminal whether its font has Nerd Font glyphs.** So `auto` requires
  **positive evidence** — `TERM_PROGRAM`/`TERM` naming ghostty, WezTerm, or kitty (all three ship
  Nerd Font coverage by default), or an explicit `MCTL_NERD_FONT` — and otherwise picks `unicode`.
  A missing glyph is tofu or, worse, a two-cell replacement that shifts the layout.
  - Only an **explicit** non-UTF-8 locale (`C`, `POSIX`, `iso88591`) downgrades to `ascii`. An
    entirely unset `LANG` is treated as capable — routine in containers whose terminal is fine.
  - An explicit `nerd` mode is honoured even in a `C` locale: the user asserting "my font has these
    glyphs" beats any heuristic, and overriding them would make the setting useless to exactly the
    people who need it.
- **Every glyph must be one cell wide**, in every set. East-Asian *Wide* characters are barred
  outright (`☕` U+2615 was the first pick for `java` and is why the rule is tested); *Ambiguous*
  ones (`●`, `◉`, `—`) are fine — the app already draws them. Two documented ASCII exceptions,
  `ellipsis` ("...") and `transition` ("->"), because no fixed-width column measures against them.
  - **Consequence that bit twice:** any truncation helper must subtract `ellipsis.length`, not a
    literal `1`. `Toast.wrapText` and `Servers.cell` both take the marker as a parameter now.
- **`useIcons()` deliberately does NOT throw outside a provider** — it returns the auto-detected
  set. This is the one place the icon system diverges from theming: a component with no colours is
  unrenderable so `useTheme()` failing loudly is right, but every icon has a working default, and
  kit components must stay mountable in a bare test renderer.
- **`Button` only inks its label when `children` is a plain string** (`Button.tsx:212`). So
  `Get started {icons.arrowRight}` silently loses the label colour — children become an array.
  Interpolate into one string instead: `` {`Get started ${icons.arrowRight}`} ``.
- **Theme and icon writes share ONE queue** (`persistAppearance` in `App.tsx`, replacing
  `persistThemeId`). Each is a read-modify-write of the whole config, so separate queues would
  clobber each other. `configSubscriber(bus, select)` generalises the old `themeIdSubscriber` and
  feeds both providers.
  - `Settings.save` now takes `(themeId, iconMode)` for the same reason the theme id was already
    passed: `config` in hand can lag one write behind what the user is looking at.
- **ASCII mode cannot be complete:** `borderStyle` is OpenTUI's and 0.4.5 offers only
  `single | double | rounded | heavy`. Panel borders stay box-drawing; the Settings picker says so
  when `ascii` resolves rather than letting the user discover it. Prose ellipses/em-dashes in
  sentences are likewise untouched — they are typography, not icons.

## Scroll acceleration (2026-08-01)

- **A `<scrollbox>` defaults to `LinearScrollAccel` — one line per wheel notch, forever.** On a tall
  page that reads as "the wheel barely does anything". Pass `scrollAcceleration={…}`; `@opentui/core`
  exports `MacOSScrollAccel` (from `lib/scroll-acceleration`, re-exported by the package root), which
  keeps a 3-sample window of the intervals between scroll events and scales the delta by
  `1 + A*(e^(v/tau) - 1)`, capped at `maxMultiplier` (defaults `A=0.8, tau=3, max=6`). A streak breaks
  after 150 ms of silence, so a slow wheel stays exactly one line per notch.
- **The accelerator is stateful, so the instance must be stable** — a fresh instance per render resets
  the tick history on every keypress and silently degrades to linear.
- **Nothing renders the `<scrollbox>` intrinsic directly any more — use `components/ScrollBox.tsx`.**
  It is a pass-through wrapper (`ScrollBoxProps = OpenTuiScrollBoxProps & { enableAccel?: boolean }`;
  props *and* `ref` spread straight through) that owns the `useMemo`'d accelerator and adds
  `enableAccel`. It spreads `scrollAcceleration` **only when it resolves** — the renderable defaults to
  `LinearScrollAccel` when the option is absent at construction, but its setter would store an explicit
  `undefined`. An explicit `scrollAcceleration` from the caller wins over `enableAccel`.
- **`enableAccel` is off by default and set at exactly one call site:** the shell page host in
  `Router.tsx`. Acceleration is wrong for a short region — a 2-row tab strip (`NavRail`, `Tabs`) or a
  small list overshoots on the first flick. The Settings panel and the wizard are still linear by
  choice; flip them only if they feel sluggish in use.
- Measured in `components/ScrollBox.test.tsx` with `createTestRenderer` + synthetic
  `onMouseEvent({type:"scroll"})`: 30 notches 10 ms apart move **30** rows unaccelerated vs ~175
  accelerated. `onMouseEvent` is `protected` and `scrollX`/`scrollY` are absent from the public
  `ScrollBoxRenderable` type, so the test casts for both (runtime-correct, type-invisible).

## Terminal-relative dimensions — negative width/height (2026-08-03, user request)

- **A negative `width`/`height` on any element now means `terminal size - n`.** `<box width={-4}>`
  is the terminal width minus 4 cells; `<scrollbox height={-2}>` the terminal height minus 2.
  `src/components/negative-dimension-patch.ts` → `installNegativeDimensionPatch()`, called in
  `renderApp()` beside the other two patches. This is the replacement for counting cells out of
  `useTerminalDimensions()` by hand (what `NavRail` and `Tabs` still do for their rule tails).
  - **Why it was needed:** OpenTUI's `width` is `number | "auto" | "<n>%"`, and a percentage
    resolves against the **parent**, not the screen. There is no "screen minus a gutter" form.
- **Two seams, because construction and updates do not share a code path:**
  - **Construction** — `Renderable`'s constructor calls `validateOptions(id, options)`, which
    **throws** `Invalid width for Renderable <id>: -4` on a negative *before* `setupYogaProperties`
    runs. `validateOptions` is module-private, so nothing on the prototype can get in front of it:
    the only seam is rewriting `options` before `super()`, i.e. re-registering the React component
    catalogue as subclasses — the same trick `selection-opt-in.ts` uses.
    - **Dead end:** wrapping `Renderable.prototype.setupYogaProperties` (my first cut). It is the
      method that actually pushes the value into yoga, but the throw beats it by ~5 lines.
  - **Updates** — the reconciler applies changed props as plain assignments (`instance.width =
    value`, via `setProperty`'s `default:` branch, and `setStyle` does the same), so the
    `width`/`height` accessors on `Renderable.prototype` are wrapped too. That path does **not**
    validate — a negative reached yoga silently as undefined behaviour before this.
- **Tracked and re-resolved on every terminal resize.** A size baked in at construction is stale
  after the first SIGWINCH, so the raw negative is kept in a module `Map<Renderable, spec>` and
  re-applied from `ctx.on("resize")` (the `CliRenderer` updates its own `width`/`height` *before*
  emitting, so `ctx` is already current in the sweep). Entries drop on the renderable's
  `"destroyed"` event; setting a non-negative value opts back out. The sweep calls the **original**
  setter, or it would clear its own tracking.
- **Clamped at 0.** A terminal narrower than the inset yields an empty element — resolving to a
  negative would hit the same upstream `Invalid width` throw. (A laid-out renderable then reports
  `Math.max(layout.width, 1)`, so `.width` reads 1, not 0.)
- **Two catalogue patches must wrap `getComponentCatalogue()`, not `baseComponents`.**
  `selection-opt-in.ts` was changed to do this. Both wrap-and-`extend()`; if both wrapped the
  pristine `baseComponents`, the second `extend()` would re-register the same names over the
  first's classes and **silently delete the first patch**. Wrapping what is currently registered
  makes them compose in either order. Any future catalogue patch must follow this rule.
- **Covers JSX elements only.** A renderable built by hand (`new BoxRenderable(...)`) still throws
  on a negative constructor option; it is only affected on assignment. Nothing in `src/` builds
  renderables by hand, and the test therefore mounts real JSX through `createRoot`.

## OpenTUI gotchas (added 2026-07-26)

- **Box borders are NOT clipped by ancestor scissor rects — upstream bug, patched locally.**
  `BoxRenderable.renderSelf` draws via the native `bufferDrawBox`, and that is the *only* native draw
  path that ignores the buffer's scissor stack (`drawText`, `drawTextBuffer`, `fillRect`,
  `drawFrameBuffer` all honour it). Symptom: a bordered `<box>` inside a `<scrollbox>` clips its text
  correctly but keeps painting border glyphs over the surrounding chrome (top bar, nav rail, hint
  strip) once scrolled. Not scrollbox-specific — a plain `<box overflow="hidden">` does it too.
  Reproduced on `@opentui/core` 0.4.5 (latest published).
  - **Fix:** `src/components/box-clip-patch.ts` → `installBoxClipPatch()`, called first thing in
    `renderApp()`. It monkey-patches `BoxRenderable.prototype.renderSelf`: when a box is *partially*
    outside its ancestors' clip, it lets the **original** `renderSelf` draw into a shared scratch
    `OptimizedBuffer` at the origin, then blits with `drawFrameBuffer` — which *does* respect the
    scissor. Fully-visible boxes keep the untouched native fast path, so there is no cost until a box
    straddles a clip edge, and **no glyph/title/border-style logic is reimplemented** (that was the
    point: partial sides, title alignments and focus colours stay byte-identical to upstream).
  - **How to apply:** delete the module and its one call site when upstream clips `bufferDrawBox`.
    Don't reach for `buffered: true` as a workaround — a buffered renderable renders at the wrong
    offset inside a clip (tested, produces garbage).
  - **Tests must live inside `src/`** (`src/components/box-clip-patch.test.ts`). A test file outside the
    project resolves `@opentui/core` to a *different copy* (the `~/.bun/install/cache` source tree), so
    patching one copy's prototype does nothing to the other — this silently made a scratch-dir
    verification look like the patch was a no-op. First `bun test` in the repo; `test` script added.

- **Drag-selection is opt-in, via a re-registered component catalogue.** OpenTUI's text-bearing
  renderables (`text`, `code`, `markdown`, `input`, `textarea`, `ascii-font`, …) default
  `selectable: true` (base `Renderable` is `false`), and a left mouse-down over one starts a
  drag-selection — which highlights text and fights our click-to-navigate UI, where most labels are
  also click targets.
  - **Fix:** `src/components/selection-opt-in.ts` → `installSelectionOptIn()`, called in `renderApp()`
    beside `installBoxClipPatch()`. It wraps every entry of `@opentui/react`'s `baseComponents` in a
    subclass that, *only when the `selectable` prop was absent and the class defaulted to true*, sets
    `this.selectable = false` after `super()`, then re-registers them with `extend()`. `<text
    selectable>` (the server console) keeps working; everything else is inert.
  - **Why not simpler:** `selectable` is resolved inside each renderable's own constructor as
    `options.selectable ?? this._defaultOptions.selectable`, and `_defaultOptions` is a *class field*
    (own property) — so it cannot be patched from the prototype. Subclassing is the only seam.
  - **Dead end:** the earlier fix, `renderer.startSelection = () => {}`, disables selection *globally*
    — an explicit `selectable` prop then does nothing. Don't go back to it.
  - Catalogue components are all constructed by the reconciler as `new C(ctx, { id, ...props })`, so a
    uniform `(ctx, options)` subclass is safe for all of them. `RenderableConstructor` resolves to the
    *abstract* `BaseRenderable`, which TS refuses to `extend` in a class expression — narrow the base
    to a structural `new (ctx, options) => { selectable?: boolean }` instead.
- **Box border *sides* are `border={["top"|"right"|"bottom"|"left"]}`** — `border?: boolean |
  BorderSides[]`. There is **no** `borderTop`/`borderRight`/`borderBottom`/`borderLeft` prop (they
  fail typecheck). `borderColor` colours whichever sides are on.
- **`CliRenderer` extends EventEmitter and emits `"destroy"`** (`RendererEvents.DESTROY`). Use
  `renderer.on("destroy", …)` to tear down process-wide resources (we stop the event system there).
  Note `useQuit` does `renderer.destroy()` then `process.exit(0)`, so on an explicit quit the OS also
  reaps watchers regardless.

## Theme follows config changes (2026-07-31)

- **`ThemeProvider` owns `themeId` as state seeded once from `initialThemeId`** — so a `config.theme`
  changed by *another instance* or a hand-edit did nothing, even though `ConfigChanged` fired and
  `useConfig` refreshed. It also can't subscribe itself: it is mounted **above** `EventBusProvider`
  (it must wrap everything) and is UI-layer, so it does no config I/O.
  - **Fix:** a `subscribeThemeId?: (apply: (id) => void) => () => void` prop — the mirror image of
    `onThemeChange`. `renderApp()` builds it once (`themeIdSubscriber(bus)` in `App.tsx`): on
    `ConfigChanged` it `loadConfig()`s and pushes `config.theme` in. The provider's effect only calls
    `setThemeIdState` and deliberately **does not** fire `onThemeChange` — the id came *from* the
    persisted config, re-persisting it would be a write loop between instances.
  - **How to apply:** any future provider mounted above the bus that must react to hard-state changes
    takes a subscribe *prop* wired in `renderApp()`; don't move it under `EventBusProvider` and don't
    give it disk access.
- **`persistThemeId` now serializes and coalesces its writes.** It is a read-modify-write, and cycling
  with `t` fires it faster than a round-trip completes; overlapping writes could land out of order. That
  was invisible before, but with the bridge above the losing write feeds back and **visibly snaps the
  theme back**. One in-flight write at a time, only the newest id, skip when unchanged.
- Verified in a pty against a sandbox HOME: an external atomic edit of `config.json` (`terminal`→`nord`)
  repaints in Nord within ~1 s (nord bg `46;52;64` + primary `136;192;208` in the new frames); with the
  fix stashed the same edit produces **0 new bytes** of output. Three rapid `t` presses land on the right
  theme with no snap-back.
- **Still not reactive: the theme *catalogue*.** `ThemeRegistry` is loaded once in `renderApp()`, so
  editing/adding `~/.config/mctl/themes/*.json` needs a restart. No watcher on that dir. Fix by watching
  it and reloading the registry into provider state if it ever matters.

## Theming (2026-07-25)

- **Themes carry a light/dark *scheme*, not one flat palette + an `appearance` tag.** `Theme.colors`
  (and `ThemeFile.colors`) is a `ThemeColorScheme`: **either** `{ default: ThemeColors }` (mode-agnostic)
  **or** `{ dark, light }` (both variants). The old top-level `Theme.appearance`/`ThemeSummary.appearance`
  fields are **gone**. Built-ins `github` + `nord` now ship both variants (one id, renamed "GitHub"/"Nord").
  - **Current mode is a property of the *host*, not the theme.** It's derived from the terminal
    background luminance via `terminalAppearance(palette)` (exported from `core/theme/terminal.ts`,
    was the private `appearanceOf`). Even a static theme picks its light/dark variant from this — the
    terminal is the only signal of whether the user's environment is light or dark. Defaults to `dark`
    until the palette resolves.
  - **Resolution:** `resolveColors(scheme, mode)` in `types/theme.ts` collapses a scheme → flat
    `ThemeColors` (`default` ignores mode; a pair picks the match). `use-theme` does this and exposes
    **`colors` (resolved flat palette) + `appearance` (current mode)** on the context alongside `theme`.
    Components read `useTheme().colors.*`, NOT `theme.colors.*` (which is now a scheme). `App.tsx` updated.
  - **`terminal` theme is a `{ default }` scheme** — its live snapshot already reflects the current mode,
    so there's only ever one palette; `themeFromTerminalColors` lost its `mode` param.
  - `ThemeColorScheme` is a `z.union([{default}, {dark,light}])`; `"default" in scheme` narrows in TS.
- **Themes are a registry of *semantic colour roles*, not raw ANSI/component names.** Roles:
  `background, foreground, surface, border, muted, primary, secondary, success, warning, error, info`
  (Zod-defined in `types/theme.ts`, hex-only for custom files). UI colours by role via `useTheme()`.
- **Three theme sources:** built-ins (`github`, `nord`) in `core/theme/builtin.ts`; custom user files at
  `~/.config/mctl/themes/<id>.json` (id = filename, like server-id-from-dir); and the dynamic
  **`terminal`** theme built live from the host palette. `config.theme` (default `"terminal"`) stores the
  active id and is read at startup in `renderApp()`.
- **`terminal` is reserved + special.** The registry only *lists* it (no static colours); the UI layer
  (`hooks/use-theme`) substitutes the live palette. A custom file named `terminal.json` is ignored with a
  warning. `themeFromTerminalColors()` (pure, in `core/theme/terminal.ts`, no OpenTUI import) maps a
  neutral `TerminalPalette` → roles with a fallback chain so no role is ever undefined.
- **One bad custom theme file is skipped with a log warning, not fatal** — deliberate exception to
  "throw typed errors": a single malformed `themes/*.json` must not make the app unlaunchable; built-ins
  still resolve. (Contrast config.json, which *is* fatal.)
- **OpenTUI already implements terminal-colour querying** — `renderer.getPalette()` (OSC 10/11/4) and a
  `palette` change event. `use-terminal-colors.ts` is a React adapter: fetch on mount, subscribe to
  `palette`, dedupe by signature, expose a neutral `TerminalPalette`.
- **TWO load-bearing gotchas for LIVE terminal-theme changes** (both caused a "reverts to fallback /
  doesn't update on theme change" bug; the working reference is `~/projects/local-edge`):
  1. **We must enable DEC private mode 2031 ourselves** — `process.stdout.write("\x1b[?2031h")` on
     mount, `"\x1b[?2031l"` on cleanup. OpenTUI *reacts* to the terminal's colour-scheme-change
     notification but **never enables the mode**, so without this write no `palette`/`theme_mode` event
     ever fires on change. (Write to `process.stdout`, not `renderer.stdout` — the latter is private.)
  2. **The poll fallback MUST call `renderer.clearPaletteCache()` before `getPalette()`** — `getPalette`
     returns a cached result, so re-querying without clearing returns the *stale* palette forever.
  - Do NOT gate/stop the poll on `theme_mode` (an earlier version did — that was the bug). Poll
    continuously (~1s) with a cache-clear as the fallback; the `palette` event covers 2031-capable
    terminals instantly. Appearance is derived from background luminance in `terminal.ts` — no need to
    depend on `themeMode` at all.
  - **Do NOT call `renderer.setBackgroundColor()`** to theme the background. It emits OSC 11 to change
    the *actual terminal* bg, which races the terminal's own colour-scheme transition and **flashes a
    stale colour for a frame** on every change (this bit both `local-edge` and an earlier mctl version).
    Instead paint the background with a full-screen `backgroundColor` box at the app root (`App.tsx` root
    box, `flexGrow={1}`) — it draws into the render buffer and leaves the terminal's native bg alone.
    The flicker-free `rove` project works exactly this way (never touches terminal bg).
  - **Sandbox caveat:** a non-TTY pipe can't answer OSC queries and OpenTUI swallows `process.stdout`
    writes there, so live palette detection is **not verifiable headlessly** — only in a real TTY.
- **No-flash terminal theme (three parts, do not drop any):**
  1. **Pre-fetch before first paint:** `renderApp()` calls `queryTerminalPalette(renderer)` (exported from
     `use-terminal-colors`) and passes it to `<ThemeProvider initialPalette>` → `useTerminalColors(initial)`
     seeds state. OpenTUI has usually already detected the palette during `createCliRenderer`, so this
     returns from cache instantly on a real TTY (≤200ms timeout otherwise). Frame one is real colours.
  2. **`"terminal"` id NEVER falls back to a static theme.** `use-theme` resolves it to
     `terminalTheme ?? EMPTY_TERMINAL_THEME` (the empty-palette terminal theme), so an unresolved palette
     shows neutral terminal-defaults, not GitHub. A missing *named* theme also degrades to the terminal
     theme, not github. (`FALLBACK_THEME`/github is no longer referenced by the provider.)
  3. **Ignore transient all-null palettes.** `use-terminal-colors` guards every update with `hasColour()`
     — during a theme switch the terminal can briefly answer all-`null`; using it would flash empty for a
     frame. Skip it, hold the last-good palette.
- **Gotchas:**
  - `<ascii-font>` uses `color` (`ColorInput | ColorInput[]`), **not** `fg`. `<text>`/`<span>` use `fg`.
  - Added **`@types/react@19`** (devDep). The repo had no direct `react` imports before; hooks/context
    (`useState/useEffect/useMemo/useContext/createContext`, `React.ReactNode`) need it. JSX still comes
    from `@opentui/react` via `jsxImportSource`, so `@types/react` doesn't hijack JSX.
  - `lib/fs.ts` gained `readDirIfExists(dir, ext?)` → `[]` on ENOENT (absent `themes/` is normal).

## Key decisions (2026-07-25 — second design pass)

- **No in-memory authoritative state — "MCTL manages, does not hold."** The app caches nothing it
  treats as truth; server identity/config/run-state is re-derived from disk + live process probes every
  launch and every change.
  - **Why:** it is the enabling constraint for **multiple `mctl` instances running at once and staying
    in sync** — none owns the state, so they can't disagree.
  - **How to apply:** re-identify running servers by probing `~/.local/state/mctl/runtime/<id>.json`
    (pid/session liveness), never a cached "running set." Sync across instances via `fs.watch` on hard-
    state files **plus** an append-only `events.jsonl` that every instance tails and re-emits. No IPC,
    no daemon, no leader. Supervision (auto-restart/tunnel keepalive) is opportunistic behind a
    supervisor lock; a real daemon is deferred to Phase 5 on the same file substrate. Detached runtimes
    (tmux/docker) are the norm so servers outlive an instance. See [[architecture.md]] § Statelessness.
- **JSON / JSONL only — no TOML, no YAML.** `mctl.toml → mctl.json`, `config.toml → config.json`,
  `secrets.toml → secrets.json`. Cross-instance log is `events.jsonl`. Drop `@iarna/toml`; use native
  JSON + Zod at every boundary. (Earlier drafts said config was TOML — that is now wrong, ported.)
- **Pages moved into `src/app/`.** No top-level `src/pages/`. `app/` holds `App.tsx`, `Router.tsx`,
  `setup/` (wizard), and the page folders. CLI lives in `src/cli/`.
- **Two front-ends, one core: TUI *and* one-shot CLI.** `mctl` (no args) → OpenTUI; `mctl <cmd>` →
  scriptable one-shot with `--json`. Both call the same core services; `cli/commands/` is the CLI's
  bridge, mirroring hooks. Neither front-end holds logic the other lacks.
- **First-run setup wizard** (`app/setup/`) triggers when `config.json` is absent; writes defaults once.
  Headless equivalent is `mctl init` (same fields as flags → identical `config.json`).

## Key decisions (2026-07-25 — first pass, still current)

- **Server Location Registry.** `servers_dir` is only the *default parent* for new servers; each
  server's real path lives in `~/.local/state/mctl/servers.json` (`id → path`). Startup verifies each
  path (exists + `mctl.json`). Pointer index, never a data mirror; durable state, atomic writes; missing
  path ⇒ mark **unavailable**, never auto-delete; still scan `servers_dir` and fold in drop-ins.
- **Providers are dynamically registered modules** via a `ProviderRegistry` — the TS simplification over
  Rust crates.

## Conventions / preferences

- Artifacts are the project memory: `plan.md` (intent), `architecture.md` (structure), `memory.md`
  (this), `progress.md` (baseline). Read all four at session start; write `memory.md` + `progress.md`
  every session. See `AGENTS.md`.
- Precedence when artifacts disagree: `plan.md` > `architecture.md` > `progress.md`. Code beats all.
- User wants `plan.md` **rich and detailed** (the Rust plan was the depth benchmark), not blunt bullet
  lists — concrete interfaces, tables, diagrams.
- **Run `bun run format` (Biome) once at the end of a session**, after all edits have settled — not per
  file. Asked for on 2026-08-07 because unformatted diffs produced formatting-only commits (`bdf2faa`).
- **Commit meaningful units as you go, don't push unless asked** (2026-08-07, supersedes the old
  "don't commit unless asked"). Message style is the existing history's: `feat:`/`fix:`/`refactor:`/
  `chore:` + short capitalised summary, no trailing period; check `git log --oneline` first.

## Component library (2026-07-25)

- **`src/components/` is the shared UI kit.** All components are **pure-UI, controlled, and
  theme-driven**: they read colour from `useTheme().colors` (never hardcode hex), take
  `value`/`checked` + `onChange` + `focused`, hold no domain state, and do no I/O. Import from the
  barrel `src/components/index.ts`.
- **Mouse focus convention — every focusable control takes `onFocused?: () => void`.** Fired on
  mouse-down so a click moves the *page's* focus ring to that control (the component still owns no
  focus state; the page maps `onFocused` → its `setFocus`). Present on `Button`, `Tabs`, `Input`,
  `TextArea`, `Select`, `Toggle`, `Checkbox`, `RadioGroup`. **How it's wired:** form controls forward
  `onFocused` to `FormField`, which puts `onMouseDown={onFocused}` on its frame box — OpenTUI mouse
  events **bubble** (they carry `stopPropagation`), so a click anywhere in the frame (border, label, or
  the inner control) reaches it, and the inner `onMouseDown` handlers (Toggle/Checkbox/RadioGroup) that
  fire `onChange` don't stop propagation, so both fire. `Button` fires `onFocused` *then* `onClick`
  (a click focuses **and** activates). Non-focusable clickables (`Breadcrumb` crumbs, lone `Radio`,
  `Dialog` backdrop) keep plain `onMouseDown` and get **no** `onFocused`. Gallery wires every ring
  member's `onFocused` to `setFocus(id)` — click-to-focus is the demo/verification. Interactive keyboard handling lives inside each control via
  `useKeyboard` **guarded by `focused`** — that guard is what stops every mounted control from
  reacting to one keypress (many `useKeyboard` handlers all fire globally).
- **Variant language:** `support.ts` defines `Variant` (primary/secondary/success/warning/error/
  info/neutral) → `variantColor(colors, v)`; `onAccent(colors)` returns `colors.background` as the
  ink to lay on a filled accent (reads on every built-in light/dark variant). Reuse these, don't
  re-pick roles per component.
- **The form-field frame** (`FormField`/`Field` in `Form.tsx`): a rounded `<box>` that puts the
  **label on the top border via `title`** and the **hint on the bottom border via `bottomTitle`**,
  and swaps `borderColor`/`titleColor` to `primary` on `focused` (`error` on `invalid`). This is why
  a text field is a tidy 3 rows — the label/hint sit *on* the border, not on interior rows. NOTE:
  `<box>` has **`titleColor` but no `bottomTitleColor`** — the bottom title can't be coloured
  independently.
- **Adaptive `Select`:** few/short options → OpenTUI `<tab-select>` (side-by-side); options that
  overflow the field width → scrollable `<select>` dropdown (with per-option descriptions). Decided
  by `optionsFitAsTabs(labels, innerWidth)` where `innerWidth = fieldWidth - 4` (2 border + 2 pad).
  Pass `width` to a `Select` both to size it and to set the cutoff.
- **OpenTUI input/textarea value-read gotchas:**
  - `<input onSubmit>` — OpenTUI merges `InputProps.onSubmit: (value)=>void` with the inherited
    `TextareaOptions.onSubmit: (SubmitEvent)=>void` into an **intersection**, so a `(value:string)`
    handler won't type-check. Pass a **zero-arg** handler (assignable to both) and read the value from
    a `useRef<InputRenderable>().current.value`.
  - `<textarea>` is uncontrolled: seed with `initialValue`, and its `onContentChange` event is
    **empty** — read the text back from `ref.current.plainText` (`useRef<TextareaRenderable>`).
- **`Dialog` modal pattern:** no window manager, so it's two absolute full-screen layers — a dimming
  backdrop `<box opacity={0.7}>` (own opacity so the page shows through; children would inherit it, so
  the dialog is a **separate sibling** at higher `zIndex`, full opacity) centred over it.
- Page **`Tabs`** (custom, mouse + ←/→) are distinct from the `<tab-select>` *form input* — don't
  conflate. Active-tab underline renders `"─"`, inactive renders **blank spaces** (not a
  background-coloured glyph) so it's theme-proof.

## OpenTUI gotchas

- **FrameBuffer has no `<frame-buffer>` JSX intrinsic** in `@opentui/react`. Create a
  `FrameBufferRenderable(renderer, {id, width, height})` imperatively in `useEffect` and attach it to a
  host `<box>` via its `ref` (`box.add(canvas)` / cleanup `box.remove(canvas)` + `canvas.destroy()`).
  React never renders children into that box, so there's no reconciler conflict. `useId()` for a unique
  buffer id when several exist. See `components/MinecraftHead.tsx`.
- **Square "pixels" in a cell grid:** a terminal cell is ~1 wide × 2 tall, so use the upper-half-block
  glyph `▀` — fg = top pixel colour, bg = bottom pixel colour → 2 stacked pixels/cell, each its own
  colour (lossless). An 8×8 image → 8-wide × 4-tall cells and renders square. (Quadrant blocks give 2×2
  sub-pixels/cell but only 2 colours per cell, so they lose colour — avoid unless width-constrained.)

## Gotchas / open questions

- Anything referencing `.toml`, Rust crates, `cargo`, `thiserror`, or a top-level `pages/` in an
  artifact is stale — port it on sight.
- **Supervision under statelessness is a real tension:** without a daemon, auto-restart/tunnel keepalive
  only runs while some instance is alive (opportunistic, lock-guarded). If the user wants always-on
  behaviour, that's the Phase-5 agent — flag it rather than silently assuming a daemon.
