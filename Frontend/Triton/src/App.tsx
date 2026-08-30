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

function App() {
  const [message, setMessage] = useState("");
  const [threadId, setThreadId] = useState("Vinayak");
  const [messages, setMessages] = useState<Message[]>([]);
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

  async function generateSpeech(text: string, messageId: number) {
    try {
      const response = await fetch(
        `http://localhost:8000/tts?text=${encodeURIComponent(text)}`,
        { method: "POST" },
      );
      const audioUrl = URL.createObjectURL(await response.blob());
      audioUrlsRef.current.push(audioUrl);
      setMessages((current) =>
        current.map((item) =>
          item.id === messageId ? { ...item, audioUrl } : item,
        ),
      );
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
          .then((data: { text: string }) => setMessage(data.text))
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
    const text = message.trim();

    if (!text) return;

    setMessages((current) => [
      ...current,
      {
        id: Date.now(),
        role: "user",
        text,
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      },
    ]);
    setMessage("");

    try {
      const response = await fetch(
        `http://localhost:8000/ask?query=${encodeURIComponent(text)}&Thread_id=${encodeURIComponent(threadId.trim() || "Vinayak")}`,
        { method: "POST" },
      );
      const data: { response: string } = await response.json();
      const agentMessageId = Date.now();

      setMessages((current) => [
        ...current,
        {
          id: agentMessageId,
          role: "agent",
          text: data.response,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
      ]);
      void generateSpeech(data.response, agentMessageId);
    } catch {
      setMessages((current) => [
        ...current,
        {
          id: Date.now(),
          role: "agent",
          text: "Unable to reach the agent.",
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
      ]);
    }
  }

  return (
    <main className={`chat ${messages.length ? "has-messages" : "empty"}`}>
      <label className="thread-control">
        <span>Thread ID</span>
        <input
          aria-label="Thread ID"
          value={threadId}
          onChange={(event) => setThreadId(event.target.value)}
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
            value={message}
            onChange={(event) => setMessage(event.target.value)}
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
        {messages.map((item) => (
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
    </main>
  );
}

export default App;
