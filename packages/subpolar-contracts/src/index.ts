export const CONTRACT_VERSION = "0.1";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type PrincipalKind = "user" | "service" | "local";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  displayName?: string;
}

export interface ExecutionContext {
  requestId: string;
  principal: Principal;
  sessionId?: string;
  runId?: string;
  agentId?: string;
  projectId?: string;
  cwd?: string;
  metadata?: Record<string, string>;
}

export interface RunContext {
  requestId: string;
  principal: Principal;
  sessionId?: string;
  projectId?: string;
  agentId?: string;
  model?: string;
  permission?: string;
  cwd?: string;
  metadata?: Record<string, string>;
}

/** Context resolved for one run or one tool call. It is never a process-global singleton. */
export interface RuntimeContext extends RunContext {
  runId?: string;
}

export interface RuntimeContextRequest {
  requestId: string;
  runId: string;
  sessionId?: string;
  principal?: Principal;
}

export interface RuntimeContextPort {
  load(request: RuntimeContextRequest): Promise<RuntimeContext | undefined>;
}

export type RuntimeContextResolver = RuntimeContextPort;

export type RunState = "idle" | "running" | "completed" | "failed" | "interrupted" | "unknown";

export type RunEventType =
  | "run.started"
  | "run.progress"
  | "run.completed"
  | "run.failed"
  | "run.interrupted"
  | "run.unknown";

export interface RunRequest {
  runId: string;
  prompt: string;
  context: RunContext;
  signal?: AbortSignal;
}

export interface RunEvent<T = JsonValue> {
  eventId: string;
  type: RunEventType;
  occurredAt: string;
  runId: string;
  requestId: string;
  sessionId?: string;
  state: RunState;
  data: T;
}

export type RunEventSink = (event: RunEvent) => void | Promise<void>;
export type RunProgressEmitter = (data: JsonValue) => void | Promise<void>;

export interface RunError {
  code: string;
  message: string;
  details?: JsonValue;
}

export interface RunResultBase {
  runId: string;
  requestId: string;
  sessionId?: string;
  resumed: boolean;
  recoverable: boolean;
}

export interface RunSuccess extends RunResultBase {
  state: "completed";
  output: unknown;
}

export interface RunFailure extends RunResultBase {
  state: "failed" | "interrupted" | "unknown";
  error: RunError;
}

export type RunResult = RunSuccess | RunFailure;

export interface ApprovalRequiredRunResult extends RunResultBase {
  state: "approval_required";
  approvalId: string;
  error: RunError;
}

export type StatelessRunResult = RunResult | ApprovalRequiredRunResult;

export interface RunOutcome {
  runId: string;
  requestId: string;
  sessionId?: string;
  state: "completed" | "failed" | "interrupted" | "unknown";
  output?: unknown;
  error?: RunError;
  recoverable: boolean;
  occurredAt: string;
}

/** Durable run record. Implementations may store additional adapter-local fields. */
export interface Run {
  runId: string;
  requestId: string;
  sessionId?: string;
  context: RuntimeContext;
  prompt: string;
  state: RunState;
  outcome?: RunOutcome;
  createdAt: string;
  updatedAt: string;
}

export interface RunStore {
  readonly capabilities: AdapterCapabilities;
  load(runId: string): Promise<RunOutcome | undefined>;
  save(outcome: RunOutcome): Promise<void>;
}

export interface OwnerRunRecord extends RunOutcome {
  id: string;
  ownerId: string;
}

export interface RunRepository {
  load(ownerId: string, runId: string): Promise<OwnerRunRecord | undefined>;
  list(ownerId: string): Promise<OwnerRunRecord[]>;
  save(ownerId: string, outcome: RunOutcome): Promise<OwnerRunRecord>;
}

export interface RunEventRepository {
  append(ownerId: string, event: RunEvent): Promise<RunEvent>;
  replay(ownerId: string, runId: string): Promise<RunEvent[]>;
}

export interface EventReplayPort {
  readonly capabilities: AdapterCapabilities;
  append(event: RunEvent): Promise<void>;
  replay(runId: string): Promise<readonly RunEvent[]>;
}

export type AgentExecutor = (request: RunRequest, emit?: RunProgressEmitter) => unknown | Promise<unknown>;

export interface AgentRunPort {
  run(request: RunRequest, emit?: RunProgressEmitter): unknown | Promise<unknown>;
}

export interface StatelessRunRequest {
  runId: string;
  requestId: string;
  prompt: string;
  sessionId?: string;
  principal?: Principal;
  signal?: AbortSignal;
}

export interface RuntimeToolInvoker {
  call(call: ToolCall, signal?: AbortSignal): Promise<unknown>;
}

