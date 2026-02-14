"use client";
import { useEffect, useRef, useState } from "react";

type TutorResult = {
  verdict?: "correct" | "partial" | "incorrect";
  interrupt?: boolean;
  feedback?: string;
  question?: string;
  raw?: string;
};

export default function Home() {
  const [notes, setNotes] = useState("");
  const [transcript, setTranscript] = useState("");
  const [result, setResult] = useState<TutorResult | null>(null);
  const [listening, setListening] = useState(false);
  const [checking, setChecking] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [avatarSpeaking, setAvatarSpeaking] = useState(false);
  const voiceCountRef = useRef(0);
  const MAX_VOICES_PER_SESSION = 3;
  const [notesPack, setNotesPack] = useState<string>("");
  const [preparing, setPreparing] = useState(false);
  const shouldAutoRestartRef = useRef(true);
  const tutorSpeakingRef = useRef(false);

  const CHECK_EVERY_MS = 4000;          // how often to evaluate while speaking
  const MIN_NEW_CHARS = 35;             // only check if we have this many new characters
  const MAX_CHECKS_PER_SESSION = 6;     // prevents burning quota during a single speaking session
  const COOLDOWN_AFTER_INTERRUPT_MS = 9000; // wait after interrupt before checking again

  const recognitionRef = useRef<any>(null);
  const intervalRef = useRef<number | null>(null);
  const lastSpokenRef = useRef<string>("");

  const lastCheckedLenRef = useRef<number>(0);
  const checksUsedRef = useRef<number>(0);
  const cooldownUntilRef = useRef<number>(0);
  const inFlightRef = useRef<boolean>(false);
  const autoRestartRef = useRef(true);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resetForRetry = () => {
    setTranscript("");
    lastCheckedLenRef.current = 0;
    checksUsedRef.current = 0;
    cooldownUntilRef.current = 0;
  };
  const speakTutor = async (text: string) => {
    // ✅ make sure mic is OFF while tutor speaks
    shouldAutoRestartRef.current = false;
    stopListening();

    // stop any previous audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    tutorSpeakingRef.current = true;   // ✅ block restarts while speaking
    setAvatarSpeaking(true);

    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      tutorSpeakingRef.current = false;
      setAvatarSpeaking(false);
      console.error("Speak failed");
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    return new Promise<void>((resolve) => {
      const audio = new Audio(url);
      audioRef.current = audio;

      const done = () => {
        tutorSpeakingRef.current = false; // ✅ tutor finished
        setAvatarSpeaking(false);
        URL.revokeObjectURL(url);

        // ✅ now it’s safe to restart the mic (if liveMode)
        if (liveMode) {
          shouldAutoRestartRef.current = true;
          setTimeout(() => startListening(), 250);
        }

        resolve();
      };

      audio.onended = done;
      audio.onerror = done;

      audio.play().catch(() => done());
    });
  };



  // ---------- Speech Recognition ----------
  const startListening = () => {
    shouldAutoRestartRef.current = true;
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Speech recognition not supported in this browser. Try Chrome on desktop.");
      return;
    }

    // If already listening, don't start a second instance
    if (recognitionRef.current) return;

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;

    recognition.lang = "en-US";
    recognition.continuous = true;     // try to keep going through pauses
    recognition.interimResults = true; // get partial text while speaking

    recognition.onstart = () => {
      setListening(true);
      // reset counters for a new session
      lastCheckedLenRef.current = transcript.length;
      checksUsedRef.current = 0;
      cooldownUntilRef.current = 0;
      voiceCountRef.current = 0;
    };

    recognition.onresult = (event: any) => {
      // Collect final + interim parts
      if (tutorSpeakingRef.current) return;
      let finalText = "";
      let interimText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += chunk + " ";
        else interimText += chunk;
      }

      // Keep final text appended. Show interim in a "live" way.
      setTranscript((prev) => {
        // remove any previous interim marker
        const base = prev.replace(/\s*\[speaking\][\s\S]*$/, "").trim();
        const appended = (base ? base + " " : "") + finalText.trim();
        const withFinal = appended.trim();
        return interimText
          ? (withFinal ? withFinal + " " : "") + `[speaking] ${interimText}`.trim()
          : withFinal;
      });
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);

      if (!liveMode) return;
      if (!shouldAutoRestartRef.current) return;     // ✅ intentional stop
      if (tutorSpeakingRef.current) return;          // ✅ tutor is talking

      setTimeout(() => { checkWithAI(true); }, 200);

      setTimeout(() => {
        if (!recognitionRef.current) startListening();
      }, 600);
    };



    recognition.onerror = (e: any) => {
      console.log("Speech error:", e);
      recognitionRef.current = null;
      setListening(false);
    };

    recognition.start();
  };

  const stopListening = () => {
    shouldAutoRestartRef.current = false; // ✅ do not auto-restart from onend
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
    setListening(false);
  };


  // ---------- AI check (call your route) ----------
  const checkWithAI = async (force = false) => {
    if (inFlightRef.current) return;

    if (!notes.trim()) {
      setResult({
        verdict: "partial",
        interrupt: false,
        feedback: "Paste your lecture notes first.",
        question: "What topic are we covering today?",
      });
      return;
    }

    if (!transcript.trim()) {
      setResult({
        verdict: "partial",
        interrupt: false,
        feedback: "Say something (or type it) so I can check it.",
        question: "Try explaining the concept in one sentence.",
      });
      return;
    }

    // Respect cooldown after an interrupt
    const now = Date.now();
    if (now < cooldownUntilRef.current) return;

    // Don't burn quota
    if (checksUsedRef.current >= MAX_CHECKS_PER_SESSION) return;

    // Only check when there is enough new speech since last check
    const cleanTranscript = transcript.replace(/\s*\[speaking\][\s\S]*$/, "").trim();
    const newLen = cleanTranscript.length;
    const delta = newLen - lastCheckedLenRef.current;

    if (!force && delta < MIN_NEW_CHARS) return;

    // // Optional: only check at sentence boundaries (reduces spam)
    // const lastChar = cleanTranscript.slice(-1);
    // const looksLikeBoundary = [".", "?", "!"].includes(lastChar);
    // if (!force && !looksLikeBoundary && delta < MIN_NEW_CHARS * 2) {
    //   // If no punctuation, require more new text
    //   return;
    // }

    inFlightRef.current = true;
    setChecking(true);

    try {
      // send only the most recent chunk (last ~250 chars) for "live" checking
      const recentSnippet = cleanTranscript.slice(Math.max(0, newLen - 250));

      const res = await fetch("/api/test-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes,
          notesPack,
          transcript: recentSnippet,
        }),
      });

      const data: TutorResult = await res.json();

      // update counters
      lastCheckedLenRef.current = newLen;
      checksUsedRef.current += 1;

      setResult(data);
      lastCheckedLenRef.current = newLen;
      checksUsedRef.current += 1;
      if (data?.verdict === "correct" || data?.verdict === "partial") {
        resetForRetry();       // clears transcript + counters
        return;
}


      if (data?.verdict === "incorrect") {
        shouldAutoRestartRef.current = false;
        stopListening();

        cooldownUntilRef.current = Date.now() + COOLDOWN_AFTER_INTERRUPT_MS;

        const toSay = (data.feedback ?? "Hold on — that’s not quite right.").trim();
        if (toSay && toSay !== lastSpokenRef.current) {
          lastSpokenRef.current = toSay;

          if (voiceOn && voiceCountRef.current < MAX_VOICES_PER_SESSION) {
            voiceCountRef.current += 1;
            await speakTutor(toSay); // ✅ restarts mic after speaking ends
          }

          resetForRetry();
        }
      }


    } catch (e) {
      // If anything goes wrong, don't crash UX
      setResult({
        verdict: "partial",
        interrupt: false,
        feedback: "Give me a second — try again in a moment.",
        question: "What are two key facts from the notes that support your answer?",
      });
    } finally {
      inFlightRef.current = false;
      setChecking(false);
    }
  };

  // ---------- Auto-check timer while listening ----------
  useEffect(() => {
    if (!listening || !liveMode) {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    if (!intervalRef.current) {
      intervalRef.current = window.setInterval(() => {
        checkWithAI();
      }, CHECK_EVERY_MS);
    }

    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [listening, notes, transcript]);

  // Presentational: bubble shows tutor feedback when available
  const bubbleText = result?.feedback ?? "";

  // ui
  const prepareNotes = async () => {
    if (!notes.trim()) {
      setResult({
        verdict: "partial",
        interrupt: false,
        feedback: "Paste lecture notes first, then click Prepare Notes.",
        question: "What topic are we covering?",
      });
      return;
    }

    setPreparing(true);
    try {
      const res = await fetch("/api/summarize-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      const data = await res.json();
      setNotesPack(data.notesPack ?? "");
      setResult({
        verdict: "partial",
        interrupt: false,
        feedback: "✅ Notes prepared! Now live checks will be faster + cheaper.",
        question: "Start speaking when ready.",
      });
    } catch (e) {
      setResult({
        verdict: "partial",
        interrupt: false,
        feedback: "Could not prepare notes. You can still use raw notes, but it may be slower.",
        question: "Try again, or keep going without Prepare Notes.",
      });
    } finally {
      setPreparing(false);
    }
  };

  return (
    <main className="min-h-screen min-w-0 relative overflow-hidden bg-gradient-to-br from-[#fff2f2] via-[#ffe6de] to-[#fff3e8] p-6 md:p-10">
      {/* Decorative warm blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-20 top-1/4 w-72 h-72 rounded-full bg-red-300/30 blur-3xl" />
        <div className="absolute right-0 top-1/2 w-64 h-64 rounded-full bg-red-400/25 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 w-56 h-56 rounded-full bg-orange-300/30 blur-3xl" />
      </div>

      <div className="relative grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-8 md:gap-12 items-center max-w-6xl mx-auto">
        {/* LEFT: Avatar section (40–50% on desktop) */}
        <div className="flex flex-col items-center justify-center md:min-h-[420px] order-1">
          <div className="relative flex justify-center items-center">
            {/* Pastel glow ring behind avatar */}
            <div
              className={`absolute inset-0 rounded-full w-[280px] h-[280px] md:w-[320px] md:h-[320px] m-auto bg-gradient-to-br from-yellow-200/60 to-amber-300/60 blur-2xl transition-all duration-300 ${
                avatarSpeaking ? "scale-110 opacity-80" : "scale-100 opacity-60"
              }`}
            />
            <img
              src="/avatar.png"
              alt="Tutor avatar"
              className={`relative w-[280px] md:w-[340px] max-w-full transition-all duration-300 ease-out ${
                avatarSpeaking ? "scale-[1.04]" : "scale-100"
              }`}
            />
          </div>

          {/* Speech bubble when bubbleText exists */}
          {bubbleText ? (
            <div className="relative mt-6 w-full max-w-sm mx-auto">
              <div className="rounded-3xl bg-white/80 backdrop-blur-md border border-white/50 shadow-lg shadow-black/5 px-5 py-4 text-gray-800 text-sm md:text-base">
                {bubbleText}
              </div>
              {/* Bubble tail pointing toward avatar */}
              <div
                className="absolute -top-2 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[10px] border-l-transparent border-r-[10px] border-r-transparent border-b-[12px] border-b-white/80"
                aria-hidden
              />
              <span className="absolute -top-1 -right-1 text-sm opacity-70" aria-hidden>✨</span>
            </div>
          ) : null}

          {/* Status chips */}
          <div className="flex flex-wrap justify-center gap-2 mt-6">
            {listening && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200/80 bg-red-100/90 px-3 py-1.5 text-sm text-red-800 shadow-sm">
                <span aria-hidden>🎙️</span> Listening
              </span>
            )}
            {checking && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-200/80 bg-orange-100/90 px-3 py-1.5 text-sm text-orange-800 shadow-sm">
                <span aria-hidden>🧠</span> Thinking
              </span>
            )}
            {avatarSpeaking && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200/80 bg-red-50/90 px-3 py-1.5 text-sm text-red-800 shadow-sm">
                <span aria-hidden>🦦</span> Tutor speaking
              </span>
            )}
          </div>
        </div>

        {/* RIGHT: Notes, transcript, controls (50–60% on desktop) */}
        <div className="flex flex-col gap-6 order-2">
          <h1 className="text-3xl md:text-4xl font-bold text-gray-800 tracking-tight">
            AI Speaking Tutor
          </h1>

          {/* Tutor Controls (top section) */}
          <div className="rounded-2xl bg-gradient-to-r from-red-50/60 to-orange-50/60 backdrop-blur-sm border border-red-100/50 shadow-md shadow-black/5 p-4">
            <div className="flex flex-wrap gap-3 justify-center">
              <button
                onClick={() => setVoiceOn((v) => !v)}
                className={`rounded-full px-5 py-2.5 font-semibold transition-all duration-200 shadow-md shadow-black/5 border ${
                  voiceOn
                    ? "bg-red-500/90 text-white border-red-600/80 scale-105"
                    : "bg-red-400/80 text-white border-red-500/60 hover:brightness-110"
                }`}
              >
                <span aria-hidden>🔊</span> Tutor Voice: {voiceOn ? "ON" : "OFF"}
              </button>

              <button
                onClick={() => setLiveMode((v) => !v)}
                className={`rounded-full px-5 py-2.5 font-semibold transition-all duration-200 shadow-md shadow-black/5 border ${
                  liveMode
                    ? "bg-orange-500/90 text-white border-orange-600/80 scale-105"
                    : "bg-orange-400/80 text-white border-orange-500/60 hover:brightness-110"
                }`}
              >
                <span aria-hidden>⚡</span> Live Interrupt: {liveMode ? "ON" : "OFF"}
              </button>
            </div>
          </div>

          {/* Lecture Notes card */}
          <div className="rounded-3xl bg-white/70 backdrop-blur-md border border-white/40 shadow-lg shadow-black/5 p-4 md:p-5">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Lecture Notes
            </label>
            <p className="text-xs text-gray-500 mb-2">Paste your notes here so the tutor can check your answers.</p>
            <textarea
              placeholder="Paste lecture notes here..."
              className="w-full h-36 p-4 rounded-2xl border border-gray-200/80 bg-white/60 focus:border-orange-300 focus:ring-2 focus:ring-orange-200/50 focus:outline-none transition-all text-gray-800 placeholder-gray-400"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            {/* Callout prompting user to Prepare Notes when notes are present but not prepared */}
            {notes.trim() && !notesPack ? (
              <div className="mt-3 rounded-lg bg-red-50/90 border border-red-200 p-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div>
                    <p className="text-sm font-semibold text-red-700">Prepare notes first</p>
                    <p className="text-xs text-red-600">Click Prepare Notes to summarize your lecture notes — this makes live checks faster and more accurate.</p>
                  </div>
                </div>
                <div className="flex-shrink-0">
                  <button
                    onClick={prepareNotes}
                    disabled={preparing}
                    className="px-4 py-2 rounded-full bg-red-500 text-white font-medium shadow-sm disabled:opacity-50"
                  >
                    {preparing ? "Preparing..." : "Prepare Notes"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* Transcript card */}
          <div className="rounded-3xl bg-white/70 backdrop-blur-md border border-white/40 shadow-lg shadow-black/5 p-4 md:p-5">
            <div className="flex items-center gap-2 mb-1">
              <label className="block text-sm font-medium text-gray-700">
                What you said
              </label>
              {listening && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100/90 px-2 py-0.5 text-xs font-medium text-emerald-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 mb-2">Auto-filled when you speak, or type here.</p>
            <textarea
              placeholder="Transcript (auto-filled when you speak)..."
              className="w-full h-28 p-4 rounded-2xl border border-gray-200/80 bg-white/60 focus:border-orange-300 focus:ring-2 focus:ring-orange-200/50 focus:outline-none transition-all text-gray-800 placeholder-gray-400"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
            />
          </div>

          {/* Main Buttons */}
          <div className="flex flex-wrap gap-3 justify-center">
            <button
              onClick={() => {
                if (!notes.trim()) {
                  setResult({
                    verdict: "partial",
                    interrupt: false,
                    feedback: "Please paste your lecture notes first.",
                    question: "What topic are we covering today?",
                  });
                  return;
                }
                startListening();
              }}
              disabled={listening}
              className="rounded-full px-5 py-2.5 bg-red-400/90 hover:brightness-110 text-white font-medium transition disabled:opacity-50 shadow-md shadow-black/5 border border-red-500/60"
            >
              {listening ? "Listening..." : "Speak Answer"}
            </button>

            <button
              onClick={stopListening}
              disabled={!listening}
              className="rounded-full px-5 py-2.5 bg-orange-400/90 hover:brightness-110 text-white font-medium transition disabled:opacity-50 shadow-md shadow-black/5 border border-orange-500/60"
            >
              Stop
            </button>
            {/* Prepare Notes button removed from bottom - callout above provides single action */}
            <button
              onClick={() => checkWithAI(true)}
              disabled={checking || !notes.trim() || !transcript.trim()}
              className="rounded-full px-5 py-2.5 bg-orange-500/90 hover:brightness-110 text-white font-medium transition disabled:opacity-50 shadow-md shadow-black/5 border border-orange-600/60"
            >
              {checking ? "Checking..." : "Check Now"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );

}