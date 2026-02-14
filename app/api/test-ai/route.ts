import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    
    if (process.env.DISABLE_GEMINI === "true") {
        return NextResponse.json(
            {
                verdict: "partial",
                interrupt: false,
                feedback: "Dev mode: Gemini is disabled (no API calls).",
                question: "Turn DISABLE_GEMINI off to use real AI again.",
            },
            { status: 200 }
        );
    }

    if (!body?.notes || !String(body.notes).trim()) {
        return NextResponse.json(
            {
            verdict: "partial",
            interrupt: false,
            feedback: "No lecture notes provided.",
            question: "Paste your notes, then explain the topic in your own words.",
            },
            { status: 200 }
        );
        }

    if (!body?.transcript || !String(body.transcript).trim()) {
        return NextResponse.json(
            {
            verdict: "partial",
            interrupt: false,
            feedback: "No explanation provided.",
            question: "Type your explanation (we’ll use the mic next).",
            },
            { status: 200 }
        );
        }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

     // ✅ prefer condensed notesPack if provided, else raw notes
    const rawNotes = body?.notesPack && String(body.notesPack).trim()
        ? String(body.notesPack)
        : String(body.notes);

    // ✅ truncate so you never send huge prompts
    const safeNotes = rawNotes.slice(0, 3000);
    const safeTranscript = String(body.transcript).slice(0, 600);

    const prompt = `
    You are an AI tutor.

    Use ONLY the information in the notes to judge the student.

    NOTES (condensed study sheet):
    ${safeNotes}

    STUDENT SAID:
    ${safeTranscript}

    Classify the student's answer as one of:
    - "correct" (accurate and complete enough)
    - "partial" (some truth but missing key details from the notes)
    - "incorrect" (wrong or unrelated)

    Rules:
    - If you're NOT sure, choose "partial" and ask a clarifying question.
    - If verdict is "incorrect", set interrupt=true.
    - If verdict is "partial" or "correct", set interrupt=false.

    Respond ONLY with valid JSON (no markdown, no backticks):
    {"verdict":"correct","interrupt":false,"feedback":"text","question":"text"}
    `;


    const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    });
    
    const text = response.text ?? '';
    const cleaned = text.replace(/```json|```/g, "").trim();

    let parsed;

    try {
        parsed = JSON.parse(cleaned);
    } catch {
        parsed = { raw: cleaned };
    }
    if (!parsed || typeof parsed !== "object") parsed = { raw: cleaned };

    const verdict =
        parsed.verdict === "correct" || parsed.verdict === "partial" || parsed.verdict === "incorrect"
            ? parsed.verdict
            : "partial";

    const interrupt =
        typeof parsed.interrupt === "boolean"
            ? parsed.interrupt
            : verdict === "incorrect";

    const feedback =
        typeof parsed.feedback === "string" && parsed.feedback.trim()
            ? parsed.feedback
            : (typeof (parsed as any).raw === "string" ? (parsed as any).raw : "No feedback provided.");

    const question =
        typeof parsed.question === "string" && parsed.question.trim()
            ? parsed.question
            : "Can you explain that again in one sentence?";
    
    return NextResponse.json({
        verdict,
        interrupt,
        feedback,
        question,
    });


  } catch (error: any) {
    console.error("Gemini error:", error);

    const status = error?.status;
    const msg = String(error?.message ?? "");

    if (status === 429 || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Quota exceeded")) {
        return NextResponse.json(
        {
            verdict: "partial",
            interrupt: false,
            feedback:
            "Give me a second — I’m thinking. Try again in a moment, and keep your explanation to 1–2 sentences.",
            question:
            "While we wait, what are the 2 key facts from the notes that support your answer?",
        },
        { status: 200 }
        );
    }

    return NextResponse.json(
        {
        verdict: "partial",
        interrupt: false,
        feedback:
            "Something went wrong on my side. Try again in a moment.",
        question:
            "Can you restate your explanation in one clear sentence?",
        },
        { status: 200 }
    );
    }

}