export interface RuntimeExecution {
  request: StatelessRunRequest;
  context: RuntimeContext;
  tools: RuntimeToolInvoker;
  emit(data: JsonValue): Promise<void>;
}

export type StatelessExecutor = (execution: RuntimeExecution) => unknown | Promise<unknown>;

export interface StatelessSubpolarRuntimePort {
  run(request: StatelessRunRequest): Promise<StatelessRunResult>;
  callTool(call: ToolCall, request: StatelessRunRequest): Promise<unknown>;
  decideApproval(approvalId: string, decision: ApprovalDecision): Promise<ApprovalRecord>;
}

export interface ToolDefinition {
  id: string;
  namespace: string;
  description: string;
  inputSchema: JsonValue;
  enabled: boolean;
  risk: "low" | "medium" | "high";
  metadata?: Record<string, string>;
}

export interface ToolDefinitionRecord extends ToolDefinition {
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolDefinitionPatch {
  namespace?: string;
  description?: string;
  inputSchema?: JsonValue;
  enabled?: boolean;
  risk?: ToolDefinition["risk"];
  metadata?: Record<string, string>;
}

export interface ToolDefinitionRepository {
  create(ownerId: string, definition: ToolDefinition): Promise<ToolDefinitionRecord>;
  get(ownerId: string, toolId: string): Promise<ToolDefinitionRecord | undefined>;
  list(ownerId: string): Promise<ToolDefinitionRecord[]>;
  update(ownerId: string, toolId: string, patch: ToolDefinitionPatch): Promise<ToolDefinitionRecord>;
}

export interface ToolPolicyRecord {
  id: string;
  ownerId: string;
  toolId: string;
  agentId?: string;
  projectId?: string;
  rules: PolicyRules;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ToolPolicyInput {
  id?: string;
  toolId: string;
  agentId?: string;
  projectId?: string;
  rules: PolicyRules;
  version?: number;
}

export interface ToolPolicyRepository {
  save(ownerId: string, input: ToolPolicyInput): Promise<ToolPolicyRecord>;
  get(ownerId: string, id: string): Promise<ToolPolicyRecord | undefined>;
  list(ownerId: string, filter?: { toolId?: string; agentId?: string; projectId?: string }): Promise<ToolPolicyRecord[]>;
}

export interface ToolCall {
  callId: string;
  toolId: string;
  input: unknown;
  /** The run/request identity is optional for compatibility with direct gateway callers. */
  runId?: string;
  requestId?: string;
  idempotencyKey?: string;
}

export interface ToolCallRequest extends ToolCall {}

export type PolicyPrecedence = "deny" | "approval_required" | "allow";

export interface PolicyRules {
  deny?: boolean;
  requiresApproval?: boolean;
  allow?: boolean;
  reason?: string;
  /** Set by a durable policy record when the rule is selected for a call. */
  policyId?: string;
}

/**
 * Agent policy records as returned by a persistence adapter. The core does not
 * know how the records were stored; it only applies their owner/agent/project
 * scope and the rule precedence at the execution boundary.
 */
export interface AgentPolicyRules {
  policies: readonly ToolPolicyRecord[];
  fallback?: PolicyRules;
}

export type PolicyRuleSource =
  | PolicyRules
  | ToolPolicyRecord
  | readonly ToolPolicyRecord[]
  | AgentPolicyRules
  | PolicyResolver;

export type PolicyDecisionKind = "deny" | "approval_required" | "allow";

export interface PolicyDecision {
  kind: PolicyDecisionKind;
  reason: string;
  precedence?: PolicyPrecedence;
  policyId?: string;
}

export type PolicyResolver = (
  definition: ToolDefinition,
  context: ExecutionContext,
  input: unknown,
) => PolicyRules | Promise<PolicyRules>;

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

export type InputValidator = (
  input: unknown,
  definition: ToolDefinition,
) => ValidationResult | Promise<ValidationResult>;

export interface ApprovalRequest {
  approvalId: string;
  call: ToolCall;
  definition: ToolDefinition;
  context: ExecutionContext;
  decision: PolicyDecision;
  runId?: string;
  requestedAt?: string;
}

export type ApprovalContinuationFactory = (
  request: ApprovalRequest,
) => OpaqueContinuation | undefined | Promise<OpaqueContinuation | undefined>;

export type ApprovalDecision =
  | { approved: true; decidedBy?: string }
  | { approved: false; reason?: string; decidedBy?: string };

export type ApprovalCallback = (
  request: ApprovalRequest,
  signal?: AbortSignal,
) => ApprovalDecision | Promise<ApprovalDecision>;

export type ApprovalStatus = "pending" | "approved" | "denied";

/** A durable approval is the continuation record, not an in-memory callback/closure. */
export interface ApprovalRecord {
  approvalId: string;
  callId: string;
  toolId: string;
  runId?: string;
  request: JsonValue;
  status: ApprovalStatus;
  decidedBy?: string;
  reason?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface ApprovalStore {
  load(approvalId: string): Promise<ApprovalRecord | undefined>;
  create(request: ApprovalRequest): Promise<ApprovalRecord>;
  decide(approvalId: string, decision: ApprovalDecision): Promise<ApprovalRecord>;
}

export type DurableApprovalPort = ApprovalStore;

/** Owner-bound continuation storage. Implementations must keep payload opaque. */
export interface ApprovalContinuationPort {
  put(approvalId: string, callId: string, continuation: OpaqueContinuation): Promise<ApprovalContinuationRecord>;
  load(approvalId: string): Promise<ApprovalContinuationRecord | undefined>;
}

export interface ApprovalClaimPort {
  claim(approvalId: string, callId: string): Promise<ApprovalClaim>;
}

export type DurableApprovalContinuationPort = ApprovalContinuationPort;
export type DurableApprovalClaimPort = ApprovalClaimPort;

export interface OpaqueContinuation {
  payload: string;
  keyId?: string;
  requestHash: string;
  expiresAt: string;
}

export interface ApprovalContinuationRecord extends OpaqueContinuation {
  id: string;
  ownerId: string;
  approvalId: string;
  callId: string;
  claimedAt?: string;
  claimToken?: string;
}

export interface ApprovalContinuationRepository {
  put(ownerId: string, approvalId: string, callId: string, continuation: OpaqueContinuation): Promise<ApprovalContinuationRecord>;
  get(ownerId: string, approvalId: string): Promise<ApprovalContinuationRecord | undefined>;
}

export interface ApprovalClaim {
  approvalId: string;
  callId: string;
  ownerId: string;
  claimed: boolean;
  claimedAt: string;
  claimToken: string;
}

export interface ApprovalClaimRepository {
  claim(ownerId: string, approvalId: string, callId: string): Promise<ApprovalClaim>;
}

export type AtomicApprovalClaimPort = ApprovalClaimRepository;

export interface CallIdempotencyRepository {
  execute<T>(ownerId: string, callId: string, operation: () => Promise<T> | T): Promise<T>;
}

export type DurableCallIdempotencyPort = CallIdempotencyRepository;

export interface ToolSuccess<T = unknown> {
  ok: true;
  value: T;
}

export interface ToolFailure {
  ok: false;
  error: ToolError;
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure;

export interface ToolError {
  code: string;
  message: string;
  details?: JsonValue;
}

export type ToolExecutor = (
  call: ToolCall,
  definition: ToolDefinition,
  context: ExecutionContext,
  signal?: AbortSignal,
) => ToolResult | Promise<ToolResult>;

export type AuditStatus =
  | "unknown_tool"
  | "disabled"
  | "validation_failed"
  | "denied"
  | "approval_required"
  | "approval_denied"
  | "executed"
  | "failed";

export interface AuditRecord {
  auditId: string;
  callId: string;
  toolId: string;
  principalId: string;
  sessionId?: string;
  requestId: string;
  decision: PolicyDecisionKind | "not_evaluated";
  status: AuditStatus;
  input: JsonValue;
  result?: JsonValue;
  reason?: string;
  occurredAt: string;
}

export interface DomainEvent<T = JsonValue> {
  eventId: string;
  type: string;
  occurredAt: string;
  data: T;
}

export type AuditEvent = DomainEvent<AuditRecord> & { type: "tool.audit" };
export type AuditEventSink = (event: AuditEvent) => void | Promise<void>;
export type EventSink = (event: DomainEvent) => void | Promise<void>;

export interface AuditPort {
  append(event: AuditEvent): Promise<void>;
}

export type AuditStore = AuditPort;

export interface EventPort {
  append(event: DomainEvent): Promise<void>;
  replay?(runId: string): Promise<readonly DomainEvent[]>;
}

export type EventStore = EventPort;

export type AdapterCapability =
  | "session.persistence"
  | "run.persistence"
  | "run.outcome.persistence"
  | "transcript.persistence"
  | "event.replay"
  | "multi-process-concurrency"
  | "durable-approvals"
  | "idempotency"
  | "memory.persistence";

export interface AdapterCapabilities {
  adapter: string;
  durability: "ephemeral" | "json-file" | "remote";
  supports: Readonly<Partial<Record<AdapterCapability, boolean>>>;
}

export class UnsupportedCapabilityError extends Error {
  readonly code = "UNSUPPORTED_CAPABILITY";
  readonly capability: AdapterCapability;
  readonly adapter: string;

