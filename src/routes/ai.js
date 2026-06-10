import { Router } from "express";
import { fal } from "@fal-ai/client";

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────────
const FAL_KEY        = (process.env.FAL_KEY        || "").trim();
const GROQ_API_KEY   = (process.env.GROQ_API_KEY   || "").trim();

const AI_RATE_LIMIT_MAX      = Number(process.env.AI_RATE_LIMIT_MAX      || 100);
const AI_RATE_LIMIT_WINDOW_MS= Number(process.env.AI_RATE_LIMIT_WINDOW_MS|| 60_000);
const AI_TIMEOUT_MS          = Number(process.env.AI_TIMEOUT_MS          || 12_000);

const AI_NEGATIVE_PROMPT = (
  process.env.AI_NEGATIVE_PROMPT ||
  "photorealistic, photograph, 3d render, hyperrealistic, skin texture, bokeh, camera, lens, realistic lighting, blurry, watermark, ugly, deformed, dark background, black background"
).trim();

const AI_ALLOWED_MODELS = (process.env.AI_ALLOWED_MODELS || "flux,flux-pro,flux-schnell")
  .split(",").map(s => s.trim()).filter(Boolean);

if (FAL_KEY) fal.config({ credentials: FAL_KEY });

// ── Fal.ai model registry ─────────────────────────────────────────────────────
const FAL_MODEL_PATHS = {
  "flux":         "fal-ai/flux",
  "flux-pro":     "fal-ai/flux-pro",
  "flux-schnell": "fal-ai/flux/schnell",
  "flux-realism": "fal-ai/flux-realism",
  "recraft-v3":   "fal-ai/recraft-v3",
};

const EDIT_MODEL_BY_ACTION = {
  remove_background: "fal-ai/birefnet",
  crop:              "fal-ai/flux-pro/kontext/max",
  edit:              "fal-ai/flux-pro/kontext/max",
};

// ── In-memory state ───────────────────────────────────────────────────────────
const aiRateLimitByIp = new Map();
const aiRequestMeta   = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────
function enforceAiRateLimit(req, res) {
  const ip  = req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const cur = aiRateLimitByIp.get(ip) || { count: 0, windowStart: now };
  if (now - cur.windowStart > AI_RATE_LIMIT_WINDOW_MS) { cur.count = 0; cur.windowStart = now; }
  cur.count++;
  aiRateLimitByIp.set(ip, cur);
  if (cur.count > AI_RATE_LIMIT_MAX) {
    res.status(429).json({ ok: false, message: "Rate limit exceeded. Please try again shortly." });
    return false;
  }
  return true;
}

