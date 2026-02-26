import { z } from "zod";

// =============================================================================
// Base/Shared Schemas
// =============================================================================

export const SuccessSchema = z.object({
  success: z.boolean(),
});

export const ViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number(),
});

export const AnchorTypeSchema = z.enum(["top", "bottom", "left", "right"]);

// =============================================================================
// Draft Schemas
// =============================================================================

export const DraftSchema = z.object({
  id: z.string(),
  name: z.string(),
  public: z.boolean(),
  picks: z.array(z.string()),
  owner_id: z.string().nullable(),
  type: z.enum(["canvas", "versus"]),
  versus_draft_id: z.string().nullable().optional(),
  seriesIndex: z.number().nullable().optional(),
  completed: z.boolean().optional(),
  winner: z.enum(["blue", "red"]).nullable().optional(),
  firstPick: z.enum(["blue", "red"]),
  blueSideTeam: z.union([z.literal(1), z.literal(2)]),
  description: z.string().optional(),
  icon: z.string().optional(),
  is_locked: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const CanvasDraftInnerSchema = z.object({
  name: z.string(),
  id: z.string(),
  picks: z.array(z.string()),
  type: z.enum(["canvas", "versus"]),
  versus_draft_id: z.string().nullable().optional(),
  seriesIndex: z.number().nullable().optional(),
  completed: z.boolean().optional(),
  winner: z.enum(["blue", "red"]).nullable().optional(),
  firstPick: z.enum(["blue", "red"]).optional(),
  blueSideTeam: z.union([z.literal(1), z.literal(2)]).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const CanvasDraftSchema = z.object({
  positionX: z.number(),
  positionY: z.number(),
  is_locked: z.boolean().optional(),
  group_id: z.string().nullable().optional(),
  source_type: z.enum(["canvas", "versus"]).optional(),
  Draft: CanvasDraftInnerSchema,
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

// =============================================================================
// Canvas Group Schemas
// =============================================================================

export const CanvasGroupMetadataSchema = z.object({
  blueTeamName: z.string().optional(),
  redTeamName: z.string().optional(),
  length: z.number().optional(),
  competitive: z.boolean().optional(),
  seriesType: z.string().optional(),
});

export const CanvasGroupSchema = z.object({
  id: z.string(),
  canvas_id: z.string(),
  name: z.string(),
  type: z.enum(["series", "custom"]),
  positionX: z.number(),
  positionY: z.number(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  versus_draft_id: z.string().nullable().optional(),
  metadata: CanvasGroupMetadataSchema,
  isInProgress: z.boolean().optional(),
  CanvasDrafts: z.array(CanvasDraftSchema).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

// =============================================================================
// Connection Schemas
// =============================================================================

export const ConnectionEndpointSchema = z.union([
  z.object({
    type: z.literal("draft").optional(),
    draft_id: z.string(),
    anchor_type: AnchorTypeSchema,
  }),
  z.object({
    type: z.literal("group"),
    group_id: z.string(),
    anchor_type: AnchorTypeSchema,
  }),
]);

export const VertexSchema = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
});

export const ConnectionSchema = z.object({
  id: z.string(),
  canvas_id: z.string(),
  source_draft_ids: z.array(ConnectionEndpointSchema),
  target_draft_ids: z.array(ConnectionEndpointSchema),
  vertices: z.array(VertexSchema),
  style: z.enum(["solid", "dashed", "dotted"]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

// =============================================================================
// Canvas User Schemas
// =============================================================================

export const CanvasUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  picture: z.string(),
  permissions: z.enum(["view", "edit", "admin"]),
  lastAccessedAt: z.string(),
});

// =============================================================================
// Versus Schemas
// =============================================================================

export const VersusDraftSchema = z.object({
  id: z.string(),
  name: z.string(),
  blueTeamName: z.string(),
  redTeamName: z.string(),
  description: z.string().nullable().optional(),
  length: z.number(),
  competitive: z.boolean(),
  icon: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  shareLink: z.string(),
  owner_id: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  Drafts: z.array(DraftSchema).optional(),
});

// Simplified draft schema for versus list endpoint (returns subset of fields)
export const VersusDraftListItemDraftSchema = z.object({
  id: z.string(),
  name: z.string(),
  picks: z.array(z.string()),
  seriesIndex: z.number().nullable().optional(),
  completed: z.boolean().optional(),
  winner: z.enum(["blue", "red"]).nullable().optional(),
});

// Schema for GET /versus-drafts list endpoint
export const VersusDraftListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  blueTeamName: z.string(),
  redTeamName: z.string(),
  description: z.string().nullable().optional(),
  length: z.number(),
  competitive: z.boolean(),
  icon: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  shareLink: z.string(),
  owner_id: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  Drafts: z.array(VersusDraftListItemDraftSchema).optional(),
});

export const VersusParticipantSchema = z.object({
  id: z.string(),
  versus_draft_id: z.string(),
  user_id: z.string().nullable().optional(),
  role: z.enum(["blue_captain", "red_captain", "spectator"]),
  socketId: z.string().nullable().optional(),
  reclaimToken: z.string().nullable().optional(),
  isConnected: z.boolean(),
  lastSeenAt: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const VersusStateSchema = z.object({
  draftId: z.string(),
  currentPickIndex: z.number(),
  timerStartedAt: z.number().nullable(),
  isPaused: z.boolean(),
  readyStatus: z.object({
    blue: z.boolean(),
    red: z.boolean(),
  }),
  completed: z.boolean(),
  winner: z.enum(["blue", "red"]).nullable().optional(),
  firstPick: z.enum(["blue", "red"]).optional(),
  blueSideTeam: z.union([z.literal(1), z.literal(2)]).optional(),
});

export const VersusJoinResponseSchema = z.object({
  success: z.boolean(),
  versusDraft: VersusDraftSchema,
  participants: z.array(VersusParticipantSchema),
  myParticipant: VersusParticipantSchema.nullable(),
  availableRoles: z.object({
    blue_captain: z.boolean(),
    red_captain: z.boolean(),
    spectator: z.boolean(),
  }),
  autoJoinedRole: z
    .enum(["blue_captain", "red_captain", "spectator"])
    .nullable(),
});

export const VersusRoleSelectResponseSchema = z.object({
  success: z.boolean(),
  participant: VersusParticipantSchema,
  reclaimToken: z.string(),
});

// =============================================================================
// API Response Schemas
// =============================================================================

export const CanvasResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  drafts: z.array(CanvasDraftSchema),
  connections: z.array(ConnectionSchema),
  groups: z.array(CanvasGroupSchema),
  lastViewport: ViewportSchema,
  userPermissions: z.enum(["view", "edit", "admin"]),
});

export const ShareLinkResponseSchema = z.object({
  shareLink: z.string(),
});

export const CanvasShareLinkResponseSchema = z.object({
  viewShareLink: z.string(),
  editShareLink: z.string(),
});

export const UserDetailsSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  picture: z.string(),
});

export const AuthResponseSchema = z.object({
  token: z.string(),
  user: UserDetailsSchema,
});

export const CanvasListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.string(),
});

export const ActivityItemSchema = z.object({
  resource_type: z.enum(["draft", "canvas", "versus"]),
  resource_id: z.string(),
  resource_name: z.string(),
  description: z.string().nullable().optional(),
  public: z.boolean().optional(),
  icon: z.string().nullable().optional(),
  timestamp: z.string(),
  created_at: z.string(),
  is_owner: z.boolean(),
  draft_type: z.string().optional(),
  // Versus-specific fields
  blueTeamName: z.string().optional(),
  redTeamName: z.string().optional(),
  length: z.number().optional(),
  competitive: z.boolean().optional(),
  type: z.string().optional(),
});

export const ActivityResponseSchema = z.object({
  activities: z.array(ActivityItemSchema),
  hasMore: z.boolean(),
  nextPage: z.number().nullable(),
});

export const CreateCanvasResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  drafts: z.array(z.unknown()),
});

