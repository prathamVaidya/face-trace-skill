import crypto from "crypto";
import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { verifyTraceSignature } from "./hmac";
import {
  savePendingPhoto,
  getPendingPhoto,
  clearPendingPhoto,
  savePerson,
  getPeopleWithEmbeddings,
  findPersonById,
  findPersonByName,
  listPeople,
  deletePeopleForUser,
} from "./store";
import { generateEmbedding, matchFace } from "./faceService";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const TRACE_HMAC_SECRET = process.env.TRACE_HMAC_SECRET || "";
const TRACE_SKILL_ID = process.env.TRACE_SKILL_ID || "";
const BRAIN_BASE_URL = process.env.BRAIN_BASE_URL || "https://brain.endlessriver.ai";

app.use(bodyParser.json());

// ─── Webhook ──────────────────────────────────────────────────────────────────

app.post("/webhook", verifyTraceSignature(TRACE_HMAC_SECRET), async (req: Request, res: Response) => {
  const { event, user, request_id, callback_url } = req.body;
  const channel: string = event?.channel;
  console.log(`[Webhook] ${channel} | user=${user.id} | request_id=${request_id}`);

  if (channel === "media.photo") {
    const imageUrl: string = event?.items?.[0]?.url;
    if (!imageUrl) return res.status(200).json({ status: "error", responses: [] });

    res.status(202).json({ status: "processing", request_id });
    processPhoto(user.id, imageUrl, callback_url, request_id);
    return;
  }

  res.status(200).json({ status: "ignored", responses: [] });
});

async function processPhoto(userId: string, imageUrl: string, callbackUrl: string, requestId: string) {
  const embedding = await generateEmbedding(imageUrl);

  if (!embedding) {
    console.log(`[Photo] No face detected for user ${userId}`);
    return postCallback(callbackUrl, requestId, [
      notification("No face detected", "Couldn't find a face in the photo. Try again."),
    ]);
  }

  const candidates = getPeopleWithEmbeddings(userId);
  if (candidates.length > 0) {
    const { matched_id, distance } = await matchFace(imageUrl, candidates);
    const person = matched_id ? findPersonById(userId, matched_id) : null;
    if (person) {
      console.log(`[Photo] Matched ${person.name} (distance=${distance}) for user ${userId}`);
      return postCallback(callbackUrl, requestId, [
        notification(`That's ${person.name}!`, `You met them on ${formatDate(new Date(person.met_at))}`, true),
      ]);
    }
  }

  savePendingPhoto(uuidv4(), userId, imageUrl, embedding);
  console.log(`[Photo] No match — saved pending photo for user ${userId}`);
  return postCallback(callbackUrl, requestId, [
    notification("New face captured!", 'Say "name is [name]" to remember this person.'),
  ]);
}

// ─── MCP ──────────────────────────────────────────────────────────────────────

