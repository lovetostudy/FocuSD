import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type WheelEvent,
} from "react";
import {
  Check,
  ChevronUp,
  CircleDot,
  ClipboardList,
  Columns2,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Save,
  SkipBack,
  SkipForward,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

export type IslandMode = "collapsed" | "expanded";

type IslandPage = "todo" | "music" | "layout";
type TodoPageMode = "today" | "archive";
type ArchiveLayout = "cards" | "timeline";
type MediaPlaybackStatus = "unavailable" | "playing" | "paused";
type AgentProvider = "codex" | "claudeCode";
type AgentTaskPhase = "idle" | "running" | "completed" | "failed" | "awaiting_confirmation";

type TodoItem = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  category: string;
};

type CompletedArchiveEntry = {
  title: string;
};

type CompletedArchive = {
  date: string;
  items: CompletedArchiveEntry[];
};

type MediaState = {
  available: boolean;
  audioActive: boolean;
  audioPeak: number;
  playbackStatus: MediaPlaybackStatus;
  updatedAt: number;
};

type AudioLevel = {
  active: boolean;
  peak: number;
  updatedAt: number;
};

type AgentTaskStatus = {
  phase: AgentTaskPhase;
  taskId?: string;
  updatedAt: number;
};

type AgentSessionInfo = {
  sessionId: string;
  provider: string;
  phase: AgentTaskPhase;
};

type AgentStatusSnapshot = Record<AgentProvider, AgentTaskStatus> & {
  activeSessions: AgentSessionInfo[];
  updatedAt: number;
  statusPath: string;
};

type AgentHooksInstallResult = {
  scriptsDir: string;
  statusPath: string;
  codexConfigPath: string;
  claudeConfigPath: string;
  installedAt: number;
};

type AgentHooksInstallState = "idle" | "installing" | "installed" | "error";

type IslandSettings = {
  opacity: number;
  sizeScale: number;
  marginY: number;
  marginX: number;
  taskTextColor: string;
  pulseColor: string;
  pulseBrightness: number;
  islandBackgroundColor: string;
  todoBackgroundColor: string;
  agentRunningColor: string;
  agentConfirmingColor: string;
  agentIdleColor: string;
  agentDotSize: number;
};

type IslandPreset = {
  id: string;
  name: string;
  settings: IslandSettings;
  createdAt: number;
  isDefault?: boolean;
};

type IslandShellProps = {
  mode: IslandMode;
  page: IslandPage;
  isTucked: boolean;
  activeTaskTitle: string | null;
  pendingTodoCount: number;
  mediaState: MediaState;
  activeSessions: AgentSessionInfo[];
  isAgentConfirming: boolean;
  onOpenPage: (page: IslandPage) => void;
  onCollapse: () => void;
  onMinimize: () => void;
  onTuck: () => void;
  onReveal: () => void;
  onPageChange: (page: IslandPage) => void;
  children: ReactNode;
};

const STORAGE_KEY = "focusd-island-settings";
const SETTINGS_PRESETS_STORAGE_KEY = "focusd-island-setting-presets";
const TODOS_STORAGE_KEY = "focusd-island-todos";
const ACTIVE_TODO_STORAGE_KEY = "focusd-island-active-todo";
const TODOS_DIRECTORY_STORAGE_KEY = "focusd-island-todos-directory";
const DEFAULT_CATEGORY = "TASKS";
const CATEGORY_NAMES_STORAGE_KEY = "focusd-island-categories";
const SYNC_URL_STORAGE_KEY = "focusd-island-sync-url";
const SYNC_DEVICE_ID_KEY = "focusd-island-device-id";
const BASE_EXPANDED_ISLAND_HEIGHT = 306;
const TODO_ARCHIVE_EXPANDED_ISLAND_HEIGHT = 352;
const MUSIC_EXPANDED_ISLAND_HEIGHT = 286;
const EDITOR_EXPANDED_ISLAND_HEIGHT = 430;
const TODO_ROW_HEIGHT = 46;
const TODO_TITLE_CHARACTERS_PER_LINE = 32;
const TODO_MAX_ESTIMATED_TITLE_LINES = 5;
const TODO_GROW_START_ROWS = 2;
const TODO_SCROLL_START_ROWS = 6;
const MAX_CUSTOM_SETTING_PRESETS = 6;
const DEFAULT_TASK_TEXT_COLOR = "#1afbff";
const AUDIO_ACTIVE_THRESHOLD = 0.000015;
const DEFAULT_MEDIA_STATE: MediaState = {
  available: false,
  audioActive: false,
  audioPeak: 0,
  playbackStatus: "unavailable",
  updatedAt: 0,
};
const DEFAULT_AGENT_TASK_STATUS: AgentTaskStatus = {
  phase: "idle",
  updatedAt: 0,
};
const DEFAULT_AGENT_STATUS: AgentStatusSnapshot = {
  codex: DEFAULT_AGENT_TASK_STATUS,
  claudeCode: DEFAULT_AGENT_TASK_STATUS,
  activeSessions: [],
  updatedAt: 0,
  statusPath: "",
};
const DEFAULT_SETTINGS: IslandSettings = {
  opacity: 95,
  sizeScale: 1,
  marginY: 16,
  marginX: 0,
  taskTextColor: DEFAULT_TASK_TEXT_COLOR,
  pulseColor: "#ff8f70",
  pulseBrightness: 100,
  islandBackgroundColor: "#101013",
  todoBackgroundColor: "#ffffff",
  agentRunningColor: "#e8a400",
  agentConfirmingColor: "#ff5e4d",
  agentIdleColor: "#35e985",
  agentDotSize: 14,
};
const LEGACY_DEFAULT_PRESET_IDS = new Set(["default-white", "default-khaki"]);
const LEGACY_DEFAULT_PRESET_NAMES = new Set(["白色", "卡其"]);