function getFalHeaders() {
  if (!FAL_KEY) throw new Error("Missing FAL_KEY environment variable.");
  return { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = AI_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonSafely(response) {
  try { return JSON.parse(await response.text()); } catch { return {}; }
}

function buildFalModelPath(model) {
  if (!AI_ALLOWED_MODELS.includes(model)) {
    throw new Error(`Unsupported model "${model}". Allowed: ${AI_ALLOWED_MODELS.join(", ")}.`);
  }
  const p = FAL_MODEL_PATHS[model];
  if (!p) throw new Error(`No fal.ai path configured for model "${model}".`);
  return p;
}

function makeCompositeId(modelPath, requestId) {
  return Buffer.from(JSON.stringify({ modelPath, id: requestId })).toString("base64url");
}

function parseCompositeId(compositeId) {
  const decoded = JSON.parse(Buffer.from(compositeId, "base64url").toString());
  if (!decoded.modelPath || !decoded.id) throw new Error("Invalid requestId");
  return decoded;
}

// ── Groq prompt rewriter (neon sign edition) ──────────────────────────────────
async function rewritePromptForNeon(userPrompt) {
  if (!GROQ_API_KEY) {
    return `neon sign design of ${userPrompt}, glowing neon tubes, vibrant light, isolated on white background, clean vector style`;
  }

  try {
    const response = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          max_tokens: 120,
          messages: [
            {
              role: "system",
              content: `You are a prompt rewriter for a neon sign design generator.
              Your ONLY job is to rewrite the user's prompt so the image looks like a real custom neon sign.

              ━━━ NEON SIGN STYLE RULES ━━━

              - Glowing neon tube lights (LED or glass tube style)
              - Vibrant saturated colors: pink, blue, red, green, yellow, white, purple, orange
              - Clean bold lines — neon signs are made of bent tubes so shapes must be continuous strokes
              - Isolated on a plain white or transparent background (never dark/black background unless user asks)
              - No photorealistic elements, no textures, no shadows
              - If user mentions a color, preserve it as the neon glow color
              - If user mentions text/words, preserve them exactly — neon signs commonly feature text
              - Simple bold shapes work best — neon cannot render fine detail
              - Prompt style: "neon sign of [subject], glowing neon tube lights, vibrant [color] glow, bold continuous lines, clean stroke design, isolated on white background"

              ━━━ RULES ━━━
              - ALWAYS start with "neon sign of ..."
              - Keep the subject 100% as the user intended — NEVER drop or replace the main subject
              - Preserve any colors, text, or shapes the user specifies
              - If no color mentioned, pick a fitting vibrant neon color
              - Always end with: isolated on plain white background, no dark background, no scenery
              - Strip out any words like: realistic, cinematic, photo, painting, render, 3d, atmospheric
              - Return ONLY the rewritten prompt as a single sentence, nothing else, no explanation`
            },
            { role: "user", content: userPrompt }
          ]
        })
      },
      8000
    );

    const data = await readJsonSafely(response);
    if (!response.ok) {
      console.warn(`[GROQ] API error: ${data?.error?.message || response.status} — using fallback`);
      return `neon sign of ${userPrompt}, glowing neon tube lights, vibrant colorful glow, bold continuous lines, isolated on plain white background`;
    }

    const rewritten = data?.choices?.[0]?.message?.content?.trim();
    if (!rewritten) {
      console.warn("[GROQ] Empty response — using fallback");
      return `neon sign of ${userPrompt}, glowing neon tube lights, vibrant colorful glow, bold continuous lines, isolated on plain white background`;
    }

    return rewritten;
  } catch (err) {
    console.warn("[GROQ] Request failed — using fallback:", err.message);
    return `neon sign of ${userPrompt}, glowing neon tube lights, vibrant colorful glow, bold continuous lines, isolated on plain white background`;
  }
}

// ── Shared fal.ai status poller ───────────────────────────────────────────────
async function pollFalStatus(compositeRequestId, res) {
  const requestId = String(compositeRequestId || "").trim();
  if (!requestId) return res.status(400).json({ ok: false, message: "requestId is required." });

  let falRequestId = requestId;
  let modelPath = "fal-ai/flux";
  try {
    const decoded = parseCompositeId(requestId);
    modelPath    = decoded.modelPath;
    falRequestId = decoded.id;
  } catch (_) {}

  const falBase      = `https://queue.fal.run/${modelPath}/requests/${encodeURIComponent(falRequestId)}`;
  const statusRes    = await fetchWithTimeout(`${falBase}/status`, { method: "GET", headers: getFalHeaders() });
  const statusPayload= await readJsonSafely(statusRes);

  if (!statusRes.ok) {
    return res.status(502).json({
      status: "failed",
      error: statusPayload?.detail || statusPayload?.error || statusPayload?.message || `fal.ai status check failed (${statusRes.status}).`
    });
  }

  const falStatus = String(statusPayload?.status || "").toUpperCase();

  if (falStatus === "COMPLETED") {
    const resultRes     = await fetchWithTimeout(falBase, { method: "GET", headers: getFalHeaders() });
    const resultPayload = await readJsonSafely(resultRes);
    if (!resultRes.ok) {
      return res.status(502).json({
        status: "failed",
        error: resultPayload?.detail || resultPayload?.error || resultPayload?.message || "fal.ai result fetch failed."
      });
    }
    const images = resultPayload?.image?.url
      ? [{ url: resultPayload.image.url }]
      : (resultPayload?.images || []).map(item => ({ url: item?.url })).filter(item => Boolean(item.url));
    return res.json({ status: "completed", images });
  }

  if (falStatus === "FAILED" || falStatus === "ERROR") {
    return res.json({
      status: "failed",
      error: statusPayload?.error || statusPayload?.detail || statusPayload?.message || "Job failed."
    });
  }

  return res.json({ status: "processing", falStatus });
}

