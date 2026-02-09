# DRA-11: Edit Canvas Dialog Close Bug

## Problem Statement

When clicking outside the Edit Dialog in ActivityItem, the dialog closes AND the user is navigated to the resource (canvas/draft/versus). Clicking outside should only close the dialog, treating it the same as clicking Cancel.

**Linear Issue**: [DRA-11](https://linear.app/draft-simulator/issue/DRA-11/edit-canvas-dialog-close-bug)

## Root Cause

In `frontend/src/components/ActivityItem.tsx`, the Edit Dialog (lines 751-918) is implemented as an inline custom dialog rather than using the reusable `Dialog` component.

The bug occurs because:
1. The backdrop div has `onClick={() => setIsEditOpen(false)}` (line 754)
2. This click event propagates to the parent ActivityItem card
3. The card's `handleClick` function (line 307-313) navigates to the resource

The existing `Dialog` component handles this correctly by calling `onCancel()` only when the backdrop itself is clicked, and the inner content div naturally stops propagation.

## Solution

Refactor the inline Edit Dialog to use the existing `Dialog` component, matching the pattern already used by the ManageUsersDialog in the same file.

### Current Implementation (lines 751-918)
```tsx
<Show when={isEditOpen()}>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    onClick={() => setIsEditOpen(false)}  // BUG: propagates to parent
  >
    <div
      class="w-full max-w-md rounded-lg bg-slate-800 p-6 shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      {/* dialog content */}
    </div>
  </div>
</Show>
```

### New Implementation
```tsx
<Dialog
  isOpen={isEditOpen}
  onCancel={() => setIsEditOpen(false)}
  body={
    <div class="w-full max-w-md">
      {/* dialog content - same as before, minus outer wrapper */}
    </div>
  }
/>
```

## Implementation Tasks

### Task 1: Refactor Edit Dialog to use Dialog component
**File**: `frontend/src/components/ActivityItem.tsx`

1. Replace the inline `<Show when={isEditOpen()}>` block (lines 751-918) with a `<Dialog>` component
2. Move the inner dialog content into the `body` prop
3. Remove the outer wrapper divs (backdrop and container) since `Dialog` provides these
4. Keep all form fields, handlers, and conditional sections intact
5. Adjust width class since `Dialog` already provides `rounded-lg bg-slate-800 p-6 shadow-lg`

### Task 2: Verify TypeScript compilation
Run `npx tsc --noEmit` in frontend to ensure no type errors were introduced.

## Files Changed

- `frontend/src/components/ActivityItem.tsx` - Refactor Edit Dialog

## Handoff Prompt

```
Implement DRA-11: Fix the Edit Dialog close bug in ActivityItem.tsx.

The issue: Clicking outside the Edit Dialog navigates to the resource instead of just closing the dialog.

The fix: Refactor the inline Edit Dialog (lines 751-918) to use the existing Dialog component, following the same pattern as the ManageUsersDialog at line 929.

Steps:
1. Replace the <Show when={isEditOpen()}> wrapper with <Dialog isOpen={isEditOpen} onCancel={() => setIsEditOpen(false)} body={...} />
2. Move the inner content (starting from <h3>) into the body prop
3. Remove the custom backdrop div and container div - Dialog provides these
4. Adjust the width: add max-w-md to the body wrapper div
5. Run `npx tsc --noEmit` in frontend/ to verify no type errors

Reference the existing ManageUsersDialog usage at line 929-940 for the pattern.
```
