# UI Design Principles

Design conventions for the platform dashboard. Follow these when building or modifying UI.

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
