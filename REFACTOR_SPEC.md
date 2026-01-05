# Multi-Flow Architecture Refactor Specification

## Executive Summary

This specification outlines a major architectural refactor to transform the draft simulator from a single-purpose application into a multi-flow platform supporting Draft, Canvas, and Versus modes. The refactor introduces a new home page, unified navigation structure, and flow-specific dashboards while maintaining backward compatibility with existing data and share links.

**Timeline**: Single deploy, no feature flags
**Scope**: All three flows (draft, canvas, versus) implemented together
**Data Migration**: None required - existing schema supports new architecture

---

## 1. Navigation & Routing Architecture

### 1.1 URL Structure

```
/ → HomePage (overall home with recent activity feed)

/draft → DraftFlowDashboard (getting started/tutorial)
/draft/:id → DraftDetailView (individual draft)

/canvas → CanvasFlowDashboard (getting started/tutorial)
/canvas/:id → CanvasDetailView (individual canvas)

/versus → VersusFlowDashboard (coming soon placeholder)
/versus/:id → VersusDetailView (future implementation)

/share/draft → ShareDraftPage (unchanged)
/share/canvas → ShareCanvasPage (unchanged)

/oauth2callback → AuthCallback (unchanged)
```

### 1.2 Routing Implementation

**Router Configuration** (`frontend/src/index.tsx`):

```typescript
<Router>
  <Route path="/oauth2callback" component={AuthCallback} />
  <Route path="/share/draft" component={ShareDraftPage} />
  <Route path="/share/canvas" component={ShareCanvasPage} />

  <Route path="/" component={UserWrapper}>
    <Route path="/" component={HomePage} />

    <Route path="/draft">
      <Route path="/" component={DraftFlowDashboard} />
      <Route path="/:id" component={DraftDetailView} />
    </Route>

    <Route path="/canvas">
      <Route path="/" component={CanvasFlowDashboard} />
      <Route path="/:id" component={CanvasDetailView} />
    </Route>

    <Route path="/versus">
      <Route path="/" component={VersusFlowDashboard} />
      <Route path="/:id" component={VersusDetailView} />
    </Route>
  </Route>
</Router>
```

### 1.3 Navigation Behavior

- **Default entry** (`/`): Show home page with recent activity feed
- **Flow dashboards** (`/draft`, `/canvas`, `/versus`): Show getting started/tutorial content
- **Detail views** (`/draft/:id`): Show specific item
- **Share link redirects**: Existing `/share/draft` and `/share/canvas` routes redirect to new structure unchanged

---

## 2. Global Navigation Framework

### 2.1 Layout Structure

```
┌─────────────────────────────────────────────────────┐
│ GlobalNavBar (persistent across all flows)         │
│  - Flow Navigation: [Draft] [Canvas] [Versus]      │
│  - User Section: Avatar, Name, Settings, Logout    │
├─────────────────────────────────────────────────────┤ ← Horizontal divider
│ FlowPanel (flow-specific, auto-expands on enter)   │
│  - Draft flow: DraftList                           │
│  - Canvas flow: CanvasSelector + CanvasDraftList   │
│  - Versus flow: TBD                                │
│                                                     │
│  (Main Content Area)                               │
│  - Dashboard or Detail View                        │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 2.2 GlobalNavBar Component

**Location**: `frontend/src/components/GlobalNavBar.tsx`

**Responsibilities**:
- Render flow navigation buttons
- Display user profile and auth controls
- Persist across all flows (no unmount on navigation)

**Structure**:

```typescript
interface GlobalNavBarProps {}

export function GlobalNavBar() {
  const user = useUser();
  const navigate = useNavigate();
  const location = useLocation();

  // Determine active flow from URL
  const activeFlow = () => {
    if (location.pathname.startsWith('/draft')) return 'draft';
    if (location.pathname.startsWith('/canvas')) return 'canvas';
    if (location.pathname.startsWith('/versus')) return 'versus';
    return null;
  };

  return (
    <div class="global-navbar">
      {/* Flow Navigation */}
      <div class="flow-navigation">
        <FlowButton
          icon={<DraftIcon />}
          label="Draft"
          active={activeFlow() === 'draft'}
          onClick={() => navigate('/draft')}
        />
        <FlowButton
          icon={<CanvasIcon />}
          label="Canvas"
          active={activeFlow() === 'canvas'}
          onClick={() => navigate('/canvas')}
        />
        <FlowButton
          icon={<VersusIcon />}
          label="Versus"
          active={activeFlow() === 'versus'}
          onClick={() => navigate('/versus')}
        />
      </div>

      {/* User Section */}
      <div class="user-section">
        <img src={user()?.picture} alt={user()?.name} class="user-avatar" />
        <span class="user-name">{user()?.name}</span>
        <button onClick={() => navigate('/settings')}>Settings</button>
        <button onClick={handleLogout}>Logout</button>
      </div>
    </div>
  );
}
```

**Visual Styling**:
- Icon buttons with labels (e.g., `[📄 Draft] [🎨 Canvas] [⚔️ Versus]`)
- Active state highlighting for current flow
- Horizontal divider below global section (border/separator)

### 2.3 FlowPanel Component

**Location**: `frontend/src/components/FlowPanel.tsx`

**Responsibilities**:
- Render flow-specific left panel content
- Auto-expand on flow enter
- Manage panel state (local component state)

**Structure**:

```typescript
interface FlowPanelProps {
  flow: 'draft' | 'canvas' | 'versus';
}