type LegacyIslandSettings = Partial<IslandSettings> & {
  margin?: number;
  taskTitleColor?: string;
  pendingTodoColor?: string;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function getColorSetting(value: unknown, fallback: string) {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? value
    : fallback;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = HEX_COLOR_PATTERN.test(hex)
    ? hex.slice(1)
    : DEFAULT_SETTINGS.pulseColor.slice(1);
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function normalizeSettings(
  settings: LegacyIslandSettings | null | undefined,
): IslandSettings {
  const taskTextColor = getColorSetting(
    settings?.taskTextColor ?? settings?.pendingTodoColor,
    getColorSetting(settings?.taskTitleColor, DEFAULT_SETTINGS.taskTextColor),
  );

  return {
    opacity: clamp(Number(settings?.opacity ?? DEFAULT_SETTINGS.opacity), 50, 100),
    sizeScale: clamp(
      Number(settings?.sizeScale ?? DEFAULT_SETTINGS.sizeScale),
      0.75,
      1.4,
    ),
    marginY: clamp(
      Number(settings?.marginY ?? settings?.margin ?? DEFAULT_SETTINGS.marginY),
      0,
      160,
    ),
    marginX: clamp(
      Number(settings?.marginX ?? DEFAULT_SETTINGS.marginX),
      -300,
      300,
    ),
    taskTextColor,
    pulseColor: getColorSetting(
      settings?.pulseColor,
      DEFAULT_SETTINGS.pulseColor,
    ),
    pulseBrightness: clamp(
      Number(settings?.pulseBrightness ?? DEFAULT_SETTINGS.pulseBrightness),
      50,
      160,
    ),
    islandBackgroundColor: getColorSetting(
      settings?.islandBackgroundColor,
      DEFAULT_SETTINGS.islandBackgroundColor,
    ),
    todoBackgroundColor: getColorSetting(
      settings?.todoBackgroundColor,
      DEFAULT_SETTINGS.todoBackgroundColor,
    ),
    agentRunningColor: getColorSetting(
      settings?.agentRunningColor,
      DEFAULT_SETTINGS.agentRunningColor,
    ),
    agentConfirmingColor: getColorSetting(
      settings?.agentConfirmingColor,
      DEFAULT_SETTINGS.agentConfirmingColor,
    ),
    agentIdleColor: getColorSetting(
      settings?.agentIdleColor,
      DEFAULT_SETTINGS.agentIdleColor,
    ),
    agentDotSize: clamp(
      Number(settings?.agentDotSize ?? DEFAULT_SETTINGS.agentDotSize),
      6,
      40,
    ),
  };
}

function getDefaultSettingPresets(): IslandPreset[] {
  return [];
}

function mergeWithDefaultSettingPresets(presets: IslandPreset[]) {
  const defaultPresets = getDefaultSettingPresets();
  const customPresets = presets
    .filter(
      (preset) =>
        !preset.isDefault &&
        !LEGACY_DEFAULT_PRESET_IDS.has(preset.id) &&
        !LEGACY_DEFAULT_PRESET_NAMES.has(preset.name.trim()),
    )
    .map((preset) => ({ ...preset, isDefault: false }))
    .slice(0, MAX_CUSTOM_SETTING_PRESETS);

  return [...defaultPresets, ...customPresets];
}

function isDefaultSettingPreset(presetId: string) {
  return LEGACY_DEFAULT_PRESET_IDS.has(presetId);
}

function getTodoTitleLineCount(title: string) {
  const visualLength = Array.from(title).reduce(
    (total, character) => total + (character.charCodeAt(0) > 255 ? 1.6 : 1),
    0,
  );

  return clamp(
    Math.ceil(visualLength / TODO_TITLE_CHARACTERS_PER_LINE),
    1,
    TODO_MAX_ESTIMATED_TITLE_LINES,
  );
}

function getTodoVisualRows(todoList: TodoItem[]) {
  return todoList.reduce(
    (total, todo) => total + getTodoTitleLineCount(todo.title),
    0,
  );
}

function loadSettings(): IslandSettings {
  const stored = window.localStorage.getItem(STORAGE_KEY);

  if (!stored) {
    return DEFAULT_SETTINGS;
  }

  try {
    const parsed = JSON.parse(stored) as Partial<IslandSettings> & {
      margin?: number;
    };

    return normalizeSettings(parsed);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadSettingPresets(): IslandPreset[] {
  const stored = window.localStorage.getItem(SETTINGS_PRESETS_STORAGE_KEY);

  if (!stored) {
    return getDefaultSettingPresets();
  }

  try {
    const parsed = JSON.parse(stored) as Partial<IslandPreset>[];

    if (!Array.isArray(parsed)) {
      return getDefaultSettingPresets();
    }

    const presets = parsed
      .map((preset, index) => ({
        id:
          typeof preset.id === "string" && preset.id
            ? preset.id
            : createTodoId(),
        name:
          typeof preset.name === "string" && preset.name.trim()
            ? preset.name.trim()
            : `预设 ${index + 1}`,
        settings: normalizeSettings(preset.settings),
        createdAt:
          typeof preset.createdAt === "number" ? preset.createdAt : Date.now(),
        isDefault: false,
      }));

    return mergeWithDefaultSettingPresets(presets);
  } catch {
    return getDefaultSettingPresets();
  }
}

function normalizeTodo(todo: Partial<TodoItem>): TodoItem {
  return {
    id: typeof todo.id === "string" && todo.id ? todo.id : createTodoId(),
    title: todo.title?.trim() ?? "",
    completed: Boolean(todo.completed),
    createdAt: typeof todo.createdAt === "number" ? todo.createdAt : Date.now(),
    category:
      typeof todo.category === "string" && todo.category.trim()
        ? todo.category.trim()
        : DEFAULT_CATEGORY,
  };
}

function loadTodos(): TodoItem[] {
  const stored = window.localStorage.getItem(TODOS_STORAGE_KEY);

  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as Partial<TodoItem>[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((todo) => typeof todo.title === "string" && todo.title.trim())
      .map(normalizeTodo);
  } catch {
    return [];
  }
}

async function loadTodosFromFile(dirPath: string): Promise<TodoItem[]> {
  try {
    const content = await invoke<string>("read_todos_file", {
      filePath: `${dirPath}/todos.md`,
    });
    if (!content.trim()) return [];
    return parseTodosFromMarkdown(content);
  } catch {
    return [];
  }
}

function loadActiveTodoId() {
  return window.localStorage.getItem(ACTIVE_TODO_STORAGE_KEY);
}

function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getDisplayDateParts(date: string) {
  const [fallbackYear = date, fallbackMonth = "", fallbackDay = ""] =
    date.split("-");
  const parsedDate = new Date(`${date}T00:00:00`);
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const hasValidDate = !Number.isNaN(parsedDate.getTime());

  return {
    year: hasValidDate ? String(parsedDate.getFullYear()) : fallbackYear,
    month: hasValidDate
      ? String(parsedDate.getMonth() + 1).padStart(2, "0")
      : fallbackMonth,
    day: hasValidDate
      ? String(parsedDate.getDate()).padStart(2, "0")
      : fallbackDay,
    weekday: hasValidDate ? weekdays[parsedDate.getDay()] : "",
  };
}

function formatTodosAsMarkdown(todos: TodoItem[], categoryNames: string[]) {
  const byCategory: Record<string, TodoItem[]> = {};

  for (const todo of todos) {
    if (!byCategory[todo.category]) {
      byCategory[todo.category] = [];
    }
    byCategory[todo.category].push(todo);
  }

  // Collect all known categories: from todos + from persisted categoryNames
  const allKnown = new Set<string>();
  allKnown.add(DEFAULT_CATEGORY);
  for (const name of categoryNames) allKnown.add(name);
  for (const key of Object.keys(byCategory)) allKnown.add(key);

  // TASKS first, then alphabetical for the rest
  const sortedOrder = [DEFAULT_CATEGORY];
  for (const name of [...allKnown].sort()) {
    if (name !== DEFAULT_CATEGORY) sortedOrder.push(name);
  }

  const sections: string[] = [];
  for (const category of sortedOrder) {
    sections.push(`## ${category}`);
    const items = byCategory[category] || [];
    for (const todo of items) {
      sections.push(`- [${todo.completed ? "x" : " "}] ${todo.title}`);
    }
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

function parseTodosFromMarkdown(markdown: string): TodoItem[] {
  const todos: TodoItem[] = [];
  const lines = markdown.split("\n");
  let currentCategory: string = DEFAULT_CATEGORY;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("## ")) {
      currentCategory = trimmed.slice(3).trim();
      continue;
    }

    const taskMatch = trimmed.match(/^- \[([ x])\] (.+)$/);
    if (taskMatch) {
      todos.push({
        id: createTodoId(),
        title: taskMatch[2].trim(),
        completed: taskMatch[1] === "x",
        createdAt: Date.now(),
        category: currentCategory,
      });
    }
  }

  return todos;
}

function parseCategoriesFromMarkdown(markdown: string): string[] {
  const categories: string[] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      const name = trimmed.slice(3).trim();
      if (name && !categories.includes(name)) {
        categories.push(name);
      }
    }
  }
  return categories;
}

function createTodoId() {
  if ("crypto" in window && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getDeviceId(): string {
  let id = window.localStorage.getItem(SYNC_DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(SYNC_DEVICE_ID_KEY, id);
  }
  return id;
}

async function pullFromServer(url: string): Promise<Record<string, string>> {
  const res = await fetch(`${url}/sync`);
  if (!res.ok) throw new Error(`pull failed: ${res.status}`);
  const data = await res.json();
  return data.files as Record<string, string>;
}

async function pushToServer(url: string, files: Record<string, string>) {
  const res = await fetch(`${url}/sync`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files, deviceId: getDeviceId() }),
  });
  if (!res.ok) throw new Error(`push failed: ${res.status}`);
}

async function readAllLocalFiles(dir: string): Promise<Record<string, string>> {
  const names: string[] = await invoke("list_todos_files", { directory: dir });
  const result: Record<string, string> = {};
  for (const name of names) {
    try {
      result[name] = await invoke<string>("read_todos_file", {
        filePath: `${dir}/${name}`,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return result;
}

async function writeAllLocalFiles(
  dir: string,
  files: Record<string, string>,
) {
  for (const [name, content] of Object.entries(files)) {
    await invoke("save_todos", { filePath: `${dir}/${name}`, content });
  }
}

function IslandShell({
  mode,
  page,
  isTucked,
  activeTaskTitle,
  pendingTodoCount,
  mediaState,
  activeSessions,
  isAgentConfirming,
  onOpenPage,
  onCollapse,
  onMinimize,
  onTuck,
  onReveal,
  onPageChange,
  children,
}: IslandShellProps) {
  const isExpanded = mode === "expanded";
  const isMusicPlaying =
    mediaState.playbackStatus === "playing" ||
    (mediaState.playbackStatus !== "paused" && mediaState.audioActive);
  const className = [
    "island",
    `island--${mode}`,
    `island--${page}`,
  ]
    .filter(Boolean)
    .join(" ");
  const isAgentRunning = activeSessions.length > 0;
  const getSessionDotClassName = (phase: AgentTaskPhase) =>
    [
      "island__session-dot",
      phase === "awaiting_confirmation"
        ? "island__session-dot--confirming"
        : phase === "running"
          ? "island__session-dot--running"
          : "island__session-dot--idle",
    ].join(" ");
  const agentStatusIconClassName = [
    "island__agent-status-icon",
    isAgentConfirming
      ? "island__agent-status-icon--confirming"
      : isAgentRunning
      ? "island__agent-status-icon--running"
      : "island__agent-status-icon--idle",
  ].join(" ");
  const collapsedLabel = activeTaskTitle
    ? `正在专注：${activeTaskTitle}`
    : "FocuSD Island";

  return (
    <section
      className={className}
      aria-label={collapsedLabel}
      onClick={() => {
        if (!isExpanded) {
          onOpenPage(page);
        }
      }}
      onMouseEnter={() => {
        if (isTucked) {
          onReveal();
        }
      }}
    >
      <div className="island__collapsed" aria-hidden={isExpanded}>
        <div className="island__collapsed-row">
          <div className="island__session-dots">
            {activeSessions.length > 0 ? (
              activeSessions.map((s) => (
                <span
                  key={`${s.provider}:${s.sessionId}`}
                  className={getSessionDotClassName(s.phase)}
                  title={`${s.provider}: ${s.sessionId.slice(0, 8)} ${s.phase}`}
                />
              ))
            ) : (
              <span className={getSessionDotClassName("idle")} />
            )}
          </div>
          {activeTaskTitle ? (
            <span className="island__active-task">
              {activeTaskTitle}
            </span>
          ) : (
            <span className="island__todo-count">
              剩余{pendingTodoCount}个待办
            </span>
          )}
          <MusicWaveButton
            isAvailable={mediaState.available || mediaState.audioActive}
            isPlaying={isMusicPlaying}
            audioPeak={mediaState.audioPeak}
            label="打开音乐控制"
            onClick={() => onOpenPage("music")}
          />
          <button
            className="island__quiet-button"
            type="button"
            title="收起"
            aria-label="收起岛屿"
            onClick={(event) => {
              event.stopPropagation();
              onTuck();
            }}
          />
        </div>
      </div>

      <div className="island__expanded" aria-hidden={!isExpanded}>
        <header className="island__header">
          <div className="island__title">
            <CircleDot
              className={agentStatusIconClassName}
              size={16}
              strokeWidth={2.2}
            />
            <span>FocuSD</span>
          </div>

          <div
            className="editor-dots"
            aria-label="岛屿编辑"
          >
            <button
              className={`dot-button dot-button--todo ${
                page === "todo" ? "dot-button--active" : ""
              }`}
              type="button"
              title="任务清单"
              aria-label="任务清单"
              onClick={(event) => {
                event.stopPropagation();
                onPageChange("todo");
              }}
            />
            <button
              className={`dot-button dot-button--music ${
                page === "music" ? "dot-button--active" : ""
              }`}
              type="button"
              title="Music"
              aria-label="Music"
              onClick={(event) => {
                event.stopPropagation();
                onPageChange("music");
              }}
            />
            <button
              className={`dot-button dot-button--layout ${
                page === "layout" ? "dot-button--active" : ""
              }`}
              type="button"
              title="布局编辑"
              aria-label="布局编辑"
              onClick={(event) => {
                event.stopPropagation();
                onPageChange("layout");
              }}
            />
          </div>

          <div
            className="island__collapse-target"
            onClick={onCollapse}
          />

          <div className="window-actions">
            <button
              className="icon-button"
              type="button"
              title="收起"
              aria-label="收起岛屿"
              onClick={(event) => {
                event.stopPropagation();
                onCollapse();
              }}
            >
              <ChevronUp size={18} strokeWidth={2.2} />
            </button>
            <button
              className="icon-button"
              type="button"
              title="最小化到托盘"
              aria-label="最小化到托盘"
              onClick={(event) => {
                event.stopPropagation();
                onMinimize();
              }}
            >
              <Minus size={18} strokeWidth={2.2} />
            </button>
          </div>
        </header>
        <div className="island__content">{children}</div>
      </div>
    </section>
  );
}

function MusicWaveButton({
  isAvailable,
  isPlaying,
  audioPeak,
  label,
  onClick,
}: {
  isAvailable: boolean;
  isPlaying: boolean;
  audioPeak: number;
  label: string;
  onClick: () => void;
}) {
  const [phase, setPhase] = useState(0);
  const className = [
    "music-wave-button",
    isAvailable ? "music-wave-button--available" : "music-wave-button--idle",
    isPlaying ? "music-wave-button--playing" : "music-wave-button--paused",
  ]
    .filter(Boolean)
    .join(" ");
  const shouldAnimate = isAvailable || isPlaying;
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (!shouldAnimate) {
      setPhase(0);
      return;
    }

    const interval = window.setInterval(
      () => {
        setPhase(performance.now() / (isPlaying ? 260 : 900));
      },
      prefersReducedMotion ? 420 : isPlaying ? 72 : 180,
    );

    return () => window.clearInterval(interval);
  }, [isPlaying, prefersReducedMotion, shouldAnimate]);

  const liftedPeak = isPlaying
    ? clamp(Math.log1p(clamp(audioPeak, 0, 1) * 150) / Math.log1p(150), 0, 1)
    : 0;
  const barScales = [0.34, 0.72, 0.48, 0.86, 0.42].map((bar, index) => {
    const floor = isAvailable ? 0.22 : 0.12;
    const breath =
      shouldAnimate && !prefersReducedMotion
        ? 0.07 + Math.sin(phase + index * 0.82) * 0.045
        : 0;
    const movement =
      liftedPeak *
      (0.26 + bar * 1.02) *
      (0.82 + Math.sin(phase * (1.15 + index * 0.08) + index * 1.7) * 0.24);

    return clamp(floor + breath + movement, 0.12, 1.22);
  });

  return (
    <button
      className={className}
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {barScales.map((scale, index) => (
        <span
          key={index}
          style={
            {
              "--wave-scale": scale.toFixed(3),
              "--wave-opacity": (0.42 + scale * 0.52).toFixed(3),
            } as CSSProperties
          }
        />
      ))}
    </button>
  );
}

function SliderControl({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
  onChangeEnd,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
  onChangeEnd?: (value: number) => void;
}) {
  return (
    <label className="slider-control">
      <span className="slider-control__meta">
        <span>{label}</span>
        <strong>
          {step < 1 ? value.toFixed(2) : Math.round(value)}
          {suffix}
        </strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        onMouseUp={(event) => onChangeEnd?.(Number(event.currentTarget.value))}
        onTouchEnd={(event) => onChangeEnd?.(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="color-control">
      <span className="color-control__meta">
        <span>{label}</span>
        <strong>{value.toUpperCase()}</strong>
      </span>
      <input
        type="color"
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function ToggleControl({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-control">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="toggle-control__switch" aria-hidden="true" />
    </label>
  );
}


function LayoutEditor({
  settings,
  todosDirectoryDraft,
  presets,
  launchAtStartup,
  agentHooksInstallState,
  agentHooksInstallResult,
  agentHooksInstallError,
  onSettingsChange,
  onReset,
  onTodosDirectoryDraftChange,
  onSaveTodosDirectory,
  onSavePreset,
  onApplyPreset,
  onRenamePreset,
  onDeletePreset,
  onLaunchAtStartupChange,
  onInstallAgentHooks,
  syncServerUrl,
  onSyncServerUrlChange,
  onSyncNow,
}: {
  settings: IslandSettings;
  todosDirectoryDraft: string;
  presets: IslandPreset[];
  launchAtStartup: boolean;
  agentHooksInstallState: AgentHooksInstallState;
  agentHooksInstallResult: AgentHooksInstallResult | null;
  agentHooksInstallError: string;
  onSettingsChange: (settings: IslandSettings) => void;
  onReset: () => void;
  onTodosDirectoryDraftChange: (value: string) => void;
  onSaveTodosDirectory: () => void;
  onSavePreset: () => void;
  onApplyPreset: (presetId: string) => void;
  onRenamePreset: (presetId: string, name: string) => void;
  onDeletePreset: (presetId: string) => void;
  onLaunchAtStartupChange: (enabled: boolean) => void;
  onInstallAgentHooks: () => void;
  syncServerUrl: string;
  onSyncServerUrlChange: (url: string) => void;
  onSyncNow: () => void;
}) {
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [marginXDraft, setMarginXDraft] = useState<number | null>(null);

  const startPresetRename = useCallback((preset: IslandPreset) => {
    setEditingPresetId(preset.id);
    setPresetNameDraft(preset.name);
  }, []);

  const commitPresetRename = useCallback(() => {
    if (!editingPresetId) {
      return;
    }

    onRenamePreset(editingPresetId, presetNameDraft);
    setEditingPresetId(null);
    setPresetNameDraft("");
  }, [editingPresetId, onRenamePreset, presetNameDraft]);

  return (
    <div className="editor-panel">
      <div className="editor-panel__header">
        <span>设置</span>
        <button
          className="reset-button"
          type="button"
          title="恢复默认"
          aria-label="恢复默认"
          onClick={() => {
            if (window.confirm("确认恢复所有设置为默认值？")) {
              onReset();
            }
          }}
        >
          <RefreshCcw size={15} strokeWidth={2.2} />
        </button>
      </div>

      <section className="settings-section settings-section--layout">
        <div className="settings-section__header">
          <span>布局设置</span>
        </div>
        <SliderControl
          label="不透明度"
          value={settings.opacity}
          min={50}
          max={100}
          step={1}
          suffix="%"
          onChange={(opacity) => onSettingsChange({ ...settings, opacity })}
        />
        <SliderControl
          label="整体大小"
          value={settings.sizeScale}
          min={0.75}
          max={1.4}
          step={0.01}
          suffix="x"
          onChange={(sizeScale) => onSettingsChange({ ...settings, sizeScale })}
        />
        <SliderControl
          label="上下边距"
          value={settings.marginY}
          min={0}
          max={160}
          step={1}
          suffix="px"
          onChange={(marginY) => onSettingsChange({ ...settings, marginY })}
        />
        <SliderControl
          label="左右偏移"
          value={marginXDraft ?? settings.marginX}
          min={-300}
          max={300}
          step={1}
          suffix="px"
          onChange={(marginX) => setMarginXDraft(marginX)}
          onChangeEnd={(marginX) => {
            onSettingsChange({ ...settings, marginX });
            setMarginXDraft(null);
          }}
        />
        <ToggleControl
          label="开机自启动"
          checked={launchAtStartup}
          onChange={onLaunchAtStartupChange}
        />
      </section>

      <section className="settings-section settings-section--agent-hooks">
        <div className="settings-section__header">
          <span>AI Agent 状态灯</span>
          <button
            className={[
              "agent-hooks-button",
              agentHooksInstallState === "installed"
                ? "agent-hooks-button--installed"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            disabled={agentHooksInstallState === "installing"}
            onClick={onInstallAgentHooks}
          >
            {agentHooksInstallState === "installed" ? (
              <Check size={13} strokeWidth={2.6} />
            ) : (
              <RefreshCcw size={13} strokeWidth={2.4} />
            )}
            <span>
              {agentHooksInstallState === "installing"
                ? "安装中"
                : agentHooksInstallState === "installed"
                  ? "已安装"
                  : "安装/修复"}
            </span>
          </button>
        </div>
        {agentHooksInstallState === "installed" && agentHooksInstallResult ? (
          <div className="agent-hooks-status agent-hooks-status--ok">
            <span>脚本目录</span>
            <strong title={agentHooksInstallResult.scriptsDir}>
              {agentHooksInstallResult.scriptsDir}
            </strong>
          </div>
        ) : null}
        {agentHooksInstallState === "error" ? (
          <div className="agent-hooks-status agent-hooks-status--error">
            {agentHooksInstallError}
          </div>
        ) : null}
      </section>

      <section className="settings-section settings-section--storage">
        <div className="settings-section__header">
          <span>待办文件保存目录</span>
        </div>
        <div className="save-path-row">
          <label className="save-path-field">
            <span>文件夹</span>
            <input
              value={todosDirectoryDraft}
              placeholder="例如 D:\FocuSD\todos"
              aria-label="待办文件保存目录"
              onChange={(event) =>
                onTodosDirectoryDraftChange(event.currentTarget.value)
              }
            />
          </label>
          <button
            className="save-path-button"
            type="button"
            onClick={onSaveTodosDirectory}
          >
            <Save size={14} strokeWidth={2.2} />
            <span>保存</span>
          </button>
        </div>
      </section>

      <section className="settings-section settings-section--sync">
        <div className="settings-section__header">
          <span>多设备同步</span>
        </div>
        <div className="save-path-row">
          <label className="save-path-field">
            <span>服务器地址</span>
            <input
              value={syncServerUrl}
              placeholder="例如 http://192.168.1.100:3456"
              aria-label="同步服务器地址"
              onChange={(event) =>
                onSyncServerUrlChange(event.currentTarget.value)
              }
            />
          </label>
          <button
            className="save-path-button"
            type="button"
            onClick={onSyncNow}
          >
            <Save size={14} strokeWidth={2.2} />
            <span>同步</span>
          </button>
        </div>
        <p className="settings-hint" style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
          设备标识：{getDeviceId()} &nbsp;|&nbsp; 留空服务器地址则不同步
        </p>
      </section>

      <section className="settings-section settings-section--colors">
        <div className="settings-section__header">
          <span>颜色设置</span>
        </div>

        <div className="agent-light-row">
          <label className="agent-light-pick">
            <span className="agent-light-pick__label">运行灯</span>
            <div
              className="agent-light-pick__dot"
              style={{ backgroundColor: settings.agentRunningColor }}
              onClick={(e) => {
                const input = e.currentTarget
                  .closest(".agent-light-pick")
                  ?.querySelector("input") as HTMLInputElement | null;
                input?.click();
              }}
            />
            <input
              type="color"
              value={settings.agentRunningColor}
              onChange={(e) =>
                onSettingsChange({
                  ...settings,
                  agentRunningColor: e.target.value,
                })
              }
            />
            <strong className="agent-light-pick__hex">
              {settings.agentRunningColor}
            </strong>
          </label>
          <label className="agent-light-pick">
            <span className="agent-light-pick__label">确认灯</span>
            <div
              className="agent-light-pick__dot"
              style={{ backgroundColor: settings.agentConfirmingColor }}
              onClick={(e) => {
                const input = e.currentTarget
                  .closest(".agent-light-pick")
                  ?.querySelector("input") as HTMLInputElement | null;
                input?.click();
              }}
            />
            <input
              type="color"
              value={settings.agentConfirmingColor}
              onChange={(e) =>
                onSettingsChange({
                  ...settings,
                  agentConfirmingColor: e.target.value,
                })
              }
            />
            <strong className="agent-light-pick__hex">
              {settings.agentConfirmingColor}
            </strong>
          </label>
          <label className="agent-light-pick">
            <span className="agent-light-pick__label">空闲灯</span>
            <div
              className="agent-light-pick__dot"
              style={{ backgroundColor: settings.agentIdleColor }}
              onClick={(e) => {
                const input = e.currentTarget
                  .closest(".agent-light-pick")
                  ?.querySelector("input") as HTMLInputElement | null;
                input?.click();
              }}
            />
            <input
              type="color"
              value={settings.agentIdleColor}
              onChange={(e) =>
                onSettingsChange({
                  ...settings,
                  agentIdleColor: e.target.value,
                })
              }
            />
            <strong className="agent-light-pick__hex">
              {settings.agentIdleColor}
            </strong>
          </label>
        </div>

        <label className="color-control" style={{ marginTop: 16 }}>
          <span className="color-control__meta">
            <span>指示灯大小</span>
            <strong>{settings.agentDotSize}px</strong>
          </span>
          <input
            type="number"
            min={6}
            max={40}
            step={1}
            value={settings.agentDotSize}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v >= 6 && v <= 40) {
                onSettingsChange({ ...settings, agentDotSize: v });
              }
            }}
          />
        </label>

        <div className="color-grid" style={{ marginTop: 16 }}>
          <ColorControl
            label="任务/待办字样"
            value={settings.taskTextColor}
            onChange={(taskTextColor) =>
              onSettingsChange({ ...settings, taskTextColor })
            }
          />
          <ColorControl
            label="亮点颜色"
            value={settings.pulseColor}
            onChange={(pulseColor) =>
              onSettingsChange({ ...settings, pulseColor })
            }
          />
          <ColorControl
            label="岛屿背景"
            value={settings.islandBackgroundColor}
            onChange={(islandBackgroundColor) =>
              onSettingsChange({ ...settings, islandBackgroundColor })
            }
          />
          <ColorControl
            label="待办纸张"
            value={settings.todoBackgroundColor}
            onChange={(todoBackgroundColor) =>
              onSettingsChange({ ...settings, todoBackgroundColor })
            }
          />
        </div>
        <SliderControl
          label="亮点亮度"
          value={settings.pulseBrightness}
          min={50}
          max={160}
          step={1}
          suffix="%"
          onChange={(pulseBrightness) =>
            onSettingsChange({ ...settings, pulseBrightness })
          }
        />
      </section>

      <section className="settings-section settings-section--presets">
        <div className="settings-section__header">
          <span>预设</span>
          <button
            className="preset-save-button"
            type="button"
            onClick={onSavePreset}
          >
            <Save size={13} strokeWidth={2.2} />
            <span>保存当前</span>
          </button>
        </div>
        {presets.length === 0 ? (
          <div className="preset-empty">还没有预设</div>
        ) : (
          <div className="preset-list" role="list">
            {presets.map((preset) => (
              <div
                className={[
                  "preset-item",
                  preset.isDefault ? "preset-item--default" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={preset.id}
                role="listitem"
              >
                {editingPresetId === preset.id ? (
                  <input
                    className="preset-name-input"
                    value={presetNameDraft}
                    aria-label="预设名称"
                    autoFocus
                    onChange={(event) =>
                      setPresetNameDraft(event.currentTarget.value)
                    }
                    onBlur={commitPresetRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        commitPresetRename();
                      }

                      if (event.key === "Escape") {
                        setEditingPresetId(null);
                        setPresetNameDraft("");
                      }
                    }}
                  />
                ) : (
                  <button
                    className="preset-name-button"
                    type="button"
                    title={preset.isDefault ? "默认预设" : "重命名预设"}
                    disabled={preset.isDefault}
                    onClick={() => {
                      if (!preset.isDefault) {
                        startPresetRename(preset);
                      }
                    }}
                  >
                    {preset.name}
                  </button>
                )}
                <button
                  className="preset-apply-button"
                  type="button"
                  onClick={() => onApplyPreset(preset.id)}
                >
                  启用
                </button>
                {preset.isDefault ? (
                  <span className="preset-delete-spacer" aria-hidden="true" />
                ) : (
                  <button
                    className="preset-delete-button"
                    type="button"
                    title="删除预设"
                    aria-label={`删除 ${preset.name}`}
                    onClick={() => onDeletePreset(preset.id)}
                  >
                    <Trash2 size={13} strokeWidth={2.2} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}

function TodoNotebook({
  todos,
  draft,
  activeTodoId,
  pageMode,
  completedArchives,
  archiveLayout,
  activeCategory,
  categoryNames,
  onDraftChange,
  onAddTodo,
  onToggleTodo,
  onUpdateTodo,
  onStartTodo,
  onDeleteTodo,
  onShowArchive,
  onShowToday,
  onArchiveLayoutChange,
  onCategoryChange,
  onAddCategory,
}: {
  todos: TodoItem[];
  draft: string;
  activeTodoId: string | null;
  pageMode: TodoPageMode;
  completedArchives: CompletedArchive[];
  archiveLayout: ArchiveLayout;
  activeCategory: string;
  categoryNames: string[];
  onDraftChange: (value: string) => void;
  onAddTodo: () => void;
  onToggleTodo: (id: string) => void;
  onUpdateTodo: (id: string, title: string) => void;
  onStartTodo: (id: string) => void;
  onDeleteTodo: (id: string) => void;
  onShowArchive: () => void;
  onShowToday: () => void;
  onArchiveLayoutChange: (layout: ArchiveLayout) => void;
  onCategoryChange: (category: string) => void;
  onAddCategory: (category: string) => void;
}) {
  const isTodayMode = pageMode === "today";
  const isArchiveMode = pageMode === "archive";
  const [selectedArchiveDate, setSelectedArchiveDate] = useState<string | null>(null);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState("");

  // Derive category tabs: all known categories, TASKS always first
  const categoryTabs: { name: string; count: number }[] = useMemo(() => {
    const countMap: Record<string, number> = {};
    for (const todo of todos) {
      if (!todo.completed) {
        countMap[todo.category] = (countMap[todo.category] || 0) + 1;
      }
    }
    // Merge: file-derived categories + user-added categories + todos categories
    const allNames = new Set<string>();
    allNames.add(DEFAULT_CATEGORY);
    for (const name of categoryNames) allNames.add(name);
    for (const key of Object.keys(countMap)) allNames.add(key);

    const ordered: string[] = [DEFAULT_CATEGORY];
    for (const name of [...allNames].sort()) {
      if (name !== DEFAULT_CATEGORY) ordered.push(name);
    }
    return ordered.map((name) => ({ name, count: countMap[name] || 0 }));
  }, [todos, categoryNames]);

  // Filter todos by active category
  const filteredTodos = useMemo(
    () =>
      isArchiveMode
        ? todos
        : todos.filter((t) => !t.completed && t.category === activeCategory),
    [todos, activeCategory, isArchiveMode],
  );

  const openCount = filteredTodos.filter((todo) => !todo.completed).length;
  const listClassName = [
    "todo-list",
    filteredTodos.length > TODO_SCROLL_START_ROWS ? "todo-list--scroll" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const archiveTitle =
    archiveLayout === "cards" ? "Notebook cards" : "Two-column timeline";
  const notebookClassName = [
    "todo-notebook",
    isArchiveMode ? "todo-notebook--archive" : "",
    isArchiveMode ? `todo-notebook--archive-${archiveLayout}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [todoTitleDraft, setTodoTitleDraft] = useState("");

  useEffect(() => {
    if (isTodayMode) {
      setSelectedArchiveDate(null);
    }
  }, [isTodayMode]);

  const startTodoTitleEdit = useCallback((todo: TodoItem) => {
    if (!isTodayMode) {
      return;
    }

    setEditingTodoId(todo.id);
    setTodoTitleDraft(todo.title);
  }, [isTodayMode]);

  const commitTodoTitleEdit = useCallback(() => {
    if (!editingTodoId) {
      return;
    }

    const nextTitle = todoTitleDraft.trim();

    if (nextTitle) {
      onUpdateTodo(editingTodoId, nextTitle);
    }

    setEditingTodoId(null);
    setTodoTitleDraft("");
  }, [editingTodoId, onUpdateTodo, todoTitleDraft]);

  return (
    <section className={notebookClassName} aria-label="任务清单">
      <div className="todo-notebook__spine">
        <button
          className={[
            "todo-spine-button",
            "todo-spine-button--today",
            isTodayMode ? "todo-spine-button--active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          type="button"
          title="Back to todo list"
          aria-label="Back to todo list"
          onClick={onShowToday}
        />
        <button
          className={[
            "todo-spine-button",
            "todo-spine-button--archive",
            isArchiveMode ? "todo-spine-button--active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          type="button"
          title="Review completed todos"
          aria-label="Review completed todos"
          onClick={onShowArchive}
        />
      </div>

      <div className="todo-notebook__topline">
        <div className="todo-notebook__title-group">
          {isArchiveMode ? (
            <span className="todo-notebook__tab">
              <ClipboardList size={15} strokeWidth={2.1} />
              Completed
            </span>
          ) : (
            <>
              {categoryTabs.map((tab) => (
                <button
                  key={tab.name}
                  className={[
                    "todo-notebook__tab",
                    activeCategory === tab.name
                      ? "todo-notebook__tab--active"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  type="button"
                  onClick={() => onCategoryChange(tab.name)}
                >
                  <ClipboardList size={15} strokeWidth={2.1} />
                  {tab.name}
                  <span className="todo-notebook__tab-count">{tab.count}</span>
                </button>
              ))}
              {showAddCategory ? (
                <form
                  className="todo-category-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = categoryDraft.trim();
                    if (name) {
                      onAddCategory(name);
                      setCategoryDraft("");
                      setShowAddCategory(false);
                    }
                  }}
                >
                  <input
                    className="todo-category-input"
                    value={categoryDraft}
                    placeholder="Name"
                    autoFocus
                    onChange={(e) => setCategoryDraft(e.target.value)}
                    onBlur={() => {
                      setShowAddCategory(false);
                      setCategoryDraft("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setShowAddCategory(false);
                        setCategoryDraft("");
                      }
                    }}
                  />
                </form>
              ) : (
                <button
                  className="todo-notebook__tab todo-notebook__tab--add"
                  type="button"
                  title="Add category"
                  onClick={() => setShowAddCategory(true)}
                >
                  <Plus size={13} strokeWidth={2.2} />
                </button>
              )}
            </>
          )}
        </div>
        {isArchiveMode ? (
          <div className="archive-layout-toggle" aria-label={archiveTitle}>
            <button
              className={archiveLayout === "cards" ? "archive-layout-toggle--active" : ""}
              type="button"
              title="Notebook cards"
              aria-label="Notebook cards"
              onClick={() => onArchiveLayoutChange("cards")}
            >
              <ClipboardList size={14} strokeWidth={2.1} />
            </button>
            <button
              className={archiveLayout === "timeline" ? "archive-layout-toggle--active" : ""}
              type="button"
              title="Two-column timeline"
              aria-label="Two-column timeline"
              onClick={() => onArchiveLayoutChange("timeline")}
            >
              <Columns2 size={14} strokeWidth={2.1} />
            </button>
          </div>
        ) : (
          <span className="todo-notebook__open-count">{openCount} open</span>
        )}
      </div>

      {!isArchiveMode && (
        <form
          className="todo-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (isTodayMode) {
              onAddTodo();
            }
          }}
        >
          <Plus size={16} strokeWidth={2.2} aria-hidden="true" />
          <input
            value={draft}
            disabled={!isTodayMode}
            placeholder="Add a task..."
            aria-label="Add a task, press Enter to save"
            onChange={(event) => onDraftChange(event.currentTarget.value)}
          />
        </form>
      )}

      {isArchiveMode && selectedArchiveDate ? (
        <div className="archive-detail">
          <button
            className="archive-detail__back"
            type="button"
            onClick={() => setSelectedArchiveDate(null)}
          >
            <ChevronUp size={14} strokeWidth={2.2} style={{ transform: "rotate(-90deg)" }} />
            <span>Back</span>
          </button>
          <strong className="archive-detail__date">{selectedArchiveDate}</strong>
          <div className="todo-list">
            {(completedArchives
              .find((a) => a.date === selectedArchiveDate)
              ?.items.map((item, idx) => (
                <div className="todo-item todo-item--done" key={idx} role="listitem">
                  <span className="todo-check" aria-pressed={true}>
                    <Check size={14} strokeWidth={2.5} />
                  </span>
                  <span className="todo-title">{item.title}</span>
                </div>
              )))}
          </div>
        </div>
      ) : isArchiveMode ? (
        <ArchiveBrowser
          archives={completedArchives}
          layout={archiveLayout}
          onSelectArchive={setSelectedArchiveDate}
        />
      ) : (
        <div className={listClassName} role="list">
          {filteredTodos.length === 0 ? (
            <div className="todo-empty">今天还很轻</div>
          ) : (
            filteredTodos.map((todo) => {
              const isActive =
                isTodayMode && todo.id === activeTodoId && !todo.completed;
              const titleLineCount = getTodoTitleLineCount(todo.title);

              return (
                <div
                  className={[
                    "todo-item",
                    todo.completed ? "todo-item--done" : "",
                    isActive ? "todo-item--active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={todo.id}
                  role="listitem"
                  style={
                    {
                      "--todo-title-min-height": `${titleLineCount * 19}px`,
                    } as CSSProperties
                  }
                >
                  <button
                    className="todo-check"
                    type="button"
                    aria-pressed={todo.completed}
                    title={todo.completed ? "标记未完成" : "完成"}
                    aria-label={`${todo.completed ? "标记未完成" : "完成"}：${
                      todo.title
                    }`}
                    onClick={() => onToggleTodo(todo.id)}
                  >
                    {todo.completed && <Check size={14} strokeWidth={2.5} />}
                  </button>
                  {isTodayMode && editingTodoId === todo.id ? (
                    <input
                      className="todo-title-input"
                      value={todoTitleDraft}
                      aria-label="编辑任务名"
                      autoFocus
                      onChange={(event) =>
                        setTodoTitleDraft(event.currentTarget.value)
                      }
                      onBlur={commitTodoTitleEdit}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          commitTodoTitleEdit();
                        }

                        if (event.key === "Escape") {
                          setEditingTodoId(null);
                          setTodoTitleDraft("");
                        }
                      }}
                    />
                  ) : isTodayMode ? (
                    <button
                      className="todo-title todo-title--editable"
                      type="button"
                      title="编辑任务名"
                      onClick={() => startTodoTitleEdit(todo)}
                    >
                      {todo.title}
                    </button>
                  ) : (
                    <span className="todo-title">{todo.title}</span>
                  )}
                  {isTodayMode && (
                    <>
                      <button
                        className={["todo-start", isActive ? "todo-start--active" : ""]
                          .filter(Boolean)
                          .join(" ")}
                        type="button"
                        title={isActive ? "结束" : "开始"}
                        aria-label={`${isActive ? "结束" : "开始"}：${todo.title}`}
                        disabled={todo.completed}
                        onClick={() => onStartTodo(todo.id)}
                      >
                        <Play size={13} strokeWidth={2.4} />
                        <span>{isActive ? "结束" : "开始"}</span>
                      </button>
                      <button
                        className="todo-delete"
                        type="button"
                        title="删除"
                        aria-label={`删除：${todo.title}`}
                        onClick={() => onDeleteTodo(todo.id)}
                      >
                        <Trash2 size={14} strokeWidth={2.2} />
                      </button>
                    </>
                  )}
                </div>
              );
            })
          )}

        </div>
      )}
    </section>
  );
}

function ArchiveBrowser({
  archives,
  layout,
  onSelectArchive,
}: {
  archives: CompletedArchive[];
  layout: ArchiveLayout;
  onSelectArchive: (date: string) => void;
}) {
  const handleHorizontalWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (layout !== "cards") {
      return;
    }

    event.preventDefault();
    event.currentTarget.scrollLeft += event.deltaY + event.deltaX;
  };

  if (archives.length === 0) {
    return <div className="todo-empty">No completed todos yet</div>;
  }

  if (layout === "timeline") {
    return (
      <div className="archive-timeline" role="list">
        {archives.map((archive) => (
          <button
            className="archive-timeline__item"
            key={archive.date}
            type="button"
            role="listitem"
            onClick={() => onSelectArchive(archive.date)}
          >
            <span className="archive-timeline__dot" />
            <span>{archive.date}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="archive-cards" role="list" onWheel={handleHorizontalWheel}>
      {archives.map((archive) => {
        const previewItems = archive.items.slice(0, 3);
        const dateParts = getDisplayDateParts(archive.date);

        return (
          <button
            className="archive-card"
            key={archive.date}
            type="button"
            role="listitem"
            onClick={() => onSelectArchive(archive.date)}
          >
            <span className="archive-card__eyebrow">COMPLETED</span>
            <strong className="archive-card__date">
              <span>{dateParts.year}</span>
              <span>
                {dateParts.month}
                <em>/</em>
                {dateParts.day}
              </span>
            </strong>
            <span className="archive-card__preview">
              {previewItems.length > 0 ? (
                previewItems.map((item, idx) => (
                  <span className="archive-card__todo" key={idx}>
                    <span className="archive-card__todo-mark archive-card__todo-mark--done" />
                    <span>{item.title}</span>
                  </span>
                ))
              ) : (
                <span className="archive-card__empty">No tasks</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MusicPlayerPanel({
  mediaState,
  onPlayPause,
  onNext,
  onPrevious,
}: {
  mediaState: MediaState;
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
}) {
  const isPlaying =
    mediaState.playbackStatus === "playing" ||
    (mediaState.playbackStatus !== "paused" && mediaState.audioActive);
  const isPaused = mediaState.playbackStatus === "paused";
  const hasAudioSignal = mediaState.available || mediaState.audioActive;
  const statusLabel = isPaused
    ? "Paused"
    : hasAudioSignal
      ? "Audio active"
      : "No signal";
  const peakPercent = Math.round(
    clamp(Math.log1p(mediaState.audioPeak * 160) / Math.log1p(160), 0, 1) *
      100,
  );

  return (
    <section
      className={[
        "music-player",
        hasAudioSignal ? "" : "music-player--empty",
        isPaused ? "music-player--paused" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="Music player"
    >
      <div className="music-player__signal">
        <div className="music-player__status">
          <span>{statusLabel}</span>
          <strong>{peakPercent}%</strong>
        </div>
        <MusicLevelWave
          isAvailable={hasAudioSignal}
          isPlaying={isPlaying}
          audioPeak={mediaState.audioPeak}
        />
      </div>

      <div className="music-player__controls">
        <button
          className="music-control-button"
          type="button"
          title="Previous"
          aria-label="Previous track"
          onClick={onPrevious}
        >
          <SkipBack size={18} strokeWidth={2.4} />
        </button>
        <button
          className="music-control-button music-control-button--primary"
          type="button"
          title={isPlaying ? "Pause" : "Play"}
          aria-label={isPlaying ? "Pause" : "Play"}
          onClick={onPlayPause}
        >
          {isPlaying ? (
            <Pause size={20} strokeWidth={2.5} />
          ) : (
            <Play size={20} strokeWidth={2.5} />
          )}
        </button>
        <button
          className="music-control-button"
          type="button"
          title="Next"
          aria-label="Next track"
          onClick={onNext}
        >
          <SkipForward size={18} strokeWidth={2.4} />
        </button>
      </div>
    </section>
  );
}

function MusicLevelWave({
  isAvailable,
  isPlaying,
  audioPeak,
}: {
  isAvailable: boolean;
  isPlaying: boolean;
  audioPeak: number;
}) {
  const [phase, setPhase] = useState(0);
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (!isAvailable && !isPlaying) {
      setPhase(0);
      return;
    }

    const interval = window.setInterval(
      () => {
        setPhase(performance.now() / (isPlaying ? 210 : 760));
      },
      prefersReducedMotion ? 460 : isPlaying ? 58 : 150,
    );

    return () => window.clearInterval(interval);
  }, [isAvailable, isPlaying, prefersReducedMotion]);

  const liftedPeak = isPlaying
    ? clamp(Math.log1p(clamp(audioPeak, 0, 1) * 185) / Math.log1p(185), 0, 1)
    : 0;
  const bars = [0.22, 0.48, 0.78, 0.54, 0.92, 0.68, 0.4, 0.72, 0.34].map(
    (bar, index) => {
      const floor = isAvailable ? 0.2 : 0.1;
      const breath =
        isAvailable && !prefersReducedMotion
          ? 0.06 + Math.sin(phase + index * 0.72) * 0.045
          : 0;
      const movement =
        liftedPeak *
        (0.34 + bar * 1.06) *
        (0.78 + Math.sin(phase * (1.05 + index * 0.05) + index * 1.35) * 0.28);

      return clamp(floor + breath + movement, 0.1, 1.08);
    },
  );

  return (
    <div className="music-player__wave" aria-hidden="true">
      {bars.map((scale, index) => (
        <span
          key={index}
          style={
            {
              "--wave-scale": scale.toFixed(3),
              "--wave-opacity": (0.3 + scale * 0.68).toFixed(3),
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

function App() {
  const [mode, setMode] = useState<IslandMode>("collapsed");
  const [isTucked, setIsTucked] = useState(false);
  const [page, setPage] = useState<IslandPage>("todo");
  const [mediaState, setMediaState] =
    useState<MediaState>(DEFAULT_MEDIA_STATE);
  const [agentStatus, setAgentStatus] =
    useState<AgentStatusSnapshot>(DEFAULT_AGENT_STATUS);
  const isRefreshingAgentStatus = useRef(false);
  const mediaStatusLockUntil = useRef(0);
  const [settings, setSettings] = useState<IslandSettings>(loadSettings);
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [settingPresets, setSettingPresets] =
    useState<IslandPreset[]>(loadSettingPresets);
  const [todos, setTodos] = useState<TodoItem[]>(loadTodos);
  const [_completedTodos, setCompletedTodos] = useState<TodoItem[]>([]);
  const [todosDirectory, setTodosDirectory] = useState(
    () => window.localStorage.getItem(TODOS_DIRECTORY_STORAGE_KEY) ?? "",
  );
  const [todosDirectoryDraft, setTodosDirectoryDraft] = useState(todosDirectory);
  const [draftTodo, setDraftTodo] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>(DEFAULT_CATEGORY);
  const [categoryNames, setCategoryNames] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem(CATEGORY_NAMES_STORAGE_KEY);
      return stored ? (JSON.parse(stored) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [syncServerUrl, setSyncServerUrl] = useState(
    () => window.localStorage.getItem(SYNC_URL_STORAGE_KEY) ?? "",
  );
  const [activeTodoId, setActiveTodoId] = useState<string | null>(
    loadActiveTodoId,
  );
  const [todoPageMode, setTodoPageMode] = useState<TodoPageMode>("today");
  const [archiveLayout, setArchiveLayout] = useState<ArchiveLayout>("cards");
  const [completedArchives, setCompletedArchives] = useState<CompletedArchive[]>([]);
  const [agentHooksInstallState, setAgentHooksInstallState] =
    useState<AgentHooksInstallState>("idle");
  const [agentHooksInstallResult, setAgentHooksInstallResult] =
    useState<AgentHooksInstallResult | null>(null);
  const [agentHooksInstallError, setAgentHooksInstallError] = useState("");
  const didShowInitialWindow = useRef(false);
  const isTodoArchivePage = page === "todo" && todoPageMode === "archive";
  const visibleTodoRows = Math.min(
    Math.max(
      isTodoArchivePage
        ? TODO_GROW_START_ROWS
        : getTodoVisualRows(todos),
      1,
    ),
    TODO_SCROLL_START_ROWS,
  );
  const expandedIslandHeight =
    page === "todo"
      ? isTodoArchivePage
        ? TODO_ARCHIVE_EXPANDED_ISLAND_HEIGHT
        : BASE_EXPANDED_ISLAND_HEIGHT +
          Math.max(0, visibleTodoRows - TODO_GROW_START_ROWS) * TODO_ROW_HEIGHT
      : page === "music"
        ? MUSIC_EXPANDED_ISLAND_HEIGHT
        : EDITOR_EXPANDED_ISLAND_HEIGHT;
  const layoutSync = useRef<{
    frame: number | null;
    inFlight: boolean;
    pending: IslandSettings;
    active: IslandSettings;
  }>({
    frame: null,
    inFlight: false,
    pending: settings,
    active: settings,
  });

  const stageStyle = useMemo(
    () =>
      ({
        "--island-opacity": settings.opacity / 100,
        "--island-scale": settings.sizeScale,
        "--expanded-island-height": `${expandedIslandHeight}px`,
        "--task-text-color": settings.taskTextColor,
        "--island-pulse-color": settings.pulseColor,
        "--island-pulse-glow-color": hexToRgba(settings.pulseColor, 0.72),
        "--island-pulse-brightness": `${settings.pulseBrightness}%`,
        "--island-background-color": settings.islandBackgroundColor,
        "--todo-background-color": settings.todoBackgroundColor,
        "--agent-running-color": settings.agentRunningColor,
        "--agent-running-glow-color": hexToRgba(settings.agentRunningColor, 0.64),
        "--agent-confirming-color": settings.agentConfirmingColor,
        "--agent-confirming-glow-color": hexToRgba(settings.agentConfirmingColor, 0.64),
        "--agent-idle-color": settings.agentIdleColor,
        "--agent-dot-size": `${settings.agentDotSize}px`,
      }) as CSSProperties,
    [
      expandedIslandHeight,
      settings.islandBackgroundColor,
      settings.opacity,
      settings.pulseBrightness,
      settings.pulseColor,
      settings.sizeScale,
      settings.taskTextColor,
      settings.todoBackgroundColor,
      settings.agentRunningColor,
      settings.agentConfirmingColor,
      settings.agentIdleColor,
      settings.agentDotSize,
    ],
  );

  const syncNativeLayout = useCallback(async (nextSettings: IslandSettings) => {
    try {
      await invoke("set_island_layout", {
        layout: {
          sizeScale: nextSettings.sizeScale,
          marginY: nextSettings.marginY,
          marginX: nextSettings.marginX,
        },
      });
    } catch (error) {
      console.error("Failed to sync island layout", error);
    }
  }, []);

  const flushNativeLayout = useCallback(() => {
    const syncState = layoutSync.current;

    if (syncState.inFlight) {
      return;
    }

    const nextSettings = syncState.pending;
    syncState.active = nextSettings;
    syncState.inFlight = true;

    void syncNativeLayout(nextSettings).finally(() => {
      const latestState = layoutSync.current;
      latestState.inFlight = false;

      if (latestState.pending !== latestState.active) {
        latestState.frame = window.requestAnimationFrame(() => {
          latestState.frame = null;
          flushNativeLayout();
        });
      }
    });
  }, [syncNativeLayout]);

  const scheduleNativeLayout = useCallback(
    (nextSettings: IslandSettings) => {
      const syncState = layoutSync.current;
      syncState.pending = nextSettings;

      if (syncState.frame !== null || syncState.inFlight) {
        return;
      }

      syncState.frame = window.requestAnimationFrame(() => {
        syncState.frame = null;
        flushNativeLayout();
      });
    },
    [flushNativeLayout],
  );

  const syncNativeInteraction = useCallback(
    async (
      nextMode: IslandMode,
      nextSettings: IslandSettings,
      nextExpandedHeight: number,
      nextIsTucked: boolean,
    ) => {
      try {
        await invoke("set_island_interaction", {
          mode: nextMode,
          sizeScale: nextSettings.sizeScale,
          marginY: nextSettings.marginY,
          marginX: nextSettings.marginX,
          expandedHeight: nextExpandedHeight,
          isTucked: nextIsTucked,
        });
      } catch (error) {
        console.error("Failed to sync island interaction", error);
      }
    },
    [],
  );

  const showReadyIsland = useCallback(async () => {
    if (didShowInitialWindow.current) {
      return;
    }

    didShowInitialWindow.current = true;

    try {
      await invoke("show_ready_island");
    } catch (error) {
      console.error("Failed to show island", error);
    }
  }, []);

  const refreshAgentStatus = useCallback(async () => {
    if (isRefreshingAgentStatus.current) {
      return;
    }

    isRefreshingAgentStatus.current = true;
    try {
      const snapshot = await invoke<AgentStatusSnapshot>("get_agent_status");
      setAgentStatus(snapshot);
    } catch (error) {
      console.error("Failed to read agent status", error);
      setAgentStatus(DEFAULT_AGENT_STATUS);
    } finally {
      isRefreshingAgentStatus.current = false;
    }
  }, []);

  const minimizeIsland = useCallback(async () => {
    try {
      await invoke("minimize_island");
    } catch (error) {
      console.error("Failed to minimize island", error);
    }
  }, []);

  const setIslandMode = useCallback((nextMode: IslandMode) => {
    setMode(nextMode);
    setIsTucked(false);
  }, []);

  const tuckIsland = useCallback(() => {
    setIslandMode("collapsed");
    setIsTucked(true);
  }, [setIslandMode]);

  const revealIsland = useCallback(() => {
    setIsTucked(false);
  }, []);

  const openIslandPage = useCallback((nextPage: IslandPage) => {
    setPage(nextPage);
    setMode("expanded");
    setIsTucked(false);
  }, []);

  const collapseIsland = useCallback(() => {
    setIslandMode("collapsed");
  }, [setIslandMode]);

  const refreshMediaState = useCallback(async () => {
    try {
      const nextMediaState = await invoke<MediaState>("get_media_state");

      setMediaState((currentState) => {
        const isStatusLocked = Date.now() < mediaStatusLockUntil.current;
        const nextPeak = Math.max(
          currentState.audioPeak * 0.82,
          nextMediaState.audioPeak,
        );
        const measuredAudioActive =
          nextMediaState.audioActive || nextPeak > AUDIO_ACTIVE_THRESHOLD;
        const audioActive =
          isStatusLocked && currentState.playbackStatus === "paused"
            ? false
            : measuredAudioActive;
        const playbackStatus = isStatusLocked
          ? currentState.playbackStatus
          : audioActive
            ? "playing"
            : "unavailable";

        return {
          ...nextMediaState,
          audioActive,
          audioPeak: audioActive ? nextPeak : 0,
          playbackStatus,
        };
      });
    } catch (error) {
      console.error("Failed to read media state", error);
      setMediaState((currentState) => ({
        ...DEFAULT_MEDIA_STATE,
        audioActive: currentState.audioActive,
        audioPeak: currentState.audioPeak * 0.72,
        playbackStatus: currentState.audioActive ? "playing" : "unavailable",
      }));
    }
  }, []);

  const runMediaCommand = useCallback(
    async (command: "media_play_pause" | "media_next" | "media_previous") => {
      if (command === "media_play_pause") {
        setMediaState((currentState) => {
          const isCurrentlyPlaying =
            currentState.playbackStatus === "playing" ||
            (currentState.playbackStatus !== "paused" &&
              currentState.audioActive);
          const nextStatus: MediaPlaybackStatus = isCurrentlyPlaying
            ? "paused"
            : "playing";
          mediaStatusLockUntil.current = Date.now() + 900;

          return {
            ...currentState,
            available: nextStatus === "playing" || currentState.available,
            audioActive: nextStatus === "playing",
            audioPeak:
              nextStatus === "playing"
                ? Math.max(currentState.audioPeak, 0.08)
                : 0,
            playbackStatus: nextStatus,
          };
        });
      }

      try {
        await invoke<void>(command);
      } catch (error) {
        console.error(`Failed to run media command: ${command}`, error);
      }
      window.setTimeout(() => void refreshMediaState(), 120);
      window.setTimeout(() => void refreshMediaState(), 980);
    },
    [refreshMediaState],
  );

  useEffect(() => {
    let didCancel = false;

    const refreshAudioLevel = async () => {
      try {
        const audioLevel = await invoke<AudioLevel>("get_audio_level");

        if (didCancel) {
          return;
        }

        setMediaState((currentState) => {
          const isStatusLocked = Date.now() < mediaStatusLockUntil.current;
          const shouldSuppressAudio =
            isStatusLocked && currentState.playbackStatus === "paused";
          const decayedPeak = currentState.audioPeak * 0.82;
          const nextPeak = audioLevel.active
            ? Math.max(decayedPeak, audioLevel.peak)
            : decayedPeak;
          const audioActive =
            !shouldSuppressAudio &&
            (audioLevel.active || nextPeak > AUDIO_ACTIVE_THRESHOLD * 1.5);

          return {
            ...currentState,
            audioActive,
            audioPeak: audioActive ? nextPeak : 0,
            playbackStatus:
              isStatusLocked
                ? currentState.playbackStatus
                : audioActive
                  ? "playing"
                  : currentState.playbackStatus === "paused"
                    ? "paused"
                  : "unavailable",
          };
        });
      } catch (error) {
        console.error("Failed to read audio level", error);
      }
    };

    void refreshAudioLevel();

    const interval = window.setInterval(() => {
      void refreshAudioLevel();
    }, 120);

    return () => {
      didCancel = true;
      window.clearInterval(interval);
    };
  }, []);

  const handleCategoryChange = useCallback((category: string) => {
    setActiveCategory(category);
    setDraftTodo("");
  }, []);

  const handleAddCategory = useCallback((category: string) => {
    setCategoryNames((prev) => {
      if (prev.includes(category)) return prev;
      const next = [...prev, category];
      window.localStorage.setItem(CATEGORY_NAMES_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    setActiveCategory(category);
    setDraftTodo("");
  }, []);

  const addTodo = useCallback(() => {
    const title = draftTodo.trim();

    if (!title) {
      return;
    }

    setTodos((currentTodos) => [
      {
        id: createTodoId(),
        title,
        completed: false,
        createdAt: Date.now(),
        category: activeCategory,
      },
      ...currentTodos,
    ]);
    setDraftTodo("");
  }, [draftTodo, activeCategory]);

  const toggleTodo = useCallback(
    async (id: string) => {
      const todo = todos.find((t) => t.id === id);
      if (!todo) return;

      if (todo.completed) {
        // uncomplete: move back to active todos
        const uncompleted = { ...todo, completed: false };
        setTodos((current) => [...current, uncompleted]);
        setCompletedTodos((current) => current.filter((t) => t.id !== id));
        setActiveTodoId((currentId) => (currentId === id ? null : currentId));
      } else {
        // complete: move to completed, append to YYYY-MM-DD.md
        const completed = { ...todo, completed: true };
        setTodos((current) => current.filter((t) => t.id !== id));
        setCompletedTodos((current) => [completed, ...current]);
        setActiveTodoId((currentId) => (currentId === id ? null : currentId));

        const today = getLocalDateString();
        try {
          await invoke("append_completed_todo", {
            filePath: `${todosDirectory}/${today}.md`,
            line: `- [x] ${completed.title}`,
          });
        } catch (error) {
          console.error("Failed to append completed todo:", error);
        }
        scheduleSyncPush();
      }
    },
    [todos, todosDirectory],
  );

  const syncPushTimer = useRef<number | null>(null);

  const scheduleSyncPush = useCallback(() => {
    if (!syncServerUrl || !todosDirectory) return;
    if (syncPushTimer.current) clearTimeout(syncPushTimer.current);
    syncPushTimer.current = window.setTimeout(async () => {
      try {
        const files = await readAllLocalFiles(todosDirectory);
        await pushToServer(syncServerUrl, files);
      } catch {
        // push failed → silent, server will overwrite on next startup pull
      }
    }, 1000);
  }, [syncServerUrl, todosDirectory]);

  const saveTodosToFile = useCallback(
    async (todoList: TodoItem[]) => {
      const content = formatTodosAsMarkdown(todoList, categoryNames);
      try {
        await invoke("save_todos", {
          filePath: `${todosDirectory}/todos.md`,
          content,
        });
      } catch (error) {
        console.error("Failed to save todos:", error);
      }
      scheduleSyncPush();
    },
    [todosDirectory, categoryNames],
  );

  const updateTodoTitle = useCallback((id: string, title: string) => {
    const nextTitle = title.trim();

    if (!nextTitle) {
      return;
    }

    setTodos((currentTodos) =>
      currentTodos.map((todo) =>
        todo.id === id ? { ...todo, title: nextTitle } : todo,
      ),
    );
  }, []);

  const startTodo = useCallback(
    (id: string) => {
      const todo = todos.find((item) => item.id === id);

      if (!todo || todo.completed) {
        return;
      }

      if (activeTodoId === id) {
        setActiveTodoId(null);
        return;
      }

      setActiveTodoId(id);
      setIslandMode("collapsed");
    },
    [activeTodoId, setIslandMode, todos],
  );

  const deleteTodo = useCallback((id: string) => {
    setTodos((currentTodos) => currentTodos.filter((todo) => todo.id !== id));
    setActiveTodoId((currentId) => (currentId === id ? null : currentId));
  }, []);

  const saveTodosDirectory = useCallback(() => {
    const dir = todosDirectoryDraft.trim();
    setTodosDirectory(dir);
    setTodosDirectoryDraft(dir);
    window.localStorage.setItem(TODOS_DIRECTORY_STORAGE_KEY, dir);
  }, [todosDirectoryDraft]);

  const handleSyncServerUrlChange = useCallback((url: string) => {
    setSyncServerUrl(url);
    window.localStorage.setItem(SYNC_URL_STORAGE_KEY, url);
  }, []);

  const handleSyncNow = useCallback(() => {
    if (!syncServerUrl || !todosDirectory) {
      window.alert("请先设置同步服务器地址和待办文件目录");
      return;
    }
    void (async () => {
      try {
        // pull first
        const files = await pullFromServer(syncServerUrl);
        let pulledCount = 0;
        if (files && Object.keys(files).length > 0) {
          await writeAllLocalFiles(todosDirectory, files);
          pulledCount = Object.keys(files).length;
          const todosContent = files["todos.md"];
          if (todosContent) {
            setTodos(parseTodosFromMarkdown(todosContent));
            const cats = parseCategoriesFromMarkdown(todosContent);
            if (cats.length > 0) setCategoryNames(cats);
          }
        }
        // then push local
        const local = await readAllLocalFiles(todosDirectory);
        await pushToServer(syncServerUrl, local);
        const pushedCount = Object.keys(local).length;
        window.alert(
          `同步成功：从服务器拉取 ${pulledCount} 个文件，上传 ${pushedCount} 个文件`,
        );
      } catch (error) {
        console.error("sync failed", error);
        window.alert(`同步失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, [syncServerUrl, todosDirectory]);

  const showArchive = useCallback(() => {
    setTodoPageMode("archive");
    setDraftTodo("");
    loadCompletedArchivesFromDisk();
  }, []);

  const showToday = useCallback(() => {
    setTodoPageMode("today");
    setDraftTodo("");
  }, []);

  const loadCompletedArchivesFromDisk = useCallback(async () => {
    try {
      const result = await invoke<CompletedArchive[]>("list_completed_archives", {
        directory: "todos",
      });
      setCompletedArchives(result);
    } catch (error) {
      console.error("Failed to load completed archives:", error);
    }
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    scheduleNativeLayout(DEFAULT_SETTINGS);
  }, [scheduleNativeLayout]);

  const saveSettingsPreset = useCallback(() => {
    setSettingPresets((currentPresets) => {
      const customPresetCount = currentPresets.filter(
        (preset) => !preset.isDefault && !isDefaultSettingPreset(preset.id),
      ).length;
      const preset: IslandPreset = {
        id: createTodoId(),
        name: `预设 ${customPresetCount + 1}`,
        settings,
        createdAt: Date.now(),
        isDefault: false,
      };

      return mergeWithDefaultSettingPresets([preset, ...currentPresets]);
    });
  }, [settings]);

  const applySettingsPreset = useCallback(
    (presetId: string) => {
      const preset = settingPresets.find((item) => item.id === presetId);

      if (!preset) {
        return;
      }

      const nextSettings = normalizeSettings(preset.settings);
      setSettings(nextSettings);
      scheduleNativeLayout(nextSettings);
    },
    [scheduleNativeLayout, settingPresets],
  );

  const renameSettingsPreset = useCallback((presetId: string, name: string) => {
    const nextName = name.trim();

    if (
      !nextName ||
      isDefaultSettingPreset(presetId) ||
      LEGACY_DEFAULT_PRESET_NAMES.has(nextName)
    ) {
      return;
    }

    setSettingPresets((currentPresets) =>
      currentPresets.map((preset) =>
        preset.id === presetId ? { ...preset, name: nextName } : preset,
      ),
    );
  }, []);

  const deleteSettingsPreset = useCallback((presetId: string) => {
    if (isDefaultSettingPreset(presetId)) {
      return;
    }

    setSettingPresets((currentPresets) =>
      currentPresets.filter((preset) => preset.id !== presetId),
    );
  }, []);

  const updateLaunchAtStartup = useCallback(async (enabled: boolean) => {
    setLaunchAtStartup(enabled);

    try {
      await invoke("set_launch_at_startup", { enabled });
    } catch (error) {
      console.error("Failed to update launch at startup", error);
      setLaunchAtStartup(!enabled);
    }
  }, []);

  const installAgentHooks = useCallback(async () => {
    setAgentHooksInstallState("installing");
    setAgentHooksInstallError("");

    try {
      const result = await invoke<AgentHooksInstallResult>(
        "install_agent_status_hooks",
      );
      setAgentHooksInstallResult(result);
      setAgentHooksInstallState("installed");
      void refreshAgentStatus();
    } catch (error) {
      console.error("Failed to install agent status hooks", error);
      setAgentHooksInstallError(getErrorMessage(error));
      setAgentHooksInstallState("error");
    }
  }, [refreshAgentStatus]);

  useEffect(() => {
    void invoke<boolean>("get_launch_at_startup")
      .then(setLaunchAtStartup)
      .catch((error) => {
        console.error("Failed to read launch at startup", error);
      });
  }, []);

  useEffect(() => {
    void refreshMediaState();

    const interval = window.setInterval(() => {
      void refreshMediaState();
    }, 1500);

    return () => window.clearInterval(interval);
  }, [refreshMediaState]);

  useEffect(() => {
    void refreshAgentStatus();

    const interval = window.setInterval(() => {
      void refreshAgentStatus();
    }, 200);

    return () => window.clearInterval(interval);
  }, [refreshAgentStatus]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    window.localStorage.setItem(
      SETTINGS_PRESETS_STORAGE_KEY,
      JSON.stringify(settingPresets),
    );
  }, [settingPresets]);

  useEffect(() => {
    window.localStorage.setItem(TODOS_STORAGE_KEY, JSON.stringify(todos));
  }, [todos]);

  useEffect(() => {
    void (async () => {
      if (!todosDirectory) {
        try {
          const exeDir = await invoke<string>("get_exe_dir");
          const dir = `${exeDir}\\todos`;
          setTodosDirectory(dir);
          setTodosDirectoryDraft(dir);
        } catch (error) {
          console.error("Failed to get exe directory:", error);
        }
      }
    })();
  }, []);

  useEffect(() => {
    if (!todosDirectory) return;
    void (async () => {
      try {
        const archives = await invoke<CompletedArchive[]>("list_completed_archives", {
          directory: todosDirectory,
        });
        const items: TodoItem[] = [];
        for (const archive of archives) {
          for (const entry of archive.items) {
            items.push({
              id: createTodoId(),
              title: entry.title,
              completed: true,
              createdAt: Date.now(),
              category: DEFAULT_CATEGORY,
            });
          }
        }
        setCompletedTodos(items);
      } catch (error) {
        console.error("Failed to load completed todos from disk:", error);
      }
    })();
  }, []);

  // One-time load todos from file on startup, falling back to localStorage
  const didLoadTodosFromFile = useRef(false);
  useEffect(() => {
    if (!todosDirectory || didLoadTodosFromFile.current) return;
    didLoadTodosFromFile.current = true;
    void (async () => {
      const fileTodos = await loadTodosFromFile(todosDirectory);
      if (fileTodos.length > 0) {
        setTodos(fileTodos);
      }
      // Also extract categories from file headers
      try {
        const rawContent = await invoke<string>("read_todos_file", {
          filePath: `${todosDirectory}/todos.md`,
        });
        const fileCategories = parseCategoriesFromMarkdown(rawContent);
        if (fileCategories.length > 0) {
          setCategoryNames(fileCategories);
          window.localStorage.setItem(CATEGORY_NAMES_STORAGE_KEY, JSON.stringify(fileCategories));
        }
      } catch {
        // file doesn't exist, keep localStorage categories
      }
    })();
  }, [todosDirectory]);

  // Pull from sync server on startup (after local file load)
  useEffect(() => {
    if (!todosDirectory || !syncServerUrl) return;
    void (async () => {
      try {
        const files = await pullFromServer(syncServerUrl);
        if (files && Object.keys(files).length > 0) {
          await writeAllLocalFiles(todosDirectory, files);
          const todosContent = files["todos.md"];
          if (todosContent) {
            setTodos(parseTodosFromMarkdown(todosContent));
            const cats = parseCategoriesFromMarkdown(todosContent);
            if (cats.length > 0) {
              setCategoryNames(cats);
              window.localStorage.setItem(
                CATEGORY_NAMES_STORAGE_KEY,
                JSON.stringify(cats),
              );
            }
          }
        }
      } catch {
        // network error → keep local data
      }
    })();
  }, [todosDirectory, syncServerUrl]);

  useEffect(() => {
    if (activeTodoId) {
      window.localStorage.setItem(ACTIVE_TODO_STORAGE_KEY, activeTodoId);
      return;
    }

    window.localStorage.removeItem(ACTIVE_TODO_STORAGE_KEY);
  }, [activeTodoId]);

  useEffect(() => {
    if (
      activeTodoId &&
      !todos.some((todo) => todo.id === activeTodoId && !todo.completed)
    ) {
      setActiveTodoId(null);
    }
  }, [activeTodoId, todos]);

  useEffect(() => {
    const debounce = window.setTimeout(() => {
      void saveTodosToFile(todos);
    }, 500);
    return () => window.clearTimeout(debounce);
  }, [todos, saveTodosToFile]);

  useEffect(() => {
    scheduleNativeLayout(settings);
  }, [settings.marginX, settings.marginY, scheduleNativeLayout]);

  useEffect(() => {
    void syncNativeInteraction(
      mode,
      settings,
      expandedIslandHeight,
      isTucked,
    ).finally(() => {
      void showReadyIsland();
    });
  }, [
    expandedIslandHeight,
    isTucked,
    mode,
    settings.marginX,
    settings.marginY,
    settings.sizeScale,
    showReadyIsland,
    syncNativeInteraction,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        collapseIsland();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [collapseIsland]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused && mode === "expanded") {
          collapseIsland();
        }
      })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch((error) => {
        console.error("Failed to listen for island focus changes", error);
      });

    return () => {
      unlisten?.();
    };
  }, [collapseIsland, mode]);

  const activeTaskTitle = useMemo(() => {
    const activeTodo = todos.find(
      (todo) => todo.id === activeTodoId && !todo.completed,
    );

    return activeTodo?.title ?? null;
  }, [activeTodoId, todos]);
  const openTodoCount = useMemo(
    () => todos.filter((todo) => !todo.completed).length,
    [todos],
  );
  return (
    <main className="stage" style={stageStyle}>
      <IslandShell
        mode={mode}
        page={page}
        isTucked={isTucked}
        activeTaskTitle={activeTaskTitle}
        pendingTodoCount={openTodoCount}
        mediaState={mediaState}
        activeSessions={agentStatus.activeSessions}
        isAgentConfirming={
          agentStatus.codex?.phase === "awaiting_confirmation" ||
          agentStatus.claudeCode?.phase === "awaiting_confirmation"
        }
        onOpenPage={openIslandPage}
        onCollapse={collapseIsland}
        onMinimize={minimizeIsland}
        onTuck={tuckIsland}
        onReveal={revealIsland}
        onPageChange={setPage}
      >
        {page === "layout" && (
          <LayoutEditor
            settings={settings}
            todosDirectoryDraft={todosDirectoryDraft}
            presets={settingPresets}
            launchAtStartup={launchAtStartup}
            agentHooksInstallState={agentHooksInstallState}
            agentHooksInstallResult={agentHooksInstallResult}
            agentHooksInstallError={agentHooksInstallError}
            onSettingsChange={setSettings}
            onReset={resetSettings}
            onTodosDirectoryDraftChange={setTodosDirectoryDraft}
            onSaveTodosDirectory={saveTodosDirectory}
            onSavePreset={saveSettingsPreset}
            onApplyPreset={applySettingsPreset}
            onRenamePreset={renameSettingsPreset}
            onDeletePreset={deleteSettingsPreset}
            onLaunchAtStartupChange={updateLaunchAtStartup}
            onInstallAgentHooks={installAgentHooks}
            syncServerUrl={syncServerUrl}
            onSyncServerUrlChange={handleSyncServerUrlChange}
            onSyncNow={handleSyncNow}
          />
        )}
        {page === "music" && (
          <MusicPlayerPanel
            mediaState={mediaState}
            onPlayPause={() => void runMediaCommand("media_play_pause")}
            onNext={() => void runMediaCommand("media_next")}
            onPrevious={() => void runMediaCommand("media_previous")}
          />
        )}
        {page === "todo" && (
          <TodoNotebook
            todos={todos}
            draft={draftTodo}
            activeTodoId={activeTodoId}
            pageMode={todoPageMode}
            completedArchives={completedArchives}
            archiveLayout={archiveLayout}
            activeCategory={activeCategory}
            categoryNames={categoryNames}
            onDraftChange={setDraftTodo}
            onAddTodo={addTodo}
            onToggleTodo={toggleTodo}
            onUpdateTodo={updateTodoTitle}
            onStartTodo={startTodo}
            onDeleteTodo={deleteTodo}
            onShowArchive={showArchive}
            onShowToday={showToday}
            onArchiveLayoutChange={setArchiveLayout}
            onCategoryChange={handleCategoryChange}
            onAddCategory={handleAddCategory}
          />
        )}
      </IslandShell>
    </main>
  );
}

export default App;