export const CanvasInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
});

export const UpdateCanvasNameResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  canvas: CanvasInfoSchema,
});

export const ImportResponseSchema = z.object({
  success: z.boolean(),
  draft: CanvasDraftSchema,
});

export const ImportSeriesResponseSchema = z.object({
  success: z.boolean(),
  group: CanvasGroupSchema,
});

// =============================================================================
// Socket Event Schemas - Versus Session
// =============================================================================

export const VersusParticipantsUpdateSchema = z.object({
  participants: z.array(VersusParticipantSchema),
});

export const VersusSyncResponseSchema = z.object({
  versusDraft: VersusDraftSchema,
  participants: z.array(VersusParticipantSchema),
  myParticipant: VersusParticipantSchema.nullable(),
});

export const VersusSeriesUpdateSchema = z.object({
  versusDraft: VersusDraftSchema,
});

export const VersusErrorSchema = z.object({
  error: z.string(),
});

// =============================================================================
// Socket Event Schemas - Draft State
// =============================================================================

export const DraftStateSyncSchema = z.object({
  draftId: z.string(),
  picks: z.array(z.string()),
  currentPickIndex: z.number(),
  timerStartedAt: z.number().nullable(),
  isPaused: z.boolean(),
  readyStatus: z.object({
    blue: z.boolean(),
    red: z.boolean(),
  }),
  completed: z.boolean(),
  winner: z.enum(["blue", "red"]).nullable().optional(),
  firstPick: z.enum(["blue", "red"]),
  blueSideTeam: z.union([z.literal(1), z.literal(2)]),
});