  constructor(capability: AdapterCapability, adapter: string, message?: string) {
    super(message ?? `${adapter} does not support ${capability}`);
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
    this.adapter = adapter;
  }
}

export class UnsupportedRecoveryError extends Error {
  readonly code = "UNSUPPORTED_RECOVERY";
  readonly adapter: string;

  constructor(adapter: string, message?: string) {
    super(message ?? `${adapter} cannot durably recover an interrupted run`);
    this.name = "UnsupportedRecoveryError";
    this.adapter = adapter;
  }
}

export interface RunMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  occurredAt: string;
  messageId?: string;
  runId?: string;
  requestId?: string;
}

export type SessionTranscriptEntry = RunMessage;

export type CanonicalTranscriptRole = "system" | "user" | "assistant" | "tool";

export interface CanonicalTranscriptEntry {
  messageId?: string;
  role: CanonicalTranscriptRole;
  content?: string;
  toolCall?: JsonValue;
  toolResult?: JsonValue;
  error?: JsonValue;
  usage?: JsonValue;
  metadata?: JsonValue;
  occurredAt: string;
}

export interface CanonicalTranscriptRecord extends CanonicalTranscriptEntry {
  id: string;
  ownerId: string;
  sessionId: string;
  runId?: string;
  sequence: number;
}

export interface CanonicalTranscriptRepository {
  append(ownerId: string, sessionId: string, entries: readonly CanonicalTranscriptEntry[], runId?: string): Promise<CanonicalTranscriptRecord[]>;
  list(ownerId: string, sessionId: string): Promise<CanonicalTranscriptRecord[]>;
  get(ownerId: string, sessionId: string, messageId: string): Promise<CanonicalTranscriptRecord | undefined>;
}

export type StructuredTranscriptRepository = CanonicalTranscriptRepository;

export type TranscriptEventType =
  | "message.created"
  | "tool.call.requested"
  | "tool.call.completed"
  | "approval.required";

export interface TranscriptEvent<T = JsonValue> {
  eventId: string;
  type: TranscriptEventType;
  occurredAt: string;
  runId: string;
  requestId: string;
  sessionId?: string;
  data: T;
}

export interface MessageEvent extends TranscriptEvent<RunMessage> {
  type: "message.created";
}

export interface ToolCallEvent extends TranscriptEvent<ToolCall> {
  type: "tool.call.requested" | "tool.call.completed";
}

export type StructuredTranscriptEvent = MessageEvent | ToolCallEvent | TranscriptEvent;

export interface TranscriptPort {
  load(sessionId: string): Promise<readonly SessionTranscriptEntry[]>;
  append(sessionId: string, entries: readonly SessionTranscriptEntry[]): Promise<void>;
}

export interface SessionRecord {
  sessionId: string;
  transcript: SessionTranscriptEntry[];
  updatedAt: string;
}

export interface SessionStore {
  readonly capabilities: AdapterCapabilities;
  load(sessionId: string): Promise<SessionRecord | undefined>;
  append(sessionId: string, entries: SessionTranscriptEntry[]): Promise<SessionRecord>;
}

export interface IdempotencyPort {
  /** The operation must return the previously committed value for an existing key. */
  execute<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export type DurableIdempotencyPort = IdempotencyPort;

export interface RuntimeEventPort {
  append(event: RunEvent | TranscriptEvent | AuditEvent): Promise<void>;
  replay(runId: string): Promise<readonly (RunEvent | TranscriptEvent | AuditEvent)[]>;
}

export interface RuntimePersistencePorts {
  readonly context: RuntimeContextPort;
  readonly sessions?: SessionStore;
  readonly runs?: RunStore;
  readonly approvals?: ApprovalStore;
  readonly idempotency?: IdempotencyPort;
  readonly audit?: AuditPort;
  readonly events?: RuntimeEventPort;
}

export type MemoryScope = "user" | "agent" | "project";

export interface MemoryRecord {
  id: string;
  ownerId: string;
  scope: MemoryScope;
  agentId?: string;
  projectId?: string;
  content: string;
  metadata: JsonValue;
  createdAt: string;
  updatedAt: string;
  version: number;
  tombstone: boolean;
}

export interface MemoryStore {
  readonly capabilities: AdapterCapabilities;
  list(ownerId: string, limit?: number): Promise<readonly MemoryRecord[]>;
  save(record: MemoryRecord): Promise<MemoryRecord>;
}

export * from "./skills.ts";
export * from "./operations.ts";
