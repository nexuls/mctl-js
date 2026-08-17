/**
 * Form — the field wrapper and the full set of form controls, sharing one
 * consistent look so every settings/create/wizard screen reads the same.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): every control here is *controlled* —
 * it renders the `value`/`checked` it's given and reports edits through
 * `onChange`. None of them hold their own source-of-truth state or touch I/O; the
 * page (via a hook) owns the form's data.
 *
 * ## The field frame
 * All controls sit inside {@link FormField}: a rounded box that carries the
 * control's **label on its top border** and an optional **hint on its bottom
 * border**, and switches its border to the accent colour when the control is
 * focused. This is the single visual primitive that makes a stack of mixed
 * controls (text, select, toggle, radios) look like one coherent form.
 *
 * ## Adaptive Select
 * {@link Select} chooses its layout from how much room the options need: a few
 * short options render side-by-side as tabs (OpenTUI `<tab-select>`); when they
 * would overflow the field width they become a vertical, scrollable dropdown
 * list (OpenTUI `<select>`). See {@link optionsFitAsTabs}.
 */

import type {
	BoxRenderable,
	InputRenderable,
	MouseEvent as TuiMouseEvent,
	SelectOption,
	TabSelectOption,
	TabSelectRenderable,
	TextareaRenderable,
} from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { BoxProps, InputProps as OpenTuiInputProps } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../hooks/use-theme.tsx";
import { useIcons } from "../hooks/use-icons.tsx";
import {
	clamp,
	onAccent,
	optionsFitAsTabs,
	type TabSelectHit,
	tabSelectHit,
	variantColor,
} from "./support.ts";
import { useBoxWidth } from "./use-box-width.ts";

export { Label } from "./Label.tsx";

// ---------------------------------------------------------------------------
// FormGroup — a titled section grouping related fields.
// ---------------------------------------------------------------------------

/** Props for {@link FormGroup}. */
export interface FormGroupProps {
	/** Section heading, drawn bold in the foreground colour. */
	title?: string;
	/** Optional supporting line under the heading, muted. */
	description?: string;
	/** Gap in cells between the grouped fields. Defaults to 1. */
	gap?: number;
	children: React.ReactNode;
}

/**
 * A vertical stack of fields under an optional heading. Purely structural — it
 * adds rhythm and a title, never a border of its own, so the fields' own frames
 * stay the dominant shapes on screen.
 */
export function FormGroup({
	title,
	description,
	gap = 1,
	children,
}: FormGroupProps) {
	const { colors } = useTheme();
	return (
		<box flexDirection="column" gap={gap}>
			{title ? <text fg={colors.foreground}>{title}</text> : null}
			{description ? <text fg={colors.muted}>{description}</text> : null}
			{children}
		</box>
	);
}

// ---------------------------------------------------------------------------
// FormField — the rounded frame every control lives in.
// ---------------------------------------------------------------------------

/** Props for {@link FormField}. */
export type FormFieldProps = BoxProps & {
	/** Label drawn on the top border. */
	label?: string;
	/** Hint/help drawn on the bottom border (keep it short — it shares the border line). */
	hint?: string;
	/** Marks the field required — appends a `*` to the label. */
	required?: boolean;
	/** Whether the contained control is focused; drives the accent border. */
	focused?: boolean;
	/**
	 * Fired when the field is clicked, so the page can move its focus ring here.
	 * Mouse events bubble, so a click anywhere in the frame (border, label, or the
	 * control inside) reaches this — clicking a field focuses it, mirroring the Tab
	 * ring. The page still owns focus; this only reports the intent.
	 */
	onFocused?: () => void;
	/** Fixed outer width in cells. Omit to size to the parent (flex). */
	width?: number | `${number}%` | "auto";
	/** Maximum width in cells. Omit to size to the parent (flex). */
	maxWidth?: number | `${number}%`;
	/** Hide the border and titles, leaving only the inner control. */
	noBorder?: boolean;
	/**
	 * Signals a validation problem: the border turns the error colour and the hint
	 * (if any) is shown in error colour context by the caller. Overrides `focused`
	 * colouring so an invalid field always reads as invalid.
	 */
	invalid?: boolean;
	children: React.ReactNode;
	/** Element to render on the left side of the input, inside the border. */
	prefix?: React.ReactNode;
	/** Element to render on the right side of the input, inside the border. */
	suffix?: React.ReactNode;
	/** Ref to the box renderable, so the page can measure its width. */
	ref?: React.Ref<BoxRenderable>;
};

