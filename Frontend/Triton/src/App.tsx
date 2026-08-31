import { FormEvent, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import "./App.css";

type Message = {
  id: number;
  role: "agent" | "user";
  text: string;
  timestamp: string;
  audioUrl?: string;
};

type AgentResponse = {
  response: string;
  code: string;
};

type Tab = {
  id: number;
  name: string;
  threadId: string;
  messages: Message[];
  code: string;
  message: string;
};

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

function App() {
  const nextTabId = useRef(2);
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, name: "Triton Development", threadId: "Vinayak", messages: [], code: "", message: "" }]);
  const [activeTabId, setActiveTabId] = useState(1);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [waveform, setWaveform] = useState<number[]>(Array(28).fill(8));
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const audioUrlsRef = useRef<string[]>([]);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const updateTab = (id: number, update: Partial<Tab>) => setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...update } : tab));
  const updateActiveTab = (update: Partial<Tab>) => updateTab(activeTab.id, update);

  function createTab() {
    const id = nextTabId.current++;
    setTabs((current) => [...current, { id, name: "New Agent", threadId: "Vinayak", messages: [], code: "", message: "" }]);
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
    try {
      const response = await fetch(
        `http://localhost:8000/tts?text=${encodeURIComponent(text)}`,
        { method: "POST" },
      );
      const audioUrl = URL.createObjectURL(await response.blob());
      audioUrlsRef.current.push(audioUrl);
      setTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, messages: tab.messages.map((item) => item.id === messageId ? { ...item, audioUrl } : item) } : tab));
    } catch {
      // Keep the text response available if speech generation fails.
    }
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

    if (!text) return;

    updateTab(tabId, { message: "", messages: [...activeTab.messages, {
        id: Date.now(),
        role: "user",
        text,
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      }] });

    try {
      const response = await fetch(
        `http://localhost:8000/ask?query=${encodeURIComponent(text)}&Thread_id=${encodeURIComponent(activeTab.threadId.trim() || "Vinayak")}`,
        { method: "POST" },
      );
      const data: AgentResponse = await response.json();
      const responseText = data.response || "";
      const agentMessageId = Date.now();

      setTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, messages: [...tab.messages, {
          id: agentMessageId,
          role: "agent",
          text: responseText,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        }] , code: data.code || "" } : tab));
      void generateSpeech(responseText, agentMessageId, tabId);
    } catch {
      setTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, messages: [...tab.messages, {
          id: Date.now(),
          role: "agent",
          text: "Unable to reach the agent.",
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        }] } : tab));
    }
  }

  return (
    <main className={`app-shell ${activeTab.messages.length ? "has-messages" : "empty"}`}>
      <nav className="tab-bar" aria-label="Agent tabs">
        {tabs.map((tab) => <div className={`tab ${tab.id === activeTab.id ? "active" : ""}`} key={tab.id}>
          <button className="tab-name" onClick={() => setActiveTabId(tab.id)} onDoubleClick={() => renameTab(tab.id)} title="Double-click to rename">{tab.name}</button>
          <button className="tab-close" onClick={() => closeTab(tab.id)} aria-label={`Close ${tab.name}`}>×</button>
        </div>)}
        <button className="new-tab" onClick={createTab} aria-label="Create new tab">+</button>
      </nav>
      <section className="card-workspace" aria-label="Agent workspace">
        {tabs.map((tab) => tab.code ? <div className={`code-card ${tab.id === activeTab.id ? "visible" : "hidden"}`} key={tab.id}><iframe title={`${tab.name} workspace`} srcDoc={prepareWorkspaceDocument(tab.code)} sandbox="allow-scripts" /></div> : null)}
        {!activeTab.code && <div className="workspace-placeholder">Your generated workspace will appear here.</div>}
      </section>

      <section className="chat-panel">
      <label className="thread-control">
        <span>Thread ID</span>
        <input
          aria-label="Thread ID"
          value={activeTab.threadId}
          onChange={(event) => updateActiveTab({ threadId: event.target.value })}
        />
      </label>

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
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Message the agent..."
          />
        )}
        <button type="submit" disabled={isTranscribing}>Send</button>
      </form>

      <section className="messages" aria-live="polite">
        {activeTab.messages.map((item) => (
          <div className={`message ${item.role}`} key={item.id}>
            <Markdown>{item.text}</Markdown>
            {item.audioUrl && (
              <button
                className="listen-button"
                type="button"
                onClick={() => void new Audio(item.audioUrl).play()}
              >
                Listen
              </button>
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