export function FlowPanel(props: FlowPanelProps) {
  const [isExpanded, setIsExpanded] = createSignal(true); // Auto-expanded on flow enter

  return (
    <div class="flow-panel" data-expanded={isExpanded()}>
      <Show when={props.flow === 'draft'}>
        <DraftList />
      </Show>

      <Show when={props.flow === 'canvas'}>
        <CanvasSelector />
        <CanvasDraftList />
      </Show>

      <Show when={props.flow === 'versus'}>
        {/* TBD - coming soon */}
      </Show>
    </div>
  );
}
```

**Panel State Management**:
- Local component state only (`createSignal`)
- Auto-expand on flow enter (default `isExpanded = true`)
- State resets on unmount (acceptable trade-off for simplicity)

---

## 3. Data Model & Draft Types

### 3.1 Draft Type System

The existing `draft.type` field serves as a **privilege system** controlling draft list visibility:

| Type | Draft List Visibility | Can Be in Canvas | Notes |
|------|----------------------|------------------|-------|
| `"standalone"` | ✅ Yes | ✅ Yes | Full privileges - appears everywhere |
| `"versus"` | ✅ Yes | ✅ Yes | Full privileges (future implementation) |
| `"canvas"` | ❌ No | ✅ Yes | Canvas-only, filtered from draft list |

**Key Principles**:
1. **Multi-context existence**: A single draft can exist in the draft list AND multiple canvases simultaneously
2. **Type elevation**: Canvas-only drafts (`type="canvas"`) can be elevated to standalone (`type="standalone"`) via explicit user action
3. **One-way elevation**: Elevation is permanent - no demotion back to canvas-only
4. **CanvasDraft relationship**: Junction table manages which drafts appear in which canvases (independent of type)

### 3.2 Elevation UI (Already Exists)

**Location**: Canvas draft cards

**Existing Implementation**:
- **Standalone drafts**: Show eye icon button → click to navigate to `/draft/:id`
- **Canvas-only drafts**: Show arrow icon button → click to elevate to standalone (updates `type` to `"standalone"`)

**No changes needed** - this UI already implements the elevation feature.

### 3.3 DraftList Filtering

**Current**: `DraftList` shows all drafts owned by user
**New**: Filter to only show `type="standalone"` or `type="versus"` drafts

```typescript
// In DraftList component or API endpoint
const standaloneDrafts = drafts.filter(d =>
  d.type === 'standalone' || d.type === 'versus'
);
```

### 3.4 Database Schema

**No migration required** - existing schema supports all functionality:

- `Draft.type`: Already exists, values: `"canvas" | "standalone" | "versus"`
- `CanvasDraft`: Already manages draft-to-canvas relationships with position
- `UserCanvas`, `DraftShare`, `CanvasShare`: Permission systems unchanged

---

## 4. Real-Time Collaboration (Socket.io)

### 4.1 Multi-Context Broadcasting

**Challenge**: When a draft appears in multiple canvases AND the draft list, all contexts need real-time updates.

**Solution**: Broadcast to all relevant rooms

When a draft is updated:
1. Broadcast to `draft:{id}` room (standalone draft viewers)
2. Broadcast to all `canvas:{id}` rooms containing the draft (canvas viewers)

**Implementation** (backend):

```javascript
// When draft updates occur
async function broadcastDraftUpdate(draftId, updateData) {
  // Broadcast to draft room
  io.to(`draft:${draftId}`).emit('draftUpdate', updateData);

  // Find all canvases containing this draft
  const canvasDrafts = await CanvasDraft.findAll({
    where: { draft_id: draftId },
    include: [Canvas]
  });

  // Broadcast to each canvas room
  for (const cd of canvasDrafts) {
    io.to(`canvas:${cd.canvas_id}`).emit('draftUpdate', updateData);
  }
}
```

### 4.2 Room Management Strategy

**Approach**: Join all relevant rooms on page load

**Draft Detail View** (`/draft/:id`):
- Join `draft:{id}` room only

**Canvas Detail View** (`/canvas/:id`):
- Join `canvas:{id}` room
- Join `draft:{id}` room for EACH draft in the canvas

**Example**: Canvas with 10 drafts = 11 socket rooms (1 canvas + 10 drafts)

**Performance Concern**: Many rooms per user
- **Mitigation 1**: Socket.io is designed for this - rooms are lightweight
- **Mitigation 2**: Monitor connection count and room subscriptions in production
- **Mitigation 3**: Implement room limit or pagination if canvases grow very large
- **Future optimization**: Server-side hierarchical subscriptions if needed

### 4.3 UserProvider Changes

**Current**: UserProvider manages single socket connection
**New**: No changes to connection logic, but components join more rooms

```typescript
// In Canvas.tsx or CanvasWorkflow.tsx
createEffect(() => {
  const canvasId = params.id;
  const drafts = canvasDrafts();

  if (canvasId && drafts) {
    // Join canvas room
    socket().emit('joinRoom', `canvas:${canvasId}`);

    // Join all draft rooms
    drafts.forEach(draft => {
      socket().emit('joinRoom', `draft:${draft.Draft.id}`);
    });

    // Cleanup on unmount
    onCleanup(() => {
      socket().emit('leaveRoom', `canvas:${canvasId}`);
      drafts.forEach(draft => {
        socket().emit('leaveRoom', `draft:${draft.Draft.id}`);
      });
    });
  }
});
```

---

## 5. HomePage Implementation

### 5.1 Component Structure

**Location**: `frontend/src/pages/HomePage.tsx`

**Features**:
1. Recent activity feed
2. Flow navigation cards
3. Quick-create functionality

```typescript
export function HomePage() {
  const navigate = useNavigate();
  const [activities] = createResource(fetchRecentActivity);

  const createDraft = async () => {
    const draft = await api.createDraft({ type: 'standalone' });
    navigate(`/draft/${draft.id}`);
  };

  return (
    <div class="home-page">
      <GlobalNavBar />

      <div class="home-content">
        {/* Flow Navigation Cards */}
        <section class="flow-cards">
          <FlowCard
            title="Draft"
            description="Create and manage individual drafts"
            icon={<DraftIcon />}
            onClick={() => navigate('/draft')}
          />
          <FlowCard
            title="Canvas"
            description="Visual workspace for organizing drafts"
            icon={<CanvasIcon />}
            onClick={() => navigate('/canvas')}
          />
          <FlowCard
            title="Versus"
            description="Coming soon"
            icon={<VersusIcon />}
            onClick={() => navigate('/versus')}
            disabled
          />
        </section>

        {/* Quick Create */}
        <section class="quick-create">
          <button onClick={createDraft}>+ New Draft</button>
          {/* Canvas quick-create could be added here too */}
        </section>

        {/* Recent Activity Feed */}
        <section class="activity-feed">
          <h2>Recent Activity</h2>
          <For each={activities()}>
            {(activity) => <ActivityItem activity={activity} />}
          </For>
        </section>
      </div>
    </div>
  );
}
```

### 5.2 Activity Tracking System

**Timestamp-Based Implementation** (No Activity Table):

The activity feed is derived from existing `updatedAt` and `createdAt` timestamps on Draft and Canvas models, eliminating the need for a separate Activity table and reducing database writes to zero.

**API Endpoint**: `GET /api/activity/recent`

```javascript
router.get('/recent', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: "Not authorized" });
    }

    // Get user's owned drafts (standalone and versus only)
    const ownedDrafts = await Draft.findAll({
      where: {
        owner_id: user.id,
        type: { [Op.in]: ["standalone", "versus"] }
      },
      order: [["updatedAt", "DESC"]],
      limit: 15,
      attributes: ["id", "name", "type", "updatedAt", "createdAt"]
    });

    // Get drafts shared with user
    const sharedDrafts = await user.getSharedDrafts({
      where: {
        type: { [Op.in]: ["standalone", "versus"] }
      },
      order: [["updatedAt", "DESC"]],
      limit: 15,
      attributes: ["id", "name", "type", "updatedAt", "createdAt"]
    });

    // Get user's canvases
    const canvases = await Canvas.findAll({
      include: [{
        model: User,
        where: { id: user.id },
        through: { attributes: ["permissions"] },
        required: true
      }],
      order: [["updatedAt", "DESC"]],
      limit: 15,
      attributes: ["id", "name", "updatedAt", "createdAt"]
    });

    // Combine and sort by timestamp
    const allActivities = [
      ...ownedDrafts.map(d => ({
        resource_type: "draft",
        resource_id: d.id,
        resource_name: d.name,
        timestamp: d.updatedAt,
        created_at: d.createdAt,
        is_owner: true,
        draft_type: d.type
      })),
      ...sharedDrafts.map(d => ({
        resource_type: "draft",
        resource_id: d.id,
        resource_name: d.name,
        timestamp: d.updatedAt,
        created_at: d.createdAt,
        is_owner: false,
        draft_type: d.type
      })),
      ...canvases.map(c => ({
        resource_type: "canvas",
        resource_id: c.id,
        resource_name: c.name,
        timestamp: c.updatedAt,
        created_at: c.createdAt,
        is_owner: true
      }))
    ]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 20);

    res.json(allActivities);
  } catch (error) {
    console.error("Error fetching recent activity:", error);
    res.status(500).json({ error: error.message });
  }
});
```

**Benefits**:
- ✅ Zero extra database writes
- ✅ No separate Activity table to maintain
- ✅ Simpler codebase with less moving parts
- ✅ Activity feed still shows recently modified resources
- ✅ Distinguishes owned vs shared resources

### 5.3 Activity Feed UI

```typescript
interface Activity {
  resource_type: 'draft' | 'canvas' | 'versus';
  resource_id: string;
  resource_name: string;
  timestamp: string;
  created_at: string;
  is_owner: boolean;
  draft_type?: 'standalone' | 'canvas' | 'versus';
}

