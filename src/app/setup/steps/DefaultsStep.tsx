/**
 * Step 3 — Server defaults. The values pre-filled when creating a new server:
 * Minecraft version, kind, JVM heap, runtime, and EULA behaviour. Each is
 * overridable per server later — this only sets the starting point.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3). Option sets mirror the config enums
 * (`ServerKind`, `RuntimeKind`); more kinds/runtimes are added in later phases.
 */

import {
  Checkbox,
  Input,
  RadioGroup,
  Select,
  type RadioItem,
  type SelectItem,
} from "../../../components/index.ts";
import { useFocusRing } from "../../../hooks/use-focus-ring.ts";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { StepScaffold } from "../StepScaffold.tsx";
import { WizardFooter } from "../WizardFooter.tsx";
import type { StepProps } from "../types.ts";
import type { RuntimeKind, ServerKind } from "../../../types/config.ts";

/** Server kinds available today. Grows as providers land (Phase 2+). */
const KINDS: SelectItem<ServerKind>[] = [
  { label: "Vanilla", value: "vanilla", description: "Mojang's official server" },
];

/** Runtime providers and how they relate to the MCTL process lifetime. */
const RUNTIMES: RadioItem<RuntimeKind>[] = [
  {
    label: "foreground",
    value: "foreground",
    description: "tied to MCTL; simplest, ends when you quit",
  },
  {
    label: "tmux",
    value: "tmux",
    description: "detached; survives closing MCTL (Phase 3)",
  },
  {
    label: "docker",
    value: "docker",
    description: "containerised; detached (Phase 5)",
  },
];

export function DefaultsStep({ draft, setDraft, onNext, onBack }: StepProps) {
  const { icons } = useIcons();
  const ring = useFocusRing([
    "mc",
    "kind",
    "memory",
    "runtime",
    "eula",
    "__back",
    "__next",
  ]);

  return (
    <StepScaffold
      title="Defaults for new servers"
      description="Sensible starting values — each can be overridden per server."
      footer={
        <WizardFooter
          hints={[
            { keys: "Tab", label: "next field" },
            { keys: [icons.arrowUp, icons.arrowDown], label: "choose" },
          ]}
          backFocused={ring.isFocused("__back")}
          nextFocused={ring.isFocused("__next")}
          onBack={onBack}
          onNext={onNext}
          onFocusBack={() => ring.setFocus("__back")}
          onFocusNext={() => ring.setFocus("__next")}
        />
      }
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
          onChange={(v) => setDraft({ minecraftVersion: v })}
          onSubmit={() => ring.next()}
        />
        <Input
          label="Memory"
          hint="JVM heap, e.g. 2G or 4096M"
          value={draft.memory}
          width={22}
          focused={ring.isFocused("memory")}
          onFocused={() => ring.setFocus("memory")}
          onChange={(v) => setDraft({ memory: v })}
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
        onChange={(v) => setDraft({ kind: v })}
      />

      <RadioGroup
        label="Runtime"
        hint="how the server process is run"
        options={RUNTIMES}
        value={draft.runtime}
        focused={ring.isFocused("runtime")}
        onFocused={() => ring.setFocus("runtime")}
        onChange={(v) => setDraft({ runtime: v })}
      />

      <Checkbox
        label="Minecraft EULA"
        caption="Auto-accept the EULA when creating a server"
        checked={draft.eula}
        focused={ring.isFocused("eula")}
        onFocused={() => ring.setFocus("eula")}
        onChange={(v) => setDraft({ eula: v })}
      />
    </StepScaffold>
  );
}
