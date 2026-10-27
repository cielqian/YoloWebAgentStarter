export type TaskType = "detect" | "segment" | "obb" | "classify" | "pose";
export type SplitName = "train" | "val" | "test";

/** pose 数据集的骨架配置：决定标注关键点数、YOLO 导出 kpt_shape 与画布连线。 */
export interface PoseConfig {
  kpt_count: number;
  kpt_dim: number;
  kpt_names?: (string | null)[] | null;
  skeleton?: number[][] | null;
}

export interface Dataset {
  id: string;
  name: string;
  model_name?: string | null;
  description: string | null;
  task_type: TaskType;
  pose_config?: PoseConfig | null;
  image_count: number;
  annotated_image_count: number;
  class_count: number;
  latest_version_number?: number | null;
  active_version_number?: number | null;
  import_state?: "importing" | "completed" | "failed" | "stopped" | "merging" | "merge_failed" | "merge_stopped" | null;
  import_progress?: number;
  import_message?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DatasetYoloMergeResult {
  dataset: Dataset;
  imported_images: number;
  imported_annotations: number;
  created_classes: number;
  skipped_images: number;
  split_counts: Record<string, number>;
}

export interface DatasetVersion {
  id: string;
  dataset_id: string;
  version_number: number;
  note: string | null;
  is_active: boolean;
  image_count: number;
  annotation_count: number;
  class_count: number;
  has_pending_changes?: boolean | null;
  created_at: string;
  updated_at: string;
}

export interface ClassLabel {
  id: string;
  dataset_id: string;
  class_index: number;
  name: string;
  color: string;
  sam3_prompt?: string | null;
  created_at: string;
  updated_at: string;
}

/** 全局标签库模板：可同步到各数据源作为标签;values 为枚举取值(二级标签)。 */
export interface TagTemplate {
  id: string;
  name: string;
  color: string;
  values?: string[] | null;
  description?: string | null;
  created_at: string;
  updated_at: string;
}

/** 全局类别库条目：数据集可从中导入类别，实例分割任务会带上 SAM3 英文提示词。 */
export interface ClassTemplate {
  id: string;
  name: string;
  color: string;
  sam3_prompt: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImageItem {
  id: string;
  dataset_id: string;
  file_name: string;
  width: number;
  height: number;
  split: SplitName;
  status: string;
  source_type?: string;
  source_file?: string | null;
  source_group_id?: string | null;
  source_video_task_id?: string | null;
  source_checksum?: string | null;
  frame_index?: number | null;
  timestamp?: number | null;
  file_url: string;
  created_at: string;
  updated_at: string;
}

export interface VideoImportTask {
  id: string;
  dataset_id: string | null;
  name: string;
  task_type: TaskType;
  split: SplitName;
  status: "pending" | "running" | "completed" | "failed";
  start_requested: boolean;
  checkpoint_next_frame_index: number;
  output_bytes: number;
  config_json: {
    sampling_mode: "fps" | "interval_seconds" | "frame_interval";
    sampling_value: number;
    start_seconds: number;
    end_seconds: number | null;
    split_strategy: "single" | "time_blocks";
    time_block_seconds: number | null;
    train_ratio: number | null;
    val_ratio: number | null;
    test_ratio: number | null;
  };
  source_file_name: string;
  source_checksum: string;
  video_info_json: {
    width: number;
    height: number;
    fps: number;
    frame_count: number;
    duration_seconds: number;
    size_bytes: number;
    estimated_output_bytes: number;
    estimate_sampled_frames: number;
    estimated_split_counts: Record<SplitName, number>;
  };
  total_images: number;
  generated_images: number;
  progress_percent: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OBB {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
}

export interface Annotation {
  id: string;
  image_id: string;
  dataset_id: string;
  class_id: string;
  class_index: number;
  label: string;
  color: string;
  type: "bbox" | "polygon" | "obb" | "classify" | "pose";
  bbox: BBox | null;
  polygon: [number, number][] | null;
  obb: OBB | null;
  /** pose 关键点 [x, y, v]，绝对像素，v 0=未标注 1=遮挡 2=可见。 */
  keypoints: [number, number, number][] | null;
  source: "manual" | "imported" | "sam" | "auto";
  created_at: string;
  updated_at: string;
}

export interface SamPrediction {
  image_id: string;
  class_id: string;
  mask_id: string;
  polygons: [number, number][][];
  score: number;
  backend_used: string;
  device: string | null;
}

export interface SamCapabilities {
  enabled?: boolean;
  model_configured: boolean;
  box_prompt_available: boolean;
  point_prompt_available: boolean;
  box_backend: "ultralytics_sam" | "box_stub";
  device?: string;
}

export interface SamSettings {
  enabled: boolean;
  backend: string;
  model: string;
  device: string;
  img_size: number;
  fallback_mode: "box" | "disabled";
  model_configured: boolean;
}

/** LLM settings persisted in the local data directory; GET never returns api_key. */
export type LLMAuthScheme = "bearer" | "header" | "raw_authorization";

export interface LLMSettings {
  enabled: boolean;
  provider: string;
  api_base: string;
  model: string;
  temperature: number;
  timeout_seconds: number;
  api_key_configured: boolean;
  auth_scheme: LLMAuthScheme;
  auth_header_name: string;
}

export interface LLMConnectionTestResult {
  ok: boolean;
  message: string;
  remote_test_performed: boolean;
  code?: string;
  http_status?: number | null;
}

export type WebhookMethod = "GET" | "POST";
export type WebhookEvent = "started" | "completed" | "failed" | "stopped";

/** Webhook settings persisted in settings.json; fires on training lifecycle events. */
export interface WebhookSettings {
  enabled: boolean;
  url: string;
  method: WebhookMethod;
  events: WebhookEvent[];
  body_template: string;
}

export interface WebhookDeliveryResult {
  ok: boolean;
  message: string;
  code: string;
  http_status?: number | null;
}

/** FTP settings persisted in settings.json; GET never returns the password. */
export interface FtpSettings {
  host: string;
  port: number;
  username: string;
  password_configured: boolean;
  passive: boolean;
  encoding: string;
  timeout_seconds: number;
}

export interface FtpConnectionTestResult {
  ok: boolean;
  message: string;
  code: string;
}

export interface FtpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
  modified: string | null;
}

export interface FtpListResult {
  path: string;
  entries: FtpEntry[];
}

export interface TrainingDevice {
  id: string;
  type: "cpu" | "mps" | "cuda" | "npu";
  name: string;
  index: number | null;
  memory_total_mb: number | null;
  memory_free_mb: number | null;
  status: "available" | "idle" | "busy" | "unavailable" | "unknown";
  node_id?: string | null;
  node_name?: string | null;
}

export interface TrainingNodeStatus {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  status: "online" | "offline";
  agent_version: string | null;
  device_count: number;
  error: string | null;
}

export interface BaseWeight {
  name: string;
  size_bytes: number;
  updated_at: string;
}

export interface TrainingNode {
  id: string;
  name: string;
  url: string;
  token_configured: boolean;
  enabled: boolean;
}

export interface TrainingNodeTestResult {
  ok: boolean;
  message: string;
  hostname: string | null;
  device_count: number;
  device_types: string[];
  convert_supported: boolean | null;
}

export interface RuntimeLogResponse {
  path: string;
  level: string | null;
  lines: string[];
}

export interface SystemInfo {
  name: string;
  edition: string;
  version: string;
  task_types: TaskType[];
  data_dir: string;
  import_root: string;
  auth_enabled: boolean;
  sam: SamCapabilities;
  training_devices?: TrainingDevice[];
}

export interface ValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  image_id: string | null;
  annotation_id: string | null;
}

export interface ValidationReport {
  dataset_id: string;
  valid: boolean;
  error_count: number;
  warning_count: number;
  issues: ValidationIssue[];
}

export interface QualityIssue {
  level: "error" | "warning" | "info";
  type: string;
  message: string;
  image_id: string | null;
  annotation_ids: string[];
  class_id: string | null;
  iou: number | null;
  value: number | null;
}

export interface DatasetQualityReport {
  dataset_id: string;
  task_type: TaskType;
  summary: { image_count: number; annotated_image_count: number; unannotated_image_count: number; coverage: number; annotation_count: number; bbox_count: number; polygon_count: number; obb_count: number; classify_count: number; pose_count?: number; small_object_count: number; small_object_ratio: number };
  class_distribution: Array<{ class_id: string; class_index: number; name: string; count: number; ratio: number }>;
  issues: QualityIssue[];
}
export interface DuplicateReport { images: number; duplicate: number; similar: number; invalid_images: number; invalid_image_ids: string[]; phash_distance: number; groups: Array<{ canonical_image_id: string; image_ids: string[]; kind: "exact" | "similar"; score: number; hamming_distance?: number }>; }

export interface ImagePage {
  items: ImageItem[];
  total: number;
}

export type TrainingStatus = "pending" | "dispatching" | "running" | "completed" | "failed" | "stopped";

export interface TrainingTask {
  id: string;
  dataset_id: string;
  dataset_version_number?: number | null;
  include_unannotated?: boolean;
  hsv_h?: number | null;
  degrees?: number | null;
  mixup?: number | null;
  fliplr?: number | null;
  profile_id: string | null;
  name: string;
  status: TrainingStatus;
  task_type: TaskType;
  model_name: string;
  model_path: string;
  epochs: number;
  img_size: number;
  batch_size: number;
  device: string;
  node_id: string | null;
  workers: number;
  val_ratio: number;
  seed: number;
  optimizer: string | null;
  lr0: number | null;
  patience: number | null;
  command_preview: string | null;
  export_path: string | null;
  data_yaml_path: string | null;
  run_dir: string | null;
  logs_path: string | null;
  summary_path: string | null;
  best_model_path: string | null;
  last_model_path: string | null;
  progress_epoch: number;
  progress_total_epochs: number;
  progress_percent: number;
  metrics_json: Record<string, number>;
  error_message: string | null;
  stop_requested: boolean;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface TrainingLog {
  task_id: string;
  logs: string;
  line_count: number;
}

export interface TrainingSummary {
  task_id: string;
  status: TrainingStatus;
  training_config: Record<string, unknown>;
  dataset: Record<string, unknown>;
  export_stats?: {
    counts?: Record<string, number>;
    annotated_image_counts?: Record<string, number>;
    total_image_counts?: Record<string, number>;
    skipped_image_counts?: Record<string, number>;
    label_count?: number;
  };
  progress: { epoch: number; total_epochs: number; percent: number };
  metrics: Record<string, unknown> & { history?: Array<Record<string, number>> };
  timing: Record<string, number>;
  checkpoints: Record<string, string | null>;
  log_summary: { line_count: number; tail: string[] };
  risks: string[];
  next_steps: string[];
}

export type ModelStatus = "active" | "archived" | "converting" | "failed";
export type ModelFormat = "pt" | "onnx" | "om";
export type ModelArtifactType = "best" | "last" | "onnx" | "om";

export interface ModelVersion {
  id: string;
  name: string;
  version: string;
  dataset_id: string | null;
  dataset_version_number?: number | null;
  training_task_id: string | null;
  source_model_id: string | null;
  source: "training_task" | "exported";
  artifact_type: ModelArtifactType;
  format: ModelFormat;
  task_type: TaskType;
  engine_type: string;
  model_path: string;
  base_model: string | null;
  status: ModelStatus;
  precision: number | null;
  recall: number | null;
  map50: number | null;
  map50_95: number | null;
  metrics_json: Record<string, number>;
  notes: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export type OmConvertStatus = "uploading" | "converting" | "downloading" | "completed" | "failed";
export interface OmConvertJob {
  job_id: string;
  source_model_id: string;
  source_model_name: string;
  node_id: string;
  node_name: string;
  soc_version: string;
  input_shape: string;
  status: OmConvertStatus;
  error: string | null;
  logs: string;
  result_model_id: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface InferenceDetection { class_index: number; class_name: string; confidence: number; x: number; y: number; width: number; height: number; polygon: number[][] | null; obb_points: number[][] | null; keypoints: number[][] | null; }
export interface InferenceResult { model_id: string; task_type: TaskType; detections: InferenceDetection[]; inference_time_ms: number; }
export interface ModelComparison { dataset_id: string; baseline: { id: string; name: string; metrics: Record<string, number> }; candidate: { id: string; name: string; metrics: Record<string, number> }; deltas: Record<string, number | null>; suggestions: string[]; }
export interface ModelTestRecord { id: string; model_id: string; file_name: string; result_json: InferenceResult; created_at: string; }
export type AutoAnnotationStatus = "pending" | "running" | "completed" | "failed" | "stopped";
export interface AutoAnnotationTask {
  id: string;
  dataset_id: string;
  model_id: string;
  task_type: TaskType;
  status: AutoAnnotationStatus;
  clean_old_annotations: boolean;
  skip_annotated_images: boolean;
  confidence: number;
  iou: number;
  class_mapping: Record<string, string>;
  total_images: number;
  processed_images: number;
  created_annotations: number;
  skipped_images: number;
  progress_percent: number;
  logs_path: string | null;
  error_message: string | null;
  stop_requested: boolean;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}
export interface AutoAnnotationLog { task_id: string; logs: string; line_count: number; }
export interface ModelEvaluationRecord { id: string; model_id: string; dataset_id: string; split: SplitName; status: "pending" | "running" | "completed" | "failed"; confidence: number; iou: number; result_json: { split?: SplitName; task_type?: TaskType; metrics?: Record<string, number>; artifacts?: Record<string, string | null>; error_samples?: Array<{ image_file?: string; class_index?: number; confidence?: number; type: string; message: string }> }; error_message: string | null; export_path: string | null; data_path: string | null; run_dir: string | null; logs_path: string | null; created_at: string; started_at: string | null; finished_at: string | null; }

export type AgentRunStatus = "pending" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";
export type AgentMessageRole = "user" | "assistant" | "system" | "tool";
export type AgentToolCallStatus = "pending" | "running" | "completed" | "failed" | "awaiting_approval";
export type AgentApprovalStatus = "pending" | "approved" | "executing" | "rejected" | "expired" | "executed";

export interface AgentMessage {
  id: string;
  session_id: string;
  run_id: string | null;
  role: AgentMessageRole;
  content: string;
  sequence: number;
  created_at: string;
  updated_at: string;
}

export interface AgentToolCall {
  id: string;
  run_id: string;
  name: string;
  arguments_json: Record<string, unknown>;
  result_json: Record<string, unknown> | null;
  status: AgentToolCallStatus;
  error_message: string | null;
  sequence: number;
  created_at: string;
  updated_at: string;
}

export interface AgentApproval {
  id: string;
  run_id: string;
  tool_call_id: string | null;
  tool_name: string;
  payload_json: Record<string, unknown>;
  status: AgentApprovalStatus;
  idempotency_key: string;
  expires_at: string;
  decided_at: string | null;
  result_task_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentContext {
  dataset_id?: string | null;
  training_task_id?: string | null;
  model_id?: string | null;
}

export type AgentProfileId = "global" | "dataset" | "training" | "model";

export interface AgentInferenceStep {
  round: number;
  source: "llm" | "mock" | "fallback" | "unknown";
  provider: string;
  model: string;
  duration_ms: number;
  outcome: "completed" | "failed" | "discarded";
  reason: string | null;
}

export interface AgentRun {
  id: string;
  session_id: string;
  status: AgentRunStatus;
  provider: string;
  model: string;
  error_message: string | null;
  stop_requested: boolean;
  read_only: boolean;
  context: AgentContext;
  profile_id?: AgentProfileId;
  profile_version?: number;
  actual_source?: "llm" | "mock" | "fallback" | "mixed" | "unknown";
  inference_steps?: AgentInferenceStep[];
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  messages: AgentMessage[];
  tool_calls: AgentToolCall[];
  approvals: AgentApproval[];
}

export interface AgentSession {
  id: string;
  title: string;
  profile_id?: AgentProfileId;
  profile_version?: number;
  context?: AgentContext;
  created_at: string;
  updated_at: string;
  message_count: number;
  latest_run_status: AgentRunStatus | null;
}

export interface AgentSessionDetail extends AgentSession {
  messages: AgentMessage[];
  runs: AgentRun[];
  next_before_sequence?: number | null;
}

export interface AgentSessionPage {
  items: AgentSession[];
  next_cursor: string | null;
}

export interface AgentProviderStatus {
  provider: string;
  model: string;
  configured: boolean;
  api_key_configured: boolean;
  max_tool_rounds: number;
  approval_ttl_seconds: number;
}

export interface SourceDataset {
  id: string;
  name: string;
  description: string | null;
  image_count: number;
  tag_count: number;
  created_at: string;
  updated_at: string;
}

export interface SourceTag {
  id: string;
  name: string;
  color: string;
  /** 枚举标签的取值列表(如光线=强/弱);普通标签为空 */
  values?: string[] | null;
  /** 图片上的枚举取值(仅图片标签列表出现) */
  value?: string | null;
  image_count: number;
}

export interface SourceImage {
  id: string;
  file_name: string;
  width: number;
  height: number;
  size_bytes: number;
  source_type: "upload" | "ftp";
  tags: SourceTag[];
  file_url: string;
  thumbnail_url: string;
  created_at: string;
}

export interface SourceImagePage {
  total: number;
  offset: number;
  limit: number;
  items: SourceImage[];
}

export interface PluginMeta {
  id: string;
  name: string;
  version: string;
  entry: string;
  description: string | null;
  author: string | null;
  icon: string | null;
  installed_at: string | null;
}