function ActivityItem(props: { activity: Activity }) {
  const navigate = useNavigate();

  const getMessage = () => {
    const { resource_name, is_owner } = props.activity;
    const ownershipPrefix = is_owner ? '' : 'Shared: ';
    return `${ownershipPrefix}${resource_name}`;
  };

  const handleClick = () => {
    navigate(`/${props.activity.resource_type}/${props.activity.resource_id}`);
  };

  return (
    <div class="activity-item" onClick={handleClick}>
      <div class="activity-content">
        <div class="activity-header">
          <span class="resource-type">{props.activity.resource_type}</span>
          {!props.activity.is_owner && <span class="shared-badge">Shared</span>}
        </div>
        <p>{getMessage()}</p>
        <span class="activity-time">
          Updated {formatTimestamp(props.activity.timestamp)}
        </span>
      </div>
    </div>
  );
}
```

---

## 6. Flow Dashboards

### 6.1 Draft Flow Dashboard

**Route**: `/draft` (no :id)
**Component**: `frontend/src/pages/DraftFlowDashboard.tsx`

**Purpose**: Getting started / tutorial for draft feature

**Structure**:

```typescript
export function DraftFlowDashboard() {
  const navigate = useNavigate();

  const createDraft = async () => {
    const draft = await api.createDraft({ type: 'standalone' });
    navigate(`/draft/${draft.id}`);
  };

  return (
    <div class="draft-dashboard">
      <GlobalNavBar />
      <FlowPanel flow="draft" />

      <div class="dashboard-content">
        <h1>Welcome to Draft Mode</h1>

        <section class="getting-started">
          <h2>Getting Started</h2>
          <ul>
            <li>Create a new draft to start building your team composition</li>
            <li>Use the searchable champion table to find and select champions</li>
            <li>Drag and drop champions into ban and pick slots</li>
            <li>Share your drafts with collaborators for real-time editing</li>
          </ul>
        </section>

        <section class="tutorial-steps">
          <TutorialStep
            number={1}
            title="Create Your First Draft"
            description="Click the button below or use the draft list panel"
          />
          <TutorialStep
            number={2}
            title="Select Champions"
            description="Search, filter by role, or drag champions from the table"
          />
          <TutorialStep
            number={3}
            title="Collaborate"
            description="Share your draft link with teammates for live collaboration"
          />
        </section>

        <button onClick={createDraft} class="cta-button">
          Create Your First Draft
        </button>
      </div>
    </div>
  );
}
```

**Design Considerations**:
- Tutorial content should be helpful for new users but not annoying for returning users
- DraftList panel is auto-expanded, showing existing standalone drafts
- Large CTA button to create first draft
- Could include screenshot/GIF demos of draft feature

### 6.2 Canvas Flow Dashboard

**Route**: `/canvas` (no :id)
**Component**: `frontend/src/pages/CanvasFlowDashboard.tsx`

**Purpose**: Getting started / tutorial for canvas feature

**Structure**: Similar to draft dashboard but focused on canvas concepts:

```typescript
export function CanvasFlowDashboard() {
  return (
    <div class="canvas-dashboard">
      <GlobalNavBar />
      <FlowPanel flow="canvas" />

      <div class="dashboard-content">
        <h1>Welcome to Canvas Mode</h1>

        <section class="getting-started">
          <h2>What is Canvas?</h2>
          <p>Canvas is an infinite workspace for visually organizing and connecting your drafts.</p>

          <ul>
            <li>Create and position draft cards anywhere on the canvas</li>
            <li>Draw connections between related drafts</li>
            <li>Collaborate with teammates in real-time</li>
            <li>Organize complex draft scenarios and strategies</li>
          </ul>
        </section>

        <section class="tutorial-steps">
          <TutorialStep
            number={1}
            title="Create a Canvas"
            description="Use the canvas selector in the left panel to create your first canvas"
          />
          <TutorialStep
            number={2}
            title="Add Drafts"
            description="Double-click the canvas to create draft cards, or add existing standalone drafts"
          />
          <TutorialStep
            number={3}
            title="Make Connections"
            description="Enter connection mode to draw relationships between drafts"
          />
        </section>
      </div>
    </div>
  );
}
```

### 6.3 Versus Flow Dashboard

**Route**: `/versus` (no :id)
**Component**: `frontend/src/pages/VersusFlowDashboard.tsx`

**Purpose**: Placeholder for future versus mode implementation

**Structure**:

```typescript
export function VersusFlowDashboard() {
  return (
    <div class="versus-dashboard">
      <GlobalNavBar />
      <FlowPanel flow="versus" />

      <div class="dashboard-content">
        <div class="coming-soon">
          <h1>Versus Mode</h1>
          <p class="subtitle">Coming Soon</p>

          <section class="description">
            <p>
              Versus mode will allow you to simulate head-to-head draft battles,
              compare team compositions, and analyze matchups.
            </p>
          </section>

          <div class="placeholder-icon">
            <VersusIcon size="large" />
          </div>
        </div>
      </div>
    </div>
  );
}
```

---

## 7. Draft Flow Panel Updates

### 7.1 Current State

**Current Location**: `DraftWorkflow.tsx` renders `<NavBar>` which includes `<DraftList>`
**Current Behavior**: Shows all drafts owned by user

### 7.2 New State

**New Location**: `FlowPanel` component renders `<DraftList>` when `flow="draft"`
**New Behavior**: Filter to show only `type="standalone"` or `type="versus"` drafts

**Changes to DraftList Component**:

```typescript
// frontend/src/DraftList.tsx

// OLD: Fetch all user's drafts
const [drafts] = createResource(() => fetchUserDrafts(userId));

// NEW: Fetch only standalone/versus drafts
const [drafts] = createResource(() => fetchStandaloneDrafts(userId));

