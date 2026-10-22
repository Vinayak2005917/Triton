import { FormEvent, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import Markdown from "react-markdown";
import { getCurrentWindow } from "@tauri-apps/api/window";
import defaultHexVideo from "../Interstellar-Gargantua-black-SnapYT.App.mp4?url";
import sendButtonImage from "./assets/Send.png";
import HexBackground, { type HexMode, type HexPalette } from "./HexBackground";
import TritonMascot from "./TritonMascot";
import "./App.css";

type Message = {
  id: number;
  role: "agent" | "user";
  text: string;
  timestamp: string;
  audioUrl?: string;
  audioPending?: boolean;
  audioError?: string;
  canvasState?: string;
  toolUpdates?: string[];
  requestStartedAt?: number;
  requestDurationMs?: number;
  pending?: boolean;
};

type Tab = {
  id: number;
  name: string;
  threadId: string;
  messages: Message[];
  code: string;
  message: string;
  suggestedPrompts: string[];
  canvasState?: string;
  currentCanvasState?: string;
  hasAskedFirstPrompt?: boolean;
  isSending?: boolean;
  workspacePending?: boolean;
  workspaceWasEdited?: boolean;
};

type HistoryConversation = {
  thread_id: string;
  name: string;
  updated_at: string;
  preview: string;
  message_count: number;
};

const API_BASE = "http://localhost:8000";
const TRANSCRIPTION_WS_URL = "ws://127.0.0.1:8001/v1/audio/stream";
const TRANSCRIPTION_SAMPLE_RATE = 16000;
const HEX_SETTINGS_VERSION = "2";
const DEFAULT_HEX_VIDEO_NAME = "Interstellar-Gargantua-black-SnapYT.App.mp4";
const WAVEFORM_BAR_WIDTH = 3;
const WAVEFORM_BAR_PITCH = 7;
const WAVEFORM_SAMPLE_INTERVAL = 260;

function resampleAudio(input: Float32Array, inputRate: number, outputRate: number) {
  if (inputRate === outputRate) return input.slice();

  const outputLength = Math.floor(input.length * outputRate / inputRate);
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, input.length - 1);
    const fraction = position - lower;
    output[index] = input[lower] + (input[upper] - input[lower]) * fraction;
  }
  return output;
}

function drawWaveform(canvas: HTMLCanvasElement, levels: number[], offset: number) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;

  const pixelRatio = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * pixelRatio);
  const pixelHeight = Math.round(height * pixelRatio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#d2d2d2";

  const barCount = Math.ceil(width / WAVEFORM_BAR_PITCH) + 1;
  while (levels.length < barCount) levels.push(0);
  if (levels.length > barCount) levels.splice(0, levels.length - barCount);

  for (let index = 0; index < levels.length; index += 1) {
    const x = index * WAVEFORM_BAR_PITCH - offset;
    if (x + WAVEFORM_BAR_WIDTH < 0 || x > width) continue;
    const barHeight = 2 + levels[index] * 22;
    context.beginPath();
    context.roundRect(x, (height - barHeight) / 2, WAVEFORM_BAR_WIDTH, barHeight, WAVEFORM_BAR_WIDTH / 2);
    context.fill();
  }
}

function createThreadId() {
  return `Triton_${crypto.randomUUID()}`;
}

function persistedTab(tab: Tab): Tab {
  return {
    ...tab,
    messages: tab.messages.map((message) => ({ ...message, audioUrl: undefined, audioPending: false })),
  };
}

function prepareWorkspaceDocument(html: string) {
  const workspaceStyles = `<style>
    html, body { width: 100%; min-height: 100%; margin: 0; }
    html { scrollbar-color: #181818 #181818 !important; scrollbar-width: thin !important; }
    body { overflow-y: auto; scrollbar-color: #000 #181818 !important; scrollbar-width: thin !important; }
    ::-webkit-scrollbar { width: 5px !important; height: 5px !important; background: #181818 !important; }
    ::-webkit-scrollbar-track { background: #181818 !important; }
    ::-webkit-scrollbar-thumb { background: #000 !important; border-radius: 8px !important; }
    ::-webkit-scrollbar-button { display: none !important; width: 0 !important; height: 0 !important; background: #181818 !important; }
  </style>`;

  if (html.includes("</head>")) {
    return html.replace("</head>", `${workspaceStyles}</head>`);
  }

  return `${workspaceStyles}${html}`;
}

function WorkspacePreview({ html, title }: { html: string; title: string }) {
  const initialDocument = prepareWorkspaceDocument(html);
  const latestHtml = useRef(html);
  const latestDocument = useRef(initialDocument);
  const visibleFrameRef = useRef(0);
  const loadingFrameRef = useRef<number | null>(null);
  const [frameDocuments, setFrameDocuments] = useState<[string, string]>([initialDocument, ""]);
  const [visibleFrame, setVisibleFrame] = useState(0);
  const [loadingFrame, setLoadingFrame] = useState<number | null>(null);

  useEffect(() => {
    if (html === latestHtml.current) return;
    latestHtml.current = html;
    const nextDocument = prepareWorkspaceDocument(html);
    latestDocument.current = nextDocument;
    const nextFrame = 1 - visibleFrameRef.current;
    loadingFrameRef.current = nextFrame;
    setLoadingFrame(nextFrame);
    setFrameDocuments((current) => {
      const updated: [string, string] = [...current];
      updated[nextFrame] = nextDocument;
      return updated;
    });
  }, [html]);

  function handleFrameLoad(index: number, frame: HTMLIFrameElement) {
    if (loadingFrameRef.current !== index || frame.srcdoc !== latestDocument.current) return;
    const previousFrame = visibleFrameRef.current;
    visibleFrameRef.current = index;
    loadingFrameRef.current = null;
    setVisibleFrame(index);
    setLoadingFrame(null);
    setFrameDocuments((current) => {
      const updated: [string, string] = [...current];
      updated[previousFrame] = "";
      return updated;
    });
  }

  return (
    <div className="code-card visible workspace-preview">
      {frameDocuments.map((document, index) => (
        <iframe
          key={index}
          className={`workspace-preview-frame ${visibleFrame === index ? "active" : ""}`}
          title={title}
          srcDoc={document}
          sandbox="allow-scripts"
          aria-hidden={visibleFrame !== index}
          tabIndex={visibleFrame === index ? 0 : -1}
          onLoad={(event) => handleFrameLoad(index, event.currentTarget)}
        />
      ))}
      {loadingFrame !== null && <span className="workspace-preview-loading" role="status">Updating workspace…</span>}
    </div>
  );
}