// ── GET /ai/models ────────────────────────────────────────────────────────────
router.get("/models", (_req, res) => {
  res.json({ ok: true, provider: "fal.ai", models: AI_ALLOWED_MODELS });
});

// ── POST /ai/generate ─────────────────────────────────────────────────────────
router.post("/generate", async (req, res) => {
  if (!enforceAiRateLimit(req, res)) return;
  try {
    const {
      prompt   = "",
      model    = "flux",
    } = req.body || {};

    const userPrompt = String(prompt || "")
      .split("\n").map(l => l.trim()).filter(l => l.length > 0).join("\n");

    if (!userPrompt)
      return res.status(400).json({ ok: false, message: "prompt is required." });
    if (userPrompt.length < 3 || userPrompt.length > 300)
      return res.status(400).json({ ok: false, message: "prompt must be between 3 and 300 characters." });

    const neonPrompt  = await rewritePromptForNeon(userPrompt);
    const finalPrompt = `Neon sign design, flat 2D illustration, glowing neon tubes, vibrant on white background: ${neonPrompt}`;
    console.log(`[AI_GENERATE] original="${userPrompt}" rewritten="${neonPrompt}"`);

    const modelPath = buildFalModelPath(model);
    const response  = await fetchWithTimeout(
      `https://queue.fal.run/${modelPath}`,
      {
        method: "POST",
        headers: getFalHeaders(),
        body: JSON.stringify({
          prompt: finalPrompt,
          negative_prompt: AI_NEGATIVE_PROMPT,
          num_inference_steps: 35,
          guidance_scale: 9.0,
          image_size: "square"
        })
      }
    );

    const payload = await readJsonSafely(response);
    if (!response.ok) {
      return res.status(502).json({ ok: false, message: payload?.error || payload?.message || "fal.ai generate request failed." });
    }

    const requestId = payload?.request_id || payload?.requestId;
    if (!requestId) return res.status(502).json({ ok: false, message: "fal.ai did not return requestId." });

    aiRequestMeta.set(requestId, { model, modelPath });
    const compositeId = makeCompositeId(modelPath, requestId);
    console.log(`[AI_GENERATE] requestId=${requestId}`);

    return res.json({ requestId: compositeId, status: "processing" });
  } catch (error) {
    console.error("[AI_GENERATE] error:", error?.message, error?.stack);
    const isTimeout = error?.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({
      ok: false,
      message: isTimeout ? "AI generation request timed out." : (error?.message || "Failed to start AI generation."),
      detail: error?.message
    });
  }
});

// ── GET /ai/generate/:requestId ───────────────────────────────────────────────
router.get("/generate/:requestId", async (req, res) => {
  if (!enforceAiRateLimit(req, res)) return;
  try {
    return await pollFalStatus(req.params.requestId, res);
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({
      status: "failed",
      error: isTimeout ? "Timed out." : (error?.message || "Status check failed.")
    });
  }
});

// ── POST /ai/edit ─────────────────────────────────────────────────────────────
// body: { action: "remove_background" | "crop" | "edit", imageUrl: string, prompt?: string }
router.post("/edit", async (req, res) => {
  if (!enforceAiRateLimit(req, res)) return;
  try {
    const { action, imageUrl, prompt } = req.body || {};

    console.log("[AI_EDIT] body:", JSON.stringify({ action, imageUrl, prompt }));
    console.log("[AI_EDIT] FAL_KEY present:", Boolean(FAL_KEY));

    if (!action || !EDIT_MODEL_BY_ACTION[action]) {
      return res.status(400).json({ ok: false, message: "action must be one of: remove_background, crop, edit" });
    }
    if (!imageUrl || typeof imageUrl !== "string") {
      return res.status(400).json({ ok: false, message: "imageUrl is required." });
    }
    if (action === "edit" && (!prompt || !String(prompt).trim())) {
      return res.status(400).json({ ok: false, message: "prompt is required for edit action." });
    }

    const model = EDIT_MODEL_BY_ACTION[action];
    const input = buildEditInput(action, imageUrl, prompt);

    console.log("[AI_EDIT] submitting to fal model:", model);
    console.log("[AI_EDIT] input:", JSON.stringify(input));

    const queueResult = await Promise.race([
      fal.queue.submit(model, { input }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Fal queue submit timed out")), AI_TIMEOUT_MS)
      )
    ]);

    console.log("[AI_EDIT] queueResult:", JSON.stringify(queueResult));

    const compositeId = makeCompositeId(model, queueResult.request_id);
    return res.json({ requestId: compositeId, status: "processing" });
  } catch (error) {
    console.error("[AI_EDIT] error:", error?.message, error?.stack);
    const isTimeout = error?.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({
      ok: false,
      message: isTimeout ? "Request timed out." : (error?.message || "Failed to start edit."),
      detail: error?.message
    });
  }
});