// Frontend filter (or update API endpoint)
const standaloneDrafts = () => {
  return drafts()?.filter(d =>
    d.type === 'standalone' || d.type === 'versus'
  ) || [];
};

return (
  <div class="draft-list">
    <For each={standaloneDrafts()}>
      {(draft) => <DraftListItem draft={draft} />}
    </For>
  </div>
);
```

**Backend API Update** (optional optimization):

```javascript
// backend/routes/drafts.js

// Add new endpoint or modify existing
router.get('/standalone', authenticateToken, async (req, res) => {
  const drafts = await Draft.findAll({
    where: {
      owner_id: req.user.id,
      type: ['standalone', 'versus'] // Only return these types
    },
    order: [['updatedAt', 'DESC']]
  });

  res.json(drafts);
});
```

### 7.3 Draft Creation in Flow

**Current**: Create draft button in NavBar → navigates to `/draft/:id`
**New**: Same behavior, but also available on home page

**No changes needed** to creation logic - just render create button in two places:
1. In DraftList panel (existing)
2. In HomePage quick-create section (new)

---

## 8. Canvas Flow Panel Updates

### 8.1 Current State

**Current**: `CanvasWorkflow.tsx` renders left panel with:
- Canvas selector (dropdown/list of user's canvases)
- Draft list (drafts WITHIN the selected canvas)
- Draft details panel

### 8.2 New State

**Structure**: Canvas flow panel has two sections:

```
┌─────────────────────────┐
│ CanvasSelector          │
│  [ My Canvas v ]        │ ← Dropdown or list at top
├─────────────────────────┤
│ CanvasDraftList         │
│  - Draft 1              │
│  - Draft 2              │ ← Drafts within selected canvas
│  - Draft 3              │
│  ...                    │
└─────────────────────────┘
```

**Component Updates**:

```typescript
// In FlowPanel when flow="canvas"
<Show when={props.flow === 'canvas'}>
  <div class="canvas-flow-panel">
    {/* Canvas Selector at top */}
    <CanvasSelector
      canvases={userCanvases()}
      selectedId={currentCanvasId()}
      onSelect={handleCanvasSelect}
    />

    {/* Drafts within canvas below */}
    <Show when={currentCanvasId()}>
      <CanvasDraftList canvasId={currentCanvasId()} />
    </Show>
  </div>
