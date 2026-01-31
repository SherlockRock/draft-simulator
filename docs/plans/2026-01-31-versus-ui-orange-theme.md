# Versus UI Refresh - Red Theme

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Re-theme the Versus workflow UI from teal accents to an orange color identity, mirroring the purple treatment done on the Canvas flow.

**Architecture:** Nine Versus-flow files need teal→orange class swaps. All changes are Tailwind class replacements - no logic changes.

**Tech Stack:** SolidJS, Tailwind CSS

**Scope:** Only Versus-flow pages and Versus-specific components. Shared components (GlobalNavBar, NavBar, SearchableSelect, etc.) are out of scope.

---

### Task 1: Red-Theme the Versus Draft View

**Files:**
- Modify: `frontend/src/pages/VersusDraftView.tsx`

**Step 1: Replace all teal classes with orange equivalents**

There are 5 teal references in this file:

| Line | Old | New |
|------|-----|-----|
| 649 | `text-teal-400 ... hover:text-teal-300` | `text-orange-400 ... hover:text-orange-300` |
| 673 | `text-teal-400 ... hover:text-teal-300` | `text-orange-400 ... hover:text-orange-300` |
| 941 | `border-teal-400 bg-slate-700/50 text-teal-400` | `border-orange-400 bg-slate-700/50 text-orange-400` |
| 952 | `border-teal-400 bg-slate-700/50 text-teal-400` | `border-orange-400 bg-slate-700/50 text-orange-400` |
| 1331 | `text-teal-400` | `text-orange-400` |

Use `replace_all` where safe; otherwise do targeted edits.

**Step 2: Verify** no teal references remain in this file.

**Step 3: Commit**
```bash
git commit -m "style: orange-theme VersusDraftView accents"
```

---

### Task 2: Red-Theme the Versus Series Overview

**Files:**
- Modify: `frontend/src/pages/VersusSeriesOverview.tsx`

**Step 1: Replace all teal classes with orange equivalents**

6 teal references:

| Line | Old | New |
|------|-----|-----|
| 163 | `border-teal-500/50 ... text-teal-300` | `border-orange-500/50 ... text-orange-300` |
| 217 | `bg-teal-600 ... hover:bg-teal-500` | `bg-orange-600 ... hover:bg-orange-500` |
| 372 | `bg-teal-500/20 text-teal-300` | `bg-orange-500/20 text-orange-300` |
| 378 | `bg-teal-500/20 text-teal-300` | `bg-orange-500/20 text-orange-300` |
| 422 | `bg-teal-500/20 text-teal-300` | `bg-orange-500/20 text-orange-300` |
| 441 | `bg-teal-500/20 text-teal-300` | `bg-orange-500/20 text-orange-300` |

**Step 2: Verify** no teal references remain in this file.

**Step 3: Commit**
```bash
git commit -m "style: orange-theme VersusSeriesOverview accents"
```

---

### Task 3: Red-Theme the Versus Role Selection

**Files:**
- Modify: `frontend/src/pages/VersusRoleSelection.tsx`

**Step 1: Replace the spinner border accent**

Line 67:
```
border-t-teal-400  →  border-t-orange-400
```

**Step 2: Commit**
```bash
git commit -m "style: orange-theme VersusRoleSelection spinner"
```

---

### Task 4: Red-Theme Versus Chat Panel

**Files:**
- Modify: `frontend/src/components/VersusChatPanel.tsx`

**Step 1: Replace teal classes**

| Line | Old | New |
|------|-----|-----|
| 81 | `focus:ring-teal-500/50` | `focus:ring-orange-500/50` |
| 89 | `bg-teal-700 ... hover:bg-teal-400` | `bg-orange-700 ... hover:bg-orange-400` |

**Step 2: Verify** no teal references remain.

**Step 3: Commit**
```bash
git commit -m "style: orange-theme VersusChatPanel"
```

---

### Task 5: Red-Theme Versus Timer

**Files:**
- Modify: `frontend/src/components/VersusTimer.tsx`

**Step 1: Replace timer text color**

Line 53:
```
text-teal-400  →  text-orange-400
```