function ToolActivityPanel({
  id,
  updates,
  durationMs,
  expanded,
  onToggle,
}: {
  id: string;
  updates: string[];
  durationMs?: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`tool-activity ${expanded ? "expanded" : ""}`}>
      <button
        className="tool-activity-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={`tool-activity-content-${id}`}
        onClick={onToggle}
      >
        <span className="tool-activity-label">Tool activity</span>
        <span className="tool-activity-meta">{durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : "Running…"}</span>
        <span className="tool-activity-chevron" aria-hidden="true">⌄</span>
      </button>
      <div
        className="tool-activity-content"
        id={`tool-activity-content-${id}`}
        aria-hidden={!expanded}
      >
        <div className="tool-activity-content-inner">
          <ul className="tool-activity-list">
            {updates.length
              ? updates.map((update, index) => <li key={`${id}-tool-${index}`}>{update}</li>)
              : <li className="tool-activity-empty">{durationMs !== undefined ? "No tool activity" : "Waiting for tool activity…"}</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}

function App() {
  const appWindow = getCurrentWindow();
  const nextTabId = useRef(2);
  const defaultWorkspaceRef = useRef("");
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, name: "New Agent", threadId: createThreadId(), messages: [], code: "", message: "", suggestedPrompts: [], canvasState: "", currentCanvasState: "" }]);
  const [activeTabId, setActiveTabId] = useState(1);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [transcriptionPhase, setTranscriptionPhase] = useState<"connecting" | "recording" | "finalizing" | null>(null);
  const [transcriptionError, setTranscriptionError] = useState("");
  const [socketRevision, setSocketRevision] = useState(0);
  const [workspaceLoadStatus, setWorkspaceLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [workspaceLoadError, setWorkspaceLoadError] = useState("");
  const [workspaceRetry, setWorkspaceRetry] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [hexMode, setHexMode] = useState<HexMode>(() => {
    if (window.localStorage.getItem("triton-hex-settings-version") !== HEX_SETTINGS_VERSION) return "media";
    const saved = window.localStorage.getItem("triton-hex-mode");
    return saved === "grid" || saved === "synth" || saved === "media" ? saved : "media";
  });
  const [hexMedia, setHexMedia] = useState<File | string>(defaultHexVideo);
  const [hexMediaName, setHexMediaName] = useState(DEFAULT_HEX_VIDEO_NAME);
  const hexUploadRef = useRef<HTMLInputElement>(null);
  const [hexSize, setHexSize] = useState(() => {
    if (window.localStorage.getItem("triton-hex-settings-version") !== HEX_SETTINGS_VERSION) return 10;
    const saved = Number(window.localStorage.getItem("triton-hex-size"));
    return saved >= 2 && saved <= 34 ? saved : 10;
  });
  const [hexIntensity, setHexIntensity] = useState(() => {
    if (window.localStorage.getItem("triton-hex-settings-version") !== HEX_SETTINGS_VERSION) return 30;
    const saved = Number(window.localStorage.getItem("triton-hex-intensity"));
    return saved >= 10 && saved <= 100 ? saved : 30;
  });
  const [hexPalette, setHexPalette] = useState<HexPalette>(() => {
    if (window.localStorage.getItem("triton-hex-settings-version") !== HEX_SETTINGS_VERSION) return "color";
    const saved = window.localStorage.getItem("triton-hex-palette");
    return saved === "binary" || saved === "color" || saved === "mono" ? saved : "color";
  });
  const [mascotEyeWidth, setMascotEyeWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem("triton-mascot-eye-width"));
    return saved >= 12 && saved <= 38 ? saved : 24;
  });
  const [mascotEyeLength, setMascotEyeLength] = useState(() => {
    const saved = Number(window.localStorage.getItem("triton-mascot-eye-length"));
    return saved >= 32 && saved <= 82 ? saved : 64;
  });
  const [centerBlur, setCenterBlur] = useState(() => {
    const saved = window.localStorage.getItem("triton-center-blur");
    const value = saved === null ? 8 : Number(saved);
    return value >= 0 && value <= 16 ? value : 8;
  });
  const [centerDarken, setCenterDarken] = useState(() => {
    const saved = window.localStorage.getItem("triton-center-darken");
    const value = saved === null ? 22 : Number(saved);
    return value >= 0 && value <= 60 ? value : 22;
  });
  const [centerSideSpread, setCenterSideSpread] = useState(() => {
    const saved = window.localStorage.getItem("triton-center-side-spread");
    const value = saved === null ? 120 : Number(saved);
    return value >= 0 && value <= 240 ? value : 120;
  });
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyItems, setHistoryItems] = useState<HistoryConversation[]>([]);
  const [tabsRestored, setTabsRestored] = useState(false);
  const [autoPlayTts, setAutoPlayTts] = useState(() => {
    const savedPreference = window.localStorage.getItem("triton-auto-play-tts");
    return savedPreference === null ? true : savedPreference === "true";
  });
  const autoPlayTtsRef = useRef(autoPlayTts);
  autoPlayTtsRef.current = autoPlayTts;
  const [suggestionPlaceholder, setSuggestionPlaceholder] = useState("");
  const [visibleSuggestion, setVisibleSuggestion] = useState("");
  const [, setSuggestionIndex] = useState(0);
  const [expandedToolActivityKey, setExpandedToolActivityKey] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const waveformLevelsRef = useRef<number[]>([]);
  const waveformOffsetRef = useRef(0);
  const lastWaveformSampleAtRef = useRef(0);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const transcriptionSocketRef = useRef<WebSocket | null>(null);
  const transcriptionStartRef = useRef(false);
  const recordingSessionRef = useRef(0);
  const finalTranscriptRef = useRef("");
  const recordingTabIdRef = useRef<number | null>(null);
  const isRecordingRef = useRef(false);
  const transcriptionCompletedRef = useRef(false);
  const animationRef = useRef<number | null>(null);
  const audioUrlsRef = useRef<string[]>([]);
  const audioCacheRef = useRef<Map<string, string>>(new Map());
  const socketsRef = useRef<Map<number, WebSocket>>(new Map());
  const requestMessagesRef = useRef<Map<string, { tabId: number; userMessageId: number; agentMessageId: number; toolUpdates: string[]; workspaceChanged: boolean; startedAt: number; workspaceSnapshot: string; stopRequested?: boolean }>>(new Map());
  const messagesContainerRef = useRef<HTMLElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollTargetMessageIdRef = useRef<number | null>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const isTyping = Boolean(activeTab.message || isRecording || isTranscribing);
  const updateTab = (id: number, update: Partial<Tab>) => setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...update } : tab));
  const updateActiveTab = (update: Partial<Tab>) => updateTab(activeTab.id, update);

  function resetWaveform() {
    waveformLevelsRef.current = [];
    waveformOffsetRef.current = 0;
    lastWaveformSampleAtRef.current = 0;
    const canvas = waveformRef.current;
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }

  function cancelPendingRecordingStart() {
    recordingSessionRef.current += 1;
    transcriptionStartRef.current = false;
    transcriptionCompletedRef.current = true;
    transcriptionSocketRef.current?.close();
    transcriptionSocketRef.current = null;
    processorRef.current?.disconnect();
    processorRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close();
    }
    audioContextRef.current = null;
    analyserRef.current = null;
    recordingTabIdRef.current = null;
    setIsRecording(false);
    setIsTranscribing(false);
    setTranscriptionPhase(null);
    resetWaveform();
  }

  useLayoutEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) {
      setComposerExpanded(false);
      return;
    }
    const resizeTextarea = () => {
      textarea.style.height = "auto";
      const contentHeight = textarea.scrollHeight;
      const hasWrapped = contentHeight > 52;
      textarea.style.height = `${contentHeight}px`;
      setComposerExpanded(hasWrapped);
    };
    resizeTextarea();
    let lastWidth = textarea.getBoundingClientRect().width;
    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.target.getBoundingClientRect().width ?? lastWidth;
      if (Math.abs(width - lastWidth) < 0.5) return;
      lastWidth = width;
      resizeTextarea();
    });
    resizeObserver.observe(textarea);
    window.addEventListener("resize", resizeTextarea);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", resizeTextarea);
    };
  }, [activeTab.id, activeTab.message]);

  useLayoutEffect(() => {
    const canvas = waveformRef.current;
    if (!canvas || (!isRecording && !isTranscribing)) return;
    drawWaveform(canvas, waveformLevelsRef.current, waveformOffsetRef.current);
  }, [isRecording, isTranscribing]);

  useEffect(() => {
    window.localStorage.setItem("triton-hex-mode", hexMode);
    window.localStorage.setItem("triton-hex-size", String(hexSize));
    window.localStorage.setItem("triton-hex-intensity", String(hexIntensity));
    window.localStorage.setItem("triton-hex-palette", hexPalette);
    window.localStorage.setItem("triton-hex-settings-version", HEX_SETTINGS_VERSION);
  }, [hexIntensity, hexMode, hexPalette, hexSize]);

  useEffect(() => {
    window.localStorage.setItem("triton-mascot-eye-width", String(mascotEyeWidth));
    window.localStorage.setItem("triton-mascot-eye-length", String(mascotEyeLength));
  }, [mascotEyeLength, mascotEyeWidth]);

  useEffect(() => {
    window.localStorage.setItem("triton-center-blur", String(centerBlur));
    window.localStorage.setItem("triton-center-darken", String(centerDarken));
    window.localStorage.setItem("triton-center-side-spread", String(centerSideSpread));
  }, [centerBlur, centerDarken, centerSideSpread]);

  useEffect(() => {
    function acceptDroppedMedia(event: DragEvent) {
      const file = event.dataTransfer?.files.item(0);
      if (!file || (!file.type.startsWith("image/") && !file.type.startsWith("video/"))) return;
      event.preventDefault();
      setHexMedia(file);
      setHexMediaName(file.name);
      setHexMode("media");
    }

    function allowMediaDrop(event: DragEvent) {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
    }

    window.addEventListener("dragover", allowMediaDrop);
    window.addEventListener("drop", acceptDroppedMedia);
    return () => {
      window.removeEventListener("dragover", allowMediaDrop);
      window.removeEventListener("drop", acceptDroppedMedia);
    };
  }, []);

  useEffect(() => {
    const targetMessageId = scrollTargetMessageIdRef.current;
    if (targetMessageId === null || !activeTab.messages.some((message) => message.id === targetMessageId)) return;

    const messagesContainer = messagesContainerRef.current;
    if (messagesContainer) {
      messagesContainer.scrollTo({
        top: messagesContainer.scrollHeight,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    }
    scrollTargetMessageIdRef.current = null;
  }, [activeTab.id, activeTab.messages]);

  useEffect(() => {
    let cancelled = false;
    async function restoreOpenTabs() {
      try {
        const listResponse = await fetch(`${API_BASE}/conversations`);
        if (!listResponse.ok) throw new Error("Could not load conversation history.");
        const conversations = await listResponse.json() as HistoryConversation[];
        if (cancelled) return;
        setHistoryItems(conversations);

        let openThreadIds: string[] = [];
        try {
          openThreadIds = JSON.parse(window.localStorage.getItem("triton-open-tabs") || "[]") as string[];
        } catch {
          openThreadIds = [];
        }
        const restored = (await Promise.all(openThreadIds.map(async (threadId) => {
          const response = await fetch(`${API_BASE}/conversations/${encodeURIComponent(threadId)}`);
          if (!response.ok) return null;
          const record = await response.json() as { thread_id: string; state: Tab; workspace_html: string };
          const state = record.state;
          const messages = (state.messages ?? []).map((message) => ({
            ...message,
            ...(message.pending ? { text: "stopped by the user", pending: false } : {}),
            audioUrl: undefined,
            audioPending: false,
          }));
          return {
            ...state,
            id: 0,
            threadId: record.thread_id,
            messages,
            code: state.code || record.workspace_html || "",
            canvasState: state.canvasState || record.workspace_html || "",
            currentCanvasState: record.workspace_html || state.currentCanvasState || "",
            isSending: false,
            workspacePending: false,
          } as Tab;
        }))).filter((tab): tab is Tab => tab !== null);

        if (cancelled) return;
        if (restored.length) {
          const withIds = restored.map((tab, index) => ({ ...tab, id: index + 1 }));
          setTabs(withIds);
          const savedActive = window.localStorage.getItem("triton-active-tab");
          const active = withIds.find((tab) => tab.threadId === savedActive) ?? withIds[0];
          setActiveTabId(active.id);
          nextTabId.current = withIds.length + 1;
        }
      } catch {
        // Keep the fresh tab usable if the local backend is temporarily unavailable.
      } finally {
        if (!cancelled) setTabsRestored(true);
      }
    }
    void restoreOpenTabs();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!tabsRestored) return;
    window.localStorage.setItem("triton-open-tabs", JSON.stringify(tabs.map((tab) => tab.threadId)));
    const selected = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
    if (selected) window.localStorage.setItem("triton-active-tab", selected.threadId);
  }, [tabs, activeTabId, tabsRestored]);

  useEffect(() => {
    if (!tabsRestored) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const tab of tabs) {
          try {
            await fetch(`${API_BASE}/conversations/${encodeURIComponent(tab.threadId)}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ state: persistedTab(tab) }),
            });
          } catch {
            // A later state change will retry the save.
          }
        }
      })();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [tabs, tabsRestored]);

  useEffect(() => {
    const tabIds = new Set(tabs.map((tab) => tab.id));
    for (const [tabId, socket] of socketsRef.current) {
      if (!tabIds.has(tabId)) {
        socket.close();
        socketsRef.current.delete(tabId);
      }
    }
    for (const tab of tabs) {
      if (socketsRef.current.has(tab.id)) continue;
      const socket = new WebSocket("ws://localhost:8000/ws");
      socketsRef.current.set(tab.id, socket);
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data) as { type: string; request_id: string; name?: string; tool?: string; content?: string; response?: string; workspace_code?: string; suggested_next_prompts?: string[]; message?: string };
        const request = requestMessagesRef.current.get(data.request_id);
        if (data.type === "tab_name" && data.name) {
          const cleanedName = data.name.replace(/^\s*(?:tab\s*name|title)\s*:\s*/i, "").replace(/^[-*#`\s]+|[-*#`\s]+$/g, "").replace(/[.!?]+$/, "").trim().split(/\s+/).slice(0, 4).join(" ");
          if (cleanedName) updateTab(tab.id, { name: cleanedName });
        } else if (data.type === "tool_update" && request && !request.stopRequested) {
          const update = `${data.tool ?? "tool"}: ${data.content ?? "Working"}`;
          request.toolUpdates.push(update);
          setTabs((current) => current.map((item) => item.id === request.tabId ? { ...item, messages: item.messages.map((message) => message.id === request.userMessageId ? { ...message, toolUpdates: [...request.toolUpdates] } : message) } : item));
        } else if (data.type === "workspace_update" && request) {
          if (request.stopRequested) return;
          const workspace = data.workspace_code ?? "";
          request.workspaceChanged = true;
          setTabs((current) => current.map((item) => item.id === request.tabId ? { ...item, workspaceWasEdited: true, canvasState: workspace, currentCanvasState: workspace, code: workspace } : item));
        } else if (data.type === "response" && request && !request.stopRequested) {
          const responseText = data.response ?? "The agent returned no visible response.";
          const workspace = data.workspace_code ?? "";
          const requestDurationMs = Date.now() - request.startedAt;
          setTabs((current) => current.map((item) => item.id === request.tabId ? { ...item, workspacePending: false, workspaceWasEdited: request.workspaceChanged, canvasState: workspace, currentCanvasState: workspace, code: workspace, messages: item.messages.map((message) => message.id === request.userMessageId ? { ...message, requestDurationMs } : message.id === request.agentMessageId ? { ...message, text: responseText, canvasState: workspace, pending: false } : message) } : item));
          void generateSpeech(responseText, request.agentMessageId, request.tabId);
        } else if (data.type === "suggested_prompts" && request && !request.stopRequested) {
          const suggestedPrompts = (data.suggested_next_prompts ?? []).map((prompt) => prompt.trim().split(/\s+/).slice(0, 7).join(" ")).filter(Boolean);
          updateTab(request.tabId, { suggestedPrompts });
        } else if (data.type === "error" && request) {
          if (!request.stopRequested) {
            setTabs((current) => current.map((item) => item.id === request.tabId ? { ...item, workspacePending: false, messages: item.messages.map((message) => message.id === request.agentMessageId && message.pending ? { ...message, text: data.message ?? "Unable to reach the agent.", pending: false } : message) } : item));
          }
        } else if (data.type === "stopped" && request) {
          const workspace = data.workspace_code ?? request.workspaceSnapshot;
          const requestDurationMs = Date.now() - request.startedAt;
          const hasOtherRequest = [...requestMessagesRef.current.entries()].some(([id, activeRequest]) => id !== data.request_id && activeRequest.tabId === request.tabId);
          setTabs((current) => current.map((item) => item.id === request.tabId ? {
            ...item,
            isSending: hasOtherRequest,
            workspacePending: hasOtherRequest,
            workspaceWasEdited: false,
            code: workspace,
            canvasState: workspace,
            currentCanvasState: workspace,
            messages: item.messages.map((message) => message.id === request.userMessageId
              ? { ...message, requestDurationMs, toolUpdates: [] }
              : message.id === request.agentMessageId
                ? { ...message, text: "stopped by the user", pending: false, canvasState: undefined }
                : message),
          } : item));
        }
        if (data.type === "done" || data.type === "error" || data.type === "stopped") {
          if (request && data.type !== "stopped") updateTab(request.tabId, { isSending: false });
          requestMessagesRef.current.delete(data.request_id);
        }
      };
      socket.onclose = () => {
        for (const [requestId, request] of requestMessagesRef.current) {
          if (request.tabId === tab.id) requestMessagesRef.current.delete(requestId);
        }
        socketsRef.current.delete(tab.id);
        if (tabIds.has(tab.id)) window.setTimeout(() => setSocketRevision((revision) => revision + 1), 1000);
      };
    }
  }, [tabs.map((tab) => tab.id).join(","), socketRevision]);

  useEffect(() => () => {
    socketsRef.current.forEach((socket) => socket.close());
    socketsRef.current.clear();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setWorkspaceLoadStatus("loading");
    setWorkspaceLoadError("");
    void fetch("/workspace.html")
      .then((response) => {
        if (!response.ok) throw new Error(`Workspace request failed (${response.status})`);
        return response.text();
      })
      .then((html) => {
        if (cancelled) return;
        defaultWorkspaceRef.current = html;
        setTabs((current) => current.map((tab) => !tab.code ? {
          ...tab,
          code: html,
          canvasState: html,
          currentCanvasState: html,
        } : tab));
        setWorkspaceLoadStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setWorkspaceLoadError(error instanceof Error ? error.message : "Could not load public/workspace.html.");
        setWorkspaceLoadStatus("error");
      });
    return () => { cancelled = true; };
  }, [workspaceRetry]);

  useEffect(() => {
    const prompts = activeTab.suggestedPrompts;
    if (!prompts.length || activeTab.message) {
      setSuggestionPlaceholder("");
      setVisibleSuggestion("");
      return;
    }

    let promptIndex = 0;
    let characterIndex = 0;
    let deleting = false;
    let timer: number;
    const typeNextCharacter = () => {
      const prompt = prompts[promptIndex] ?? "";
      characterIndex += deleting ? -1 : 1;
      const typed = prompt.slice(0, Math.max(0, characterIndex));
      setSuggestionPlaceholder(typed ? `${typed}_` : "");
      setVisibleSuggestion(prompt);
      setSuggestionIndex(promptIndex);

      if (!deleting && characterIndex >= prompt.length) {
        deleting = true;
        timer = window.setTimeout(typeNextCharacter, 2200);
      } else if (deleting && characterIndex <= 0) {
        deleting = false;
        promptIndex = (promptIndex + 1) % prompts.length;
        timer = window.setTimeout(typeNextCharacter, 450);
      } else {
        timer = window.setTimeout(typeNextCharacter, deleting ? 55 : 120);
      }
    };

    timer = window.setTimeout(typeNextCharacter, 650);
    return () => window.clearTimeout(timer);
  }, [activeTab.id, activeTab.suggestedPrompts, activeTab.message]);

  function createTab() {
    const id = nextTabId.current++;
    // If the default workspace request is still in flight, leave this empty;
    // the loader below fills it in when the request completes. Do not copy the
    // loading placeholder into a new tab as if it were actual workspace HTML.
    const initialWorkspace = defaultWorkspaceRef.current;
    setTabs((current) => [...current, { id, name: "New Agent", threadId: createThreadId(), messages: [], code: initialWorkspace, message: "", suggestedPrompts: [], canvasState: initialWorkspace, currentCanvasState: initialWorkspace }]);
    setActiveTabId(id);
  }

  async function refreshHistory() {
    setIsHistoryLoading(true);
    try {
      const response = await fetch(`${API_BASE}/conversations`);
      if (!response.ok) throw new Error("Could not load conversation history.");
      setHistoryItems(await response.json() as HistoryConversation[]);
    } catch {
      setHistoryItems([]);
    } finally {
      setIsHistoryLoading(false);
    }
  }

  async function openConversation(threadId: string) {
    const alreadyOpen = tabs.find((tab) => tab.threadId === threadId);
    if (alreadyOpen) {
      setActiveTabId(alreadyOpen.id);
      setIsHistoryOpen(false);
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/conversations/${encodeURIComponent(threadId)}`);
      if (!response.ok) throw new Error("Could not open this conversation.");
      const record = await response.json() as { thread_id: string; state: Tab; workspace_html: string };
      const state = record.state;
      const messages = (state.messages ?? []).map((message) => ({
        ...message,
        ...(message.pending ? { text: "stopped by the user", pending: false } : {}),
        audioUrl: undefined,
        audioPending: false,
      }));
      const id = nextTabId.current++;
      const tab: Tab = {
        ...state,
        id,
        threadId: record.thread_id,
        messages,
        code: state.code || record.workspace_html || "",
        canvasState: state.canvasState || record.workspace_html || "",
        currentCanvasState: record.workspace_html || state.currentCanvasState || "",
        isSending: false,
        workspacePending: false,
      };
      setTabs((current) => [...current, tab]);
      setActiveTabId(id);
      setIsHistoryOpen(false);
    } catch {
      setWorkspaceLoadError("Could not load this saved conversation.");
    }
  }

  function closeTab(id: number) {
    if (tabs.length === 1) return;
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    setTabs(remaining);
    if (id === activeTabId) setActiveTabId(remaining[Math.max(0, index - 1)].id);
  }

  function renameTab(id: number) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    const name = window.prompt("Rename tab", tab.name)?.trim();
    if (name) updateTab(id, { name });
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        createTab();
        return;
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();

        if (isRecording) {
          stopRecording();
        } else {
          void startRecording();
        }
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [isRecording]);

  useEffect(() => {
    return () => {
      isRecordingRef.current = false;
      processorRef.current?.disconnect();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        void audioContextRef.current.close();
      }
      transcriptionSocketRef.current?.close();
      audioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  async function generateSpeech(text: string, messageId: number, tabId: number) {
    setTabs((current) => current.map((tab) => tab.id === tabId ? {
      ...tab,
      messages: tab.messages.map((item) => item.id === messageId ? { ...item, audioPending: true, audioError: undefined } : item),
    } : tab));
    try {
      let audioUrl = audioCacheRef.current.get(text);
      if (!audioUrl) {
        const response = await fetch(
          `http://localhost:8000/tts?text=${encodeURIComponent(text)}`,
          { method: "POST" },
        );
        if (!response.ok) throw new Error(`TTS request failed (${response.status})`);
        audioUrl = URL.createObjectURL(await response.blob());
        audioCacheRef.current.set(text, audioUrl);
        audioUrlsRef.current.push(audioUrl);
      }
      if (autoPlayTtsRef.current) {
        void new Audio(audioUrl).play().catch(() => undefined);
      }
      setTabs((current) => current.map((tab) => tab.id === tabId ? {
        ...tab,
        messages: tab.messages.map((item) => item.id === messageId ? { ...item, audioUrl, audioPending: false, audioError: undefined } : item),
      } : tab));
    } catch (error) {
      setTabs((current) => current.map((tab) => tab.id === tabId ? {
        ...tab,
        messages: tab.messages.map((item) => item.id === messageId ? {
          ...item,
          audioPending: false,
          audioError: error instanceof Error ? error.message : "Could not generate audio.",
        } : item),
      } : tab));
    }
  }

  function toggleAutoPlayTts() {
    setAutoPlayTts((enabled) => {
      const nextValue = !enabled;
      window.localStorage.setItem("triton-auto-play-tts", String(nextValue));
      return nextValue;
    });
  }

  async function startRecording() {
    if (isRecordingRef.current || transcriptionStartRef.current || isTranscribing) return;

    const recordingSession = ++recordingSessionRef.current;
    resetWaveform();
    setComposerExpanded(false);
    transcriptionStartRef.current = true;
    setTranscriptionError("");
    setTranscriptionPhase("connecting");
    setLiveTranscript("");
    setIsTranscribing(true);
    finalTranscriptRef.current = "";
    transcriptionCompletedRef.current = false;
    recordingTabIdRef.current = activeTab.id;

    let stream: MediaStream | null = null;
    let socket: WebSocket | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (recordingSession !== recordingSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      socket = await new Promise<WebSocket>((resolve, reject) => {
        const candidate = new WebSocket(TRANSCRIPTION_WS_URL);
        candidate.binaryType = "arraybuffer";
        transcriptionSocketRef.current = candidate;
        const timeout = window.setTimeout(() => {
          candidate.close();
          reject(new Error("The transcription server did not respond on port 8001."));
        }, 15000);
        candidate.addEventListener("open", () => {
          window.clearTimeout(timeout);
          resolve(candidate);
        }, { once: true });
        candidate.addEventListener("error", () => {
          window.clearTimeout(timeout);
          candidate.close();
          reject(new Error("Could not connect to the transcription server on port 8001."));
        }, { once: true });
        candidate.addEventListener("close", () => {
          window.clearTimeout(timeout);
          reject(new Error("The transcription server connection closed before it was ready."));
        }, { once: true });
      });
      if (recordingSession !== recordingSessionRef.current) {
        socket.close();
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      transcriptionSocketRef.current = socket;
      socket.send(JSON.stringify({
        sample_rate: TRANSCRIPTION_SAMPLE_RATE,
        format: "pcm_f32le",
      }));

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      const silentOutput = audioContext.createGain();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyser.connect(silentOutput);
      source.connect(processor);
      processor.connect(silentOutput);
      silentOutput.gain.value = 0;
      silentOutput.connect(audioContext.destination);
      if (audioContext.state !== "running") await audioContext.resume();
      if (recordingSession !== recordingSessionRef.current) {
        processor.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        if (audioContext.state !== "closed") void audioContext.close();
        socket.close();
        return;
      }

      streamRef.current = stream;
      analyserRef.current = analyser;

      processor.onaudioprocess = (event) => {
        if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 512_000) return;
        const samples = resampleAudio(
          event.inputBuffer.getChannelData(0),
          audioContext.sampleRate,
          TRANSCRIPTION_SAMPLE_RATE,
        );
        socket.send(samples.buffer);
      };

      socket.addEventListener("message", (event) => {
        if (recordingSession !== recordingSessionRef.current) return;
        let data: { type?: string; text?: string; message?: string };
        try {
          data = JSON.parse(String(event.data)) as { type?: string; text?: string; message?: string };
        } catch {
          return;
        }

        const text = data.text?.trim() ?? "";
        if (data.type === "partial") {
          setLiveTranscript([finalTranscriptRef.current, text].filter(Boolean).join(" "));
        } else if (data.type === "final") {
          if (text) finalTranscriptRef.current = [finalTranscriptRef.current, text].filter(Boolean).join(" ");
          setLiveTranscript(finalTranscriptRef.current);
        } else if (data.type === "done") {
          const transcript = text || finalTranscriptRef.current;
          transcriptionCompletedRef.current = true;
          if (recordingTabIdRef.current !== null) {
            updateTab(recordingTabIdRef.current, { message: transcript });
          }
          recordingTabIdRef.current = null;
          setTranscriptionPhase(null);
          setLiveTranscript("");
          setIsTranscribing(false);
        } else if (data.type === "error") {
          transcriptionCompletedRef.current = true;
          setTranscriptionError(data.message || "The transcription server could not transcribe this audio.");
          setTranscriptionPhase(null);
          setIsTranscribing(false);
        }
      });
      socket.addEventListener("close", () => {
        if (recordingSession !== recordingSessionRef.current) return;
        if (!transcriptionCompletedRef.current) {
          setTranscriptionError("The live transcription connection closed unexpectedly.");
        }
        if (isRecordingRef.current) {
          isRecordingRef.current = false;
          setIsRecording(false);
          processorRef.current?.disconnect();
          processorRef.current = null;
          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          if (audioContextRef.current && audioContextRef.current.state !== "closed") {
            void audioContextRef.current.close();
          }
          audioContextRef.current = null;
          analyserRef.current = null;
          if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
          animationRef.current = null;
        }
        setIsTranscribing(false);
        setTranscriptionPhase(null);
        transcriptionSocketRef.current = null;
      });

      finalTranscriptRef.current = "";
      setLiveTranscript("");
      setIsTranscribing(false);
      transcriptionStartRef.current = false;
      isRecordingRef.current = true;
      setTranscriptionPhase("recording");
      setIsRecording(true);

      const samples = new Uint8Array(analyser.fftSize);
      let smoothedLevel = 0;
      let peakLevel = 0;
      lastWaveformSampleAtRef.current = performance.now();
      const updateWaveform = (now: number) => {
        analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
        const rms = Math.sqrt(energy / samples.length);
        const overallLevel = Math.max(0, Math.min(1, (rms - 0.002) * 35));
        const smoothing = overallLevel > smoothedLevel ? 0.24 : 0.08;
        smoothedLevel += (overallLevel - smoothedLevel) * smoothing;
        peakLevel = Math.max(peakLevel, smoothedLevel);

        const sampleInterval = WAVEFORM_SAMPLE_INTERVAL;
        const elapsed = now - lastWaveformSampleAtRef.current;
        const samplesToAdd = Math.floor(elapsed / sampleInterval);
        if (samplesToAdd > 0) {
          const levels = waveformLevelsRef.current;
          const shifts = Math.min(samplesToAdd, levels.length || 1);
          for (let index = 0; index < shifts; index += 1) {
            if (levels.length) levels.shift();
            levels.push(peakLevel);
          }
          peakLevel = smoothedLevel;
          lastWaveformSampleAtRef.current += samplesToAdd * sampleInterval;
        }
        waveformOffsetRef.current = Math.min(1, Math.max(0, (now - lastWaveformSampleAtRef.current) / sampleInterval)) * WAVEFORM_BAR_PITCH;
        if (waveformRef.current) drawWaveform(waveformRef.current, waveformLevelsRef.current, waveformOffsetRef.current);
        animationRef.current = requestAnimationFrame(updateWaveform);
      };
      animationRef.current = requestAnimationFrame(updateWaveform);
    } catch (error) {
      if (recordingSession !== recordingSessionRef.current) {
        socket?.close();
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      socket?.close();
      stream?.getTracks().forEach((track) => track.stop());
      processorRef.current?.disconnect();
      processorRef.current = null;
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        void audioContextRef.current.close();
      }
      audioContextRef.current = null;
      analyserRef.current = null;
      streamRef.current = null;
      transcriptionSocketRef.current = null;
      setTranscriptionError(error instanceof Error ? error.message : "Could not start live transcription.");
      setTranscriptionPhase(null);
      setLiveTranscript("");
      setIsRecording(false);
      setIsTranscribing(false);
      transcriptionStartRef.current = false;
      isRecordingRef.current = false;
      recordingTabIdRef.current = null;
      resetWaveform();
    }
  }

  function stopRecording() {
    if (!isRecordingRef.current) return;

    isRecordingRef.current = false;
    setIsRecording(false);
    setIsTranscribing(true);
    setTranscriptionPhase("finalizing");
    setLiveTranscript(finalTranscriptRef.current);
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    processorRef.current?.disconnect();
    processorRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close();
    }
    audioContextRef.current = null;
    analyserRef.current = null;

    const socket = transcriptionSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "end" }));
    } else {
      setIsTranscribing(false);
      setTranscriptionPhase(null);
      setTranscriptionError("The live transcription connection is unavailable.");
      socket?.close();
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitMessage(activeTab.message);
  }

  async function submitMessage(message: string) {
    const tabId = activeTab.id;
    const text = message.trim();

    if (!text || activeTab.isSending || workspaceLoadStatus !== "ready") return;

    setComposerExpanded(false);
    const startedAt = Date.now();
    const userMessageId = startedAt;
    const agentMessageId = userMessageId + 1;
    const requestId = crypto.randomUUID();
    const stableThreadId = activeTab.threadId.trim() || createThreadId();
    const workspaceSnapshot = activeTab.currentCanvasState ?? activeTab.canvasState ?? activeTab.code ?? "";
    const conversationHistory = activeTab.messages
      .filter((message) => !message.pending && message.text.trim())
      .map((message) => ({ role: message.role, text: message.text }));
    const nextMessages: Message[] = [...activeTab.messages, {
      id: userMessageId,
      role: "user",
      text,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      toolUpdates: [],
      requestStartedAt: startedAt,
    }, {
      id: agentMessageId,
      role: "agent",
      text: "",
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      toolUpdates: [],
      pending: true,
    }];
    const nextTabState: Tab = {
      ...activeTab,
      threadId: stableThreadId,
      message: "",
      suggestedPrompts: [],
      isSending: true,
      hasAskedFirstPrompt: true,
      workspacePending: true,
      workspaceWasEdited: false,
      messages: nextMessages,
    };
    scrollTargetMessageIdRef.current = userMessageId;
    setExpandedToolActivityKey(`${tabId}:${userMessageId}`);
    updateTab(tabId, nextTabState);

    const socket = socketsRef.current.get(tabId);
    if (!socket) {
      updateTab(tabId, { isSending: false, workspacePending: false });
      return;
    }
    requestMessagesRef.current.set(requestId, { tabId, userMessageId, agentMessageId, toolUpdates: [], workspaceChanged: false, startedAt, workspaceSnapshot });
    const payload = JSON.stringify({
      request_id: requestId,
      query: text,
      thread_id: stableThreadId,
      workspace_code: workspaceSnapshot,
      user_message_id: userMessageId,
      agent_message_id: agentMessageId,
      conversation_state: persistedTab(nextTabState),
      conversation_history: conversationHistory,
    });
    const send = () => {
      const request = requestMessagesRef.current.get(requestId);
      if (!request || request.stopRequested) return;
      if (socket.readyState !== WebSocket.OPEN) {
        requestMessagesRef.current.delete(requestId);
        setTabs((current) => current.map((tab) => tab.id === tabId
          ? {
            ...tab,
            isSending: false,
            workspacePending: false,
            messages: [...tab.messages, {
              id: Date.now(),
              role: "agent",
              text: "WebSocket disconnected. Reopen the tab and try again.",
              timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            }],
          }
          : tab));
        return;
      }
      socket.send(payload);
    };
    if (socket.readyState === WebSocket.OPEN) send();
    else if (socket.readyState === WebSocket.CONNECTING) socket.addEventListener("open", send, { once: true });
    else {
      requestMessagesRef.current.delete(requestId);
      updateTab(tabId, { isSending: false, workspacePending: false });
    }
  }

  function sendVoiceTranscript() {
    const text = (liveTranscript || activeTab.message).trim();
    if (!text || activeTab.isSending || workspaceLoadStatus !== "ready") return;

    recordingTabIdRef.current = null;
    if (isRecordingRef.current) stopRecording();
    else if (transcriptionStartRef.current) cancelPendingRecordingStart();
    void submitMessage(text);
  }

  function stopAgent(tabId: number) {
    const activeRequest = [...requestMessagesRef.current.entries()].find(([, request]) => request.tabId === tabId && !request.stopRequested);
    if (!activeRequest) return;

    const [requestId, request] = activeRequest;
    const socket = socketsRef.current.get(tabId);
    request.stopRequested = true;
    const canCancelServerRequest = socket?.readyState === WebSocket.OPEN;
    if (canCancelServerRequest) {
      socket.send(JSON.stringify({ type: "cancel", request_id: requestId }));
    } else {
      requestMessagesRef.current.delete(requestId);
    }
    const requestDurationMs = Date.now() - request.startedAt;
    setTabs((current) => current.map((tab) => tab.id === tabId ? {
      ...tab,
      isSending: false,
      workspacePending: false,
      workspaceWasEdited: false,
      code: request.workspaceSnapshot,
      canvasState: request.workspaceSnapshot,
      currentCanvasState: request.workspaceSnapshot,
      messages: tab.messages.map((message) => message.id === request.userMessageId
        ? { ...message, requestDurationMs, toolUpdates: [] }
        : message.id === request.agentMessageId
          ? { ...message, text: "stopped by the user", pending: false, canvasState: undefined }
          : message),
    } : tab));
  }

  return (
    <main className={`app-shell ${activeTab.messages.length ? "has-messages" : "empty"}`}>
      {!activeTab.messages.length && <HexBackground mode={hexMode} size={hexSize} intensity={hexIntensity} palette={hexPalette} media={hexMedia} />}
      <header className="title-bar">
        <nav className="tab-bar" aria-label="Agent tabs">
          {tabs.map((tab) => <div
            className={`tab ${tab.id === activeTab.id ? "active" : ""}`}
            key={tab.id}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                closeTab(tab.id);
              }
            }}
          >
            <button className="tab-name" onClick={() => setActiveTabId(tab.id)} onDoubleClick={() => renameTab(tab.id)} title="Double-click to rename" aria-current={tab.id === activeTab.id ? "page" : undefined}>{tab.name}</button>
            <button className="tab-close" onClick={() => closeTab(tab.id)} aria-label={`Close ${tab.name}`}>×</button>
          </div>)}
          <button className="new-tab" onClick={createTab} aria-label="Create new tab">+</button>
        </nav>
        <div
          className="title-bar-drag-region"
          data-tauri-drag-region
          onMouseDown={() => void appWindow.startDragging()}
        />
        <div className="history-menu">
          <button
            className="history-trigger"
            type="button"
            aria-expanded={isHistoryOpen}
            aria-haspopup="dialog"
            onClick={() => {
              const opening = !isHistoryOpen;
              setIsHistoryOpen(opening);
              if (opening) void refreshHistory();
            }}
          >History</button>
          {isHistoryOpen && (
            <div className="history-popover" role="dialog" aria-label="Conversation history">
              <div className="history-heading">
                <strong>History</strong>
                <button type="button" onClick={() => void refreshHistory()} aria-label="Refresh history">↻</button>
              </div>
              {isHistoryLoading ? <div className="history-empty">Loading conversations…</div> : historyItems.filter((item) => item.message_count > 0).length ? (
                <div className="history-list">
                  {historyItems.filter((item) => item.message_count > 0).map((item) => (
                    <button className="history-item" type="button" key={item.thread_id} onClick={() => void openConversation(item.thread_id)}>
                      <strong>{item.name || "Untitled conversation"}</strong>
                      <span>{item.preview}</span>
                      <time>{new Date(item.updated_at).toLocaleString()}</time>
                    </button>
                  ))}
                </div>
              ) : <div className="history-empty">No previous conversations yet.</div>}
            </div>
          )}
        </div>
        <div className="settings-menu">
          <button
            className="settings-trigger"
            type="button"
            aria-label="Settings"
            aria-haspopup="dialog"
            aria-expanded={isSettingsOpen}
            onClick={() => setIsSettingsOpen((open) => !open)}
          >
            ⚙
          </button>
          {isSettingsOpen && (
            <div className="settings-popover" role="dialog" aria-label="Settings and background">
              <div className="hex-settings-section">
                <div className="hex-settings-heading">Hexagon background</div>
                <div className="hex-mode-options" role="radiogroup" aria-label="Background fill">
                  <label className={`hex-mode-choice ${hexMode === "synth" ? "selected" : ""}`}>
                    <input type="radio" name="hex-background-fill" value="synth" checked={hexMode === "synth"} onChange={() => setHexMode("synth")} />
                    <span>Synth</span>
                  </label>
                  <label className={`hex-mode-choice ${hexMode === "grid" ? "selected" : ""}`}>
                    <input type="radio" name="hex-background-fill" value="grid" checked={hexMode === "grid"} onChange={() => setHexMode("grid")} />
                    <span>No video</span>
                  </label>
                  <label className={`hex-mode-choice ${hexMode === "media" ? "selected" : ""}`}>
                    <input
                      type="radio"
                      name="hex-background-fill"
                      value="media"
                      checked={hexMode === "media"}
                      onChange={() => {
                        if (hexMedia) setHexMode("media");
                        else hexUploadRef.current?.click();
                      }}
                    />
                    <span>Custom video</span>
                  </label>
                </div>
                <input
                  ref={hexUploadRef}
                  className="hex-upload-input"
                  type="file"
                  accept="image/*,video/*"
                  aria-label="Choose image or video for the hexagon background"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (!file) return;
                    setHexMedia(file);
                    setHexMediaName(file.name);
                    setHexMode("media");
                    event.currentTarget.value = "";
                  }}
                />
                <button className="hex-upload-button" type="button" onClick={() => hexUploadRef.current?.click()}>
                  {hexMediaName || "Upload image or video"}
                </button>
                <label className="hex-range-row">
                  <span><span>Hexagon size</span><output>{hexSize}px</output></span>
                  <input type="range" min="2" max="34" value={hexSize} onChange={(event) => setHexSize(Number(event.target.value))} />
                </label>
                <label className="hex-range-row">
                  <span><span>Contrast</span><output>{hexIntensity}%</output></span>
                  <input type="range" min="10" max="100" step="5" value={hexIntensity} onChange={(event) => setHexIntensity(Number(event.target.value))} />
                </label>
                <div className="hex-palette-row">
                  <span>Palette</span>
                  <div role="group" aria-label="Hexagon palette">
                    {(["mono", "binary", "color"] as const).map((palette) => (
                      <button
                        className={hexPalette === palette ? "selected" : ""}
                        type="button"
                        key={palette}
                        aria-pressed={hexPalette === palette}
                        onClick={() => setHexPalette(palette)}
                      >{palette === "mono" ? "Mono" : palette === "binary" ? "Binary" : "Color"}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="hex-settings-section mascot-settings-section">
                <div className="hex-settings-heading">Mascot</div>
                <label className="hex-range-row">
                  <span><span>Eye width</span><output>{mascotEyeWidth}px</output></span>
                  <input type="range" min="12" max="38" value={mascotEyeWidth} onChange={(event) => setMascotEyeWidth(Number(event.target.value))} />
                </label>
                <label className="hex-range-row">
                  <span><span>Eye length</span><output>{mascotEyeLength}px</output></span>
                  <input type="range" min="32" max="82" value={mascotEyeLength} onChange={(event) => setMascotEyeLength(Number(event.target.value))} />
                </label>
              </div>
              <div className="hex-settings-section center-backdrop-settings-section">
                <div className="hex-settings-heading">Center backdrop</div>
                <label className="hex-range-row">
                  <span><span>Blur</span><output>{centerBlur}px</output></span>
                  <input type="range" min="0" max="16" value={centerBlur} onChange={(event) => setCenterBlur(Number(event.target.value))} />
                </label>
                <label className="hex-range-row">
                  <span><span>Darken</span><output>{centerDarken}%</output></span>
                  <input type="range" min="0" max="60" value={centerDarken} onChange={(event) => setCenterDarken(Number(event.target.value))} />
                </label>
                <label className="hex-range-row">
                  <span><span>Side spread</span><output>{centerSideSpread}px</output></span>
                  <input type="range" min="0" max="240" step="4" value={centerSideSpread} onChange={(event) => setCenterSideSpread(Number(event.target.value))} />
                </label>
              </div>
              <label className="settings-row">
                <span>Thread ID</span>
                <input
                  aria-label="Thread ID"
                  value={activeTab.threadId}
                  onChange={(event) => updateActiveTab({ threadId: event.target.value })}
                />
              </label>
              <label className="settings-row">
                <span>Auto-play TTS</span>
                <button
                  className={`toggle ${autoPlayTts ? "enabled" : ""}`}
                  type="button"
                  role="switch"
                  aria-checked={autoPlayTts}
                  onClick={toggleAutoPlayTts}
                >
                  <span className="toggle-thumb" />
                </button>
              </label>
            </div>
          )}
        </div>
        <div className="window-controls" aria-label="Window controls">
          <button type="button" onClick={() => void appWindow.minimize()} aria-label="Minimize">−</button>
          <button type="button" onClick={() => void appWindow.toggleMaximize()} aria-label="Maximize">□</button>
          <button type="button" className="close-window" onClick={() => void appWindow.close()} aria-label="Close">×</button>
        </div>
      </header>
      <section className="card-workspace" aria-label="Agent workspace">
        {activeTab.code ? <WorkspacePreview key={activeTab.id} title={`${activeTab.name} workspace`} html={activeTab.code} /> : workspaceLoadStatus === "loading" || activeTab.workspacePending ? (
          <div className="workspace-placeholder" role="status">
            <span className="workspace-spinner" aria-hidden="true" />
            <span>{activeTab.workspacePending ? "Preparing your workspace…" : "Loading workspace…"}</span>
          </div>
        ) : (
          <div className="workspace-placeholder" role="alert">
            <div className="workspace-load-error">
              <strong>Workspace unavailable</strong>
              <span>{workspaceLoadError || "Could not load public/workspace.html."}</span>
              <button type="button" onClick={() => setWorkspaceRetry((attempt) => attempt + 1)}>Retry</button>
            </div>
          </div>
        )}
      </section>

      <section key={activeTab.id} className="chat-panel tab-content-enter">
      <div
        className={`welcome-stage ${isTyping ? "is-typing" : ""} ${isRecording || isTranscribing ? "is-listening" : ""}`}
        style={{
          "--center-blur": `${centerBlur}px`,
          "--center-darken-peak": String(centerDarken / 100),
          "--center-darken-mid": String(centerDarken * 0.0065),
          "--center-darken-edge": String(centerDarken * 0.003),
          "--typing-blur": `${Math.max(0, Math.min(16, 28 - centerBlur))}px`,
          "--typing-darken-peak": String(Math.max(0, Math.min(75, 100 - centerDarken)) / 100),
          "--typing-darken-mid": String(Math.max(0, Math.min(75, 100 - centerDarken)) * 0.0065),
          "--typing-darken-edge": String(Math.max(0, Math.min(75, 100 - centerDarken)) * 0.003),
          "--typing-expand": "50px",
          "--center-side-inset": `${-centerSideSpread}px`,
        } as CSSProperties}
      >
      <h1 className="welcome">
        <TritonMascot isListening={isRecording} isThinking={activeTab.isSending || isTranscribing} isTyping={isTyping} isActive={!activeTab.messages.length} eyeWidth={mascotEyeWidth} eyeLength={mascotEyeLength} />
        <span className="welcome-copy">
          <span className="welcome-title">triton.</span>
          <span className="welcome-subtitle">Dare Mighty Things</span>
        </span>
      </h1>

      <form className={`composer ${isRecording || isTranscribing ? "voice-mode" : ""} ${composerExpanded ? "is-multiline" : ""}`} onSubmit={sendMessage}>
        {isRecording || isTranscribing ? (
          <>
            <div
              className={`live-transcript-input ${liveTranscript ? "" : "is-placeholder"}`}
              role="textbox"
              aria-label="Live transcript"
              aria-readonly="true"
              aria-live="polite"
            >
              {liveTranscript || (transcriptionPhase === "connecting"
                ? "Connecting to microphone…"
                : transcriptionPhase === "finalizing"
                  ? "Finalizing transcript…"
                  : "Listening…")}
            </div>
            <div className="voice-controls">
              <canvas ref={waveformRef} className="waveform" role="img" aria-label="Recent microphone level history" />
              <button
                className="mic-button"
                type="button"
                aria-label={isRecording ? "Stop live transcription" : "Live transcription"}
                title={isRecording ? "Stop live transcription" : "Live transcription"}
                disabled={!isRecording}
                onClick={stopRecording}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="3" width="6" height="12" rx="3" />
                  <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" />
                </svg>
              </button>
              <button
                className="send-button"
                type="button"
                aria-label="Send transcript"
                title="Send transcript"
                disabled={activeTab.isSending || workspaceLoadStatus !== "ready"}
                onClick={sendVoiceTranscript}
              >
                <img className="send-button-image" src={sendButtonImage} alt="" aria-hidden="true" />
              </button>
              {activeTab.isSending && <button className="stop-button" type="button" onClick={() => stopAgent(activeTab.id)} aria-label="Stop agent">Stop</button>}
            </div>
          </>
        ) : (
          <textarea
            ref={composerTextareaRef}
            className="message-input"
            aria-label="Message"
            rows={1}
            value={activeTab.message}
            onChange={(event) => updateActiveTab({ message: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Tab" && visibleSuggestion && !activeTab.message) {
                event.preventDefault();
                updateActiveTab({ message: visibleSuggestion });
                setSuggestionPlaceholder("");
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={suggestionPlaceholder || "Message the agent..."}
          />
        )}
        {!isRecording && !isTranscribing && (
          <button
            className="mic-button"
            type="button"
            aria-label="Start live transcription"
            title="Start live transcription (Ctrl+Shift+D)"
            disabled={activeTab.isSending}
            onClick={() => void startRecording()}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" />
            </svg>
          </button>
        )}
        {!isRecording && !isTranscribing && (activeTab.isSending
          ? <button className="stop-button" type="button" onClick={() => stopAgent(activeTab.id)} aria-label="Stop agent">Stop</button>
          : <button className="send-button" type="submit" aria-label="Send message" title="Send message" disabled={workspaceLoadStatus !== "ready"}>
            <img className="send-button-image" src={sendButtonImage} alt="" aria-hidden="true" />
          </button>)}
      </form>
      </div>
      {transcriptionError && <div className="transcription-error" role="alert">{transcriptionError}</div>}
      {!activeTab.messages.length && <div className="audio-shortcut-hint">Ctrl+Shift+D for audio mode</div>}

      <section ref={messagesContainerRef} className="messages" aria-live="polite">
        {activeTab.messages.map((item) => item.role === "user" ? (
          <div className="user-message-group" key={item.id}>
            <div className="message user">
              <Markdown>{item.text}</Markdown>
              <time dateTime={item.timestamp}>{item.timestamp}</time>
            </div>
            {(item.requestStartedAt !== undefined || !!item.toolUpdates?.length) && (
              <ToolActivityPanel
                id={`${activeTab.id}-${item.id}`}
                updates={item.toolUpdates ?? []}
                durationMs={item.requestDurationMs}
                expanded={expandedToolActivityKey === `${activeTab.id}:${item.id}`}
                onToggle={() => {
                  const activityKey = `${activeTab.id}:${item.id}`;
                  setExpandedToolActivityKey(expandedToolActivityKey === activityKey ? null : activityKey);
                }}
              />
            )}
          </div>
        ) : (
          <div className="message agent" key={item.id}>
            {item.pending && !item.text ? <div className="typing-indicator" aria-label="Agent is responding"><span /><span /><span /></div> : <Markdown>{item.text}</Markdown>}
            {item.canvasState && (
              <button
                className={`canvas-state-button ${activeTab.code === item.canvasState ? "selected" : ""}`}
                type="button"
                onClick={() => updateActiveTab({ code: item.canvasState })}
                aria-pressed={activeTab.code === item.canvasState}
              >
                {activeTab.code === item.canvasState ? "Showing this canvas" : "View this canvas"}
              </button>
            )}
            {!item.pending && item.text && (
              <div className="audio-controls">
                <button
                  className="listen-button"
                  type="button"
                  disabled={item.audioPending}
                  onClick={() => item.audioUrl ? void new Audio(item.audioUrl).play() : void generateSpeech(item.text, item.id, activeTab.id)}
                >
                  {item.audioPending ? "Preparing audio…" : item.audioUrl ? "Listen" : item.audioError ? "Retry audio" : "Listen"}
                </button>
                {item.audioError && <span className="audio-error" role="status">Audio unavailable. Check the TTS service and retry.</span>}
              </div>
            )}
            <time dateTime={item.timestamp}>{item.timestamp}</time>
          </div>
        ))}
      </section>
      </section>

    </main>
  );
}

export default App;
