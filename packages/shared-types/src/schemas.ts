import { z } from "zod";

// =============================================================================
// Base/Shared Schemas
// =============================================================================

export const SuccessSchema = z.object({
  success: z.boolean(),
});

export const DedupeStrategySchema = z.enum(["skip", "rename", "overwrite"]);

export const ViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number(),
});

export const AnchorTypeSchema = z.enum(["top", "bottom", "left", "right"]);
export const CardLayoutSchema = z.enum([
  "vertical",
  "horizontal",
  "wide",
  "wide-draft-order",
  "compact",
  "draft-order",
]);

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
  completedAt: z.string().nullable().optional(),
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

export const DraftModeSchema = z.enum(["standard", "fearless", "ironman"]);

export const CanvasGroupMetadataSchema = z.object({
  blueTeamName: z.string().optional(),
  redTeamName: z.string().optional(),
  length: z.number().optional(),
  competitive: z.boolean().optional(),
  seriesType: z.string().optional(),
  origin: z.enum(["live", "manual"]).optional(),
  disabledChampions: z.array(z.string()).optional(),
  draftMode: DraftModeSchema.optional(),
  layout: z.enum(["free", "grid"]).optional(),
  gridCols: z.number().int().min(1).optional(),
  rowLabels: z.array(z.string()).optional(),
  colLabels: z.array(z.string()).optional(),
});

// =============================================================================
// Team Schemas (Canvas Team entity — user-owned, global across their canvases)
// =============================================================================

export const TeamSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  name: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Team = z.infer<typeof TeamSchema>;

export const CreateTeamPayloadSchema = z.object({
  name: z.string().min(1).max(120),
});
export type CreateTeamPayload = z.infer<typeof CreateTeamPayloadSchema>;

export const UpdateTeamPayloadSchema = z.object({
  name: z.string().min(1).max(120),
});
export type UpdateTeamPayload = z.infer<typeof UpdateTeamPayloadSchema>;

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
  team1_id: z.string().nullable().optional(),
  team2_id: z.string().nullable().optional(),
  Team1: TeamSchema.nullable().optional(),
  Team2: TeamSchema.nullable().optional(),
  metadata: CanvasGroupMetadataSchema,
  isInProgress: z.boolean().optional(),
  CanvasDrafts: z.array(CanvasDraftSchema).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const DraftPositionUpdateSchema = z.object({
  draft_id: z.string(),
  positionX: z.number(),
  positionY: z.number(),
  group_id: z.string().nullable().optional(),
});

export const DraftPositionsUpdatedSchema = z.object({
  positions: z.array(DraftPositionUpdateSchema),
  group: CanvasGroupSchema.nullable(),
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

// No email by design: any canvas member (including view-only) can fetch
// this list for the Share popover's access list.
export const CanvasUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  picture: z.string(),
  display_name: z.string().nullable(),
  permissions: z.enum(["view", "edit", "admin"]),
  lastAccessedAt: z.string(),
  isOwner: z.boolean(),
});

// =============================================================================
// User Export / Import Schemas
// =============================================================================

export const ExportedUserSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  picture: z.string().optional(),
  display_name: z.string().nullable().optional(),
  createdAt: z.string().optional(),
});

export const ExportedCanvasDraftSchema = z.object({
  id: z.string(),
  name: z.string(),
  picks: z.array(z.string()),
  positionX: z.number(),
  positionY: z.number(),
});

export const ExportedCanvasGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["series", "custom"]),
  positionX: z.number(),
  positionY: z.number(),
});

export const ExportedCanvasSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  createdAt: z.string().optional(),
  drafts: z.array(ExportedCanvasDraftSchema).default([]),
  groups: z.array(ExportedCanvasGroupSchema).default([]),
});

export const ExportedVersusSeriesDraftSchema = z.object({
  id: z.string(),
  name: z.string(),
  picks: z.array(z.string()),
  gameNumber: z.number().nullable().optional(),
  winner: z.enum(["blue", "red"]).nullable().optional(),
});

export const ExportedVersusSeriesSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  seriesLength: z.number(),
  draftType: z.string().optional(),
  blueTeamName: z.string(),
  redTeamName: z.string(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  drafts: z.array(ExportedVersusSeriesDraftSchema).default([]),
});