</Show>
```

**CanvasSelector Component**:

```typescript
interface CanvasSelectorProps {
  canvases: Canvas[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function CanvasSelector(props: CanvasSelectorProps) {
  const navigate = useNavigate();

  const handleSelect = (canvasId: string) => {
    props.onSelect(canvasId);
    navigate(`/canvas/${canvasId}`);
  };

  return (
    <div class="canvas-selector">
      <label>Select Canvas</label>
      <select onChange={(e) => handleSelect(e.target.value)} value={props.selectedId || ''}>
        <option value="">Choose a canvas...</option>
        <For each={props.canvases}>
          {(canvas) => <option value={canvas.id}>{canvas.name}</option>}
        </For>
      </select>

      <button onClick={createNewCanvas}>+ New Canvas</button>
    </div>
  );
}
```

**CanvasDraftList Component**:

Already exists in current implementation - shows drafts within canvas for quick navigation. **No changes needed** beyond moving it into the FlowPanel structure.

### 8.3 Canvas Creation

**Current**: Create canvas button in CanvasWorkflow
**New**: Available in CanvasSelector within flow panel

**Behavior**: After creation, navigate to `/canvas/:id`

---

## 9. Component Architecture Changes

### 9.1 New Components to Create

| Component | Location | Purpose |
|-----------|----------|---------|
| `HomePage` | `frontend/src/pages/HomePage.tsx` | Home page with activity feed and flow navigation |
| `GlobalNavBar` | `frontend/src/components/GlobalNavBar.tsx` | Persistent global navigation |
| `FlowPanel` | `frontend/src/components/FlowPanel.tsx` | Flow-specific left panel container |
| `FlowButton` | `frontend/src/components/FlowButton.tsx` | Flow navigation button |
| `FlowCard` | `frontend/src/components/FlowCard.tsx` | Home page flow navigation card |
| `ActivityItem` | `frontend/src/components/ActivityItem.tsx` | Activity feed item |
| `DraftFlowDashboard` | `frontend/src/pages/DraftFlowDashboard.tsx` | Draft flow landing page |
| `CanvasFlowDashboard` | `frontend/src/pages/CanvasFlowDashboard.tsx` | Canvas flow landing page |
| `VersusFlowDashboard` | `frontend/src/pages/VersusFlowDashboard.tsx` | Versus flow landing page |
| `DraftDetailView` | `frontend/src/pages/DraftDetailView.tsx` | Wrapper for existing Draft component |
| `CanvasDetailView` | `frontend/src/pages/CanvasDetailView.tsx` | Wrapper for existing Canvas component |
| `CanvasSelector` | `frontend/src/components/CanvasSelector.tsx` | Canvas selection dropdown |

### 9.2 Modified Components

| Component | Changes | Reason |
|-----------|---------|--------|
| `DraftWorkflow.tsx` | Remove or repurpose | Replaced by DraftDetailView + DraftFlowDashboard |
| `CanvasWorkflow.tsx` | Remove or repurpose | Replaced by CanvasDetailView + CanvasFlowDashboard |
| `DraftList.tsx` | Filter to standalone/versus only | New type filtering logic |
| `NavBar.tsx` | Remove or extract components | Functionality split into GlobalNavBar + FlowPanel |
| `UserWrapper.tsx` | Update to render new layout | Add GlobalNavBar to layout |
| `index.tsx` | New routing structure | Support new URL patterns |

### 9.3 Unchanged Components

**These components continue to work as-is**:

- `Draft.tsx` - Render draft detail view
- `Canvas.tsx` - Render canvas detail view
- `DraftDetails.tsx` - Show draft metadata
- `SearchableSelect.tsx` - Champion search
- All champion table, drag-and-drop, socket logic
- Share page components
- Auth components

**Philosophy**: Minimal changes to core functionality. New structure wraps existing components.

---

## 10. Detail View Wrappers

### 10.1 DraftDetailView

**Purpose**: Wrap existing `Draft.tsx` component with new layout structure

```typescript
// frontend/src/pages/DraftDetailView.tsx
export function DraftDetailView() {
  const params = useParams();
  const [draft] = createResource(() => fetchDraft(params.id));

  return (
    <div class="draft-detail-view">
      <GlobalNavBar />
      <FlowPanel flow="draft" />

      <div class="main-content">
        <Show when={draft()}>
          <Draft draft={draft()} />
        </Show>
      </div>
    </div>
  );
}
```

**Migration from DraftWorkflow**:
- Extract draft loading logic from DraftWorkflow
- Render Draft component in main content area
- DraftList in FlowPanel provides navigation

### 10.2 CanvasDetailView

```typescript
// frontend/src/pages/CanvasDetailView.tsx
export function CanvasDetailView() {
  const params = useParams();

  return (
    <div class="canvas-detail-view">
      <GlobalNavBar />
      <FlowPanel flow="canvas" />

      <div class="main-content">
        <Canvas canvasId={params.id} />
      </div>
    </div>
  );
}
```

**Migration from CanvasWorkflow**:
- Canvas component remains largely unchanged
- CanvasSelector + CanvasDraftList move to FlowPanel
- Canvas continues to manage viewport, connections, etc.

---

## 11. Backend Changes

### 11.1 New API Endpoints

**Activity Feed** (timestamp-based):

```
GET  /api/activity/recent              → Get recent activity (from Draft/Canvas timestamps)
```

**Draft Filtering** (optional optimization):

```
GET /api/drafts/standalone             → Get only standalone/versus drafts
```

### 11.2 Modified Endpoints

**No activity logging needed** - the timestamp-based approach uses existing `updatedAt` fields that are automatically maintained by Sequelize.

### 11.3 Socket.io Updates

**Multi-context broadcast implementation** (no activity logging):

```javascript
// backend/socket/draftHandlers.js

// When draft is updated
socket.on('updateDraft', async (data) => {
  const { draftId, picks, name } = data;

  // Update database (updatedAt is automatically updated by Sequelize)
  await Draft.update({ picks, name }, { where: { id: draftId } });

  // Broadcast to draft room
  io.to(`draft:${draftId}`).emit('draftUpdate', { draftId, picks, name });

  // Find all canvases containing this draft
  const canvasDrafts = await CanvasDraft.findAll({
    where: { draft_id: draftId }
  });

  // Broadcast to each canvas room
  for (const cd of canvasDrafts) {
    io.to(`canvas:${cd.canvas_id}`).emit('draftUpdate', { draftId, picks, name });
  }
});
```

### 11.4 Database Migrations

**No migrations needed** - Activity tracking uses existing `updatedAt` and `createdAt` fields on Draft and Canvas models.

---

## 12. Migration & Rollout Strategy

### 12.1 Data Migration

**Status**: ✅ No migration required

**Reasoning**:
- Draft.type field already exists with values `"canvas" | "standalone" | "versus"`
- CanvasDraft relationship already manages canvas memberships
- New filtering logic works on existing data
- Activity table is new - starts empty

### 12.2 Deployment Approach

**Strategy**: Single deploy, no feature flags

**Rationale**:
- Clean cutover to new architecture
- Simpler code - no conditional logic for old/new versions
- Acceptable for early-stage product with few users

**Risk Mitigation**:
- Thorough testing in staging environment
- Database backup before deploy
- Ability to quickly roll back if critical issues
- Monitor error logs and user reports closely in first 24 hours

### 12.3 Deployment Checklist

**Backend**:
- [ ] Run Activity table migration
- [ ] Deploy backend with new activity endpoints
- [ ] Update socket.io handlers for multi-context broadcast
- [ ] Verify existing share routes still work

**Frontend**:
- [ ] Build and test new routing structure
- [ ] Verify all flows render correctly
- [ ] Test draft list filtering (standalone only)
- [ ] Test socket connections and room joins
- [ ] Verify share link redirects work

**Post-Deploy**:
- [ ] Monitor socket room count per user
- [ ] Check activity logging is working
- [ ] Verify existing users can access their drafts
- [ ] Test draft elevation (canvas → standalone)
- [ ] Confirm multi-context real-time updates work

---

## 13. Testing Strategy

### 13.1 Critical User Flows to Test

1. **Home Page Navigation**
   - Load home page, see activity feed
   - Click flow cards to navigate to /draft, /canvas, /versus
   - Quick-create draft from home → navigates to /draft/:id

2. **Draft Flow**
   - Navigate to /draft → see getting started tutorial
   - DraftList shows only standalone/versus drafts (not canvas-only)
   - Click draft in list → navigates to /draft/:id
   - Create new draft → type defaults to "standalone"
   - Edit draft → real-time updates work

3. **Canvas Flow**
   - Navigate to /canvas → see getting started tutorial
   - CanvasSelector shows user's canvases
   - Select canvas → navigates to /canvas/:id
   - CanvasDraftList shows drafts within canvas
   - Create draft in canvas → type defaults to "canvas"
   - Elevate canvas draft to standalone → icon changes, appears in DraftList
   - Edit draft in canvas → updates broadcast to draft room too

4. **Multi-Context Real-Time**
   - Open draft in standalone view (/draft/:id)
   - In another browser/tab, open canvas containing same draft
   - Edit draft in canvas → changes appear in standalone view
   - Edit draft in standalone view → changes appear in canvas

5. **Share Links**
   - Share a draft via /share/draft
   - Verify redirect to /draft/:id works
   - Share a canvas via /share/canvas
   - Verify redirect to /canvas/:id works

6. **Activity Feed**
   - Access various drafts/canvases
   - Check activity feed shows recent items
   - Collaborate with another user on shared draft
   - Verify collaborator activity appears in feed

### 13.2 Socket.io Performance Testing

**Concern**: Many rooms per user could impact performance

**Tests**:
1. Create canvas with 50 drafts
2. Open canvas → verify 51 rooms joined (1 canvas + 50 drafts)
3. Monitor connection latency and memory usage
4. Simulate 10 concurrent users in same canvas
5. Verify update broadcast performance

**Acceptance Criteria**:
- Room join time < 100ms per room
- Update latency < 200ms
- No memory leaks over extended session
- Graceful degradation if room limit hit

### 13.3 Edge Cases

- [ ] User with zero drafts → DraftList shows empty state
- [ ] User with zero canvases → CanvasSelector shows empty state
- [ ] Navigate directly to /draft/:invalid-id → show 404 or error
- [ ] Elevate draft while it's open in standalone view → UI updates correctly
- [ ] Delete draft from canvas while viewing standalone → handle gracefully
- [ ] Delete canvas while viewing it → redirect to /canvas dashboard
- [ ] Share link with expired/invalid token → show error
- [ ] Socket disconnection during draft edit → show reconnection UI

---

## 14. Open Questions & Future Considerations

### 14.1 Versus Mode Implementation

**Status**: Placeholder only in this refactor

**Future Decisions Needed**:
- What data model differences for versus drafts?
- How do versus matchups work? (1v1 drafts? Comparison view?)
- Does versus mode interact with canvas? (Can versus drafts be in canvas?)
- Real-time collaborative versus drafting flow?

**Current Spec**:
- Versus flow exists in routing structure
- Dashboard shows "coming soon" placeholder
- Draft.type supports "versus" value (appears in draft list)
- Can implement later without major architecture changes

### 14.2 Socket.io Optimization

**Current Concern**: Performance with many rooms

**Future Optimization Options**:
1. **Server-side hierarchical subscriptions**
   - Client joins canvas room only
   - Server automatically subscribes to all draft rooms
   - Reduces client-side room management

2. **Virtual scrolling for large canvases**
   - Only join rooms for visible drafts
   - Lazy-load draft rooms as user scrolls
   - Limits concurrent room count

3. **Draft update batching**
   - Batch multiple draft updates in single broadcast
   - Reduce socket event frequency
   - Trade-off: slight delay in real-time updates

4. **Canvas-level draft snapshots**
   - Canvas room receives aggregate updates
   - Individual draft rooms only for active editors
   - Reduces broadcast fanout

**Decision**: Start with simple approach (join all rooms), optimize if performance issues arise in production.

### 14.3 Mobile Responsiveness

**Current Spec**: Desktop-first design

**Future Work**:
- Responsive navbar design (collapsible panels on mobile)
- Touch-optimized canvas controls
- Mobile-friendly flow navigation (tabs vs sidebar)
- Simplified activity feed for small screens

**Not Blocking**: Can iterate on responsive design post-launch

### 14.4 Search & Organization

**Current**: Basic draft list, no search

**Future Enhancements**:
- Global search across all flows (mentioned in interviews but not required)
- Draft tagging/categorization
- Folder/workspace organization
- Favorites/pinning system
- Sort options (name, date, type)

**Not Blocking**: Can add incrementally

### 14.5 Settings Page

**Current**: Settings link in navbar, but page doesn't exist yet

**Future Work**:
- User preferences (default draft type, notification settings)
- Account management
- Privacy settings for sharing
- Theme/appearance options

**Not Blocking**: Can create minimal settings page or remove link initially

---

## 15. File Structure Summary

### 15.1 New Files to Create

```
frontend/src/
├── pages/
│   ├── HomePage.tsx                    # Home page with activity feed
│   ├── DraftFlowDashboard.tsx         # /draft landing page
│   ├── CanvasFlowDashboard.tsx        # /canvas landing page
│   ├── VersusFlowDashboard.tsx        # /versus landing page
│   ├── DraftDetailView.tsx            # /draft/:id wrapper
│   └── CanvasDetailView.tsx           # /canvas/:id wrapper
│
├── components/
│   ├── GlobalNavBar.tsx               # Persistent global navigation
│   ├── FlowPanel.tsx                  # Flow-specific left panel container
│   ├── FlowButton.tsx                 # Flow navigation button
│   ├── FlowCard.tsx                   # Home page flow card
│   ├── ActivityItem.tsx               # Activity feed item
│   ├── CanvasSelector.tsx             # Canvas selection dropdown
│   └── TutorialStep.tsx               # Tutorial step component (for dashboards)
│
└── utils/
    └── activityHelpers.ts             # Activity feed formatting utilities (optional)

backend/
├── routes/
│   └── activity.js                    # Activity API endpoint (timestamp-based)
```

### 15.2 Files to Modify

```
frontend/src/
├── index.tsx                          # Update routing structure
├── UserWrapper.tsx                    # Add GlobalNavBar to layout
├── DraftList.tsx                      # Filter to standalone/versus only
├── workflows/
│   ├── DraftWorkflow.tsx              # Remove or repurpose (replaced by detail view)
│   └── CanvasWorkflow.tsx             # Remove or repurpose (replaced by detail view)

backend/
├── routes/
│   └── activity.js                    # Reimplemented with timestamp-based approach
│
└── socket/
    └── index.js                       # Multi-context broadcasting (no activity logging)
```

### 15.3 Files Unchanged

```
frontend/src/
├── Draft.tsx                          # Core draft component
├── Canvas.tsx                         # Core canvas component
├── DraftDetails.tsx                   # Draft metadata panel
├── SearchableSelect.tsx               # Champion search
├── NavBar.tsx                         # May extract components but file can stay
└── components/
    ├── AuthGuard.tsx
    ├── Dialog.tsx
    ├── AnchorPoints.tsx
    ├── Connections.tsx
    ├── Vertex.tsx
    └── ContextMenu.tsx

backend/models/
├── draft.js                           # No schema changes needed
├── canvas.js
├── canvasDraft.js
└── user.js
```

---

## 16. Success Criteria

### 16.1 Functional Requirements

✅ **Navigation**:
- [ ] Home page accessible at `/`
- [ ] Flow dashboards accessible at `/draft`, `/canvas`, `/versus`
- [ ] Detail views accessible at `/draft/:id`, `/canvas/:id`
- [ ] Global navbar visible and functional on all pages
- [ ] Flow panels auto-expand on flow entry

✅ **Draft List Filtering**:
- [ ] Draft list shows only `type="standalone"` and `type="versus"` drafts
- [ ] Canvas-only drafts (`type="canvas"`) do not appear in draft list
- [ ] Elevation from canvas to standalone updates draft list in real-time

✅ **Multi-Context Drafts**:
- [ ] Same draft can exist in draft list and multiple canvases
- [ ] Edits to draft in any context broadcast to all contexts
- [ ] Real-time updates work across standalone and canvas views

✅ **Activity Feed**:
- [ ] Recent activity feed shows on home page
- [ ] Recently modified drafts and canvases displayed
- [ ] Owned vs shared resources visually distinguished
- [ ] Activity items clickable to navigate to resource
- [ ] Feed sorted by most recently updated

✅ **Canvas Navigation**:
- [ ] Canvas selector shows user's canvases
- [ ] Canvas draft list shows drafts within selected canvas
- [ ] Canvas draft list items navigate canvas viewport on click (existing behavior)

✅ **Share Links**:
- [ ] Existing share links continue to work
- [ ] Share redirects navigate to new URL structure

### 16.2 Non-Functional Requirements

✅ **Performance**:
- [ ] Page load time < 2 seconds
- [ ] Socket room join latency < 100ms per room
- [ ] Real-time update latency < 200ms
- [ ] No memory leaks during extended sessions

✅ **User Experience**:
- [ ] Navigation between flows is intuitive
- [ ] Dashboard tutorials are helpful for new users
- [ ] Panel state behavior feels natural
- [ ] No jarring transitions or layout shifts

✅ **Code Quality**:
- [ ] TypeScript types for all new components
- [ ] Minimal duplication between old and new code
- [ ] Clear separation of concerns (routing, state, UI)
- [ ] Consistent naming conventions

---

## 17. Implementation Phases

### Phase 1: Foundation (Backend + Routing)
**Estimated Effort**: 2-3 days

- [ ] Create Activity model and migration
- [ ] Add activity API endpoints
- [ ] Update socket handlers for multi-context broadcast
- [ ] Update frontend routing structure in index.tsx
- [ ] Create placeholder components for all new pages

**Deliverable**: Routing structure works, activity tracking functional

### Phase 2: Global Navigation
**Estimated Effort**: 2-3 days

- [ ] Create GlobalNavBar component
- [ ] Create FlowPanel component
- [ ] Update UserWrapper to use new layout
- [ ] Implement flow navigation buttons
- [ ] Add horizontal divider styling

**Deliverable**: Global navbar works, can switch between flows

### Phase 3: Home Page
**Estimated Effort**: 2-3 days

- [ ] Create HomePage component
- [ ] Create FlowCard component
- [ ] Create ActivityItem component
- [ ] Implement activity feed rendering
- [ ] Add quick-create functionality

**Deliverable**: Home page functional with activity feed

### Phase 4: Flow Dashboards
**Estimated Effort**: 2-3 days

- [ ] Create DraftFlowDashboard with tutorial content
- [ ] Create CanvasFlowDashboard with tutorial content
- [ ] Create VersusFlowDashboard placeholder
- [ ] Create TutorialStep component
- [ ] Add dashboard styling

**Deliverable**: All flow dashboards render correctly

### Phase 5: Detail View Wrappers
**Estimated Effort**: 2-3 days

- [ ] Create DraftDetailView wrapper
- [ ] Create CanvasDetailView wrapper
- [ ] Migrate logic from DraftWorkflow
- [ ] Migrate logic from CanvasWorkflow
- [ ] Update DraftList filtering

**Deliverable**: Draft and canvas detail views work in new structure

### Phase 6: Canvas Panel Updates
**Estimated Effort**: 1-2 days

- [ ] Create CanvasSelector component
- [ ] Update FlowPanel to render CanvasSelector
- [ ] Update canvas flow panel layout
- [ ] Test canvas selection and navigation

**Deliverable**: Canvas flow panel works with new selector

### Phase 7: Socket.io Updates
**Estimated Effort**: 2-3 days

- [ ] Update draft handlers for multi-context broadcast
- [ ] Update frontend socket room joins
- [ ] Add cleanup on component unmount
- [ ] Test real-time updates across contexts
- [ ] Performance testing with many rooms

**Deliverable**: Multi-context real-time updates work reliably

### Phase 8: Testing & Polish
**Estimated Effort**: 3-4 days

- [ ] End-to-end testing of all user flows
- [ ] Edge case testing
- [ ] Performance optimization
- [ ] UI polish and styling
- [ ] Mobile responsive adjustments (if time permits)
- [ ] Bug fixes

**Deliverable**: Production-ready implementation

### Phase 9: Deployment
**Estimated Effort**: 1 day

- [ ] Final staging environment testing
- [ ] Database backup
- [ ] Deploy backend (run migrations)
- [ ] Deploy frontend
- [ ] Monitor logs and errors
- [ ] User acceptance testing

**Deliverable**: New architecture live in production

---

## 18. Risk Assessment

### High Risk

**Risk**: Socket.io performance degradation with many rooms
**Mitigation**:
- Performance testing in Phase 7
- Monitor room count and connection metrics in production
- Have server-side hierarchical subscription plan ready if needed
- Consider room limits or pagination for very large canvases

**Risk**: User confusion with new navigation structure
**Mitigation**:
- Clear getting started tutorials on dashboard pages
- Maintain consistent behavior (draft list still works same way)
- Monitor user feedback closely post-launch
- Consider in-app announcement or changelog

### Medium Risk

**Risk**: Edge cases in multi-context draft updates
**Mitigation**:
- Comprehensive testing of edit scenarios
- Clear state management patterns
- Socket event logging for debugging
- Graceful error handling and reconnection logic

**Risk**: Activity feed performance with large datasets
**Mitigation**:
- Limit query to recent 20 activities
- Add database index on (user_id, timestamp)
- Pagination if needed in future
- Consider archiving old activities

### Low Risk

**Risk**: Share link redirects breaking
**Mitigation**:
- Keep share routes unchanged
- Existing redirect logic should work with new URLs
- Test share links explicitly in Phase 8

**Risk**: Mobile responsiveness issues
**Mitigation**:
- Desktop-first approach is acceptable for v1
- Can iterate on mobile UX post-launch
- Basic responsive CSS to prevent breaking

---

## 19. Key Architectural Principles

### 19.1 Design Principles

1. **Minimal Disruption**: Keep existing Draft and Canvas components unchanged. New structure wraps, not replaces.

2. **Progressive Enhancement**: Start with basic multi-flow support. Activity feed, search, and advanced features can evolve.

3. **Type as Privilege**: Draft.type field controls visibility. Standalone/versus are "privileged" types that appear everywhere.

4. **Multi-Context Truth**: Single draft can exist in multiple contexts. Changes propagate everywhere via socket broadcast.

5. **Flow Isolation**: Each flow has its own dashboard, panel, and navigation structure. Flows are independent but share data.

6. **Explicit Elevation**: Users consciously promote canvas drafts to standalone. No automatic elevation prevents list clutter.

7. **Real-Time First**: Socket.io updates are core to collaboration. Multi-context broadcasting ensures consistency.

8. **Activity Awareness**: Track user actions and collaborator activity. Build foundation for notifications and insights.

### 19.2 Code Organization Principles

1. **Pages vs Components**:
   - Pages (`pages/`) are route handlers, orchestrate layout
   - Components (`components/`) are reusable UI primitives

2. **Wrapper Pattern**:
   - Detail views wrap existing components with new layout
   - Minimizes changes to working code

3. **Flow-Specific Logic**:
   - FlowPanel component encapsulates flow-specific rendering
   - Easy to add new flows (versus, future modes)

4. **Shared Utilities**:
   - Activity helpers, formatting, constants in utils/
   - Keep business logic out of components

### 19.3 Data Flow Principles

1. **Server as Source of Truth**:
   - Database stores draft types, canvas relationships
   - Frontend state reflects server state

2. **Optimistic Updates**:
   - Socket broadcasts update UI immediately
   - Server persists changes asynchronously

3. **Resource-Based Fetching**:
   - Use createResource() for SolidJS reactivity
   - TanStack Query for complex caching (Canvas)

4. **Activity Logging**:
   - Log server-side for durability
   - Async logging doesn't block user actions

---

## 20. Conclusion

This refactor transforms the draft simulator from a single-purpose tool into a multi-flow platform. The architecture supports the existing draft and canvas flows while providing a foundation for versus mode and future features.

**Key Achievements**:
- ✅ Unified navigation with global frame + flow panels
- ✅ Multi-context draft support (same draft in multiple places)
- ✅ Activity tracking and recent history
- ✅ Flow-specific dashboards with tutorials
- ✅ Real-time collaboration across contexts
- ✅ Backward compatible (no data migration, share links work)

**Next Steps**:
1. Review this specification with stakeholders
2. Clarify any ambiguities or open questions
3. Begin Phase 1 implementation (Foundation)
4. Iterate based on testing feedback

**Timeline**: Approximately 15-20 development days for full implementation, assuming single developer working on it intermittently.

---

## Appendix A: UI Mockups

### Home Page Layout

```
┌─────────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────┐ │
│ │ GlobalNavBar                                    │ │
│ │ [📄 Draft] [🎨 Canvas] [⚔️ Versus]             │ │
│ │                      👤 Name  ⚙️ Settings  🚪  │ │
│ └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │  Draft   │  │  Canvas  │  │  Versus  │         │
│  │   📄     │  │   🎨     │  │   ⚔️     │         │
│  │ Manage   │  │ Organize │  │  Coming  │         │
│  │  drafts  │  │  drafts  │  │   Soon   │         │
│  └──────────┘  └──────────┘  └──────────┘         │
│                                                     │
│  [+ New Draft]                                     │
│                                                     │
│  Recent Activity                                   │
│  ───────────────────────────────────────────       │
│  👤 You viewed "Team Comp A"          2 hrs ago    │
│  👤 Alice edited "Shared Draft"       3 hrs ago    │
│  👤 You created "New Strategy"        1 day ago    │
│  👤 Bob accessed "Canvas Project"     2 days ago   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Draft Flow Dashboard

```
┌─────────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────┐ │
│ │ GlobalNavBar                                    │ │
│ │ [📄 Draft] [🎨 Canvas] [⚔️ Versus]             │ │
│ └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│ ┌──────────┐ │ Welcome to Draft Mode               │
│ │DraftList │ │                                     │
│ ├──────────┤ │ Getting Started                     │
│ │+ New     │ │ • Create drafts                     │
│ │          │ │ • Select champions                  │
│ │Draft A   │ │ • Collaborate in real-time          │
│ │Draft B   │ │                                     │
│ │Draft C   │ │ ┌───────────────────────────────┐   │
│ │          │ │ │ 1. Create Your First Draft    │   │
│ │          │ │ │ Click below to get started    │   │
│ │          │ │ └───────────────────────────────┘   │
│ │          │ │                                     │
│ │          │ │ [Create Your First Draft]           │
│ └──────────┘ │                                     │
└─────────────────────────────────────────────────────┘
```

### Draft Detail View

```
┌─────────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────┐ │
│ │ GlobalNavBar                                    │ │
│ │ [📄 Draft] [🎨 Canvas] [⚔️ Versus]             │ │
│ └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│ ┌──────────┐ │ Draft: Team Comp A                  │
│ │DraftList │ │                                     │
│ ├──────────┤ │ ┌──────────────────────────────┐    │
│ │+ New     │ │ │ [Ban] [Ban] [Ban] [Ban] [Ban]│    │
│ │          │ │ └──────────────────────────────┘    │
│ │Draft A ◀ │ │ ┌──────────────────────────────┐    │
│ │Draft B   │ │ │ Blue Side   │   Red Side     │    │
│ │Draft C   │ │ │ [Pick 1]    │   [Pick 1]     │    │
│ │          │ │ │ [Pick 2]    │   [Pick 2]     │    │
│ │          │ │ │ [Pick 3]    │   [Pick 3]     │    │
│ │          │ │ │ [Pick 4]    │   [Pick 4]     │    │
│ │          │ │ │ [Pick 5]    │   [Pick 5]     │    │
│ │          │ │ └──────────────────────────────┘    │
│ │          │ │ Champion Table (searchable)         │
│ └──────────┘ │ [Search...] [Top][Jng][Mid][Bot][Sup]│
└─────────────────────────────────────────────────────┘
```

### Canvas Detail View

```
┌─────────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────┐ │
│ │ GlobalNavBar                                    │ │
│ │ [📄 Draft] [🎨 Canvas] [⚔️ Versus]             │ │
│ └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│ ┌──────────┐ │ Infinite Canvas Workspace           │
│ │ Canvas   │ │                                     │
│ │ Selector │ │  ┌──────────┐     ┌──────────┐     │
│ ├──────────┤ │  │ Draft A  │────→│ Draft B  │     │
│ │[MyCanvas▼│ │  │ 🎯       │     │ 🎯       │     │
│ │          │ │  └──────────┘     └──────────┘     │
│ │+ New     │ │         │                          │
│ │          │ │         └─────→ ┌──────────┐       │
│ │Drafts in │ │                 │ Draft C  │       │
│ │canvas:   │ │                 │ 🎯       │       │
│ │• Draft A │ │                 └──────────┘       │
│ │• Draft B │ │                                     │
│ │• Draft C │ │  [Pan/Zoom/Connection Mode]        │
│ └──────────┘ │                                     │
└─────────────────────────────────────────────────────┘
```

---

## Appendix B: TypeScript Interfaces

### Core Types

```typescript
// Extended from existing types.ts

interface Draft {
  id: string;
  name: string;
  public: boolean;
  picks: string[];
  owner_id: string;
  type: "canvas" | "standalone" | "versus";
  createdAt: string;
  updatedAt: string;
}

interface Canvas {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface CanvasDraft {
  positionX: number;
  positionY: number;
  Draft: Draft;
}

interface Activity {
  resource_type: 'draft' | 'canvas' | 'versus';
  resource_id: string;
  resource_name: string;
  timestamp: string;
  created_at: string;
  is_owner: boolean;
  draft_type?: 'standalone' | 'canvas' | 'versus';
}

type FlowType = 'draft' | 'canvas' | 'versus';
```

### Component Props

```typescript
interface GlobalNavBarProps {
  // No props - reads from router and user context
}

interface FlowPanelProps {
  flow: FlowType;
}

interface FlowButtonProps {
  icon: JSX.Element;
  label: string;
  active: boolean;
  onClick: () => void;
}

interface FlowCardProps {
  title: string;
  description: string;
  icon: JSX.Element;
  onClick: () => void;
  disabled?: boolean;
}

interface ActivityItemProps {
  activity: Activity;
}

interface CanvasSelectorProps {
  canvases: Canvas[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

interface TutorialStepProps {
  number: number;
  title: string;
  description: string;
}
```

---

## Appendix C: API Endpoints Reference

### Draft Endpoints

```
GET    /api/drafts                  → Get all user's drafts
GET    /api/drafts/standalone       → Get standalone/versus drafts only (new)
GET    /api/drafts/:id              → Get specific draft
POST   /api/drafts                  → Create new draft
PUT    /api/drafts/:id              → Update draft
DELETE /api/drafts/:id              → Delete draft
POST   /api/drafts/:id/share        → Create share link
```

### Canvas Endpoints

```
GET    /api/canvas                  → Get all user's canvases
GET    /api/canvas/:id              → Get specific canvas with drafts
POST   /api/canvas                  → Create new canvas
PUT    /api/canvas/:id              → Update canvas
DELETE /api/canvas/:id              → Delete canvas
POST   /api/canvas/:id/drafts       → Add draft to canvas
DELETE /api/canvas/:id/drafts/:did  → Remove draft from canvas
POST   /api/canvas/:id/share        → Create share link
```

### Activity Endpoints (New)

```
GET    /api/activity/recent         → Get user's recent activity (limit 20)
POST   /api/activity/log            → Manually log activity (optional)
```

### User Endpoints

```
GET    /api/users/me                → Get current user
GET    /api/users/:id               → Get user by ID
```

### Auth Endpoints

```
GET    /api/auth/google             → Initiate Google OAuth
GET    /oauth2callback              → OAuth callback
GET    /api/auth/refresh-token      → Refresh access token
POST   /api/auth/logout             → Logout
```

### Share Endpoints

```
GET    /share/draft?token=...       → Access shared draft
GET    /share/canvas?token=...      → Access shared canvas
```

---

*End of Specification*
