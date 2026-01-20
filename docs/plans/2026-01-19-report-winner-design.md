# Report Winner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add inline winner reporting for versus drafts from both draft view and series overview, with real-time socket updates.

**Architecture:** Create a reusable `WinnerReporter` component with permission-aware UI. Backend handles winner updates via socket event with permission validation. VersusWorkflow listens for updates and syncs context.

**Tech Stack:** SolidJS, Socket.io, Express/Sequelize

---

## Task 1: Add Socket Handler for Winner Reporting

**Files:**
- Modify: `backend/socketHandlers/versusHandlers.js:957-973` (add after sendVersusMessage handler)

**Step 1: Add versusReportWinner socket handler**

Add this handler before the closing brace of `setupVersusHandlers`:

```javascript
// Report winner for a draft
socket.on("versusReportWinner", async (data) => {
  try {
    const { versusDraftId, draftId, winner } = data;

    if (!["blue", "red"].includes(winner)) {
      return socket.emit("versusError", { error: "Invalid winner value" });
    }

    const draft = await Draft.findByPk(draftId);
    if (!draft) {
      return socket.emit("versusError", { error: "Draft not found" });
    }

    if (!draft.completed) {
      return socket.emit("versusError", { error: "Draft is not completed" });
    }

    const versusDraft = await VersusDraft.findByPk(versusDraftId, {
      include: [{ model: Draft, as: "Drafts" }],
      order: [[{ model: Draft, as: "Drafts" }, "seriesIndex", "ASC"]],
    });

    if (!versusDraft) {
      return socket.emit("versusError", { error: "Versus draft not found" });
    }

    // Get participant info for this socket
    const participant = versusSessionManager.getParticipantBySocket(
      versusDraftId,
      socket.id
    );

    const isCaptain =
      participant?.role === "blue_captain" ||
      participant?.role === "red_captain";
    const isOwner = socket.user?.id === versusDraft.owner_id;

    // Determine if this is the "current" game (latest completed, no newer completed drafts)
    const drafts = versusDraft.Drafts || [];
    const draftIndex = drafts.findIndex((d) => d.id === draftId);
    const hasNewerCompletedDraft = drafts
      .slice(draftIndex + 1)
      .some((d) => d.completed);

    // Permission check: current game = captains, past games = owner only
    const canReport = hasNewerCompletedDraft ? isOwner : isCaptain || isOwner;

    if (!canReport) {
      return socket.emit("versusError", {
        error: "You don't have permission to report the winner",
      });
    }

    // Update the draft winner
    await draft.update({ winner });

    // Broadcast to all participants
    io.to(`versus:${versusDraftId}`).emit("versusWinnerUpdate", {
      draftId,
      winner,
    });
  } catch (error) {
    console.error("Error reporting winner:", error);
    socket.emit("versusError", { error: "Failed to report winner" });
  }
});
```

**Step 2: Add getParticipantBySocket method to versusSessionManager**

Check if this method exists, if not add it to the session manager.

**Step 3: Verify handler works**

Run: `cd backend && node -c index.js`
Expected: No syntax errors

**Step 4: Commit**

```bash
git add backend/socketHandlers/versusHandlers.js
git commit -m "feat(versus): add socket handler for winner reporting"
```

---

## Task 2: Add getParticipantBySocket to Session Manager

**Files:**
- Modify: `backend/services/versusSessionManager.js`

**Step 1: Check if method exists**

Search for `getParticipantBySocket` in the file.

**Step 2: Add method if missing**

```javascript
getParticipantBySocket(versusDraftId, socketId) {
  const session = this.sessions.get(versusDraftId);
  if (!session) return null;
  return session.participants.get(socketId) || null;
}
```

**Step 3: Commit**

```bash
git add backend/services/versusSessionManager.js
git commit -m "feat(versus): add getParticipantBySocket helper"
```

---

## Task 3: Create WinnerReporter Component

**Files:**
- Create: `frontend/src/components/WinnerReporter.tsx`