/**
 * The frame that gives every control its label, hint, and focus affordance. Uses
 * the box's `title`/`bottomTitle` so the text sits *on* the border rather than
 * stealing an interior row — which is what lets a text field be a tidy 3 rows
 * tall (top border + input + bottom border).
 */
export function FormField({
	label,
	hint,
	required = false,
	focused = false,
	onFocused,
	width,
	maxWidth,
	noBorder = false,
	invalid = false,
	children,
	prefix,
	suffix,
	ref,
	...rest
}: FormFieldProps) {
	const { colors } = useTheme();
	const borderColor = invalid
		? colors.error
		: focused
			? colors.primary
			: colors.border;
	const titleColor = invalid
		? colors.error
		: focused
			? colors.primary
			: colors.muted;

	// The label sits on the border unadorned: focus is carried by the accent
	// border and title colour alone. A caret used to be prefixed here as a
	// stronger cue, but it shifted the label along the top edge on every focus
	// move, which read as the frame twitching rather than as a focus ring.
	const title = label ? ` ${label}${required ? " *" : ""} ` : undefined;

	return (
		<box
			ref={ref}
			border={noBorder ? undefined : true}
			borderStyle={noBorder ? undefined : "rounded"}
			borderColor={noBorder ? undefined : borderColor}
			title={title}
			titleColor={titleColor}
			titleAlignment="left"
			// Only pass a bottom title when there is one: an interpolated empty hint
			// would paint the literal string "undefined" onto the bottom border.
			bottomTitle={hint ? ` ${hint} ` : undefined}
			bottomTitleAlignment="left"
			paddingLeft={1}
			paddingRight={1}
			width={width}
			maxWidth={maxWidth}
			flexDirection="row"
			flexShrink={0}
			onMouseDown={onFocused ? () => onFocused() : undefined}
			{...rest}
		>
			{prefix && <box paddingRight={1}>{prefix}</box>}
			<box flexGrow={1}>{children}</box>
			{suffix && <box paddingLeft={1}>{suffix}</box>}
		</box>
	);
}

/** {@link FormField} is also exported as `Field` for terse call sites. */
export const Field = FormField;

// ---------------------------------------------------------------------------
// Input — single-line text.
// ---------------------------------------------------------------------------

/** Props for {@link Input}. */
export type InputProps = OpenTuiInputProps & {
	/** Field label (top border). */
	label?: string;
	/** Field hint (bottom border). */
	hint?: string;
	/** Current text value (controlled). */
	value?: string;
	/** Placeholder shown when empty. */
	placeholder?: string;
	/** Fired on every keystroke with the new value. */
	onChange?: (value: string) => void;
	/** Fired when the user presses Enter. */
	onSubmit?: (value: string) => void;
	/** Whether this input holds focus. */
	focused?: boolean;
	/** Fired when the field is clicked, so the page can focus it. */
	onFocused?: () => void;
	/** Mark the field required. */
	required?: boolean;
	/** Mark the field invalid (error border). */
	invalid?: boolean;
	/** Fixed outer width in cells. */
	width?: number | `${number}%` | "auto";
	/** Maximum width in cells. */
	maxWidth?: number | `${number}%`;
	/** Hide the border and titles, leaving only the inner control. */
	noBorder?: boolean;
	/** FormField props */
	formFieldProps?: Omit<FormFieldProps, "children">;
};