export const UserExportSchema = z.object({
  exportedAt: z.string(),
  user: ExportedUserSchema.optional(),
  canvases: z.array(ExportedCanvasSchema).default([]),
  versusSeries: z.array(ExportedVersusSeriesSchema).default([]),
});

export const CanvasImportModeSchema = z.enum(["new_canvases", "target_canvas"]);

export const ImportUserDataRequestSchema = z.object({
  exportData: UserExportSchema,
  options: z.object({
    canvasIds: z.array(z.string()).default([]),
    versusSeriesIds: z.array(z.string()).default([]),
    dedupeStrategy: DedupeStrategySchema,
    canvasImportMode: CanvasImportModeSchema,
    targetCanvasId: z.string().nullable().optional(),
  }),
});

export const ImportUserDataResponseSchema = z.object({
  success: z.boolean(),
  summary: z.object({
    canvasesCreated: z.number(),
    canvasesUpdated: z.number(),
    draftsCreated: z.number(),
    draftsUpdated: z.number(),
    draftsSkipped: z.number(),
    seriesCreated: z.number(),
    seriesUpdated: z.number(),
    seriesSkipped: z.number(),
  }),
  warnings: z.array(z.string()),
});

export const ExternalCanvasImportDraftSchema = z.object({
  name: z.string().min(1),
  picks: z.array(z.string()).length(20),
  positionX: z.number().optional(),
  positionY: z.number().optional(),
  firstPick: z.enum(["blue", "red"]).optional(),
  blueSideTeam: z.union([z.literal(1), z.literal(2)]).optional(),
});

export const ExternalVersusImportDraftSchema = z.object({
  name: z.string().min(1).optional(),
  picks: z.array(z.string()).length(20),
  gameNumber: z.number().int().positive().optional(),
  winner: z.enum(["blue", "red"]).nullable().optional(),
  firstPick: z.enum(["blue", "red"]).optional(),
  blueSideTeam: z.union([z.literal(1), z.literal(2)]).optional(),
});

export const ExternalVersusSeriesImportSchema = z.object({
  name: z.string().min(1).optional(),
  seriesLength: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7)]),
  draftType: DraftModeSchema.optional(),
  blueTeamName: z.string().min(1).optional(),
  redTeamName: z.string().min(1).optional(),
  competitive: z.boolean().optional(),
  disabledChampions: z.array(z.string()).optional(),
  positionX: z.number().optional(),
  positionY: z.number().optional(),
  drafts: z.array(ExternalVersusImportDraftSchema).min(1),
});

export const CanvasJsonImportDataSchema = z.object({
  drafts: z.array(ExternalCanvasImportDraftSchema).default([]),
  versusSeries: z.array(ExternalVersusSeriesImportSchema).default([]),
}).refine((value) => value.drafts.length > 0 || value.versusSeries.length > 0, {
  message: "Provide at least one draft or versus series to import",
});

export const CanvasJsonImportRequestSchema = z.object({
  data: CanvasJsonImportDataSchema,
  options: z.object({
    dedupeStrategy: DedupeStrategySchema,
    basePositionX: z.number().optional(),
    basePositionY: z.number().optional(),
  }),
});

export const CanvasJsonImportResponseSchema = z.object({
  success: z.boolean(),
  summary: z.object({
    draftsCreated: z.number(),
    draftsUpdated: z.number(),
    draftsSkipped: z.number(),
    seriesCreated: z.number(),
    seriesUpdated: z.number(),
    seriesSkipped: z.number(),
  }),
  warnings: z.array(z.string()),
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
  origin: z.enum(["live", "manual"]).default("live"),
  disabledChampions: z.array(z.string()).optional(),
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
  blueSideTeam: z.union([z.literal(1), z.literal(2)]).optional(),
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
  origin: z.enum(["live", "manual"]).default("live"),
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
  role: z.enum(["team1_captain", "team2_captain", "spectator"]),
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
  completedAt: z.string().nullable().optional(),
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
    team1_captain: z.boolean(),
    team2_captain: z.boolean(),
    spectator: z.boolean(),
  }),
  autoJoinedRole: z
    .enum(["team1_captain", "team2_captain", "spectator"])
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
  cardLayout: CardLayoutSchema,
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
  display_name: z.string().nullable(),
  keyboard_controls: z.boolean(),
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