// ── GET /ai/edit/:requestId ───────────────────────────────────────────────────
router.get("/edit/:requestId", async (req, res) => {
  if (!enforceAiRateLimit(req, res)) return;
  const compositeId = String(req.params.requestId || "").trim();
  if (!compositeId) return res.status(400).json({ ok: false, message: "requestId is required." });
  if (!FAL_KEY)     return res.status(500).json({ ok: false, message: "FAL_KEY is not configured." });

  let model, falRequestId;
  try {
    const decoded = parseCompositeId(compositeId);
    model          = decoded.modelPath;
    falRequestId   = decoded.id;
  } catch (_) {
    return res.status(400).json({ ok: false, message: "Invalid or malformed requestId." });
  }

  try {
    const statusResult = await fal.queue.status(model, { requestId: falRequestId, logs: false });

    if (statusResult.status === "COMPLETED") {
      const resultData = await fal.queue.result(model, { requestId: falRequestId });
      const output     = resultData.data || {};
      const images     = output.images ?? (output.image ? [output.image] : []);
      return res.json({
        status: "completed",
        images: images.map(img => ({
          url:          img.url,
          width:        img.width,
          height:       img.height,
          content_type: img.content_type,
        }))
      });
    }

    if (statusResult.status === "FAILED") {
      return res.json({ status: "failed", error: "Job failed on fal.ai." });
    }

    return res.json({ status: "processing" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Status check failed";
    if (message.toLowerCase().includes("failed") || message.toLowerCase().includes("cancelled")) {
      return res.json({ status: "failed", error: message });
    }
    return res.status(500).json({ ok: false, message });
  }
});

// ── POST /ai/remove-background ────────────────────────────────────────────────
router.post("/remove-background", async (req, res) => {
  if (!enforceAiRateLimit(req, res)) return;
  try {
    const { image_url } = req.body || {};
    if (!image_url) return res.status(400).json({ ok: false, message: "image_url is required." });

    const response = await fetchWithTimeout(
      "https://queue.fal.run/fal-ai/birefnet",
      { method: "POST", headers: getFalHeaders(), body: JSON.stringify({ image_url }) },
      AI_TIMEOUT_MS
    );
    const payload = await readJsonSafely(response);
    if (!response.ok) {
      return res.status(502).json({ ok: false, message: payload?.error || payload?.message || "fal.ai birefnet request failed." });
    }
    const requestId = payload?.request_id || payload?.requestId;
    if (!requestId) return res.status(502).json({ ok: false, message: "fal.ai did not return requestId." });

    const compositeId = makeCompositeId("fal-ai/birefnet", requestId);
    return res.json({ requestId: compositeId, status: "processing" });
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({
      ok: false,
      message: isTimeout ? "Request timed out." : (error?.message || "Failed to start background removal.")
    });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildEditInput(action, imageUrl, prompt) {
  if (action === "remove_background") return { image_url: imageUrl };
  if (action === "crop") {
    return {
      image_url: imageUrl,
      prompt: "Tightly crop around the main neon sign artwork. Keep the full sign visible. Do not alter the design. Just crop tightly around the sign edges.",
    };
  }
  return {
    image_url: imageUrl,
    prompt: String(prompt || "").trim() || "Refine this neon sign design while preserving the same subject, text, and colors.",
  };
}

export default router;