/**
 * A single-line text input inside a {@link FormField}. The cursor uses the accent
 * colour; the field background lifts to `surface` while focused so the active row
 * is obvious.
 */
export function Input({
	label,
	hint,
	value,
	placeholder,
	onChange,
	onSubmit,
	focused = false,
	onFocused,
	required = false,
	invalid = false,
	width,
	maxWidth,
	formFieldProps,
}: InputProps) {
	const { colors } = useTheme();
	const ref = useRef<InputRenderable | null>(null);
	return (
		<FormField
			label={label}
			hint={hint}
			required={required}
			focused={focused}
			onFocused={onFocused}
			invalid={invalid}
			width={width}
			maxWidth={maxWidth}
			{...formFieldProps}
		>
			<input
				ref={ref}
				width="100%"
				value={value}
				placeholder={placeholder}
				focused={focused}
				onInput={onChange}
				// A zero-arg submit handler satisfies both onSubmit signatures OpenTUI
				// merges onto <input> (value-based and event-based); read the committed
				// text from the renderable so the caller still gets the value.
				onSubmit={() => {
					if (ref.current) onSubmit?.(ref.current.value);
				}}
				wrapMode="none"
				backgroundColor="transparent"
				focusedBackgroundColor={colors.surface}
				textColor={colors.foreground}
				placeholderColor={colors.muted}
				cursorColor={colors.primary}
				cursorStyle={{
					style: "line",
					blinking: true,
				}}
			/>
		</FormField>
	);
}

// ---------------------------------------------------------------------------
// TextArea — multi-line text.
// ---------------------------------------------------------------------------

/** Props for {@link TextArea}. */
export interface TextAreaProps {
	/** Field label (top border). */
	label?: string;
	/** Field hint (bottom border). */
	hint?: string;
	/** Initial text (the textarea edits its own buffer; changes are reported via `onChange`). */
	value?: string;
	/** Placeholder shown when empty. */
	placeholder?: string;
	/** Fired with the full text whenever the content changes. */
	onChange?: (value: string) => void;
	/** Whether this textarea holds focus. */
	focused?: boolean;
	/** Fired when the field is clicked, so the page can focus it. */
	onFocused?: () => void;
	/** Visible rows of text (the field is this + 2 for the borders). Defaults to 4. */
	rows?: number;
	/** Mark the field required. */
	required?: boolean;
	/** Fixed outer width in cells. */
	width?: number;
}

/**
 * A multi-line text editor inside a {@link FormField}. The content-change event
 * carries no payload, so the current text is read back from the renderable's
 * `plainText` via a ref — the idiomatic way to observe an OpenTUI edit buffer.
 */
export function TextArea({
	label,
	hint,
	value,
	placeholder,
	onChange,
	focused = false,
	onFocused,
	rows = 4,
	required = false,
	width,
}: TextAreaProps) {
	const { colors } = useTheme();
	const ref = useRef<TextareaRenderable | null>(null);
	return (
		<FormField
			label={label}
			hint={hint}
			required={required}
			focused={focused}
			onFocused={onFocused}
			width={width}
		>
			<textarea
				ref={ref}
				width="100%"
				height={rows}
				initialValue={value}
				placeholder={placeholder}
				focused={focused}
				backgroundColor="transparent"
				focusedBackgroundColor={colors.surface}
				textColor={colors.foreground}
				placeholderColor={colors.muted}
				cursorColor={colors.primary}
				onContentChange={() => {
					if (ref.current) onChange?.(ref.current.plainText);
				}}
				cursorStyle={{
					style: "line",
					blinking: true,
				}}
			/>
		</FormField>
	);
}

// ---------------------------------------------------------------------------
// Select — adaptive tabs / dropdown.
// ---------------------------------------------------------------------------

/**
 * How long the pointer must rest on a `<tab-select>` end arrow between steps.
 * Slow enough to stop at a specific option, fast enough to walk a long list.
 */
