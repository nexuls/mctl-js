/**
 * Settings — the editable view of `config.json`, rendering the same schema the
 * first-run wizard collects. Every field is editable except `root`, which is
 * permanent by design (plan.md § First-Run Setup Wizard) and shown read-only.
 *
 * Page-layer (AGENTS.md § 3): all state and I/O live in {@link useSettings};
 * this file only renders controls and reports intent. Edits are buffered and
 * written on Save (or Ctrl+S) — not on every keystroke — so a half-typed path
 * never reaches disk.
 *
 * **Key capture:** while the focus ring sits on a text field this page holds an
 * input capture ({@link useCaptureKeys}), which suppresses the shell's
 * single-character shortcuts. Without it, typing `2` in *Memory* would navigate
 * to Servers and `q` would quit mid-edit.
 */

import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import {
  Button,
  Checkbox,
  FormGroup,
  Hint,
  Input,
  RadioGroup,
  Select,
  type RadioItem,
  type SelectItem,
} from "../../components/index.ts";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useFocusRing } from "../../hooks/use-focus-ring.ts";
import { useCaptureKeys } from "../../hooks/use-input-capture.tsx";
import { resolveRootPaths } from "../../core/config/index.ts";
import { configFile } from "../../lib/paths.ts";
import type {
  BackupProvider,
  CompressionKind,
  NetworkProvider,
  RuntimeKind,
  ServerKind,
} from "../../types/config.ts";
import { PageHeader } from "../shared.tsx";
import { useSettings, type SettingsDraft } from "./use-settings.ts";

/** Server kinds available today. Grows as providers land (Phase 2+). */
const KINDS: SelectItem<ServerKind>[] = [
  { label: "Vanilla", value: "vanilla", description: "Mojang's official server" },
];

/** Runtime providers, mirroring the wizard's Defaults step. */
const RUNTIMES: RadioItem<RuntimeKind>[] = [
  { label: "foreground", value: "foreground", description: "tied to MCTL" },
  { label: "tmux", value: "tmux", description: "detached (Phase 3)" },
  { label: "docker", value: "docker", description: "containerised (Phase 5)" },
];

/** Backup providers registered today. */
const BACKUP_PROVIDERS: SelectItem<BackupProvider>[] = [
  { label: "filesystem", value: "filesystem", description: "local directory" },
];

/** Archive formats. */
const COMPRESSIONS: RadioItem<CompressionKind>[] = [
  { label: "tar.zst", value: "tar.zst", description: "smallest, fastest" },
  { label: "tar.gz", value: "tar.gz", description: "most portable" },
  { label: "zip", value: "zip", description: "widest tooling" },
];

/** Network profiles available today; tunnels arrive in Phase 4. */
const NETWORKS: RadioItem<NetworkProvider>[] = [
  { label: "direct", value: "direct", description: "bind a local port" },
];

/**
 * Ring ids that host a live text field. Focus on one of these means the user is
 * typing, so the shell's character shortcuts must stand down.
 */
const TEXT_FIELDS = new Set(["serversDir", "backupsDir", "mc", "memory"]);

/** A read-only `label  value` row, for values that cannot be edited. */
function ReadOnlyRow({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  const { colors } = useTheme();
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text fg={colors.muted} flexShrink={0}>
        {label.padEnd(14)}
      </text>
      {/* Truncate rather than wrap: a long root path must not reflow the row
          into three lines on a narrow terminal. */}
      <text fg={colors.foreground} truncate wrapMode="none">
        {value}
      </text>
      {note ? (
        <text fg={colors.muted} attributes={TextAttributes.DIM} flexShrink={0}>
          {note}
        </text>
      ) : null}
    </box>
  );
}