**Step 1: Create the component**

```tsx
import { Component, Show, createSignal } from "solid-js";

interface WinnerReporterProps {
    draftId: string;
    blueTeamName: string;
    redTeamName: string;
    currentWinner: "blue" | "red" | null | undefined;
    canEdit: boolean;
    onReportWinner: (winner: "blue" | "red") => void;
    compact?: boolean;
}

export const WinnerReporter: Component<WinnerReporterProps> = (props) => {
    const [isChanging, setIsChanging] = createSignal(false);

    const handleSelect = (winner: "blue" | "red") => {
        props.onReportWinner(winner);
        setIsChanging(false);
    };

    const showButtons = () => !props.currentWinner || isChanging();

    return (
        <div class={props.compact ? "" : "space-y-2"}>
            <Show
                when={showButtons() && props.canEdit}
                fallback={
                    <Show when={props.currentWinner}>
                        <div
                            class={`flex items-center gap-2 ${props.compact ? "text-sm" : ""}`}
                        >
                            <span class="text-slate-400">Winner:</span>
                            <span
                                class={`font-medium ${
                                    props.currentWinner === "blue"
                                        ? "text-blue-400"
                                        : "text-red-400"
                                }`}
                            >
                                {props.currentWinner === "blue"
                                    ? props.blueTeamName
                                    : props.redTeamName}
                            </span>
                            <Show when={props.canEdit}>
                                <button
                                    onClick={() => setIsChanging(true)}
                                    class="text-xs text-slate-400 hover:text-slate-300"
                                >
                                    Change
                                </button>
                            </Show>
                        </div>
                    </Show>
                }
            >
                <div
                    class={`flex gap-2 ${props.compact ? "flex-row" : "flex-col"}`}
                >
                    <button
                        onClick={() => handleSelect("blue")}
                        class={`rounded-lg border-2 border-blue-600/50 bg-blue-600/10 font-semibold text-blue-400 transition-all hover:border-blue-500 hover:bg-blue-600/20 ${
                            props.compact ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm"
                        }`}
                    >
                        {props.blueTeamName} Won
                    </button>
                    <button
                        onClick={() => handleSelect("red")}
                        class={`rounded-lg border-2 border-red-600/50 bg-red-600/10 font-semibold text-red-400 transition-all hover:border-red-500 hover:bg-red-600/20 ${
                            props.compact ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm"
                        }`}
                    >
                        {props.redTeamName} Won
                    </button>
                </div>
            </Show>
        </div>
    );
};
```

**Step 2: Verify no syntax errors**

Run: `cd frontend && npx tsc --noEmit src/components/WinnerReporter.tsx`

**Step 3: Commit**

```bash
git add frontend/src/components/WinnerReporter.tsx
git commit -m "feat(versus): create WinnerReporter component"
```

---

## Task 4: Add Socket Listener to VersusWorkflow

**Files:**
- Modify: `frontend/src/workflows/VersusWorkflow.tsx:254-260`

**Step 1: Add versusWinnerUpdate listener**

In the socket listener setup effect (around line 254, after the other listeners), add:

```tsx
// Winner update handler
const handleWinnerUpdate = (data: { draftId: string; winner: "blue" | "red" }) => {
    setVersusContext((prev) => {
        if (!prev.versusDraft?.Drafts) return prev;
        return {
            ...prev,
            versusDraft: {
                ...prev.versusDraft,
                Drafts: prev.versusDraft.Drafts.map((d) =>
                    d.id === data.draftId ? { ...d, winner: data.winner } : d
                ),
            },
        };
    });
};
```

**Step 2: Register the listener**

Add after line 260 (after versusUserCountUpdate listener):

```tsx
sock.on("versusWinnerUpdate", handleWinnerUpdate);
```

**Step 3: Add cleanup**

In the onCleanup section (around line 282), add:

```tsx
sock.off("versusWinnerUpdate");
```

**Step 4: Commit**

