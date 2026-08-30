import { FormEvent, useState } from "react";
import "./App.css";

type Message = {
  id: number;
  role: "agent" | "user";
  text: string;
  timestamp: string;
};

function App() {
  const [message, setMessage] = useState("");
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
        `http://localhost:8000/ask?query=${encodeURIComponent(text)}`,
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
    <main className="chat">
      <section className="messages" aria-live="polite">
        {messages.map((item) => (
          <p className={`message ${item.role}`} key={item.id}>
            <span>{item.text}</span>
            <time dateTime={item.timestamp}>{item.timestamp}</time>
          </p>
        ))}
      </section>

      <form className="composer" onSubmit={sendMessage}>
        <input
          aria-label="Message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Message the agent..."
        />
        <button type="submit">Send</button>
      </form>
    </main>
  );
}

export default App;