const ARROW_REPEAT_MS = 180;

/** One selectable option. */
export interface SelectItem<T = string> {
	/** Visible label. */
	label: string;
	/** The value reported through `onChange` when chosen. */
	value: T;
	/** Optional secondary text (shown in the dropdown layout). */
	description?: string;
}

/** Props for {@link Select}. */
export interface SelectProps<T = string> {
	/** Field label (top border). */
	label?: string;
	/** Field hint (bottom border). */
	hint?: string;
	/** The available options. */
	options: SelectItem<T>[];
	/** The currently-selected value (controlled). */
	value?: T;
	/** Fired with the newly-selected value. */
	onChange?: (value: T) => void;
	/** Whether this control holds focus. */
	focused?: boolean;
	/** Fired when the field is clicked, so the page can focus it. */
	onFocused?: () => void;
	/** Force the dropdown layout even if the options fit as tabs. */
	forceDropdown?: boolean;
	/** Mark the field required. */
	required?: boolean;
	/** Mark the field invalid (error border), as {@link Input} does. */
	invalid?: boolean;
	/**
	 * Fixed outer field width in cells. Also decides the tabs-vs-dropdown cutoff:
	 * options that fit within it render as side-by-side tabs, otherwise as a
	 * scrollable dropdown. Defaults to 40.
	 */
	width?: number | `${number}%` | "auto";
	/** Max visible rows in the dropdown layout before it scrolls. Defaults to 5. */
	maxVisible?: number;
	/**
	 * Element drawn inside the border, left of the options. Forwarded to
	 * {@link FormField}.
	 */
	prefix?: React.ReactNode;
	/**
	 * Element drawn inside the border, right of the options — a
	 * {@link "./Spinner".Spinner} while the options are still being fetched, say.
	 * Forwarded to {@link FormField}.
	 */
	suffix?: React.ReactNode;
}

/**
 * A single-choice selector that adapts its layout to the options:
 *
 *  - **Tabs** (`<tab-select>`) when the labels fit side-by-side within the field
 *    — fastest to scan for a handful of short choices (runtime, kind, …).
 *  - **Dropdown** (`<select>`) when they don't — a vertical, scrollable list that
 *    also shows per-option descriptions (long version lists, Java vendors, …).
 *
 * Selection is controlled: the chosen value is located by identity each render,
 * and both layouts report changes back as the option's `value`.
 *
 * Both OpenTUI controls are keyboard-only, so the mouse behaviour is this
 * component's: the **wheel** walks a dropdown's selection, a **click** picks a
 * tab, and **resting on a tab strip's end arrow** walks toward the options that
 * are scrolled out of view. All three move the selection, because in both
 * controls the scroll offset is derived from the selected option — there is no
 * viewport to move on its own.
 */
