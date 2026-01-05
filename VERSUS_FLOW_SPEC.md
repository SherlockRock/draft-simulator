# Versus Flow Feature Specification

## 1. Overview

The Versus Flow feature enables head-to-head competitive League of Legends draft simulations between two teams (Blue and Red) with real-time pick/ban mechanics, timed selections, and series management.

### Key Features
- Best-of-N series support (user-defined length)
- Role-based access (Blue Captain, Red Captain, Spectator)
- Timed pick/ban phase (30 seconds per pick)
- Competitive vs Scrim modes
- Pause system with approval mechanics
- Pick modification requests
- Real-time updates for all participants
- Series navigation and progress tracking

---

## 2. Data Models

### 2.1 VersusDraft Model (NEW)

**Location**: `backend/models/VersusDraft.js`

```javascript
{
  id: UUID (primary key),
  name: STRING (required),
  blueTeamName: STRING (required),
  redTeamName: STRING (required),
  description: TEXT (nullable),
  length: INTEGER (required), // Number of drafts in series (e.g., 3 for Bo3, 5 for Bo5)
  competitive: BOOLEAN (default: false), // true = competitive, false = scrim
  owner_id: UUID (foreign key to User),
  blueTeamLink: STRING (unique, generated on creation),
  redTeamLink: STRING (unique, generated on creation),
  spectatorLink: STRING (unique, generated on creation),
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP
}
```

**Relationships**:
- `hasMany(Draft)` - One VersusDraft has many Drafts (equal to `length`)
- `belongsTo(User)` - Owner of the versus draft

### 2.2 Draft Model Updates (EXISTING)

**Location**: `backend/models/Draft.js`

**New fields to add**:
```javascript
{
  versus_draft_id: UUID (foreign key to VersusDraft, nullable),
  seriesIndex: INTEGER (nullable), // Position in series (0-based: 0, 1, 2 for Bo3)
  completed: BOOLEAN (default: false),
  winner: STRING (nullable, enum: 'blue' | 'red' | null),
  currentPickIndex: INTEGER (default: 0), // Index in pickOrder (0-19)
  timerStartedAt: TIMESTAMP (nullable), // When current pick timer started
  isPaused: BOOLEAN (default: false),
  pauseRequestedBy: STRING (nullable, enum: 'blue' | 'red' | null),

  // For pick order - NEW FIELD
  pickOrder: ARRAY of OBJECTS (default: generatePickOrder())
  // Structure: [
  //   { team: 'blue', type: 'ban', slot: 0 },
  //   { team: 'red', type: 'ban', slot: 0 },
  //   ...
  // ]
}
```

**Pick Order Array** (20 items total):
```javascript
// Helper function to generate pick order
function generatePickOrder() {
  const order = [];

  // Phase 1: Blue ban, Red ban (3 each, alternating)
  for (let i = 0; i < 3; i++) {
    order.push({ team: 'blue', type: 'ban', slot: i });
    order.push({ team: 'red', type: 'ban', slot: i });
  }

  // Phase 2: Blue pick, Red pick (3 each, alternating)
  for (let i = 0; i < 3; i++) {
    order.push({ team: 'blue', type: 'pick', slot: i });
    order.push({ team: 'red', type: 'pick', slot: i });
  }

  // Phase 3: Red ban, Blue ban (2 each, alternating)
  for (let i = 3; i < 5; i++) {
    order.push({ team: 'red', type: 'ban', slot: i });
    order.push({ team: 'blue', type: 'ban', slot: i });
  }

  // Phase 4: Red pick, Blue pick (2 each, alternating)
  for (let i = 3; i < 5; i++) {
    order.push({ team: 'red', type: 'pick', slot: i });
    order.push({ team: 'blue', type: 'pick', slot: i });
  }

  return order;
}
```

**Picks Array Mapping** (existing field, different interpretation for versus):
```javascript
// picks[0-9]: Bans (5 blue, 5 red)
// picks[10-14]: Blue picks
// picks[15-19]: Red picks

// For versus drafts, maintain this structure but populate in pick order
```

### 2.3 VersusParticipant Model (NEW)

**Location**: `backend/models/VersusParticipant.js`

Tracks active participants in a versus draft.

