/**
 * The MCTL component library — the shared, theme-driven UI primitives every page
 * composes so the TUI reads as one consistent app.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): everything re-exported here renders
 * props and reports intent through callbacks. No component touches the
 * filesystem, spawns processes, or holds domain state; pages wire them to hooks.
 *
 * Import from the barrel: `import { Button, Input, Select } from "../components";`.
 */

export { Label, type LabelProps } from "./Label.tsx";
export { Kbd, type KbdProps } from "./Kbd.tsx";
export { Hint, type HintItem, type HintProps } from "./Hint.tsx";
export { Button, type ButtonProps } from "./Button.tsx";
export { ProgressBar, type ProgressBarProps } from "./ProgressBar.tsx";
export { Breadcrumb, type Crumb, type BreadcrumbProps } from "./Breadcrumb.tsx";
export { Tabs, type TabItem, type TabsProps } from "./Tabs.tsx";
export { Dialog, type DialogProps } from "./Dialog.tsx";

export {
  FormGroup,
  type FormGroupProps,
  FormField,
  Field,
  type FormFieldProps,
  Input,
  type InputProps,
  TextArea,
  type TextAreaProps,
  Select,
  type SelectItem,
  type SelectProps,
  Toggle,
  type ToggleProps,
  Checkbox,
  type CheckboxProps,
  RadioGroup,
  type RadioItem,
  type RadioGroupProps,
  Radio,
} from "./Form.tsx";

export {
  type SemanticColor,
  type Variant,
  variantColor,
  onAccent,
  clamp,
  optionsFitAsTabs,
} from "./support.ts";

export {
  MinecraftHead,
  SKINS,
  type MinecraftSkin,
  type MinecraftHeadProps,
} from "./MinecraftHead.tsx";