export function Select<T = string>({
	label,
	hint,
	options,
	value,
	onChange,
	focused = false,
	onFocused,
	forceDropdown = false,
	required = false,
	invalid = false,
	width = 40,
	maxVisible = 5,
	prefix,
	suffix,
}: SelectProps<T>) {
	const { colors } = useTheme();
	const ref = useRef<BoxRenderable | null>(null);
	const tabRef = useRef<TabSelectRenderable | null>(null);
	const measured = useBoxWidth(ref);
	// Which end arrow of the tab strip the pointer is resting on, if any — `-1`
	// for the leading arrow, `1` for the trailing one. Drives the repeat below.
	const [arrowHover, setArrowHover] = useState<-1 | 1 | null>(null);

	const selectedIndex = Math.max(
		0,
		options.findIndex((o) => o.value === value),
	);

	// Before the first layout `measured` is 0, so fall back to the requested
	// width — for the common fixed-width call that is already the right answer
	// and the field never flips layout after its first frame. A flex-sized field
	// ("100%"/"auto") has no such guess and starts as a dropdown, then switches
	// once the real width arrives.
	const outer = measured || (typeof width === "number" ? width : 0);
	// Interior width available to the control: outer minus the two borders and the
	// one cell of padding on each side that FormField applies, minus a cell plus
	// its padding for each affix drawn beside the options (a loading spinner is
	// the usual one) — otherwise the tabs-vs-dropdown test measures room the
	// options do not have.
	const affixes = (prefix ? 2 : 0) + (suffix ? 2 : 0);
	const inner = outer - 4 - affixes;
	const asTabs = optionsFitAsTabs(
		options.map((o) => o.label),
		inner,
	);

	// A pick that lands on the value already held is not reported: the control is
	// a value picker, so "chose the same thing" is not an edit. It also keeps the
	// tab strip's index sync (below) from echoing back as a spurious change —
	// pushing the index in makes the renderable announce a selection, which would
	// otherwise reach the page as a second `onChange` for a value it just set.
	const pick = (index: number) => {
		const opt = options[index];
		if (opt && opt.value !== value) onChange?.(opt.value);
	};
	/** Move the selection by `delta`, stopping at either end. */
	const step = (delta: number) => {
		const next = clamp(selectedIndex + delta, 0, options.length - 1);
		if (next !== selectedIndex) pick(next);
	};

	/**
	 * Resolve a pointer event to the tab (or end arrow) under it. The renderable
	 * reports its own screen position, so the pointer's absolute cell becomes an
	 * offset inside the strip; see {@link tabSelectHit} for the layout maths.
	 */
	const hitAt = (event: TuiMouseEvent): TabSelectHit => {
		const el = tabRef.current;
		if (!el) return { kind: "none" };
		return tabSelectHit({
			offsetX: event.x - el.screenX,
			offsetY: event.y - el.screenY,
			width: el.width,
			tabWidth: el.tabWidth,
			count: options.length,
			selectedIndex,
		});
	};

	// `<tab-select>` keeps its selected index to itself: there is no prop for it,
	// only `setSelectedIndex`, and that index is what draws the highlight *and*
	// fixes the strip's scroll offset. So the controlled value has to be pushed
	// in whenever the two drift — without this a mouse pick reports the right
	// value and the strip goes on highlighting the old tab, and an arrow walk
	// never scrolls. Runs after every render because the strip is also mounted
	// and unmounted as the field resizes between layouts.
	useEffect(() => {
		const el = tabRef.current;
		if (el && el.getSelectedIndex() !== selectedIndex) {
			el.setSelectedIndex(selectedIndex);
		}
	});

	// Resting the pointer on an end arrow keeps walking the strip that way, so a
	// user can reveal off-screen options without touching the keyboard. It walks
	// the *selection* because that is the only handle there is: `<tab-select>`
	// derives its scroll offset from the selected tab, so the viewport cannot be
	// moved independently. Deliberately without a dependency array: each step
	// re-renders, which restarts the timer, so the repeat is paced at one option
	// per interval and always reads the current selection. The *first* step is
	// fired by the pointer handler instead, so entering the arrow responds at
	// once rather than after a delay.
	useEffect(() => {
		if (arrowHover === null) return;
		const timer = setInterval(() => step(arrowHover), ARROW_REPEAT_MS);
		return () => clearInterval(timer);
	});

	const tabOptions: TabSelectOption[] = options.map((o) => ({
		name: ` ${o.label} `,
		description: o.description ?? "",
		value: o.value,
	}));
	const dropdownOptions: SelectOption[] = options.map((o) => ({
		name: o.label,
		description: o.description ?? "",
		value: o.value,
	}));
	const hasDescriptions = options.some((o) => o.description);
	// One row per option, capped so the list scrolls instead of growing unbounded.
	const visible = Math.min(options.length, maxVisible);
	const height = visible * (hasDescriptions ? 2 : 1);
	const maxOptionWidth = Math.max(...options.map((o) => o.label.length));

	// One FormField for both layouts — it is what `ref` measures, so it must be
	// mounted on every path (see useBoxWidth); branching on it would strand a
	// flex-sized field in whichever layout rendered first.
	return (
		<FormField
			ref={ref}
			label={label}
			hint={hint}
			required={required}
			focused={focused}
			invalid={invalid}
			onFocused={onFocused}
			width={width}
			prefix={prefix}
			suffix={suffix}
		>
			{asTabs && !forceDropdown ? (
				<tab-select
					ref={tabRef}
					width="100%"
					tabWidth={maxOptionWidth + 6}
					options={tabOptions}
					focused={focused}
					showDescription={false}
					showUnderline={false}
					showScrollArrows={true}
					wrapSelection
					textColor={colors.muted}
					focusedBackgroundColor="transparent"
					selectedBackgroundColor="transparent"
					selectedTextColor={variantColor(colors, "primary")}
					onChange={(index) => pick(index)}
					// `<tab-select>` is keyboard-only upstream, so clicking a tab picks
					// it here. The click still bubbles up to FormField, which is what
					// moves the page's focus ring onto this field.
					onMouseDown={(event) => {
						const hit = hitAt(event);
						if (hit.kind === "tab") pick(hit.index);
						else if (hit.kind === "scroll") step(hit.direction);
					}}
					// Entering an end arrow steps once immediately; resting on it hands
					// over to the repeat above. Any other cell cancels the repeat.
					onMouseMove={(event) => {
						const hit = hitAt(event);
						const direction = hit.kind === "scroll" ? hit.direction : null;
						if (direction !== null && arrowHover === null) step(direction);
						setArrowHover(direction);
					}}
					onMouseOut={() => setArrowHover(null)}
				/>
			) : (
				<select
					width="100%"
					height={height}
					options={dropdownOptions}
					selectedIndex={selectedIndex}
					focused={focused}
					showDescription={hasDescriptions}
					showScrollIndicator={options.length > visible}
					wrapSelection
					backgroundColor="transparent"
					focusedBackgroundColor="transparent"
					textColor={colors.foreground}
					descriptionColor={colors.muted}
					selectedBackgroundColor="transparent"
					selectedTextColor={variantColor(colors, "primary")}
					selectedDescriptionColor={variantColor(colors, "primary")}
					onChange={(index) => pick(index)}
					// The wheel walks the selection, which is also what scrolls the list
					// (`<select>` derives its scroll offset from the selection). It clamps
					// rather than wrapping the way the keyboard does: a wheel is a
					// continuous gesture, and flipping from the last option back to the
					// first mid-flick reads as the list jumping. The event is consumed so
					// the page's scrollbox does not scroll underneath the pointer.
					onMouseScroll={(event) => {
						const direction = event.scroll?.direction;
						if (direction !== "up" && direction !== "down") return;
						event.stopPropagation();
						const delta = Math.max(1, event.scroll?.delta ?? 1);
						step(direction === "up" ? -delta : delta);
					}}
				/>
			)}
		</FormField>
	);
}