```javascript
{
  id: UUID (primary key),
  versus_draft_id: UUID (foreign key to VersusDraft, required),
  user_id: UUID (foreign key to User, nullable), // Null for anonymous participants
  role: STRING (enum: 'blue_captain' | 'red_captain' | 'spectator', required),
  socketId: STRING (nullable), // Current socket connection ID
  isConnected: BOOLEAN (default: true),
  lastSeenAt: TIMESTAMP,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP
}
```

**Constraints**:
- Unique constraint on `(versus_draft_id, role)` for captain roles
- Only ONE blue_captain and ONE red_captain per versus draft at a time

### 2.4 PickChangeRequest Model (NEW)

**Location**: `backend/models/PickChangeRequest.js`

Tracks requests to modify locked picks.

```javascript
{
  id: UUID (primary key),
  draft_id: UUID (foreign key to Draft, required),
  requestingTeam: STRING (enum: 'blue' | 'red', required),
  pickIndex: INTEGER (required), // Index in picks array (0-19)
  oldChampion: STRING (nullable), // Current champion index
  newChampion: STRING (required), // Requested champion index
  status: STRING (enum: 'pending' | 'approved' | 'rejected', default: 'pending'),
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP
}
```

---

## 3. User Flows

### 3.1 Versus Draft Creation Flow

**Route**: `/versus/new`

**UI Component**: `VersusCreateForm.tsx`

**Fields**:
- Name (text input, required)
- Blue Team Name (text input, required, default: "Blue Team")
- Red Team Name (text input, required, default: "Red Team")
- Description (textarea, optional)
- Series Length (dropdown: 1, 3, 5, 7, default: 3)
- Mode (toggle: Competitive / Scrim, default: Scrim)

**Submit Action**:
1. POST `/api/versus-drafts` with form data
2. Backend creates:
   - 1 VersusDraft record
   - `length` number of Draft records (with `versus_draft_id` set, `type: 'versus'`)
   - 3 unique links (blueTeamLink, redTeamLink, spectatorLink)
3. Redirect to `/versus/:versusDraftId` (series overview page)

### 3.2 Role Selection Flow

**Route**: `/versus/join/:linkToken`

**UI Component**: `VersusRoleSelection.tsx`

**Process**:
1. Decode `linkToken` to determine which link type (blue/red/spectator)
2. Show role selection screen:
   - If blue link → "Join as Blue Team Captain" button (disabled if role taken)
   - If red link → "Join as Red Team Captain" button (disabled if role taken)
   - If spectator link → "Join as Spectator" button (always enabled)
3. On role selection:
   - Create/update VersusParticipant record
   - Establish socket connection with role
   - Redirect to series overview: `/versus/:versusDraftId`

**Role Locking**:
- Query VersusParticipant for existing captain with `isConnected: true`
- If exists, disable captain role button
- If captain disconnects (`isConnected: false`), unlock role

### 3.3 Series Overview Page

**Route**: `/versus/:versusDraftId`

**UI Component**: `VersusSeriesOverview.tsx`

**Layout**:
```
┌─────────────────────────────────────────┐
│  Series Name                            │
│  Blue Team vs Red Team - Best of X      │
│  Mode: Competitive | Scrim              │
├─────────────────────────────────────────┤
│  Draft 1: [Complete] Winner: Blue       │
│  Draft 2: [In Progress] → Current       │
│  Draft 3: [Locked] (Previous incomplete)│
├─────────────────────────────────────────┤
│  Links (if owner):                      │
│  Blue: [Copy Link]                      │
│  Red: [Copy Link]                       │
│  Spectator: [Copy Link]                 │
└─────────────────────────────────────────┘
```

**Navigation Rules**:
- Click "Draft 1" → Navigate to `/versus/:versusDraftId/draft/:draftId`
- Draft N is clickable/accessible only if drafts 1 through N-1 are `completed: true`
- Current/active draft is highlighted
- Show draft status: "Not Started" | "In Progress" | "Complete"
- Show winner badge if `winner` field is set

### 3.4 Versus Draft View

**Route**: `/versus/:versusDraftId/draft/:draftId`

**UI Component**: `VersusDraft.tsx`

**Layout** (similar to standalone draft, with modifications):

