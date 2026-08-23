# UI Design Principles

Design conventions for the platform dashboard. Follow these when building or modifying UI.

## Design scale

Use only the values listed below. Do not reach for other Tailwind spacing or text utilities.

### Spacing

| Name | Values | Use for |
|------|--------|---------|
| tight | `gap-1`, `gap-1.5`, `space-y-1.5` | Elements within a single group (icon + label, badge row, stacked label + input) |
| related | `gap-2`, `space-y-2`, `mt-2`, `mb-2` | Sibling items that belong together (row items, form field + label, heading to its content) |
| group | `gap-3`, `space-y-3`, `gap-4`, `space-y-4`, `mt-4` | Between distinct groups within a section |
| section | `gap-6`, `space-y-6` | Between top-level sections, card internal padding (`p-6` standard, `p-4` compact) |
| region | `gap-8`, `space-y-8`, `space-y-12` | Page-level: between sibling cards (`gap-8`), between host groups (`space-y-12`) |

Do not use `mt-3`, `mt-5`, `mt-6`, `gap-5`, `gap-7`, `gap-9`, `gap-10`, or arbitrary spacing values. If a layout doesn't fit these tiers, reconsider the grouping rather than inventing a new value.

Main content padding: `p-4`. Card padding: `p-6` standard, `p-4` compact. No other values.

### Typography

| Role | Classes | Use for |
|------|---------|---------|
| page heading | `text-xl font-medium` | Host group headings, dialog titles |
| title | `text-lg font-semibold` | Card or view primary heading |
| section heading | `text-base font-medium` | Named section within a view (e.g. "Network", "Lifecycle") |
| body | `text-sm` | Default readable text, metadata, link text |
| label | `text-xs font-medium` | Section headers, form labels |
| supporting | `text-xs text-muted-foreground` | Timestamps, hints, secondary context, sub-group labels |

Do not use `text-2xl` or larger. Do not use `text-base` for body text — body is `text-sm`. The only place `text-xl` appears is page-level headings and dialog titles.

### Colors

All colors must come from theme tokens defined in `index.css`. Never use raw hex, rgb, or oklch values in components. Key tokens:
- **Text:** `text-foreground` (primary), `text-muted-foreground` (secondary/supporting)
- **Surfaces:** `bg-background`, `bg-card`, `bg-card-muted`
- **Status:** `bg-status-healthy-bg`, `bg-status-down-bg`, `bg-status-warn-bg`, `bg-status-muted-bg` (and matching `-fg`, `-border`)

### Radius

Components inherit radius from shadcn defaults. Do not add `rounded-*` overrides to shadcn components unless there is a specific reason.

### Fixed dimensions

- Nav bar height: `h-12`
- Service cards: `w-96`
- Dialog width: `sm:max-w-[672px]` for detail views, `max-w-lg` for simpler dialogs
- Select triggers with known short values: `w-36`
- Short numeric inputs: `w-16` or `w-20`

When adding a new view, define its card/container width explicitly rather than letting content dictate it.

## Styling

- **No custom CSS.** No `.css` files, no `style={{}}`, no inline styles. Tailwind utility classes and shadcn/ui components only.
- Use the existing theme tokens (`text-muted-foreground`, `bg-status-healthy-bg`, etc.) — do not hardcode colors.
- Use `cn()` from `@/lib/utils` to compose conditional class names.

## Icons

- Icons must always be accompanied by a text label. Never use an icon alone for a named action (e.g. a "History" button must say "History", not just show the icon).
- Exception: compact utility buttons where the action is obvious from context (copy, refresh, close). These may be icon-only but must have a `title` attribute for accessibility.
- Icon size: `size-3` inside small buttons, `size-4` for standalone use.
- Source: lucide-react only.

## Buttons

- Use `variant="ghost"` for secondary or inline actions.
- Use `size="sm"` with `h-6 px-1.5 text-xs` for compact card-level actions.
- Use `size="sm"` with `h-7 text-xs` for dialog-level actions.
- Destructive actions use `variant="destructive"` or `text-destructive` on ghost.

## Forms

- Use the `Label` component for all form field labels — not raw `<label>` elements. Pair with `htmlFor` / `id` for accessibility.
- Use `h-7 text-xs` for compact inputs inside dialogs.
- Disable fields that are contextually inactive (e.g. idle timeout input when idle unload is off).
- Use `font-mono` for command/path inputs.

## Tooltips

- Use `TooltipProvider` at the app root (already in `App.tsx`).
- Use the `InfoTip` helper in service-detail for inline explanatory hints — `Info` icon + `TooltipContent`.
- Tooltip text: brief functional description. Explain what the setting *does*, not just what it is. One or two sentences max.
- Use tooltips for non-obvious settings: load strategy, auto-start, idle eviction, tailscale serve.

## Dialogs

- Dialogs are for **focused configuration or detail views** — not for browsing or navigation.
- Width: `max-w-lg` for service detail/history. Use wider only if content genuinely needs it.
- History and detail are separate dialogs — do not combine read-only event history with editable configuration.

## Information architecture

- **Group by concern**, not by data type. Fields that belong to the same mental model go together.
- **Section headers** use `text-xs font-medium`. Sub-group labels use `text-xs text-muted-foreground`.
- Use `Separator` between top-level sections.
- **Rarely-edited content** (e.g. commands) goes in a `Collapsible`, collapsed by default. Show a summary of what's configured in the trigger label.
- **Read-only context** (status, identity) goes at the top. **Editable fields** are the primary content. **Save/Cancel** appear only when the form is dirty, immediately after the editable sections.

## Progressive disclosure

- Don't show everything at once. Fields that are only relevant in certain configurations should be visually de-emphasised or disabled (e.g. idle timeout disabled when idle unload is off).
- Collapsed sections for content that is set once and rarely changed.

## Accessibility

- All interactive elements must be keyboard-accessible (shadcn components handle this).
- All form fields must have associated labels via `htmlFor` / `id`.
- Tooltip triggers must be focusable (`asChild` on a real element, or use a button).