const ActivityBaseSchema = z.object({
  resource_id: z.string(),
  resource_name: z.string(),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  timestamp: z.string(),
  created_at: z.string(),
  is_owner: z.boolean(),
});

const CanvasActivitySchema = ActivityBaseSchema.extend({
  resource_type: z.literal("canvas"),
});

const VersusActivitySchema = ActivityBaseSchema.extend({
  resource_type: z.literal("versus"),
  blueTeamName: z.string(),
  redTeamName: z.string(),
  length: z.number(),
  competitive: z.boolean(),
  type: z.string().nullable(),
  origin: z.enum(["live", "manual"]).default("live"),
  disabledChampions: z.array(z.string()),
  hasStarted: z.boolean(),
});

export const NavigatorActivitySchema = ActivityBaseSchema.extend({
  resource_type: z.literal("navigator"),
});

export const ActivityItemSchema = z.discriminatedUnion("resource_type", [
  CanvasActivitySchema,
  VersusActivitySchema,
  NavigatorActivitySchema,
]);

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
  cardLayout: CardLayoutSchema.optional(),
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

export const ShareCanvasVerifySchema = z.object({
  success: z.boolean(),
  canvasId: z.string(),
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
  completedAt: z.string().nullable().optional(),
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
  completedAt: z.string().nullable().optional(),
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
  role: z.enum(["team1_captain", "team2_captain", "spectator"]),
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
  picks: z.array(z.string()),
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
  positionX: z.number().optional(),
});

// =============================================================================
// Socket Event Schemas - General
// =============================================================================

export const HeartbeatSchema = z.object({
  timerStartedAt: z.number().nullable(),
  currentPickIndex: z.number(),
});

export const RoleAvailableSchema = z.object({
  role: z.enum(["team1_captain", "team2_captain"]),
});

// =============================================================================
// Type Exports (inferred from schemas)
// =============================================================================

export type Draft = z.infer<typeof DraftSchema>;
// Lowercase alias for backward compatibility
export type draft = Draft;
export type CanvasDraft = z.infer<typeof CanvasDraftSchema>;
export type CanvasGroupMetadata = z.infer<typeof CanvasGroupMetadataSchema>;
export type DraftMode = z.infer<typeof DraftModeSchema>;
export type CanvasGroup = z.infer<typeof CanvasGroupSchema>;
export type DraftPositionUpdate = z.infer<typeof DraftPositionUpdateSchema>;
export type DraftPositionsUpdated = z.infer<
  typeof DraftPositionsUpdatedSchema
>;
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

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Derives the effective side (blue/red) from a team-based role and the current
 * blueSideTeam assignment. Replaces all `role.includes("blue")` patterns.
 */
export function getEffectiveSide(
  role: string,
  blueSideTeam: number,
): "blue" | "red" {
  if (role === "team1_captain") return blueSideTeam === 1 ? "blue" : "red";
  if (role === "team2_captain") return blueSideTeam === 1 ? "red" : "blue";
  return "blue"; // fallback (spectators don't call this)
}

// =============================================================================
// Navigator Pool Schemas
// =============================================================================

export const RoleSchema = z.enum(["top", "jungle", "mid", "adc", "support"]);
export type Role = z.infer<typeof RoleSchema>;

export const RolePoolMapSchema = z.object({
  top: z.array(z.string()),
  jungle: z.array(z.string()),
  mid: z.array(z.string()),
  adc: z.array(z.string()),
  support: z.array(z.string()),
});
export type RolePoolMap = z.infer<typeof RolePoolMapSchema>;

export const TeamPoolSchema = z.object({
  display: RolePoolMapSchema,
  search: z.array(z.string()),
});
export type TeamPool = z.infer<typeof TeamPoolSchema>;

export const EMPTY_ROLE_POOL_MAP: RolePoolMap = {
  top: [],
  jungle: [],
  mid: [],
  adc: [],
  support: [],
};

export const EMPTY_TEAM_POOL: TeamPool = {
  display: EMPTY_ROLE_POOL_MAP,
  search: [],
};

// =============================================================================
// SavedPool Schemas (Navigator)
// =============================================================================