```
┌──────────────────────────────────────────────────────────────┐
│  Top Bar:                                                     │
│  [Back to Series] | Draft 2 of 3 | Timer: 00:23 | [Pause]   │
│  Blue Team vs Red Team                                       │
│  Your Role: Blue Captain | Red Captain: ✓ Connected          │
├──────────────────────────────────────────────────────────────┤
│  Bans Section (10% height):                                  │
│  Blue Bans: [1] [2] [3] [4] [5]  |  Red Bans: [1] [2] [3] [4] [5] │
│  Current Pick Indicator: ^ (blinks under active slot)        │
├──────────────────────────────────────────────────────────────┤
│  Main Section (80% height):                                  │
│  ┌──────┬────────────────────────┬──────┐                   │
│  │ Blue │   Champion Selection   │ Red  │                   │
│  │ Picks│   (Search/Grid)        │ Picks│                   │
│  │ [1]  │   [Champion Grid]      │ [1]  │                   │
│  │ [2]  │   [Champion Grid]      │ [2]  │                   │
│  │ [3]  │   [Champion Grid]      │ [3]  │                   │
│  │ [4]  │   [Champion Grid]      │ [4]  │                   │
│  │ [5]  │   [Champion Grid]      │ [5]  │                   │
│  └──────┴────────────────────────┴──────┘                   │
├──────────────────────────────────────────────────────────────┤
│  Chat Panel (10% height):                                    │
│  [Chat messages...] [Input field]                           │
└──────────────────────────────────────────────────────────────┘
```

**Key UI Elements**:

1. **Timer Display**:
   - Format: "00:23" (MM:SS)
   - Red color when < 10 seconds
   - Synced from server (`timerStartedAt` + 30s - current time)

2. **Current Pick Indicator**:
   - Blinking border/highlight on the active slot
   - Determined by `currentPickIndex` in pickOrder
   - Animation: CSS animation (client-side)

3. **Pause Button**:
   - If Scrim mode: Click to toggle pause immediately
   - If Competitive mode: Click to request pause, shows "Waiting for other team..."
   - Shows "[Resume]" when paused

4. **Connection Indicators**:
   - "Blue Captain: ✓ Connected" or "Blue Captain: ✗ Disconnected"
   - "Red Captain: ✓ Connected" or "Red Captain: ✗ Disconnected"

5. **Champion Selection**:
   - If current pick is YOUR team AND you're captain: Enable selection
   - Otherwise: Disabled (view-only)
   - Hover state is tracked and sent to server for auto-lock

6. **Pick/Ban Slots**:
   - Show champion portrait when filled
   - Empty state: Team color background
   - Completed picks: Static (no animation)
   - Current pick: Blinking border

7. **Navigation Buttons** (appear when draft is completed):
   - [Previous Draft] (if seriesIndex > 0)
   - [Next Draft] (if seriesIndex < length - 1)
   - [Back to Series]

8. **Winner Declaration** (appears when all 20 picks complete):
   - Modal/overlay: "Draft Complete! Who won?"
   - Buttons: [Blue Team] [Red Team] [Skip]
   - Only captains can declare winner
   - Sets `completed: true` and `winner: 'blue' | 'red' | null`

---

## 4. Backend API Endpoints

### 4.1 Versus Draft Endpoints

**POST `/api/versus-drafts`**
- Body: `{ name, blueTeamName, redTeamName, description, length, competitive }`
- Auth: Required
- Returns: Created VersusDraft with links
- Side effects: Creates `length` Draft records

**GET `/api/versus-drafts/:id`**
- Auth: Optional (public if has link)
- Returns: VersusDraft with related Drafts (ordered by seriesIndex)

**GET `/api/versus-drafts/:id/drafts`**
- Auth: Optional
- Returns: Array of Drafts for this series

**PUT `/api/versus-drafts/:id`**
- Body: `{ name?, description?, competitive? }`
- Auth: Owner only
- Returns: Updated VersusDraft

**DELETE `/api/versus-drafts/:id`**
- Auth: Owner only
- Side effects: Deletes related Drafts and VersusParticipants

### 4.2 Versus Draft Join/Participant Endpoints

**POST `/api/versus-drafts/join`**
- Body: `{ linkToken, role }`
- Auth: Optional (allows anonymous)
- Validates:
  - Link token is valid
  - Role matches link type
  - For captains: Role not already taken by connected user
- Creates/updates VersusParticipant
- Returns: `{ versusDraftId, role, participantId }`

**GET `/api/versus-drafts/:id/participants`**
- Returns: List of current participants with connection status

**POST `/api/versus-drafts/:id/release-role`**
- Body: `{ role: 'blue_captain' | 'red_captain' }`
- Auth: Owner only (or auto on disconnect)
- Sets participant `isConnected: false`
- Allows another user to claim role