```bash
git add frontend/src/workflows/VersusWorkflow.tsx
git commit -m "feat(versus): add socket listener for winner updates"
```

---

## Task 5: Add Permission Helper Function

**Files:**
- Create: `frontend/src/utils/versusPermissions.ts`

**Step 1: Create the helper**

```typescript
import { draft, VersusDraft } from "./types";

export function canReportWinner(
    targetDraft: draft,
    versusDraft: VersusDraft,
    myRole: "blue_captain" | "red_captain" | "spectator" | null,
    userId: string | null
): boolean {
    // Must be completed to report winner
    if (!targetDraft.completed) return false;

    const drafts = versusDraft.Drafts || [];
    const draftIndex = drafts.findIndex((d) => d.id === targetDraft.id);

    // Check if there's a newer completed draft
    const hasNewerCompletedDraft = drafts
        .slice(draftIndex + 1)
        .some((d) => d.completed);

    const isCaptain = myRole === "blue_captain" || myRole === "red_captain";
    const isOwner = userId === versusDraft.owner_id;

    // Past games: owner only. Current game: captains or owner.
    return hasNewerCompletedDraft ? isOwner : isCaptain || isOwner;
}
```

**Step 2: Commit**

```bash
git add frontend/src/utils/versusPermissions.ts
git commit -m "feat(versus): add canReportWinner permission helper"
```

---

## Task 6: Integrate WinnerReporter into VersusFlowPanelContent

**Files:**
- Modify: `frontend/src/components/VersusFlowPanelContent.tsx`

**Step 1: Add imports**

At the top of the file, add:

```tsx
import { WinnerReporter } from "./WinnerReporter";
import { canReportWinner } from "../utils/versusPermissions";
import { useUser } from "../userProvider";
```

**Step 2: Get user info**

Inside the component, after the existing context destructuring:

```tsx
const accessor = useUser();
const [user] = accessor();
const userId = createMemo(() => user()?.id || null);
```

**Step 3: Add canEdit memo**

```tsx
const canEditWinner = createMemo(() => {
    const draft = draftState()?.draft;
    const vd = versusDraft();
    if (!draft || !vd) return false;
    return canReportWinner(draft, vd, myRole(), userId());
});
```

**Step 4: Add handleReportWinner function**

```tsx
const handleReportWinner = (winner: "blue" | "red") => {
    const sock = socket();
    const vd = versusDraft();
    const draft = draftState()?.draft;
    if (!sock || !vd || !draft) return;

    sock.emit("versusReportWinner", {
        versusDraftId: vd.id,
        draftId: draft.id,
        winner,
    });
};
```

**Step 5: Add WinnerReporter in Draft Controls section**

After the PickChangeModal (around line 129), inside the Draft Controls section:

```tsx
{/* Winner Reporter - shown when draft is completed */}
<Show when={draftState()?.completed}>
    <WinnerReporter
        draftId={draftState()!.draft.id}
        blueTeamName={versusDraft()!.blueTeamName}
        redTeamName={versusDraft()!.redTeamName}
        currentWinner={draftState()!.draft.winner}
        canEdit={canEditWinner()}
        onReportWinner={handleReportWinner}
    />
</Show>
```

**Step 6: Update the Show condition for Draft Controls**

Change the existing condition to also show for spectators when draft is completed (so they can see the winner):

From:
```tsx
<Show when={isInDraftView() && draftState() && callbacks() && !isSpectator()}>
```

To:
```tsx
<Show when={isInDraftView() && draftState() && (callbacks() && !isSpectator() || draftState()?.completed)}>
```

**Step 7: Commit**

```bash
git add frontend/src/components/VersusFlowPanelContent.tsx
git commit -m "feat(versus): integrate WinnerReporter into FlowPanel draft controls"
```

---

## Task 7: Integrate WinnerReporter into VersusSeriesOverview

**Files:**
- Modify: `frontend/src/pages/VersusSeriesOverview.tsx`

**Step 1: Add imports**