// ---------------------------------------------------------------------------
// Toggle / Switch — boolean, segmented.
// ---------------------------------------------------------------------------

/** Props for {@link Toggle}. */
export interface ToggleProps {
	/** Field label (top border). */
	label?: string;
	/** Field hint (bottom border). */
	hint?: string;
	/** Current on/off state (controlled). */
	value: boolean;
	/** Fired with the new state on toggle. */
	onChange?: (value: boolean) => void;
	/** Whether this control holds focus (enables Space/Enter/←/→). */
	focused?: boolean;
	/** Fired when the control is clicked, so the page can focus it. */
	onFocused?: () => void;
	/** Labels for the two states. Defaults to `["OFF", "ON"]`. */
	labels?: [string, string];
}

/**
 * A segmented on/off switch inside a {@link FormField}. The active segment fills
 * — success colour for ON, a neutral surface for OFF — so state is legible at a
 * glance. Focus enables Space/Enter to flip and ←/→ to set explicitly; a mouse
 * click anywhere on the switch flips it.
 */
export function Toggle({
	label,
	hint,
	value,
	onChange,
	focused = false,
	onFocused,
	labels = ["OFF", "ON"],
}: ToggleProps) {
	const { colors } = useTheme();

	useKeyboard((key) => {
		if (!focused) return;
		if (key.name === "space" || key.name === "return") onChange?.(!value);
		else if (key.name === "left") onChange?.(false);
		else if (key.name === "right") onChange?.(true);
	});

	const [offLabel, onLabel] = labels;
	return (
		<FormField
			label={label}
			hint={hint}
			focused={focused}
			onFocused={onFocused}
		>
			<box
				flexDirection="row"
				flexShrink={0}
				onMouseDown={() => onChange?.(!value)}
			>
				<box paddingLeft={1} paddingRight={1}>
					<text fg={!value ? colors.error : colors.muted}>{offLabel}</text>
				</box>
				<box
					backgroundColor={value ? colors.success : "transparent"}
					paddingLeft={1}
					paddingRight={1}
				>
					<text fg={value ? onAccent(colors) : colors.muted}>{onLabel}</text>
				</box>
			</box>
		</FormField>
	);
}

