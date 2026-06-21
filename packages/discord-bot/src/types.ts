// StructuredIO NDJSON Protocol Types
// Based on claude-code/src/entrypoints/sdk/coreSchemas.ts and controlSchemas.ts

// --- Inbound (stdin → Claude CLI) ---

export interface SDKUserMessage {
  type: "user";
  session_id?: string;
  uuid?: string;
  message: {
    role: "user";
    content: string;
  };
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
}

export interface ControlResponse {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response: PermissionResponse | InitializeResponse | Record<string, unknown>;
  };
}

export interface PermissionResponse {
  behavior: "allow" | "deny" | "allowForSession";
  toolUseID: string;
  message?: string;
}

export interface InitializeResponse {
  commands?: unknown[];
  agents?: unknown[];
  models?: unknown[];
  account?: unknown;
}

export interface ControlInitializeRequest {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "initialize";
    hooks?: Record<string, unknown>;
    sdkMcpServers?: string[];
    systemPrompt?: string;
    appendSystemPrompt?: string;
    promptSuggestions?: boolean;
  };
}

// --- Outbound (Claude CLI → stdout) ---

export interface SDKAssistantMessage {
  type: "assistant";
  message: {
    role: "assistant";
    content: ContentBlock[];
  };
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
  error?: { message: string };
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  thinking?: string;
}

export interface SDKResultSuccess {
  type: "result";
  subtype: "success";
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  result: string;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: Record<string, unknown>;
  permission_denials: PermissionDenial[];
  uuid: string;
  session_id: string;
}

export interface SDKResultError {
  type: "result";
  subtype:
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries";
  duration_ms: number;
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
  errors: string[];
  uuid: string;
  session_id: string;
}

export type SDKResultMessage = SDKResultSuccess | SDKResultError;

export interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

export interface SDKSystemMessage {
  type: "system";
  subtype: "init";
  model: string;
  cwd: string;
  tools: string[];
  claude_code_version: string;
  permissionMode: string;
  uuid: string;
  session_id: string;
}

export interface SDKStreamEvent {
  type: "stream_event";
  event: StreamEventData;
  parent_tool_use_id: string | null;
}

export type StreamEventData =
  | ContentBlockStart
  | ContentBlockDelta
  | ContentBlockStop
  | MessageStart
  | MessageDelta
  | MessageStop;

export interface ContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block: ContentBlock;
}

export interface ContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta: {
    type: "text_delta" | "input_json_delta" | "thinking_delta";
    text?: string;
    partial_json?: string;
    thinking?: string;
  };
}

export interface ContentBlockStop {
  type: "content_block_stop";
  index: number;
}

export interface MessageStart {
  type: "message_start";
  message: Record<string, unknown>;
}

export interface MessageDelta {
  type: "message_delta";
  delta: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

export interface MessageStop {
  type: "message_stop";
}

export interface SDKControlRequest {
  type: "control_request";
  request_id: string;
  request: ControlRequestBody;
}

export type ControlRequestBody =
  | CanUseToolRequest
  | InterruptRequest
  | SetModelRequest;

export interface CanUseToolRequest {
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
  title?: string;
  display_name?: string;
  description?: string;
  permission_suggestions?: unknown[];
}

export interface InterruptRequest {
  subtype: "interrupt";
}

export interface SetModelRequest {
  subtype: "set_model";
  model?: string;
}

// Union of all outbound message types
export type SDKOutboundMessage =
  | SDKAssistantMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKStreamEvent
  | SDKControlRequest
  | { type: "keep_alive" }
  | { type: string; [key: string]: unknown };
