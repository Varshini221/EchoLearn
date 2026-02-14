import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    if (process.env.DISABLE_GEMINI === "true") {
      // ✅ dev fallback so you can test UI without burning quota
      const fake = {
        topic: "Demo Mode",
        keyFacts: [
          "This is a fake summary because DISABLE_GEMINI=true.",
          "Turn it off to generate a real study sheet.",
        ],
        misconceptions: ["Fake misconception example."],
        quickQuiz: ["What is the main idea of these notes?"],
      };
      return NextResponse.json({ notesPack: JSON.stringify(fake, null, 2) }, { status: 200 });
    }

    if (!body?.notes || !String(body.notes).trim()) {
      return NextResponse.json({ error: "No notes provided" }, { status: 400 });
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    // ✅ truncate raw notes BEFORE summarizing
    const safeNotes = String(body.notes).slice(0, 12000);

    const prompt = `
You are an expert study tutor.
Turn these lecture notes into a short, structured study sheet.

NOTES:
${safeNotes}

Return ONLY valid JSON (no markdown, no backticks) with this exact shape:
{
  "topic": "string",
  "keyFacts": ["5-10 bullets max"],
  "keyTerms": [{"term":"string","meaning":"string"}],
  "misconceptions": ["3-6 common mistakes students make"],
  "quickQuiz": ["5 short questions"]
}
`;

    const resp = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });

    const text = resp.text ?? "";
    const cleaned = text.replace(/```json|```/g, "").trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // if Gemini returns non-json, still return something usable
      return NextResponse.json(
        { notesPack: JSON.stringify({ topic: "Study Sheet", keyFacts: [cleaned] }, null, 2) },
        { status: 200 }
      );
    }

    // ✅ store as a compact string that’s cheap to send later
    return NextResponse.json({ notesPack: JSON.stringify(parsed, null, 2) }, { status: 200 });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Summarize failed" }, { status: 500 });
  }
}
