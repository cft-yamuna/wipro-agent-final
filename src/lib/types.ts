// --- Agent Configuration ---
export interface AgentConfig {
  serverUrl: string;
  deviceSlug: string;
  healthIntervalMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFile: string;
  identityFile: string;
  /** When false, agent runs in kiosk-only mode — no local server/display processes. Default: true */
  localServices: boolean;
  kiosk?: KioskConfig;
  screenshot?: ScreenshotConfig;
  powerSchedule?: PowerScheduleConfig;
  /** Port for the local hardware event WebSocket server (default: 3402) */
  localEventsPort?: number;
}

// --- Device Identity (persisted locally) ---
export interface Identity {
  deviceId: string;
  apiKey: string;
}

// --- WebSocket Messages ---
export interface WsMessage {
  type: string;
  payload?: Record<string, unknown>;
  timestamp: number;
}

// --- Health Report ---
export interface HealthReport {
  cpuUsage: number;
  memTotal: number;
  memUsed: number;
  memPercent: number;
  diskTotal: number;
  diskUsed: number;
  diskPercent: number;
  cpuTemp: number | null;
  uptime: number;
  agentVersion: string;
  // RPi-specific fields (optional, only present on Raspberry Pi)
  gpuTemp?: number | null;
  throttled?: number | null;
  sdCardReadOnly?: boolean;
  // Network info (optional)
  network?: {
    interface: string;
    ip: string;
    mac: string;
    serverLatencyMs: number | null;
  };
}

// --- Command Execution ---
export interface CommandRequest {
  id: string;
  command: string;
  args?: Record<string, unknown>;
  timeout?: number;
}

export interface CommandResult {
  id: string;
  command: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

// --- Kiosk Configuration ---
export interface KioskConfig {
  browserPath: string;
  defaultUrl: string;
  extraArgs: string[];
  pollIntervalMs: number;
  maxCrashesInWindow: number;
  crashWindowMs: number;
  /** Shell replacement mode: Chrome is launched by the Windows shell (lightman-shell.bat),
   *  not by the agent. Agent only manages URL changes and monitors Chrome via process list. */
  shellMode?: boolean;
}

// --- Multi-Screen Configuration ---

/** Mapping of a physical screen to a URL (stored in device config, pushed from admin) */
export interface ScreenMapping {
  /** Hardware display ID, e.g. "\\\\.\\DISPLAY1" or "HDMI-1" */
  hardwareId: string;
  /** URL to open on this screen */
  url: string;
  /** Optional label for admin display */
  label?: string;
}

// --- Kiosk Status ---
export interface KioskStatus {
  running: boolean;
  pid: number | null;
  url: string | null;
  crashCount: number;
  crashLoopDetected: boolean;
  uptimeMs: number | null;
}

/** Status for multi-screen kiosk */
export interface MultiScreenKioskStatus {
  screens: SingleScreenStatus[];
}

export interface SingleScreenStatus {
  hardwareId: string;
  url: string | null;
  running: boolean;
  pid: number | null;
  uptimeMs: number | null;
}

// --- Screenshot Configuration ---
export interface ScreenshotConfig {
  captureCommand: string;
  quality: number;
  uploadEndpoint: string;
}

// --- Command Handler Function ---
export type CommandHandler = (
  args?: Record<string, unknown>
) => Promise<Record<string, unknown> | void>;

// --- Log Forwarding ---
export interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  source: string;
}

// --- Power Schedule ---
export interface PowerScheduleConfig {
  /** Cron expression for shutdown (e.g., "0 19 * * *" = 7 PM daily) */
  shutdownCron?: string;
  /** Cron expression for startup prep — agent uses this only for logging; actual wake is via WOL */
  startupCron?: string;
  /** Timezone for cron expressions (e.g., "Asia/Kolkata"). Defaults to system timezone. */
  timezone?: string;
  /** Seconds before shutdown to warn via WebSocket (default: 60) */
  shutdownWarningSeconds?: number;
}

// --- Watchdog & Self-Healing ---
export interface WatchdogConfig {
  checkIntervalMs: number;
  kioskCrashCooldownMs: number;
  highMemoryThresholdMb: number;
  highMemoryCooldownMs: number;
  highDiskThresholdPercent: number;
  highDiskCooldownMs: number;
  wsDisconnectedThresholdMs: number;
  wsDisconnectedCooldownMs: number;
}

export interface CrashReport {
  process: string;
  exitCode: number | null;
  signal: string | null;
  timestamp: string;
  system: {
    memPercent: number;
    diskPercent: number;
    cpuUsage: number;
    uptime: number;
  };
}