app.post("/mcp", async (req: Request, res: Response) => {
  const { jsonrpc, method, params, id } = req.body;
  if (jsonrpc !== "2.0") return res.status(400).send("Invalid JSON-RPC");

  if (method === "tools/list") return res.json(toolsList(id));

  if (method === "tools/call" && params.name === "handle_dialog") {
    const args = params.arguments;
    const utterance = (args.utterance || "").toLowerCase().trim();
    const userId: string = args.user.id;
    const location: string | undefined = args.location;
    console.log(`[MCP] user=${userId} | utterance="${utterance}"`);

    if (args.person_name) return handleSaveName(res, id, userId, args.person_name, location);

    const whoMatch = utterance.match(/^(?:who is|find|recall|remember)\s+(.+)$/);
    if (whoMatch) return handleWhoIs(res, id, userId, whoMatch[1].trim());

    if (/^(?:list|show|who have i met|people i've met|all people)/.test(utterance))
      return handleListPeople(res, id, userId);

    return mcpReply(res, id, 'Say "name is [name]" to save a face, or "who is [name]" to look someone up.', [
      notification("Face Trace", "Take a photo, then say a name."),
    ]);
  }

  res.status(404).json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});

function handleSaveName(res: Response, id: unknown, userId: string, rawName: string, location?: string) {
  const personName = toTitleCase(rawName.trim());
  const pending = getPendingPhoto(userId);

  if (!pending) {
    return mcpReply(res, id, "I don't have a recent photo to link. Take a photo first, then tell me the name.", [
      notification("No photo found", "Take a photo first, then say the name."),
    ]);
  }

  savePerson(uuidv4(), userId, personName, pending.image_url, pending.embedding ?? undefined, location);
  clearPendingPhoto(userId);
  console.log(`[MCP] Saved ${personName} for user ${userId}`);

  return mcpReply(res, id, `Got it! I'll remember ${personName}.`, [
    notification(`Remembered: ${personName}`, `Saved on ${formatDate(new Date())}`),
    feedItem(`Met ${personName}`, `You met ${personName} on ${formatDate(new Date())}.`),
  ]);
}

function handleWhoIs(res: Response, id: unknown, userId: string, query: string) {
  const person = findPersonByName(userId, query);

  if (!person) {
    return mcpReply(res, id, `I don't have anyone named ${toTitleCase(query)} saved.`, [
      notification("Not found", `No record of ${toTitleCase(query)}.`),
    ]);
  }

  const metDate = formatDate(new Date(person.met_at));
  return mcpReply(res, id, `${person.name} — you met them on ${metDate}.`, [
    notification(person.name, `Met on ${metDate}`, true),
  ]);
}

function handleListPeople(res: Response, id: unknown, userId: string) {
  const people = listPeople(userId);

  if (people.length === 0) {
    return mcpReply(res, id, "You haven't saved anyone yet.", [
      notification("No people saved", "Take a photo and say the person's name to get started."),
    ]);
  }

  const summary = people.slice(0, 5).map((p) => `${p.name} (${formatDate(new Date(p.met_at))})`).join(", ");
  return mcpReply(res, id, `You've met: ${summary}.`, [
    notification(`People you've met (${people.length})`, summary, true),
  ]);
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

app.post("/delete-user", (req: Request, res: Response) => {
  const { user_id } = req.body;
  deletePeopleForUser(user_id);
  console.log(`[Cleanup] Deleted all data for user ${user_id}`);
  res.json({ ok: true });
});

// ─── Response builders ────────────────────────────────────────────────────────

function notification(title: string, body: string, persist = false) {
  return { type: "notification", content: { title, body, tts: true, persist } };
}

function feedItem(title: string, story: string) {
  return { type: "feed_item", content: { title, story } };
}

function mcpReply(res: Response, id: unknown, text: string, responses: unknown[]) {
  return res.json({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }, { type: "embedded_responses", responses }] },
  });
}

function toolsList(id: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      tools: [{
        name: "handle_dialog",
        description: 'Face Trace skill. Handles: "name is [person_name]" to save a pending face, "who is [person_name]" to recall someone, "list people" to see everyone met.',
        inputSchema: {
          type: "object",
          properties: {
            utterance: { type: "string" },
            person_name: { type: "string", description: "The name of the person to save/remember" },
            location: { type: "string", description: "The current GPS location of the user" },
            context: { type: "object" },
          },
          required: ["utterance", "person_name"],
        },
      }],
    },
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function toTitleCase(str: string) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function postCallback(callbackUrl: string, requestId: string, responses: unknown[]) {
  try {
    const body = JSON.stringify({ request_id: requestId, status: "success", responses });
    const timestamp = Date.now().toString();
    const signature = "sha256=" + crypto.createHmac("sha256", TRACE_HMAC_SECRET).update(`${timestamp}.${body}`).digest("hex");

    const r = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-trace-timestamp": timestamp, "x-trace-signature": signature },
      body,
    });
    if (!r.ok) console.error(`[Callback] ${r.status} ${await r.text()}`);
  } catch (err) {
    console.error("[Callback] Error:", err);
  }
}

// Use to send a notification without any user interaction (limit: 5/day)
async function sendPushResponse(user_id: string, responses: unknown[]) {
  const url = `${BRAIN_BASE_URL}/api/skill-push/${TRACE_SKILL_ID}`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TRACE_HMAC_SECRET}` },
      body: JSON.stringify({ user_id, responses }),
    });
    if (!r.ok) console.error(`[Push] ${r.status} ${await r.text()}`);
  } catch (err) {
    console.error("[Push] Error:", err);
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => console.log(`🚀 Face Trace Skill running at http://localhost:${PORT}`));

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
