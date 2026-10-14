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
  workspacePending?: boolean;
  workspaceWasEdited?: boolean;
};

function createThreadId() {
  return `Vinayak_${Math.floor(1000 + Math.random() * 9000)}`;
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

function App() {
  const appWindow = getCurrentWindow();
  const nextTabId = useRef(2);
  const defaultWorkspaceRef = useRef("");
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, name: "New Agent", threadId: createThreadId(), messages: [], code: "", message: "", suggestedPrompts: [], canvasState: "", currentCanvasState: "" }]);
  const [activeTabId, setActiveTabId] = useState(1);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [socketRevision, setSocketRevision] = useState(0);
  const [workspaceLoadStatus, setWorkspaceLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [workspaceLoadError, setWorkspaceLoadError] = useState("");
  const [workspaceRetry, setWorkspaceRetry] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
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
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const audioUrlsRef = useRef<string[]>([]);
  const audioCacheRef = useRef<Map<string, string>>(new Map());
  const socketsRef = useRef<Map<number, WebSocket>>(new Map());
  const requestMessagesRef = useRef<Map<string, { tabId: number; userMessageId: number; agentMessageId: number; toolUpdates: string[]; workspaceChanged: boolean; startedAt: number }>>(new Map());
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const updateTab = (id: number, update: Partial<Tab>) => setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...update } : tab));
  const updateActiveTab = (update: Partial<Tab>) => updateTab(activeTab.id, update);

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
        } else if (data.type === "tool_update" && request) {
          const update = `${data.tool ?? "tool"}: ${data.content ?? "Working"}`;
          request.toolUpdates.push(update);
          setTabs((current) => current.map((item) => item.id === request.tabId ? { ...item, messages: item.messages.map((message) => message.id === request.userMessageId ? { ...message, toolUpdates: [...request.toolUpdates] } : message) } : item));
        } else if (data.type === "workspace_update" && request) {
          const workspace = data.workspace_code ?? "";
          request.workspaceChanged = true;
          setTabs((current) => current.map((item) => item.id === request.tabId ? { ...item, workspaceWasEdited: true, canvasState: workspace, currentCanvasState: workspace, code: workspace } : item));
        } else if (data.type === "response" && request) {
          const responseText = data.response ?? "The agent returned no visible response.";
          const workspace = data.workspace_code ?? "";
          const requestDurationMs = Date.now() - request.startedAt;
          setTabs((current) => current.map((item) => item.id === request.tabId ? { ...item, workspacePending: false, workspaceWasEdited: request.workspaceChanged, canvasState: workspace, currentCanvasState: workspace, code: workspace, messages: item.messages.map((message) => message.id === request.userMessageId ? { ...message, requestDurationMs } : message.id === request.agentMessageId ? { ...message, text: responseText, canvasState: workspace, pending: false } : message) } : item));
          void generateSpeech(responseText, request.agentMessageId, request.tabId);
        } else if (data.type === "suggested_prompts" && request) {
          const suggestedPrompts = (data.suggested_next_prompts ?? []).map((prompt) => prompt.trim().split(/\s+/).slice(0, 7).join(" ")).filter(Boolean);
          updateTab(request.tabId, { suggestedPrompts });
        } else if (data.type === "error" && request) {
          setTabs((current) => current.map((item) => item.id === request.tabId ? { ...item, workspacePending: false, messages: item.messages.map((message) => message.id === request.agentMessageId ? { ...message, text: data.message ?? "Unable to reach the agent.", pending: false } : message) } : item));
        }
        if (data.type === "done" || data.type === "error") {
          requestMessagesRef.current.delete(data.request_id);
          setIsSending(false);
        }
      };
      socket.onclose = () => {
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
          recorderRef.current?.stop();
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
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      analyser.fftSize = 64;
      source.connect(analyser);

      audioChunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        setIsRecording(false);
        setIsTranscribing(true);
        if (animationRef.current) cancelAnimationFrame(animationRef.current);
        void audioContext.close();
        audioContextRef.current = null;
        analyserRef.current = null;
        setWaveform(Array(28).fill(8));
        const audio = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        const formData = new FormData();
        formData.append("file", audio, "recording.webm");

        void fetch("http://localhost:8000/transcribe", {
          method: "POST",
          body: formData,
        })
          .then((response) => response.json())
          .then((data: { text: string }) => updateActiveTab({ message: data.text }))
          .catch(() => undefined)
          .finally(() => setIsTranscribing(false));

        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
      };

      recorder.start();
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
    } catch {
      setIsRecording(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tabId = activeTab.id;
    const text = activeTab.message.trim();

    if (!text || workspaceLoadStatus !== "ready") return;

    setIsSending(true);
    const userMessageId = Date.now();
    const agentMessageId = userMessageId + 1;
    updateTab(tabId, {
      message: "",
      suggestedPrompts: [],
      hasAskedFirstPrompt: true,
      workspacePending: true,
      workspaceWasEdited: false,
      messages: [...activeTab.messages, {
        id: userMessageId,
        role: "user",
        text,
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        toolUpdates: [],
        requestStartedAt: Date.now(),
      }, {
        id: agentMessageId,
        role: "agent",
        text: "",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        toolUpdates: [],
        pending: true,
      }],
    });

    const socket = socketsRef.current.get(tabId);
    if (!socket) {
      setIsSending(false);
      return;
    }
    const requestId = `${tabId}-${userMessageId}`;
    requestMessagesRef.current.set(requestId, { tabId, userMessageId, agentMessageId, toolUpdates: [], workspaceChanged: false, startedAt: Date.now() });
    const payload = JSON.stringify({
      request_id: requestId,
      query: text,
      thread_id: activeTab.threadId.trim() || "Vinayak",
      workspace_code: activeTab.currentCanvasState ?? activeTab.canvasState ?? activeTab.code ?? "",
    });
    const send = () => {
      if (socket.readyState !== WebSocket.OPEN) {
        requestMessagesRef.current.delete(requestId);
        setIsSending(false);
        setTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, messages: [...tab.messages, { id: Date.now(), role: "agent", text: "WebSocket disconnected. Reopen the tab and try again.", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }] } : tab));
        return;
      }
      socket.send(payload);
    };
    if (socket.readyState === WebSocket.OPEN) send();
    else if (socket.readyState === WebSocket.CONNECTING) socket.addEventListener("open", send, { once: true });
    else {
      requestMessagesRef.current.delete(requestId);
      setIsSending(false);
    }
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
          <div className="waveform" aria-label="Recording audio">
            {waveform.map((height, index) => (
              <span key={index} style={{ height: `${height}%` }} />
            ))}
          </div>
        ) : isTranscribing ? (
          <div className="transcribing" aria-label="Transcribing audio">
            <span className="spinner" />
            <span>Transcribing...</span>
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
        <button type="submit" disabled={isTranscribing || isSending || workspaceLoadStatus !== "ready"}>{isSending ? "Thinking…" : "Send"}</button>
      </form>
      {!activeTab.messages.length && <div className="audio-shortcut-hint">Ctrl+Shift+D for audio mode</div>}

      <section className="messages" aria-live="polite">
        {activeTab.messages.map((item) => item.role === "user" ? (
          <div className="user-message-group" key={item.id}>
            <div className="message user">
              <Markdown>{item.text}</Markdown>
              <time dateTime={item.timestamp}>{item.timestamp}</time>
            </div>
            {!!item.toolUpdates?.length && (
              <details className="tool-activity" open>
                <summary>Tool activity <span>{item.requestDurationMs !== undefined ? `${(item.requestDurationMs / 1000).toFixed(1)}s` : "Running…"}</span></summary>
                <ul>{item.toolUpdates.map((update, index) => <li key={`${item.id}-tool-${index}`}>{update}</li>)}</ul>
              </details>
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
