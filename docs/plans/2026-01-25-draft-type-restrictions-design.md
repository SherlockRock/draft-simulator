# Draft Type Restrictions Design

## Overview

Implement functional differences between the three versus draft types: Standard, Fearless, and Ironman. Currently the `type` field exists but has no effect on gameplay.

## Draft Type Definitions

### Standard
- Within a single game, once a champion is picked or banned, it cannot be selected again
- Each game is independent - no restrictions carry over between games
- This is the current behavior

### Fearless
- **Picks** from previous games restrict that champion for the rest of the series
- Bans from previous games do NOT carry over
- Restricted champions cannot be picked OR banned in later games (fully removed from pool)

### Ironman
- **Both picks AND bans** from previous games restrict that champion for the rest of the series
- Restricted champions cannot be picked OR banned in later games (fully removed from pool)

## Core Restriction Logic

### Function: `getRestrictedChampions(seriesType, drafts, currentSeriesIndex)`

Returns an array of champion IDs unavailable for the current game.

```javascript
function getRestrictedChampions(seriesType, drafts, currentSeriesIndex) {
  if (seriesType === 'standard') {
    return [];
  }

  const restricted = [];

  for (const draft of drafts) {
    if (draft.seriesIndex >= currentSeriesIndex) continue;

    const picks = draft.picks;

    if (seriesType === 'fearless') {
      // Picks only: indices 10-19
      for (let i = 10; i < 20; i++) {
        if (picks[i] && picks[i] !== '') {
          restricted.push(picks[i]);
        }
      }
    } else if (seriesType === 'ironman') {
      // Picks and bans: indices 0-19
      for (let i = 0; i < 20; i++) {
        if (picks[i] && picks[i] !== '') {
          restricted.push(picks[i]);
        }
      }
    }
  }

  return [...new Set(restricted)]; // dedupe
}
```

### Picks Array Layout Reference
- Indices 0-4: Blue bans
- Indices 5-9: Red bans
- Indices 10-14: Blue picks
- Indices 15-19: Red picks

## Backend Validation

### Socket Handler Changes (`versusHandlers.js`)

In the `versusPick` handler, after existing validation checks:

```javascript
// Existing checks:
// 1. Draft not complete
// 2. Correct team's turn
// 3. Draft not paused
// 4. Champion not already in current game's picks array

// NEW check:
const versusDraft = await VersusDraft.findByPk(draft.versus_draft_id, {
  include: [{ model: Draft, as: 'drafts' }]
});

const restrictedChampions = getRestrictedChampions(
  versusDraft.type,
  versusDraft.drafts,
  draft.seriesIndex
);

if (restrictedChampions.includes(champion)) {
  return callback({ error: 'Champion restricted from previous games in this series' });
}
```

### Type Change Validation (`routes/versus.js`)

Update `PUT /api/versus-drafts/:id` to allow type changes until Game 2 starts:

```javascript
// When type is being modified:
if (req.body.type && req.body.type !== versusDraft.type) {
  const game2 = versusDraft.drafts.find(d => d.seriesIndex === 1);
  if (game2 && game2.picks.some(p => p !== '')) {
    return res.status(400).json({
      error: 'Cannot change series type after Game 2 has started'
    });
  }
}
```

## Frontend Changes

### Champion Selection State (`VersusDraftView.tsx`)

```typescript
const restrictedChampions = createMemo(() =>
  getRestrictedChampions(
    versusDraft().type,
    versusDraft().drafts,
    currentDraft().seriesIndex
  )
);

const isPicked = () => draft()!.picks.includes(String(originalIndex));
const isSeriesRestricted = () => restrictedChampions().includes(String(originalIndex));
const canSelect = () => isMyTurn() && !isPicked() && !isSeriesRestricted() && !versusState().isPaused;
```

Restricted champions receive the same visual treatment as picked champions (opacity-30, non-interactive).

### Tabbed Champion Panel

The right-side champion panel becomes a tabbed interface:

#### Tab 1: "Pick" (default)
- Current searchable champion grid
- Restricted champions grayed out (same style as picked)
- Search and category filters unchanged

#### Tab 2: "Restricted"
- Hidden for Standard mode
- Shows previous games with their restricted champions
- Each game section displays:

**Fearless layout (10 champions per game):**
```
Game 1:
  Blue Picks: [champ] [champ] [champ] [champ] [champ]
  Red Picks:  [champ] [champ] [champ] [champ] [champ]
```

**Ironman layout (20 champions per game):**
```
Game 1:
  Blue Bans:  [champ] [champ] [champ] [champ] [champ]
  Red Bans:   [champ] [champ] [champ] [champ] [champ]
  Blue Picks: [champ] [champ] [champ] [champ] [champ]
  Red Picks:  [champ] [champ] [champ] [champ] [champ]
```

- Empty slots display BlankSquare placeholder
- Consistent layout regardless of whether previous game completed
- Labels are text-based: "Blue Bans:", "Red Picks:", etc.

#### Tab Visibility Rules
- Standard mode: Hide "Restricted" tab entirely
- Fearless/Ironman, Game 1: Show tab with empty state ("No previous games")
- Fearless/Ironman, Game 2+: Show tab with game-by-game breakdown

## Files to Modify

### New Files
- `backend/utils/seriesRestrictions.js` - Core restriction logic
- `frontend/src/utils/seriesRestrictions.ts` - Frontend restriction logic

### Backend Modifications
- `backend/socketHandlers/versusHandlers.js` - Add restriction validation in `versusPick` handler
- `backend/routes/versus.js` - Update type-change validation timing

### Frontend Modifications
- `frontend/src/pages/VersusDraftView.tsx`:
  - Add tabbed interface (Pick / Restricted tabs)
  - Integrate `isSeriesRestricted()` into champion button state
  - Create Restricted tab content component
- `frontend/src/components/RestrictedChampionsTab.tsx` (optional extraction)

### No Changes Required
- Database schema (type field already exists on VersusDraft)
- API response structure (all drafts already included in series response)
- Socket event structure (existing events sufficient)

## Edge Cases

1. **Reconnection during Game 2+**: Frontend fetches full series data; restrictions computed on load
2. **Spectators**: See same restrictions and can access Restricted tab
3. **Incomplete previous games**: Picks/bans still count as restrictions; BlankSquare shown for empty slots
4. **Race conditions**: Backend validation prevents selection even if frontend state is stale
