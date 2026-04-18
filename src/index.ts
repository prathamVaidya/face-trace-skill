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
const BRAIN_BASE_URL =
  process.env.BRAIN_BASE_URL || "https://brain.endlessriver.ai";

app.use(bodyParser.json());

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.post(
  "/webhook",
  verifyTraceSignature(TRACE_HMAC_SECRET),
  async (req: Request, res: Response) => {
    const { event, user, request_id } = req.body;
    const userId = "1";
    const channel: string = event?.channel;

    console.log("user: ", JSON.stringify(user));
    console.log(
      `[Webhook] ${channel} for user ${userId} | request_id=${request_id}`,
    );

    // ── media.photo: generate embedding, try to match, else save as pending ──
    if (channel === "media.photo") {
      const photoItem = event?.items?.[0];
      if (!photoItem?.url) {
        return res.status(200).json({ status: "error", responses: [] });
      }

      // Respond immediately, process in background
      res.status(200).json({ status: "success", responses: [] });

      (async () => {
        const imageUrl: string = photoItem.url;
        const embedding = await generateEmbedding(imageUrl);

        if (!embedding) {
          console.log(`[Webhook] No face detected in photo for user ${userId}`);
          await sendPushResponse(user.id, [
            {
              type: "notification",
              content: {
                title: "No face detected",
                body: "Couldn't find a face in the photo. Try again.",
                tts: true,
              },
            },
          ]);
          return;
        }

        // Try to match against stored people
        const candidates = getPeopleWithEmbeddings(userId);
        if (candidates.length > 0) {
          const { matched_id, distance } = await matchFace(
            imageUrl,
            candidates,
          );
          if (matched_id) {
            const person = findPersonById(userId, matched_id);
            if (person) {
              console.log(
                `[Webhook] Matched ${person.name} (distance=${distance}) for user ${userId}`,
              );
              await sendPushResponse(user.id, [
                {
                  type: "notification",
                  content: {
                    title: `That's ${person.name}!`,
                    body: `You met them on ${formatDate(new Date(person.met_at))}`,
                    tts: true,
                    persist: true,
                  },
                },
              ]);
              return;
            }
          }
        }

        // No match — save as pending so user can name them
        savePendingPhoto(uuidv4(), userId, imageUrl, embedding);
        console.log(
          `[Webhook] No match found, saved pending photo for user ${userId}`,
        );
        await sendPushResponse(user.id, [
          {
            type: "notification",
            content: {
              title: "New face captured!",
              body: 'Say "name is [name]" to remember this person.',
              tts: true,
            },
          },
        ]);
      })();

      return;
    }

    res.status(200).json({ status: "ignored", responses: [] });
  },
);

