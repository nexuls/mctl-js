/**
 * Settings — a read-only view of the current `config.json` in Phase 1. The
 * editable form (the same Zod schema the wizard renders, every field but `root`
 * editable) is the next Phase-1 task; this page shows the resolved values now so
 * the config is inspectable from the TUI.
 *
 * Page-layer (AGENTS.md § 3): renders the config view model from {@link useConfig},
 * does no I/O.
 * TODO(phase-1): make this editable, reusing the wizard's form controls, and
 * emit `ConfigChanged` on save.
 */

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useConfig } from "../../hooks/use-config.ts";
import { resolveRootPaths } from "../../core/config/index.ts";
import { PageHeader } from "../shared.tsx";

function Row({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <box flexDirection="row" gap={1}>
      <text fg={colors.muted}>{label.padEnd(16)}</text>
      <text fg={colors.foreground}>{value}</text>
    </box>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <box
      flexDirection="column"
      border
      borderColor={colors.border}
      title={title}
      titleColor={colors.secondary}
      padding={1}
      marginBottom={1}
    >
      {children}
    </box>
  );
}

export function Settings() {
  const { colors } = useTheme();
  const { config, loading, error } = useConfig();

  if (loading || !config) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <PageHeader
          title="Settings"
          subtitle={error ? `error: ${error}` : "reading config…"}
        />
      </box>
    );
  }

  const paths = resolveRootPaths(config);

  return (
    <box flexDirection="column" flexGrow={1}>
      <PageHeader title="Settings" subtitle="current configuration (read-only)" />

      <Section title="Paths">
        <Row label="root" value={config.root} />
        <Row label="servers_dir" value={paths.serversDir} />
        <Row label="backups_dir" value={paths.backupsDir} />
      </Section>

      <Section title="Defaults">
        <Row label="minecraft" value={config.defaults.minecraftVersion ?? "latest"} />
        <Row label="kind" value={config.defaults.kind} />
        <Row label="memory" value={config.defaults.memory} />
        <Row label="runtime" value={config.defaults.runtime} />
        <Row label="eula" value={String(config.defaults.eula)} />
      </Section>

      <Section title="Backup">
        <Row label="enabled" value={String(config.backup.enabled)} />
        <Row label="provider" value={config.backup.provider} />
        <Row label="compression" value={config.backup.compression} />
      </Section>

      <Section title="Network & theme">
        <Row label="default profile" value={config.network.defaultProfile} />
        <Row label="theme" value={config.theme} />
        <Row label="configVersion" value={String(config.configVersion)} />
      </Section>

      <text fg={colors.muted} attributes={TextAttributes.DIM}>
        Editing lands with the Settings form (Phase 1, next). `root` is permanent.
      </text>
    </box>
  );
}
