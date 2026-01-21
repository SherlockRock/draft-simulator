# Series Length Change Design

## Overview

Enable users to change the series length (Bo1, Bo3, Bo5, Bo7) after creation, dynamically creating or deleting Draft records to match.

## Constraints

- **Length can only be changed if the series hasn't started** (existing constraint - first draft has no picks)
- **Decreasing length is blocked** if any drafts that would be deleted have picks
- **Increasing length is always allowed** (even if series has been "won")

## Backend Logic

**Location:** `PUT /api/versus-drafts/:id` in `/backend/routes/versus.js`

### Flow

1. Get current drafts ordered by `seriesIndex`
2. Calculate delta: `newLength - currentDraftCount`
3. **If increasing (delta > 0):**
   - Create `delta` new Draft records
   - `seriesIndex` continues from current max (e.g., if 3 exist, new ones get 3, 4)
   - Name pattern: `${seriesName} - Game ${seriesIndex + 1}`
   - Copy `owner_id` from VersusDraft, `type` from VersusDraft.type
4. **If decreasing (delta < 0):**
   - Get drafts where `seriesIndex >= newLength`
   - Check each for picks - if ANY have non-empty picks, return 400 error
   - Delete those drafts
5. Update `length` field on VersusDraft
6. Wrap in transaction for atomicity

### Error Handling

```javascript
// When decreasing but drafts have activity
{
  status: 400,
  error: "Cannot reduce series length - Game X has already started"
}
```

### Socket Broadcast

After success, reload VersusDraft with Drafts included and broadcast:

```javascript
const updatedVersusDraft = await VersusDraft.findByPk(versusDraft.id, {
  include: [{ model: Draft, as: "Drafts", order: [["seriesIndex", "ASC"]] }]
});

socketService.emitToRoom(`versus:${versusDraft.id}`, "versusSeriesUpdate", {
  versusDraft: updatedVersusDraft.toJSON()
});
```

## Frontend

No changes needed - existing implementation handles Drafts array updates via the `versusSeriesUpdate` socket event.

## Files to Modify

| File | Change |
|------|--------|
| `backend/routes/versus.js` | Add draft creation/deletion logic in PUT endpoint |
