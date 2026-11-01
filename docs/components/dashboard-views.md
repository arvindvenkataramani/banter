# Adding New Views to the Banter Dashboard

Each feature area (`services/`, `chat/`, `settings/`) follows a standard structure. This document describes how to add a new view.

## File Convention

All feature areas live under `dashboard/src/features/<name>/`:

```
src/features/<name>/
  page.tsx              ← the main view (required)
  <component>.tsx       ← supporting components
  widgets/
    <widget-name>.tsx   ← reusable widgets for other views
```

Shared UI primitives stay in `src/components/ui/` (shadcn components) and `src/lib/` (utilities).

## Checklist: Adding a New View

### 1. Create the page component
Create `src/features/<name>/page.tsx`:

```typescript
interface Props {
  filter?: string
  navigate: (path: string, filter?: string) => void
}

export function NamePage({ filter, navigate }: Props) {
  // Fetch own data, manage own state
  // Use @/components/ui/* for shared primitives
  // Call navigate(path, filter) to navigate to other views
  return <div>...</div>
}
```

The page component:
- Receives `navigate: (path: string, filter?: string) => void` to navigate to other views
- Optionally receives `filter` for filtering/state via query param
- Fetches its own data (no shared state management)
- Uses shadcn/ui components from `@/components/ui/*`
- Manages its own layout, including sidebar if needed

### 2. Register the route in App.tsx
Add a route in `src/App.tsx`:

```typescript
{path === '/name' && <NamePage filter={filter} navigate={navigate} />}
```

### 3. Add a navigation option
Add an entry to `NAV_OPTIONS` in `src/components/nav-bar.tsx`:

```typescript
const NAV_OPTIONS = [
  { path: '/', label: 'Chat', icon: BanterIcon },
  { path: '/services', label: 'Services', icon: HardDrivesIcon },
  { path: '/name', label: 'Name', icon: NameIcon },  // ← add here
]
```

Use an icon from `@phosphor-icons/react`. The icon will render in the tab.

### 4. (Optional) Create widgets
If this feature should contribute a summary card or widget to another view, create `src/features/<name>/widgets/<widget-name>.tsx`:

```typescript
interface Props {
  navigate: (path: string, filter?: string) => void
}

export function WidgetName({ navigate }: Props) {
  // Self-contained, fetches own data
  // Accepts navigate for cross-feature linking
  return <Card>...</Card>
}
```

Widgets are imported by the view that wants them. `health-summary.tsx` lives in `services/widgets/`; no view imports it at present.

### 5. (Optional) Add a sidebar
If the view needs sub-navigation or filtering, render a sidebar as internal layout:

```typescript
export function NamePage({ filter, navigate }: Props) {
  return (
    <div className="flex">
      <aside className="w-56 border-r p-4">
        {/* sidebar content: filters, nav, status, etc. */}
      </aside>
      <div className="flex-1 p-4">
        {/* main content */}
      </div>
    </div>
  )
}
```

The sidebar is part of the page's internal layout — not a separate abstraction.

## Data Flow

- Each view fetches its own data via `src/lib/api.ts`
- Views are independent; there is no shared global state, with one exception — voice is an app-level engine that outlives any single page. A voice session — microphone capture, VAD, smart-turn, the services, the player — is owned by a module instance, `VoiceSystem` (`dashboard/src/lib/voice/system/`); no page owns it, so navigating away from Chat does not stop it. Every other view holds only its own state.
- Navigation between views is via the `navigate` callback and URL (path + query params)
- A view explicitly imports the widgets it wants to display (pull model)

## Routing

Routes are path-based: `/` and `/chat` (both the chat page) and `/services`.

Filtering and local state can use query params: `/services?filter=healthy`.

The `navigate` callback handles all URL updates via `history.pushState`, and the `popstate` event handler keeps the component state in sync on browser back/forward.

## UI Constraints

- Style via Tailwind utilities and shadcn components
- Import UI components from `@/components/ui/`
- Shared design tokens live in `src/styles/tokens.css`; the shared component vocabulary in `src/index.css`. These two are the only stylesheets
- No other `.css` files, no `style={{}}`, no one-off styles inside a component; they're unauditable and drift
- Need a style the system doesn't have? Add a new shared token to `tokens.css` and use that