### 4.3 Draft Endpoints (Versus-specific)

**POST `/api/drafts/:id/complete`**
- Body: `{ winner?: 'blue' | 'red' }`
- Auth: Participant (captain only)
- Sets `completed: true`, `winner` field
- Returns: Updated Draft

**POST `/api/drafts/:id/request-pick-change`**
- Body: `{ pickIndex, newChampion }`
- Auth: Participant (captain only)
- Validates: Draft is completed
- If Scrim mode: Apply change immediately
- If Competitive mode: Create PickChangeRequest, notify other team
- Returns: PickChangeRequest or updated Draft

**POST `/api/drafts/:id/respond-pick-change/:requestId`**
- Body: `{ approved: boolean }`
- Auth: Participant (opposite team captain)
- If approved: Apply change to draft, update request status
- If rejected: Update request status
- Returns: Updated PickChangeRequest

**POST `/api/drafts/:id/pause`**
- Auth: Participant (captain only)
- If Scrim mode: Toggle `isPaused` immediately
- If Competitive mode: Set `pauseRequestedBy` to team, emit to other captain
- Returns: Updated Draft

**POST `/api/drafts/:id/approve-pause`**
- Auth: Participant (opposite team captain)
- Sets `isPaused: true`, clears `pauseRequestedBy`
- Returns: Updated Draft

---

## 5. Socket.IO Events (Real-time)

### 5.1 Connection & Rooms

**Client → Server: `joinVersusDraft`**
```javascript
{
  versusDraftId: string,
  draftId: string,
  role: 'blue_captain' | 'red_captain' | 'spectator',
  participantId: string
}
```
- Server joins client to rooms: `versus:${versusDraftId}` and `draft:${draftId}`
- Server updates VersusParticipant: `socketId = socket.id`, `isConnected = true`
- Server broadcasts `participantConnected` to room

**Client → Server: `leaveVersusDraft`**
```javascript
{ versusDraftId: string, participantId: string }
```
- Server leaves rooms
- Server updates VersusParticipant: `isConnected = false`
- Server broadcasts `participantDisconnected` to room

**On socket disconnect**:
- Automatically set participant `isConnected: false`
- Broadcast `participantDisconnected`
- If captain disconnects, unlock role for others

### 5.2 Draft Updates

**Client → Server: `versusPick`**
```javascript
{
  draftId: string,
  pickIndex: number, // Index in picks array (0-19)
  champion: string, // Champion index
  role: 'blue_captain' | 'red_captain'
}
```
- Server validates:
  - Current pick belongs to this team (via pickOrder[currentPickIndex])
  - Timer hasn't expired
  - Draft not paused
  - Champion not already picked
- Server updates picks array
- Server increments `currentPickIndex`
- Server sets `timerStartedAt` to current time (start next timer)
- If `currentPickIndex >= 20`: Mark draft as completed
- Broadcast `draftUpdate` to all in room

**Server → Clients: `draftUpdate`**
```javascript
{
  draftId: string,
  picks: string[],
  currentPickIndex: number,
  timerStartedAt: timestamp,
  isPaused: boolean,
  completed: boolean
}
```
- All clients update their local draft state
- Restart timer countdown on client

**Client → Server: `hoverChampion`**
```javascript
{
  draftId: string,
  champion: string | null, // null when unhover
  role: 'blue_captain' | 'red_captain'
}
```
- Server stores current hover state per captain
- Used for auto-lock on timer expiry

**Server Timer Logic** (every 1 second):
- For each active versus draft (not paused, not completed):
  - Check if `currentTime - timerStartedAt > 30000` (30 seconds)
  - If yes:
    - Get current pick from pickOrder[currentPickIndex]
    - Get hovered champion for that team's captain
    - If hovered champion exists: Lock it in
    - If no hovered champion: Leave slot empty (or pick random?)
    - Increment currentPickIndex
    - Broadcast draftUpdate

### 5.3 Pause System

**Client → Server: `requestPause`**
```javascript
{ draftId: string, role: 'blue_captain' | 'red_captain' }
```
- If Scrim mode:
  - Toggle `isPaused`
  - Clear `timerStartedAt` if paused, set if resumed
  - Broadcast `draftUpdate`
- If Competitive mode:
  - Set `pauseRequestedBy: team`
  - Broadcast `pauseRequested` to room