export const SavedPoolSchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  champions: RolePoolMapSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedPool = z.infer<typeof SavedPoolSchema>;

export const CreateSavedPoolPayloadSchema = z.object({
  name: z.string().min(1).max(120),
  champions: RolePoolMapSchema,
});
export type CreateSavedPoolPayload = z.infer<
  typeof CreateSavedPoolPayloadSchema
>;

export const UpdateSavedPoolPayloadSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  champions: RolePoolMapSchema.optional(),
});
export type UpdateSavedPoolPayload = z.infer<
  typeof UpdateSavedPoolPayloadSchema
>;

// =============================================================================
// Pool JSON Import Schema
// =============================================================================
//
// Shape accepted by the "Import JSON" modal. `name` is optional and used as
// the default when the user chooses "Save as SavedPool". All 5 role keys are
// required; empty arrays allowed. Champion names are resolved downstream by a
// case-insensitive / variant-tolerant matcher — this schema only checks shape.

export const PoolJsonImportSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  champions: z.object({
    top: z.array(z.string()),
    jungle: z.array(z.string()),
    mid: z.array(z.string()),
    adc: z.array(z.string()),
    support: z.array(z.string()),
  }),
});
export type PoolJsonImport = z.infer<typeof PoolJsonImportSchema>;

// =============================================================================
// Navigator Series Schemas
// =============================================================================

export const SeriesLengthSchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(5),
  z.literal(7),
]);
export type SeriesLength = z.infer<typeof SeriesLengthSchema>;

export const SideSwapModeSchema = z.enum(["auto", "manual"]);
export type SideSwapMode = z.infer<typeof SideSwapModeSchema>;

export const OurSideOverrideSchema = z.enum(["blue", "red"]).nullable();
export type OurSideOverride = z.infer<typeof OurSideOverrideSchema>;

// =============================================================================
// Player Scouting Schemas (Team Scouting & Player-Derived Pools — Slice 1)
// =============================================================================

export const ChampionStatEntrySchema = z.object({
  championId: z.string(),
  role: z.enum(["top", "jungle", "mid", "adc", "support"]),
  games: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  lastPlayed: z.string().nullable(),
  recentWindowGames: z.number().int().nonnegative().nullable(),
});
export type ChampionStatEntry = z.infer<typeof ChampionStatEntrySchema>;

export const ChampionStatsEnvelopeSchema = z.object({
  provider: z.literal("ugg"),
  schemaVersion: z.literal(1),
  fetchedAt: z.string(),
  season: z.string(),
  queue: z.string(),
  entries: z.array(ChampionStatEntrySchema),
});
export type ChampionStatsEnvelope = z.infer<typeof ChampionStatsEnvelopeSchema>;

// Max players per multi-scout. Single source of truth for the cap (client +
// server). Lifting the cap later is a one-line change here.
export const MAX_SCOUT_PLAYERS = 5;

export const ScoutPlayerInputSchema = z.object({
  region: z.string(),
  gameName: z.string(),
  tagLine: z.string(),
});
export type ScoutPlayerInput = z.infer<typeof ScoutPlayerInputSchema>;

// Batch request: one shared region, 1..MAX players.
export const ScoutPlayersRequestSchema = z.object({
  region: z.string().min(1),
  players: z
    .array(z.object({ gameName: z.string().min(1), tagLine: z.string().min(1) }))
    .min(1)
    .max(MAX_SCOUT_PLAYERS),
});
export type ScoutPlayersRequest = z.infer<typeof ScoutPlayersRequestSchema>;

// Per-player result: a discriminated union so one bad Riot ID never nukes the
// whole scout. Type-safe narrowing on `status` (no `as`).
export const PlayerScoutResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    input: ScoutPlayerInputSchema,
    envelope: ChampionStatsEnvelopeSchema,
  }),
  z.object({
    status: z.literal("error"),
    input: ScoutPlayerInputSchema,
    error: z.string(),
  }),
]);
export type PlayerScoutResult = z.infer<typeof PlayerScoutResultSchema>;

export const ScoutPlayersResponseSchema = z.object({
  results: z.array(PlayerScoutResultSchema),
});
export type ScoutPlayersResponse = z.infer<typeof ScoutPlayersResponseSchema>;
