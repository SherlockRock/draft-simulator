# ActivityItem Declutter Design

## Problem

The versus activity cards on the VersusFlowDashboard are visually cluttered:
1. The Competitive badge overflows when team names are long
2. Team names look cramped when they exceed one line
3. All metadata (team names, Bo length, Competitive badge, timestamp) is packed into a dense horizontal layout

## Solution

Restructure the ActivityItem card layout to:
- Prioritize team names by giving them their own line
- Move metadata (Bo length, mode badge) to a footer row
- Apply the new structure consistently across all activity types (draft, canvas, versus)

## Design

### Card Structure

**Header row:**
- Icon on the left
- Action buttons (share, edit, manage users) on the right for owners
- "Shared" badge on the right for non-owners

**Content area:**
- Resource name (title)
- Type-specific content (team matchup for versus)
- Optional description (line-clamped to 2 lines)

**Footer row:**
- Timestamp left-aligned
- Type-specific badges right-aligned (versus only)

### Layout by Type

**Draft:**
```
┌───────────────────────────────────────────┐
│  📄                        [share] [edit] │
│                                           │
│  My Draft Name                            │
│  Optional description text here...        │
│                                           │
│  5 mins ago                               │
└───────────────────────────────────────────┘
```

**Canvas:**
```
┌───────────────────────────────────────────┐
│  🎨              [users] [share] [edit]   │
│                                           │
│  My Canvas Name                           │
│  Optional description text here...        │
│                                           │
│  5 mins ago                               │
└───────────────────────────────────────────┘
```

**Versus:**
```
┌───────────────────────────────────────────┐
│  ⚔️                        [share] [edit] │
│                                           │
│  Series Name                              │
│  Team Liquid vs Cloud9                    │
│  Optional description text here...        │
│                                           │
│  5 mins ago              Bo3 • Competitive│
└───────────────────────────────────────────┘
```

**Shared items (non-owner):**
```
┌───────────────────────────────────────────┐
│  📄                             [Shared]  │
│  ...                                      │
└───────────────────────────────────────────┘
```

### Styling

**Header row:**
- Flexbox with `justify-between` and `items-start`
- Icon uses existing IconDisplay component at `md` size
- Action buttons grouped with `gap-2`, color-coded per type (orange/blue/purple)

**Team matchup (versus only):**
- Separate line below the title
- `text-sm` size
- Natural wrapping allowed (no `whitespace-nowrap`)
- Colors: `text-blue-400` for blue team, `text-red-400` for red team

**Footer row:**
- Flexbox with `justify-between` and `items-center`
- Timestamp: `text-sm text-slate-400`
- Right side badges (versus only):
  - Bo length: `text-sm text-slate-400`
  - Separator: `•` in `text-slate-500`
  - Mode badge (see below)

**Mode badges:**

| Mode        | Style                                    |
|-------------|------------------------------------------|
| Competitive | `bg-orange-500/20 text-orange-300`       |
| Scrim       | `bg-teal-500/20 text-teal-300`           |

Both modes display a badge - every versus card explicitly shows its mode.

**Spacing:**
- `gap-2` or `gap-3` between content sections
- `p-4` padding on the card (unchanged)

### Edge Cases

**Long team names:**
- Wrap naturally within card width
- No truncation - full names visible
- More width available at mobile breakpoint (1-column)

**Long series names:**
- Keep existing overflow handling
- Consider `line-clamp-1` if needed

**Missing description:**
- Footer moves up, no empty space rendered

**Scrim mode:**
- Shows teal "Scrim" badge instead of orange "Competitive" badge
- Bo length always displayed

**Long descriptions:**
- Keep existing `line-clamp-2` behavior

### Grid Behavior

No changes to the responsive grid in VersusFlowDashboard:
- 1 column on mobile
- 2 columns on medium screens
- 3 columns on large screens

Cards will be slightly taller due to footer separation but more readable.

## Implementation

Changes required in `frontend/src/components/ActivityItem.tsx`:

1. Restructure the main card JSX to separate header, content, and footer areas
2. Move action buttons to header row (right side)
3. Extract team matchup from inline metadata row to its own line
4. Create footer row with timestamp (left) and badges (right)
5. Add Scrim badge as fallback when `competitive` is false
6. Remove inline separators and metadata from team matchup row

## Files Affected

- `frontend/src/components/ActivityItem.tsx` - Main component restructure