// ---------------------------------------------------------------------------
// Checkbox — single boolean with an inline caption.
// ---------------------------------------------------------------------------

/** Props for {@link Checkbox}. */
export interface CheckboxProps {
	/** Field label (top border). */
	label?: string;
	/** Field hint (bottom border). */
	hint?: string;
	/** The inline caption beside the checkbox glyph (the thing being agreed to). */
	caption: string;
	/** Checked state (controlled). */
	checked: boolean;
	/** Fired with the new state on toggle. */
	onChange?: (checked: boolean) => void;
	/** Whether this control holds focus (enables Space/Enter). */
	focused?: boolean;
	/** Fired when the control is clicked, so the page can focus it. */
	onFocused?: () => void;
	/** Drop the field frame, leaving a bare glyph + caption for use inside a row. */
	noBorder?: boolean;
	/**
	 * Draw the glyph inside `[ ]` brackets. Worth setting wherever a *column* of
	 * checkboxes is read at a glance: in the `ascii` icon set an unchecked box is
	 * the empty string, so without the brackets an off row shows nothing at all
	 * and the reader has to infer it from the gap.
	 */
	boxed?: boolean;
	/** Caption ink. Defaults to the foreground colour. */
	captionColor?: string;
}

/**
 * A single checkbox with an inline caption, inside a {@link FormField}. The glyph
 * fills with the success colour when checked. Focus enables Space/Enter; a mouse
 * click toggles.
 */
export function Checkbox({
	label,
	hint,
	caption,
	checked,
	onChange,
	focused = false,
	onFocused,
	noBorder = false,
	boxed = false,
	captionColor,
}: CheckboxProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();

	useKeyboard((key) => {
		if (!focused) return;
		if (key.name === "space" || key.name === "return") onChange?.(!checked);
	});

	return (
		<FormField
			label={label}
			hint={hint}
			focused={focused}
			onFocused={onFocused}
			noBorder={noBorder}
		>
			<box
				flexDirection="row"
				gap={1}
				alignItems="center"
				flexShrink={0}
				onMouseDown={() => onChange?.(!checked)}
			>
				<text fg={checked ? colors.success : colors.muted} flexShrink={0}>
					{boxed
						? `[${checked ? icons.checkOn : icons.checkOff}]`
						: `${checked ? icons.checkOn : icons.checkOff} `}
				</text>
				<text
					fg={captionColor ?? colors.foreground}
					truncate
					wrapMode="none"
					flexShrink={1}
				>
					{caption}
				</text>
			</box>
		</FormField>
	);
}

// ---------------------------------------------------------------------------
// Radio / RadioGroup — single choice from a small explicit set.
// ---------------------------------------------------------------------------

