import { FormEvent, useState } from "react";
import Markdown from "react-markdown";
import "./App.css";

type Message = {
  id: number;
  role: "agent" | "user";
  text: string;
  timestamp: string;
};

function App() {
  const [message, setMessage] = useState("");
  const [threadId, setThreadId] = useState("Vinayak");
  const [messages, setMessages] = useState<Message[]>([]);

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

      setMessages((current) => [
        ...current,
        {
          id: Date.now(),
          role: "agent",
          text: data.response,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
      ]);
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
        <input
          aria-label="Message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Message the agent..."
        />
        <button type="submit">Send</button>
      </form>

      <section className="messages" aria-live="polite">
        {messages.map((item) => (
          <div className={`message ${item.role}`} key={item.id}>
            <Markdown>{item.text}</Markdown>
            <time dateTime={item.timestamp}>{item.timestamp}</time>
          </div>
        ))}
      </section>
    </main>
  );
}

export default App;