**Server → Clients: `pauseRequested`**
```javascript
{ draftId: string, team: 'blue' | 'red' }
```
- Show notification to other captain: "Blue Team requested pause"

**Client → Server: `approvePause`**
```javascript
{ draftId: string, role: 'blue_captain' | 'red_captain' }
```
- Validate caller is opposite team
- Set `isPaused: true`
- Clear `pauseRequestedBy`
- Clear `timerStartedAt`
- Broadcast `draftUpdate`

### 5.4 Pick Change Requests

**Client → Server: `requestPickChange`**
```javascript
{
  draftId: string,
  pickIndex: number,
  newChampion: string,
  role: 'blue_captain' | 'red_captain'
}
```
- If Scrim mode: Apply immediately
- If Competitive mode: Create PickChangeRequest, broadcast to other captain

**Server → Clients: `pickChangeRequested`**
```javascript
{
  requestId: string,
  draftId: string,
  team: 'blue' | 'red',
  pickIndex: number,
  oldChampion: string,
  newChampion: string
}
```
- Show modal to other captain

**Client → Server: `respondPickChange`**
```javascript
{
  requestId: string,
  approved: boolean,
  role: 'blue_captain' | 'red_captain'
}
```
- If approved: Apply change, broadcast draftUpdate
- If rejected: Broadcast rejection

### 5.5 Chat

**Client → Server: `sendVersusMessage`**
```javascript
{
  versusDraftId: string,
  message: string,
  role: 'blue_captain' | 'red_captain' | 'spectator',
  username?: string
}
```

**Server → Clients: `newVersusMessage`**
```javascript
{
  username: string,
  role: string,
  message: string,
  timestamp: number
}
```
- Broadcast to all in `versus:${versusDraftId}` room

---

## 6. Frontend Components

### 6.1 New Components

**`VersusFlowDashboard.tsx`**
- Route: `/versus`
- Shows list of user's versus drafts (similar to DraftFlowDashboard)
- "Create New Versus Draft" button

**`VersusCreateForm.tsx`**
- Route: `/versus/new`
- Form fields as described in section 3.1

**`VersusRoleSelection.tsx`**
- Route: `/versus/join/:linkToken`
- Role selection UI with availability checking

**`VersusSeriesOverview.tsx`**
- Route: `/versus/:versusDraftId`
- Series navigation and status display
- Link sharing UI (for owner)

**`VersusDraft.tsx`**
- Route: `/versus/:versusDraftId/draft/:draftId`
- Main draft interface with:
  - Timer component
  - Current pick indicator
  - Permission-based champion selection
  - Pause button
  - Connection status indicators
  - Winner declaration modal
  - Chat panel

**`VersusTimer.tsx`**
- Reusable timer component
- Props: `timerStartedAt`, `duration`, `isPaused`
- Displays countdown with color coding

**`VersusChatPanel.tsx`**
- Reusable chat component
- Shows messages with role badges
- Input field for sending messages

**`PickChangeModal.tsx`**
- Modal for requesting pick changes
- Shows pending requests
- Approve/reject buttons for receiving team

**`PauseRequestModal.tsx`**
- Modal showing pause request from other team
- Approve/reject buttons

### 6.2 Component State Management

Use SolidJS signals and createResource for reactive state:

```typescript
// In VersusDraft.tsx
const [versusDraft] = createResource(() => params.versusDraftId, fetchVersusDraft);
const [draft, { mutate: mutateDraft }] = createResource(() => params.draftId, fetchDraft);
const [participants, { mutate: mutateParticipants }] = createResource(
  () => params.versusDraftId,
  fetchParticipants
);

// Socket listeners
onMount(() => {
  socket.emit('joinVersusDraft', {
    versusDraftId: params.versusDraftId,
    draftId: params.draftId,
    role: userRole,
    participantId: participantId
  });

  socket.on('draftUpdate', (data) => {
    mutateDraft(data);
  });

  socket.on('participantConnected', (data) => {
    mutateParticipants((prev) => [...prev, data]);
  });

  // ... more listeners
});

onCleanup(() => {
  socket.emit('leaveVersusDraft', { versusDraftId, participantId });
  socket.off('draftUpdate');
  socket.off('participantConnected');
  // ... cleanup
});
```

---

## 7. Implementation Phases

