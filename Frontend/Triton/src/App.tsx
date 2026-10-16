import { FormEvent, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  const [transcriptionError, setTranscriptionError] = useState("");
  const [socketRevision, setSocketRevision] = useState(0);
  const [workspaceLoadStatus, setWorkspaceLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [workspaceLoadError, setWorkspaceLoadError] = useState("");
  const [workspaceRetry, setWorkspaceRetry] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
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
  const [waveform, setWaveform] = useState<number[]>(Array(28).fill(8));
  const [suggestionPlaceholder, setSuggestionPlaceholder] = useState("");
  const [visibleSuggestion, setVisibleSuggestion] = useState("");
  const [, setSuggestionIndex] = useState(0);
  const [expandedToolActivityKey, setExpandedToolActivityKey] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const transcriptionSocketRef = useRef<WebSocket | null>(null);
  const transcriptionStartRef = useRef(false);
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
  const scrollTargetMessageIdRef = useRef<number | null>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const updateTab = (id: number, update: Partial<Tab>) => setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...update } : tab));
  const updateActiveTab = (update: Partial<Tab>) => updateTab(activeTab.id, update);

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

    transcriptionStartRef.current = true;
    setTranscriptionError("");
    setLiveTranscript("Connecting to live transcription…");
    setIsTranscribing(true);
    finalTranscriptRef.current = "";
    transcriptionCompletedRef.current = false;
    recordingTabIdRef.current = activeTab.id;

    let stream: MediaStream | null = null;
    let socket: WebSocket | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      socket = await new Promise<WebSocket>((resolve, reject) => {
        const candidate = new WebSocket(TRANSCRIPTION_WS_URL);
        candidate.binaryType = "arraybuffer";
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
      });

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
      analyser.fftSize = 64;
      source.connect(analyser);
      source.connect(processor);
      processor.connect(silentOutput);
      silentOutput.gain.value = 0;
      silentOutput.connect(audioContext.destination);

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
          setLiveTranscript("");
          setIsTranscribing(false);
        } else if (data.type === "error") {
          transcriptionCompletedRef.current = true;
          setTranscriptionError(data.message || "The transcription server could not transcribe this audio.");
          setIsTranscribing(false);
        }
      });
      socket.addEventListener("close", () => {
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
          setWaveform(Array(28).fill(8));
        }
        setIsTranscribing(false);
        transcriptionSocketRef.current = null;
      });

      finalTranscriptRef.current = "";
      setLiveTranscript("Listening…");
      setIsTranscribing(false);
      transcriptionStartRef.current = false;
      isRecordingRef.current = true;
      setIsRecording(true);

      const levels = new Uint8Array(analyser.frequencyBinCount);
      const updateWaveform = () => {
        analyser.getByteFrequencyData(levels);
        setWaveform(
          Array.from({ length: 28 }, (_, index) =>
            Math.max(8, (levels[index % levels.length] / 255) * 100),
          ),
        );
        animationRef.current = requestAnimationFrame(updateWaveform);
      };
      updateWaveform();
    } catch (error) {
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
      setLiveTranscript("");
      setIsRecording(false);
      setIsTranscribing(false);
      transcriptionStartRef.current = false;
      isRecordingRef.current = false;
      recordingTabIdRef.current = null;
    }
  }

  function stopRecording() {
    if (!isRecordingRef.current) return;

    isRecordingRef.current = false;
    setIsRecording(false);
    setIsTranscribing(true);
    setLiveTranscript(finalTranscriptRef.current || "Finalizing transcript…");
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    setWaveform(Array(28).fill(8));
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
      setTranscriptionError("The live transcription connection is unavailable.");
      socket?.close();
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tabId = activeTab.id;
    const text = activeTab.message.trim();

    if (!text || activeTab.isSending || workspaceLoadStatus !== "ready") return;

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
            <div className="settings-popover" role="dialog" aria-label="Settings">
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
      <h1 className="welcome">Triton</h1>

      <form className="composer" onSubmit={sendMessage}>
        {isRecording ? (
          <>
            <div className="recording-status">
              <div className="waveform" aria-label="Recording audio">
                {waveform.map((height, index) => (
                  <span key={index} style={{ height: `${height}%` }} />
                ))}
              </div>
              <span className="live-transcript" aria-live="polite">{liveTranscript || "Listening…"}</span>
            </div>
            <button className="stop-recording-button" type="button" onClick={stopRecording}>Done</button>
          </>
        ) : isTranscribing ? (
          <div className="transcribing" aria-label="Transcribing audio">
            <span className="spinner" />
            <span className="live-transcript" aria-live="polite">{liveTranscript || "Finalizing transcript…"}</span>
          </div>
        ) : (
          <input
            aria-label="Message"
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
        {activeTab.isSending
          ? <button className="stop-button" type="button" onClick={() => stopAgent(activeTab.id)} aria-label="Stop agent">Stop</button>
          : <button type="submit" disabled={isRecording || isTranscribing || workspaceLoadStatus !== "ready"}>Send</button>}
      </form>
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