/** A titled section wrapper, matching the spacing the wizard steps use. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <FormGroup title={title} description={description}>
        {children}
      </FormGroup>
    </box>
  );
}

export function Settings() {
  const { colors, themeId, setThemeId, themes } = useTheme();
  const {
    draft,
    config,
    loading,
    loadError,
    set,
    dirty,
    issues,
    revert,
    save,
    saving,
    saveError,
    saved,
  } = useSettings();

  // The ring adapts to the two override toggles: a path field only joins the
  // cycle while its override is on (same pattern as the wizard's Paths step).
  const ids = [
    "overrideServers",
    ...(draft?.overrideServers ? ["serversDir"] : []),
    "overrideBackups",
    ...(draft?.overrideBackups ? ["backupsDir"] : []),
    "mc",
    "kind",
    "memory",
    "runtime",
    "eula",
    "backupEnabled",
    ...(draft?.backupEnabled ? ["backupProvider", "compression"] : []),
    "network",
    "theme",
    "__revert",
    "__save",
  ];
  const ring = useFocusRing(ids);

  // Suppress the shell's digit/q/t shortcuts while a text field has the ring.
  useCaptureKeys(ring.focus !== undefined && TEXT_FIELDS.has(ring.focus));

  const invalid = Object.keys(issues).length > 0;
  const canSave = dirty && !invalid && !saving;

  // Ctrl+S saves from anywhere on the page, including mid-edit — a modifier
  // chord is unambiguous even while a text field is capturing plain characters.
  useKeyboard((key) => {
    if (key.ctrl && key.name === "s" && canSave) void save(themeId);
  });

  if (loading || !draft || !config) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <PageHeader
          title="Settings"
          subtitle={loadError ? `error: ${loadError}` : "reading config…"}
        />
      </box>
    );
  }

  const paths = resolveRootPaths(config);
  const edit = (patch: Partial<SettingsDraft>) => set(patch);

  return (
    <box flexDirection="column" flexGrow={1}>
      <PageHeader
        title="Settings"
        subtitle={
          saveError
            ? `save failed: ${saveError}`
            : invalid
              ? "fix the highlighted field to save"
              : dirty
                ? "unsaved changes · Ctrl+S or Save"
                : saved
                  ? "saved"
                  : "everything on this screen is written to config.json"
        }
      />

      <Section
        title="Locations"
        description="`root` is chosen once at first run and is permanent."
      >
        <ReadOnlyRow label="root" value={config.root} note="(permanent)" />
        <ReadOnlyRow
          label="configVersion"
          value={String(config.configVersion)}
        />

        <Checkbox
          label="Servers directory"
          caption={
            draft.overrideServers
              ? "Custom location"
              : `Default — ${paths.serversDir}`
          }
          checked={draft.overrideServers}
          focused={ring.isFocused("overrideServers")}
          onFocused={() => ring.setFocus("overrideServers")}
          onChange={(v) => edit({ overrideServers: v })}
        />
        {draft.overrideServers ? (
          <Input
            label="servers_dir"
            hint={issues.serversDir ?? "absolute path"}
            value={draft.serversDir}
            invalid={issues.serversDir !== undefined}
            focused={ring.isFocused("serversDir")}
            onFocused={() => ring.setFocus("serversDir")}
            onChange={(v) => edit({ serversDir: v })}
            onSubmit={() => ring.next()}
          />
        ) : null}

        <Checkbox
          label="Backups directory"
          caption={
            draft.overrideBackups
              ? "Custom location"
              : `Default — ${paths.backupsDir}`
          }
          checked={draft.overrideBackups}
          focused={ring.isFocused("overrideBackups")}
          onFocused={() => ring.setFocus("overrideBackups")}
          onChange={(v) => edit({ overrideBackups: v })}
        />
        {draft.overrideBackups ? (
          <Input
            label="backups_dir"
            hint={issues.backupsDir ?? "absolute path"}
            value={draft.backupsDir}
            invalid={issues.backupsDir !== undefined}
            focused={ring.isFocused("backupsDir")}
            onFocused={() => ring.setFocus("backupsDir")}
            onChange={(v) => edit({ backupsDir: v })}
            onSubmit={() => ring.next()}
          />
        ) : null}
      </Section>

      <Section
        title="Defaults for new servers"
        description="Starting values when a server is created; each is overridable per server."
      >
        <box flexDirection="row" gap={2} flexWrap="wrap">
          <Input
            label="Minecraft version"
            hint="blank = latest at create time"
            placeholder="latest"
            value={draft.minecraftVersion}
            width={30}
            focused={ring.isFocused("mc")}
            onFocused={() => ring.setFocus("mc")}
            onChange={(v) => edit({ minecraftVersion: v })}
            onSubmit={() => ring.next()}
          />
          <Input
            label="Memory"
            hint={issues.memory ?? "JVM heap, e.g. 2G"}
            value={draft.memory}
            width={22}
            invalid={issues.memory !== undefined}
            focused={ring.isFocused("memory")}
            onFocused={() => ring.setFocus("memory")}
            onChange={(v) => edit({ memory: v })}
            onSubmit={() => ring.next()}
          />
        </box>

        <Select
          label="Server kind"
          hint="the server implementation"
          options={KINDS}
          value={draft.kind}
          width={40}
          focused={ring.isFocused("kind")}
          onFocused={() => ring.setFocus("kind")}
          onChange={(v) => edit({ kind: v })}
        />

        <RadioGroup
          label="Runtime"
          hint="how the server process is run"
          options={RUNTIMES}
          value={draft.runtime}
          focused={ring.isFocused("runtime")}
          onFocused={() => ring.setFocus("runtime")}
          onChange={(v) => edit({ runtime: v })}
        />

        <Checkbox
          label="Minecraft EULA"
          caption="Auto-accept the EULA when creating a server"
          checked={draft.eula}
          focused={ring.isFocused("eula")}
          onFocused={() => ring.setFocus("eula")}
          onChange={(v) => edit({ eula: v })}
        />
      </Section>

      <Section title="Backups" description="Scheduling and retention arrive in Phase 4.">
        <Checkbox
          label="Automatic backups"
          caption="Back servers up on a schedule"
          checked={draft.backupEnabled}
          focused={ring.isFocused("backupEnabled")}
          onFocused={() => ring.setFocus("backupEnabled")}
          onChange={(v) => edit({ backupEnabled: v })}
        />
        {draft.backupEnabled ? (
          <>
            <Select
              label="Provider"
              hint="where archives are written"
              options={BACKUP_PROVIDERS}
              value={draft.backupProvider}
              width={40}
              focused={ring.isFocused("backupProvider")}
              onFocused={() => ring.setFocus("backupProvider")}
              onChange={(v) => edit({ backupProvider: v })}
            />
            <RadioGroup
              label="Compression"
              hint="archive format"
              options={COMPRESSIONS}
              value={draft.compression}
              focused={ring.isFocused("compression")}
              onFocused={() => ring.setFocus("compression")}
              onChange={(v) => edit({ compression: v })}
            />
          </>
        ) : null}
      </Section>

      <Section title="Network" description="Tunnels and DNS arrive in Phase 4.">
        <RadioGroup
          label="Default profile"
          hint="applied to new servers"
          options={NETWORKS}
          value={draft.network}
          focused={ring.isFocused("network")}
          onFocused={() => ring.setFocus("network")}
          onChange={(v) => edit({ network: v })}
        />
      </Section>

      <Section
        title="Appearance"
        description="Applies immediately and is saved on its own — no need to press Save."
      >
        <Select
          label="Theme"
          hint="`terminal` follows the host palette"
          options={themes.map((t) => ({
            label: t.name,
            value: t.id,
            description: t.source,
          }))}
          value={themeId}
          width={44}
          focused={ring.isFocused("theme")}
          onFocused={() => ring.setFocus("theme")}
          onChange={(id) => setThemeId(id)}
        />
      </Section>

      {/* Action bar: hints on the left, Revert/Save on the right. */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        flexShrink={0}
      >
        <Hint
          items={[
            { keys: "Tab", label: "next field" },
            { keys: "Ctrl+S", label: "save" },
            { keys: "Enter", label: "activate" },
          ]}
        />
        <box flexDirection="row" gap={2} flexShrink={0} alignItems="center">
          <Button
            kind="ghost"
            variant="neutral"
            disabled={!dirty || saving}
            focused={ring.isFocused("__revert")}
            onClick={revert}
            onFocused={() => ring.setFocus("__revert")}
          >
            Revert
          </Button>
          <Button
            kind="outline"
            variant="primary"
            disabled={!canSave}
            focused={ring.isFocused("__save")}
            onClick={() => void save(themeId)}
            onFocused={() => ring.setFocus("__save")}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </box>
      </box>

      {saveError ? (
        <text fg={colors.error}>{saveError}</text>
      ) : (
        <text fg={colors.muted} attributes={TextAttributes.DIM}>
          Written to {configFile()} · other instances refresh automatically.
        </text>
      )}
    </box>
  );
}