### Phase 1: Data Models & Backend Structure (Week 1)
- [ ] Create VersusDraft model
- [ ] Create VersusParticipant model
- [ ] Create PickChangeRequest model
- [ ] Update Draft model with new fields
- [ ] Create versus draft API endpoints
- [ ] Create join/participant endpoints
- [ ] Set up database migrations

### Phase 2: Link Generation & Role Selection (Week 1-2)
- [ ] Implement link token generation/validation
- [ ] Create role selection page
- [ ] Implement participant tracking
- [ ] Handle role locking/unlocking on disconnect

### Phase 3: Series Overview & Navigation (Week 2)
- [ ] Create VersusFlowDashboard component
- [ ] Create VersusCreateForm component
- [ ] Create VersusSeriesOverview component
- [ ] Implement series navigation logic
- [ ] Implement draft completion unlocking

### Phase 4: Draft Interface & Pick Order (Week 3)
- [ ] Create VersusDraft component (adapt from Draft.tsx)
- [ ] Implement pickOrder array generation
- [ ] Map pickOrder to UI slots (bans/picks)
- [ ] Implement current pick indicator (client animation)
- [ ] Implement permission-based selection (captains only)

### Phase 5: Timer & Server-side Control (Week 3-4)
- [ ] Create VersusTimer component
- [ ] Implement server-side timer logic (background job)
- [ ] Implement hover state tracking
- [ ] Implement auto-lock on timer expiry
- [ ] Implement timer reset on each pick

### Phase 6: Pause System (Week 4)
- [ ] Implement Scrim mode immediate pause
- [ ] Implement Competitive mode pause requests
- [ ] Create PauseRequestModal component
- [ ] Handle pause approval/rejection

### Phase 7: Pick Change System (Week 5)
- [ ] Implement Scrim mode immediate changes
- [ ] Implement Competitive mode change requests
- [ ] Create PickChangeModal component
- [ ] Handle change approval/rejection

### Phase 8: Real-time & Chat (Week 5-6)
- [ ] Set up Socket.IO rooms for versus drafts
- [ ] Implement all socket event handlers
- [ ] Create VersusChatPanel component
- [ ] Implement connection status indicators
- [ ] Handle reconnection scenarios

### Phase 9: Winner Declaration & Completion (Week 6)
- [ ] Implement draft completion detection (20 picks done)
- [ ] Create winner declaration modal
- [ ] Implement winner recording
- [ ] Implement next/previous navigation buttons
- [ ] Handle series completion

### Phase 10: Testing & Polish (Week 7)
- [ ] End-to-end testing of full flow
- [ ] Test competitive vs scrim mode differences
- [ ] Test disconnect/reconnect scenarios
- [ ] Test timer synchronization
- [ ] UI/UX polish and responsive design
- [ ] Performance optimization

---

## 8. Technical Considerations

### 8.1 Pick Order Mapping

Current draft structure uses:
- `picks[0-9]`: Bans (5 blue, 5 red)
- `picks[10-14]`: Blue picks
- `picks[15-19]`: Red picks

For versus drafts, we need to map the alternating pick order to this structure:

```javascript
function mapPickOrderToPicksArray(pickOrder, currentPickIndex, champion) {
  const currentPick = pickOrder[currentPickIndex];
  const { team, type, slot } = currentPick;

  let picksIndex;

  if (type === 'ban') {
    // Bans: picks[0-9]
    // Blue bans: 0-4, Red bans: 5-9
    picksIndex = team === 'blue' ? slot : slot + 5;
  } else {
    // Picks: picks[10-19]
    // Blue picks: 10-14, Red picks: 15-19
    picksIndex = team === 'blue' ? slot + 10 : slot + 15;
  }

  return picksIndex;
}
```

### 8.2 Timer Synchronization

To ensure timer is synchronized across all clients:

1. **Server stores** `timerStartedAt` timestamp (when current pick timer started)
2. **Clients calculate** remaining time: `30000 - (Date.now() - timerStartedAt)`
3. **Server validates** picks are within time window
4. **Server-side job** runs every 1 second to check for timer expiry

```javascript
// Server-side (pseudo-code)
setInterval(() => {
  const activeDrafts = await Draft.findAll({
    where: {
      type: 'versus',
      completed: false,
      isPaused: false,
      timerStartedAt: { [Op.not]: null }
    }
  });

  for (const draft of activeDrafts) {
    const elapsed = Date.now() - draft.timerStartedAt;
    if (elapsed > 30000) {
      await handleTimerExpiry(draft);
    }
  }
}, 1000);
```