/** One radio option. */
export interface RadioItem<T = string> {
	/** Visible label. */
	label: string;
	/** Value reported when chosen. */
	value: T;
	/** Optional muted description shown after the label. */
	description?: string;
}

/** Props for {@link RadioGroup}. */
export interface RadioGroupProps<T = string> {
	/** Field label (top border). */
	label?: string;
	/** Field hint (bottom border). */
	hint?: string;
	/** The options. */
	options: RadioItem<T>[];
	/** The selected value (controlled). */
	value?: T;
	/** Fired with the newly-selected value. */
	onChange?: (value: T) => void;
	/** Whether the group holds focus (enables ↑/↓/j/k to move). */
	focused?: boolean;
	/** Fired when the group is clicked, so the page can focus it. */
	onFocused?: () => void;
	/** Lay options in a row instead of a column. Defaults to column. */
	row?: boolean;
	/** Mark the field required. */
	required?: boolean;
}

/**
 * A single-choice radio group inside a {@link FormField}. Unlike {@link Select},
 * this keeps *every* option visible at once — use it for a small, fixed set
 * where seeing all choices matters (runtime, compression, EULA behaviour). The
 * selected option shows a filled bullet in the accent colour. Focus enables
 * ↑/↓ (or j/k) to move; a mouse click selects directly.
 */
export function RadioGroup<T = string>({
	label,
	hint,
	options,
	value,
	onChange,
	focused = false,
	onFocused,
	row = false,
	required = false,
}: RadioGroupProps<T>) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const selectedIndex = Math.max(
		0,
		options.findIndex((o) => o.value === value),
	);

	useKeyboard((key) => {
		if (!focused || options.length === 0) return;
		const back = key.name === "up" || key.name === "k" || key.name === "left";
		const fwd = key.name === "down" || key.name === "j" || key.name === "right";
		if (back) {
			const next =
				options[(selectedIndex - 1 + options.length) % options.length];
			if (next) onChange?.(next.value);
		} else if (fwd) {
			const next = options[(selectedIndex + 1) % options.length];
			if (next) onChange?.(next.value);
		}
	});

	return (
		<FormField
			label={label}
			hint={hint}
			required={required}
			focused={focused}
			onFocused={onFocused}
		>
			<box flexDirection={row ? "row" : "column"} gap={row ? 2 : 0}>
				{options.map((opt) => {
					const selected = opt.value === value;
					return (
						<box
							key={String(opt.value)}
							flexDirection="row"
							gap={1}
							alignItems="center"
							flexShrink={0}
							onMouseDown={() => onChange?.(opt.value)}
						>
							<text
								fg={selected ? colors.primary : colors.muted}
								flexShrink={0}
							>
								{`${selected ? icons.radioOn : icons.radioOff} `}
							</text>
							<text
								fg={selected ? colors.foreground : colors.muted}
								flexShrink={0}
							>
								{opt.label}
							</text>
							{opt.description ? (
								<text fg={colors.muted} truncate wrapMode="none">
									{" "}
									{icons.separator} {opt.description}
								</text>
							) : null}
						</box>
					);
				})}
			</box>
		</FormField>
	);
}

/**
 * A single radio button, for the rare case a lone option is placed outside a
 * {@link RadioGroup}. Most forms should reach for `RadioGroup`.
 */
export function Radio({
	label,
	selected,
	onSelect,
}: {
	/** The option label. */
	label: string;
	/** Whether this radio is the chosen one. */
	selected: boolean;
	/** Fired when clicked. */
	onSelect?: () => void;
}) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	return (
		<box
			flexDirection="row"
			gap={1}
			alignItems="center"
			flexShrink={0}
			onMouseDown={onSelect}
		>
			<text fg={selected ? colors.primary : colors.muted}>
				{selected ? icons.radioOn : icons.radioOff}
			</text>
			<text fg={selected ? colors.foreground : colors.muted}>{label}</text>
		</box>
	);
}