export const DraftUpdateSchema = z.object({
  draftId: z.string(),
  picks: z.array(z.string()),
  currentPickIndex: z.number(),
  timerStartedAt: z.number().nullable(),
  isPaused: z.boolean(),
  completed: z.boolean(),
  firstPick: z.enum(["blue", "red"]).optional(),
});

// Canvas draft updates use a simpler format (no timer state)
export const CanvasDraftUpdateSchema = z.object({
  id: z.string(),
  picks: z.array(z.string()),
});

export const DraftStartedSchema = z.object({
  draftId: z.string(),
  timerStartedAt: z.number(),
  currentPickIndex: z.number(),
  firstPick: z.enum(["blue", "red"]),
});

export const ReadyUpdateSchema = z.object({
  draftId: z.string(),
  blueReady: z.boolean(),
  redReady: z.boolean(),
});

export const GameSettingsUpdateSchema = z.object({
  draftId: z.string(),
  firstPick: z.enum(["blue", "red"]),
  blueSideTeam: z.union([z.literal(1), z.literal(2)]),
});

// =============================================================================
// Socket Event Schemas - Draft Control
// =============================================================================

export const PauseRequestedSchema = z.object({
  draftId: z.string(),
  team: z.enum(["blue", "red"]),
});

export const ResumeRequestedSchema = z.object({
  draftId: z.string(),
  team: z.enum(["blue", "red"]),
});

export const ResumeCountdownStartedSchema = z.object({
  draftId: z.string(),
  countdownStartedAt: z.number(),
});

export const ResumeRejectedSchema = z.object({
  draftId: z.string(),
});

export const PickChangeRequestedSchema = z.object({
  requestId: z.string(),
  draftId: z.string(),
  team: z.enum(["blue", "red"]),
  pickIndex: z.number(),
  oldChampion: z.string(),
  newChampion: z.string(),
});

export const PickChangeResponseSchema = z.object({
  requestId: z.string(),
});

// =============================================================================
// Socket Event Schemas - Communication
// =============================================================================

export const VersusMessageSchema = z.object({
  username: z.string(),
  role: z.enum(["blue_captain", "red_captain", "spectator"]),
  message: z.string(),
  timestamp: z.number(),
});

export const WinnerUpdateSchema = z.object({
  draftId: z.string(),
  winner: z.enum(["blue", "red"]),
});

export const DraftStatusUpdateSchema = z.object({
  draftId: z.string(),
  completed: z.boolean(),
});

// =============================================================================
// Socket Event Schemas - Canvas
// =============================================================================

export const CanvasObjectMovedSchema = z.object({
  draftId: z.string(),
  positionX: z.number(),
  positionY: z.number(),
});

export const VertexMovedSchema = z.object({
  connectionId: z.string(),
  vertexId: z.string(),
  x: z.number(),
  y: z.number(),
});