// ─── MCP ──────────────────────────────────────────────────────────────────────
app.post("/mcp", async (req: Request, res: Response) => {
  const { jsonrpc, method, params, id, user } = req.body;
  console.log(req.body);
  if (jsonrpc !== "2.0") return res.status(400).send("Invalid JSON-RPC");

  if (method === "tools/list") {
    return res.json({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "handle_dialog",
            description:
              'Face Trace skill. Handles: "name is [person_name]" to save a pending face, "who is [person_name]" to recall someone, "list people" to see everyone met.',
            inputSchema: {
              type: "object",
              properties: {
                utterance: { type: "string" },
                person_name: {
                  type: "string",
                  description: "The name of the person to save/remember",
                },
                location: {
                  type: "string",
                  description: "The current GPS location of the user",
                },
                context: { type: "object" },
              },
              required: ["utterance", "person_name"],
            },
          },
        ],
      },
    });
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params;

    if (name === "handle_dialog") {
      const utterance: string = (args.utterance || "").toLowerCase().trim();
      const userId: string = "1";
      // const userId: string =
      //   args.userId || args.user_id || args.context?.user?.id || "";
      console.log(
        `[MCP] handle_dialog | user=${userId} | utterance="${utterance}"`,
      );
      console.log(`[MCP] full args:`, JSON.stringify(args, null, 2));
      const location: string | undefined = args.location;

      // ── save name → link pending photo to person_name ────────────────────
      if (args.person_name) {
        const personName = toTitleCase((args.person_name as string).trim());
        const pending = getPendingPhoto(userId);
        console.log(userId, pending);

        if (!pending) {
          return mcpText(
            res,
            id,
            "I don't have a recent photo to link. Take a photo first, then tell me the name.",
            [
              {
                type: "notification",
                content: {
                  title: "No photo found",
                  body: "Take a photo first, then say the name.",
                  tts: true,
                },
              },
            ],
          );
        }

        savePerson(
          uuidv4(),
          userId,
          personName,
          pending.image_url,
          pending.embedding ?? undefined,
          location,
        );
        clearPendingPhoto(userId);

        return mcpText(res, id, `Got it! I'll remember ${personName}.`, [
          {
            type: "notification",
            content: {
              title: `Remembered: ${personName}`,
              body: `Saved on ${formatDate(new Date())}`,
              tts: true,
            },
          },
          {
            type: "feed_item",
            content: {
              title: `Met ${personName}`,
              story: `You met ${personName} on ${formatDate(new Date())}.`,
            },
          },
        ]);
      }

      // ── "who is X" → recall person ────────────────────────────────────────
      const whoMatch = utterance.match(
        /^(?:who is|find|recall|remember)\s+(.+)$/,
      );
      if (whoMatch) {
        const query = whoMatch[1].trim();
        const person = findPersonByName(userId, query);

        if (!person) {
          return mcpText(
            res,
            id,
            `I don't have anyone named ${toTitleCase(query)} saved.`,
            [
              {
                type: "notification",
                content: {
                  title: "Not found",
                  body: `No record of ${toTitleCase(query)}.`,
                  tts: true,
                },
              },
            ],
          );
        }

        const metDate = formatDate(new Date(person.met_at));
        return mcpText(
          res,
          id,
          `${person.name} — you met them on ${metDate}.`,
          [
            {
              type: "notification",
              content: {
                title: person.name,
                body: `Met on ${metDate}`,
                tts: true,
                persist: true,
              },
            },
          ],
        );
      }

      // ── "list people" → show all ──────────────────────────────────────────
      if (
        /^(?:list|show|who have i met|people i've met|all people)/.test(
          utterance,
        )
      ) {
        const people = listPeople(userId);

        if (people.length === 0) {
          return mcpText(res, id, "You haven't saved anyone yet.", [
            {
              type: "notification",
              content: {
                title: "No people saved",
                body: "Take a photo and say the person's name to get started.",
                tts: true,
              },
            },
          ]);
        }

        const summary = people
          .slice(0, 5)
          .map((p) => `${p.name} (${formatDate(new Date(p.met_at))})`)
          .join(", ");

        return mcpText(res, id, `You've met: ${summary}.`, [
          {
            type: "notification",
            content: {
              title: `People you've met (${people.length})`,
              body: summary,
              tts: true,
              persist: true,
            },
          },
        ]);
      }

      // ── Fallback ──────────────────────────────────────────────────────────
      return mcpText(
        res,
        id,
        'Say "name is [name]" to save a face, or "who is [name]" to look someone up.',
        [
          {
            type: "notification",
            content: {
              title: "Face Trace",
              body: "Take a photo, then say a name.",
              tts: true,
            },
          },
        ],
      );
    }
  }

  res.status(404).json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  });
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────
app.post("/delete-user", (req: Request, res: Response) => {
  const { user_id } = req.body;
  deletePeopleForUser(user_id);
  console.log(`[Cleanup] Deleted all data for user ${user_id}`);
  res.json({ ok: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function mcpText(
  res: Response,
  id: unknown,
  text: string,
  responses: unknown[],
) {
  return res.json({
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        { type: "text", text },
        { type: "embedded_responses", responses },
      ],
    },
  });
}

function toTitleCase(str: string) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

async function sendPushResponse(user_id: string, responses: unknown[]) {
  const url = `${BRAIN_BASE_URL}/api/skill-push/${TRACE_SKILL_ID}`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TRACE_HMAC_SECRET}`,
      },
      body: JSON.stringify({ user_id, responses }),
    });
    if (!r.ok) console.error(`[Push] ${r.status} ${await r.text()}`);
  } catch (err) {
    console.error("[Push] Error:", err);
  }
}

const server = app.listen(PORT, () =>
  console.log(`🚀 Face Trace Skill running at http://localhost:${PORT}`),
);

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
