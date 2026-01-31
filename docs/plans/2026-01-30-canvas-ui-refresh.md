# Canvas UI Refresh - Purple Theme & Slim Sidebar

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refresh the Canvas workflow UI with a purple accent color identity and a slimmer sidebar with fewer buttons.

**Architecture:** Three files need changes: `FlowPanel.tsx` (sidebar width), `CanvasWorkflow.tsx` (remove buttons, purple-theme remaining ones), and `Canvas.tsx` (purple accents on toolbar). All changes are Tailwind class swaps - no logic changes.

**Tech Stack:** SolidJS, Tailwind CSS

---

### Task 1: Slim Down FlowPanel Sidebar Width

**Files:**
- Modify: `frontend/src/components/FlowPanel.tsx:14` (expanded width class)

**Step 1: Change the expanded sidebar width**

In `FlowPanel.tsx` line 14, change the expanded width from `w-[max(18vw,260px)]` to `w-44` (176px / ~180px):

```tsx
// OLD (line 14):
isExpanded() ? "w-[max(18vw,260px)]" : "w-5"

// NEW:
isExpanded() ? "w-44" : "w-5"
```

**Step 2: Verify visually**

Run: `cd frontend && npm run dev`
Open canvas detail view. Toggle sidebar. Confirm it's noticeably narrower but all button text still fits.

**Step 3: Commit**

```bash
git add frontend/src/components/FlowPanel.tsx
git commit -m "refactor: slim down FlowPanel sidebar width to 176px"
```

---

### Task 2: Remove "Create Draft" and "New Group" Buttons from Canvas Sidebar

**Files:**
- Modify: `frontend/src/workflows/CanvasWorkflow.tsx:297-327` (remove two buttons)

**Step 1: Remove the Create Draft button**

Delete lines 298-306 in `CanvasWorkflow.tsx` (the Create Draft button block):

```tsx
// DELETE THIS BLOCK:
                                        <button
                                            class="rounded-md bg-teal-700 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-teal-400"
                                            onClick={() => {
                                                const callback = createDraftCallback();
                                                if (callback) callback();
                                            }}
                                        >
                                            Create Draft
                                        </button>
```

**Step 2: Remove the New Group button**

Delete lines 316-326 (after removing the above block, approximately the New Group button):

```tsx
// DELETE THIS BLOCK:
                                        <button
                                            class="rounded-md bg-teal-700 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-teal-400"
                                            onClick={() => {
                                                const callback = createGroupCallback();
                                                if (callback) {
                                                    callback(0, 0);
                                                }
                                            }}
                                        >
                                            New Group
                                        </button>
```

After removal, the `<Show when={hasEditPermissions()}>` block should only contain the Import button.

**Step 3: Verify visually**

Confirm sidebar now shows: Canvas Selector, Swap Orientation, Import (edit+), Manage Users (admin), Share (admin), and the draft list. No Create Draft or New Group buttons.

**Step 4: Commit**

```bash
git add frontend/src/workflows/CanvasWorkflow.tsx
git commit -m "refactor: remove Create Draft and New Group sidebar buttons (use right-click)"
```

---

### Task 3: Purple-Theme the Canvas Sidebar Buttons

**Files:**
- Modify: `frontend/src/workflows/CanvasWorkflow.tsx` (all remaining sidebar buttons)

**Step 1: Replace teal with purple on all sidebar buttons**

There are 4 remaining buttons (Swap Orientation, Import, Manage Users, Share) plus the 2 share popup copy buttons. Replace every instance of `bg-teal-700` with `bg-purple-600` and `hover:bg-teal-400` with `hover:bg-purple-500` in this file.

Button class should change from:
```
rounded-md bg-teal-700 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-teal-400
```
to:
```
rounded-md bg-purple-600 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-purple-500
```

Also update the share popup copy buttons from:
```
rounded-md bg-teal-400 px-2 py-1 text-xs text-slate-50 hover:bg-teal-700
```
to:
```
rounded-md bg-purple-500 px-2 py-1 text-xs text-slate-50 hover:bg-purple-400
```

**Step 2: Verify visually**

All sidebar buttons should now be purple. Hover states should lighten to a brighter purple.

**Step 3: Commit**

```bash
git add frontend/src/workflows/CanvasWorkflow.tsx
git commit -m "style: purple-theme Canvas sidebar buttons"
```

---

### Task 4: Purple-Theme the Canvas Toolbar

**Files:**
- Modify: `frontend/src/Canvas.tsx:2263,2287` (toolbar input focus ring and Reset View button)

**Step 1: Update canvas name input focus ring**

Line 2263 - change `focus:border-teal-400` to `focus:border-purple-400`:

```tsx
// OLD:
class="rounded border border-slate-500 bg-slate-600 px-3 py-1.5 text-slate-50 shadow focus:border-teal-400 focus:outline-none"

// NEW:
class="rounded border border-slate-500 bg-slate-600 px-3 py-1.5 text-slate-50 shadow focus:border-purple-400 focus:outline-none"
```

**Step 2: Update Reset View button**

Line 2287 - change `bg-teal-700` to `bg-purple-600` and `hover:bg-teal-400` to `hover:bg-purple-500`:

```tsx
// OLD:
class="rounded border border-slate-500 bg-teal-700 px-3 py-1.5 text-slate-50 shadow hover:bg-teal-400"

// NEW:
class="rounded border border-slate-500 bg-purple-600 px-3 py-1.5 text-slate-50 shadow hover:bg-purple-500"
```

**Step 3: Update dialog Cancel buttons**

Line 2529 and 2582 - change both Cancel buttons from teal to purple:

```tsx
// OLD:
class="rounded bg-teal-700 px-4 py-2 text-slate-50 hover:bg-teal-400"

// NEW:
class="rounded bg-purple-600 px-4 py-2 text-slate-50 hover:bg-purple-500"
```

**Step 4: Verify visually**

- Canvas name input focus ring should glow purple
- Reset View button should be purple with lighter purple hover
- Dialog cancel buttons should be purple

**Step 5: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "style: purple-theme Canvas toolbar and dialog accents"
```

---

## Summary of Color Mapping

| Element | Old | New |
|---------|-----|-----|
| Sidebar buttons bg | `bg-teal-700` | `bg-purple-600` |
| Sidebar buttons hover | `hover:bg-teal-400` | `hover:bg-purple-500` |
| Share copy buttons bg | `bg-teal-400` | `bg-purple-500` |
| Share copy buttons hover | `hover:bg-teal-700` | `hover:bg-purple-400` |
| Toolbar focus ring | `focus:border-teal-400` | `focus:border-purple-400` |
| Reset View / Cancel bg | `bg-teal-700` | `bg-purple-600` |
| Reset View / Cancel hover | `hover:bg-teal-400` | `hover:bg-purple-500` |

## Files Changed

1. `frontend/src/components/FlowPanel.tsx` - sidebar width
2. `frontend/src/workflows/CanvasWorkflow.tsx` - remove buttons + purple theme
3. `frontend/src/Canvas.tsx` - toolbar + dialog purple accents
