"use client"
import { useState} from "react";

export default function Home(){
  const [notes, setNotes] = useState("");
  const [transcript, setTranscript] = useState("");
  const [result, setResult] = useState<any>(null);
  const [listening, setListening] = useState(false);

  // for listenign stuff
  const startListening = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Speech recognition not supported in this browser");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";

    recognition.onstart = () => setListening(true);

    recognition.onresult = (event: any) => {
      const text = event.results[0][0].transcript;
      setTranscript(text);
    };

    recognition.onend = () => setListening(false);

    recognition.start();
  };

  const testAPI = async() => {
    if (!notes.trim()) {
      setResult({
        verdict: "partial",
        interrupt: false,
        feedback: "Please paste your lecture notes first.",
        question: "What topic are we covering today?",
      });
      return;
    }
    
    if (!transcript.trim()) {
      setResult({
        verdict: "partial",
        interrupt: false,
        feedback: "Type your explanation first (we’ll replace this with mic input next).",
        question: "Try explaining the concept in one sentence.",
      });
      return;
    }

    const res = await fetch("/api/test-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes, transcript }),
    });

    const data = await res.json();
    setResult(data);
    console.log(data);
  };

  return (
    <main className="p-10">
      <h1 className = "text-3xl font-bold">
        ai speaking tutor
      </h1>
      <textarea 
        placeholder="Paste lecture notes here..."
        className="mt-6 w-full h-40 p-3 border rounded"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <textarea
        placeholder="Type what you would say out loud (for now)..."
        className="mt-4 w-full h-28 p-3 border rounded"
        value={transcript}
        onChange={(e) => setTranscript(e.target.value)}
      />
      <button
        onClick={startListening}
        className="mt-3 px-4 py-2 bg-green-500 text-white rounded">
        {listening ? "Listening..." : "Speak Answer"}
      </button>
      <button onClick={testAPI} className="mt-6 px-4 py-2 bg-blue-500 text-white rounded">
        test api route 
      </button>

      {result && (
        <div className="mt-6 p-4 border rounded">
          <p><b>Verdict:</b> {result.verdict ?? "unknown"}</p>
          <p className="mt-2"><b>Interrupt:</b> {String(result.interrupt ?? false)}</p>
          <p className="mt-2"><b>Feedback:</b> {result.feedback ?? result.raw ?? ""}</p>
          <p className="mt-2"><b>Question:</b> {result.question ?? ""}</p>
        </div>
      )}

    </main>
  );

}