export const GroupMovedSchema = z.object({
  groupId: z.string(),
  positionX: z.number(),
  positionY: z.number(),
});

export const GroupResizedSchema = z.object({
  groupId: z.string(),
  width: z.number(),
  height: z.number(),
});

// =============================================================================
// Socket Event Schemas - General
// =============================================================================

export const HeartbeatSchema = z.object({
  timerStartedAt: z.number().nullable(),
  currentPickIndex: z.number(),
});

export const RoleAvailableSchema = z.object({
  role: z.enum(["blue_captain", "red_captain"]),
});

// =============================================================================
// Type Exports (inferred from schemas)
// =============================================================================

export type Draft = z.infer<typeof DraftSchema>;
// Lowercase alias for backward compatibility
export type draft = Draft;
export type CanvasDraft = z.infer<typeof CanvasDraftSchema>;
export type CanvasGroup = z.infer<typeof CanvasGroupSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type ConnectionEndpoint = z.infer<typeof ConnectionEndpointSchema>;
export type Vertex = z.infer<typeof VertexSchema>;
export type Viewport = z.infer<typeof ViewportSchema>;
export type CanvasUser = z.infer<typeof CanvasUserSchema>;
export type AnchorType = z.infer<typeof AnchorTypeSchema>;
export type VersusDraft = z.infer<typeof VersusDraftSchema>;
export type VersusDraftListItem = z.infer<typeof VersusDraftListItemSchema>;
export type VersusParticipant = z.infer<typeof VersusParticipantSchema>;
export type VersusState = z.infer<typeof VersusStateSchema>;
export type VersusJoinResponse = z.infer<typeof VersusJoinResponseSchema>;
export type VersusRoleSelectResponse = z.infer<
  typeof VersusRoleSelectResponseSchema
>;
export type CanvasResponse = z.infer<typeof CanvasResponseSchema>;
export type UserDetails = z.infer<typeof UserDetailsSchema>;
export type CanvasListItem = z.infer<typeof CanvasListItemSchema>;
export type Activity = z.infer<typeof ActivityItemSchema>;
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;

// Socket Event Types
export type VersusParticipantsUpdate = z.infer<
  typeof VersusParticipantsUpdateSchema
>;
export type VersusSyncResponse = z.infer<typeof VersusSyncResponseSchema>;
export type VersusSeriesUpdate = z.infer<typeof VersusSeriesUpdateSchema>;
export type VersusError = z.infer<typeof VersusErrorSchema>;
export type DraftStateSync = z.infer<typeof DraftStateSyncSchema>;
export type DraftUpdate = z.infer<typeof DraftUpdateSchema>;
export type CanvasDraftUpdate = z.infer<typeof CanvasDraftUpdateSchema>;
export type DraftStarted = z.infer<typeof DraftStartedSchema>;
export type ReadyUpdate = z.infer<typeof ReadyUpdateSchema>;
export type GameSettingsUpdate = z.infer<typeof GameSettingsUpdateSchema>;
export type PauseRequested = z.infer<typeof PauseRequestedSchema>;
export type ResumeRequested = z.infer<typeof ResumeRequestedSchema>;
export type ResumeCountdownStarted = z.infer<
  typeof ResumeCountdownStartedSchema
>;
export type ResumeRejected = z.infer<typeof ResumeRejectedSchema>;
export type PickChangeRequested = z.infer<typeof PickChangeRequestedSchema>;
export type PickChangeResponse = z.infer<typeof PickChangeResponseSchema>;
export type VersusMessage = z.infer<typeof VersusMessageSchema>;
export type WinnerUpdate = z.infer<typeof WinnerUpdateSchema>;
export type DraftStatusUpdate = z.infer<typeof DraftStatusUpdateSchema>;
export type CanvasObjectMoved = z.infer<typeof CanvasObjectMovedSchema>;
export type VertexMoved = z.infer<typeof VertexMovedSchema>;
export type GroupMoved = z.infer<typeof GroupMovedSchema>;
export type GroupResized = z.infer<typeof GroupResizedSchema>;
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
export type RoleAvailable = z.infer<typeof RoleAvailableSchema>;
