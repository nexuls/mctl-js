/**
 * `core/icons/` — the icon catalogue and the rules for choosing a glyph set.
 *
 * Pure data plus pure resolution functions: UI-free (no OpenTUI import) and
 * I/O-free, mirroring `core/theme/`. The React adapter is
 * `hooks/use-icons.tsx`; the persisted preference is `config.icons`.
 */

export { ICONS, SPINNERS, iconsFor, spinnerFor } from "./catalogue.ts";
export {
  ICON_ENV_OVERRIDE,
  type IconEnv,
  detectIconSet,
  hasNerdFont,
  hasUtf8Locale,
  parseIconSet,
  resolveIconSet,
} from "./detect.ts";