**Step 2: Commit**
```bash
git commit -m "style: orange-theme VersusTimer accent"
```

---

### Task 6: Red-Theme Versus Modals (Pause + Pick Change)

**Files:**
- Modify: `frontend/src/components/PauseRequestModal.tsx`
- Modify: `frontend/src/components/PickChangeModal.tsx`

**Step 1: PauseRequestModal - replace teal with orange**

Line 61 — the accept/confirm button uses a teal border+bg+text pattern:
```
border-teal-600/50 bg-teal-600/10 ... text-teal-400 ... hover:border-teal-500 hover:bg-teal-600/20
→
border-orange-600/50 bg-orange-600/10 ... text-orange-400 ... hover:border-orange-500 hover:bg-orange-600/20
```

**Step 2: PickChangeModal - replace all teal with orange**

9 teal references across this file. Do a global replacement of `teal` → `orange` within this file since every instance is a color accent that should change:

| Pattern | Replacement |
|---------|-------------|
| `border-teal-600/40` | `border-orange-600/40` |
| `bg-teal-600/10` | `bg-orange-600/10` |
| `text-teal-400` | `text-orange-400` |
| `hover:border-teal-500/60` | `hover:border-orange-500/60` |
| `hover:bg-teal-600/15` | `hover:bg-orange-600/15` |
| `border-teal-500` | `border-orange-500` |
| `bg-teal-600/20` | `bg-orange-600/20` |
| `border-teal-600/50` | `border-orange-600/50` |
| `hover:border-teal-500` | `hover:border-orange-500` |
| `hover:bg-teal-600/20` | `hover:bg-orange-600/20` |

**Step 3: Verify** no teal references remain in either file.

**Step 4: Commit**
```bash
git commit -m "style: orange-theme Versus modals (PauseRequest + PickChange)"
```

---

### Task 7: Red-Theme Versus Draft Dialogs (Create + Edit)

**Files:**
- Modify: `frontend/src/components/CreateVersusDraftDialog.tsx`
- Modify: `frontend/src/components/EditVersusDraftDialog.tsx`

**Step 1: Replace teal with orange in both files**

Both files have the same two patterns:

Checkbox styling (line ~267/280):
```
text-teal-500 focus:ring-teal-500  →  text-orange-500 focus:ring-orange-500
```

Submit button (line ~290/303):
```
bg-teal-600 ... hover:bg-teal-500  →  bg-orange-600 ... hover:bg-orange-500
```

**Step 2: Verify** no teal references remain in either file.

**Step 3: Commit**
```bash
git commit -m "style: orange-theme Versus draft dialogs (Create + Edit)"
```

---

## Summary of Color Mapping

| Element | Old | New |
|---------|-----|-----|
| Text accents | `text-teal-400` | `text-orange-400` |
| Text accents (light) | `text-teal-300` | `text-orange-300` |
| Button bg (dark) | `bg-teal-700` | `bg-orange-700` |
| Button bg (medium) | `bg-teal-600` | `bg-orange-600` |
| Button hover | `hover:bg-teal-500` | `hover:bg-orange-500` |
| Button hover (light) | `hover:bg-teal-400` | `hover:bg-orange-400` |
| Borders | `border-teal-*` | `border-orange-*` (same shade) |
| Focus rings | `focus:ring-teal-*` | `focus:ring-orange-*` (same shade) |
| Translucent bg | `bg-teal-*/opacity` | `bg-orange-*/opacity` (same shade+opacity) |

## Files Changed

1. `frontend/src/pages/VersusDraftView.tsx`
2. `frontend/src/pages/VersusSeriesOverview.tsx`
3. `frontend/src/pages/VersusRoleSelection.tsx`
4. `frontend/src/components/VersusChatPanel.tsx`
5. `frontend/src/components/VersusTimer.tsx`
6. `frontend/src/components/PauseRequestModal.tsx`
7. `frontend/src/components/PickChangeModal.tsx`
8. `frontend/src/components/CreateVersusDraftDialog.tsx`
9. `frontend/src/components/EditVersusDraftDialog.tsx`