### 8.3 Hover State for Auto-lock

Clients send hover updates, server stores in memory (not database):

```javascript
// Server-side in-memory store
const hoverStates = new Map(); // draftId -> { blue: championIndex, red: championIndex }

socket.on('hoverChampion', ({ draftId, champion, role }) => {
  const team = role.includes('blue') ? 'blue' : 'red';

  if (!hoverStates.has(draftId)) {
    hoverStates.set(draftId, { blue: null, red: null });
  }

  hoverStates.get(draftId)[team] = champion;
});

async function handleTimerExpiry(draft) {
  const currentPick = draft.pickOrder[draft.currentPickIndex];
  const hoverState = hoverStates.get(draft.id);
  const hoveredChampion = hoverState?.[currentPick.team];

  if (hoveredChampion) {
    await lockInPick(draft, hoveredChampion);
  } else {
    // Leave empty or pick random
    await lockInPick(draft, ''); // Empty pick
  }
}
```

### 8.4 Competitive vs Scrim Mode Logic

Use a helper function to determine action behavior:

```javascript
function requiresApproval(draft, action) {
  if (!draft.competitive) return false; // Scrim mode = no approval needed

  const actionsRequiringApproval = ['pause', 'pickChange'];
  return actionsRequiringApproval.includes(action);
}
```

### 8.5 Role Unlocking on Disconnect

```javascript
socket.on('disconnect', async () => {
  const participant = await VersusParticipant.findOne({
    where: { socketId: socket.id }
  });

  if (participant) {
    await participant.update({ isConnected: false, lastSeenAt: new Date() });

    // Broadcast to room
    io.to(`versus:${participant.versus_draft_id}`).emit('participantDisconnected', {
      role: participant.role,
      participantId: participant.id
    });
  }
});
```

---

## 9. Open Questions / Edge Cases

### 9.1 Empty Pick Handling
**Question**: If timer expires and no champion is hovered, should we:
- Leave slot empty (null)?
- Pick a random available champion?
- Skip and move to next pick?

**Recommendation**: Leave empty for competitive integrity. Teams can request change later if needed.

### 9.2 Mid-draft Disconnection Recovery
**Question**: If blue captain disconnects at pick 10/20 and someone else joins as blue captain, should they be able to continue?

**Recommendation**: Yes, new captain inherits draft state and can continue from current pick.

### 9.3 Series Winner Tracking
**Question**: Should we auto-calculate series winner (e.g., first to win 2 in Bo3)?

**Recommendation**: Add a `seriesWinner` field to VersusDraft that gets set when a team reaches majority wins. Show prominently on series overview.

### 9.4 Draft Deletion
**Question**: Can owner delete an in-progress versus draft? What happens to participants?

**Recommendation**: Allow deletion but broadcast `versusDeleted` event to all participants, kicking them out gracefully.

### 9.5 Simultaneous Pick Change Requests
**Question**: What if both teams request pick changes at the same time?

**Recommendation**: Queue requests, handle one at a time in order received.

---

## 10. Success Metrics

### 10.1 Functionality Checklist
- [ ] Users can create versus drafts with custom settings
- [ ] Links correctly route to role selection
- [ ] Only one captain per team at a time
- [ ] Timer counts down and auto-locks picks
- [ ] Pick order follows specified sequence
- [ ] Pause works correctly in both modes
- [ ] Pick changes work correctly in both modes
- [ ] Chat is visible to all participants
- [ ] Connection status displays accurately
- [ ] Series navigation respects completion order
- [ ] Winner declaration enables next draft
- [ ] Spectators can view but not interact

### 10.2 Performance Targets
- Timer drift < 500ms across clients
- Socket latency < 200ms for pick updates
- Page load time < 2s for draft view
- Support 50+ spectators per draft without lag

---

## 11. Future Enhancements (Out of Scope for V1)

- Voice chat integration
- Replay system (watch past drafts)
- Draft analytics (pick rates, ban rates)
- Team history tracking
- Elo/ranking system for competitive mode
- Tournament bracket management
- Draft templates (save common strategies)
- Mobile responsive design
- Notifications (email/push when your turn)

---

**Document Version**: 1.0
**Last Updated**: 2026-01-05
**Author**: Claude (based on user requirements)