```tsx
import { WinnerReporter } from "../components/WinnerReporter";
import { canReportWinner } from "../utils/versusPermissions";
import { useUser } from "../userProvider";
```

**Step 2: Add user context**

After the existing context hooks:

```tsx
const accessor = useUser();
const [user] = accessor();
const userId = createMemo(() => user()?.id || null);
```

**Step 3: Add socket access**

```tsx
const { versusContext, socket } = useVersusContext();
```

**Step 4: Add handleReportWinner function**

```tsx
const handleReportWinner = (draftId: string, winner: "blue" | "red") => {
    const sock = socket();
    const vd = versusDraft();
    if (!sock || !vd) return;

    sock.emit("versusReportWinner", {
        versusDraftId: vd.id,
        draftId,
        winner,
    });
};
```

**Step 5: Add WinnerReporter in game row**

In the game row JSX (around line 420-422, after the winner display), replace the existing winner Show block with:

```tsx
{/* Winner display / reporter */}
<Show when={draft.completed}>
    <div class="mt-1.5">
        <WinnerReporter
            draftId={draft.id}
            blueTeamName={versusDraft()!.blueTeamName}
            redTeamName={versusDraft()!.redTeamName}
            currentWinner={draft.winner}
            canEdit={canReportWinner(
                draft,
                versusDraft()!,
                myRole(),
                userId()
            )}
            onReportWinner={(winner) =>
                handleReportWinner(draft.id, winner)
            }
            compact={true}
        />
    </div>
</Show>
```

**Step 6: Remove old winner display block**

Remove the existing `<Show when={winner}>...</Show>` block (lines 406-422) since WinnerReporter now handles this.

**Step 7: Commit**

```bash
git add frontend/src/pages/VersusSeriesOverview.tsx
git commit -m "feat(versus): integrate WinnerReporter into series overview"
```

---

## Task 8: Update Draft State Registration to Include Winner

**Files:**
- Modify: `frontend/src/pages/VersusDraftView.tsx`

**Step 1: Ensure winner is included in registered draft state**

Find the `registerDraftState` call and verify the draft object includes the winner field. The draft resource should already include it from the API response.

**Step 2: Verify winner updates propagate**

Check that when `versusWinnerUpdate` is received, the draft state is updated. Since we're updating via VersusWorkflow context, we need to ensure VersusDraftView reacts to those changes.

**Step 3: Commit if changes needed**

```bash
git add frontend/src/pages/VersusDraftView.tsx
git commit -m "feat(versus): ensure winner state propagates in draft view"
```

---

## Task 9: Verify Full Integration

**Step 1: Start backend**

```bash
cd backend && node index.js
```

**Step 2: Start frontend**

```bash
cd frontend && npm run dev
```

**Step 3: Manual testing checklist**

1. Create a versus draft, complete a draft (all 20 picks)
2. As captain, verify "Report Winner" buttons appear in FlowPanel
3. Click a team button, verify winner is saved and displayed
4. Click "Change", verify buttons reappear
5. Navigate to Series Overview, verify winner shows inline
6. Complete another draft, verify first draft now requires owner to edit
7. As spectator, verify winner is visible but no edit controls

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(versus): complete winner reporting feature"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Socket handler for versusReportWinner | backend/socketHandlers/versusHandlers.js |
| 2 | Add getParticipantBySocket helper | backend/services/versusSessionManager.js |
| 3 | Create WinnerReporter component | frontend/src/components/WinnerReporter.tsx |
| 4 | Add socket listener in VersusWorkflow | frontend/src/workflows/VersusWorkflow.tsx |
| 5 | Create permission helper | frontend/src/utils/versusPermissions.ts |
| 6 | Integrate into FlowPanel | frontend/src/components/VersusFlowPanelContent.tsx |
| 7 | Integrate into SeriesOverview | frontend/src/pages/VersusSeriesOverview.tsx |
| 8 | Verify draft state includes winner | frontend/src/pages/VersusDraftView.tsx |
| 9 | Full integration testing | - |
