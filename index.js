const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// ===== CONFIG =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const GEMINI_TIMEOUT_MS = 900_000;

// ===== PROMPTS =====
const PERSONA_ANCHOR = `POINT OF VIEW: Write as the accountable owner of this account. Use assertive, experience-backed statements — not neutral observations. You are the strategist who owns the outcome, not a spectator summarizing from the sidelines. Say "I drove," "We committed," "This quarter exposed" — never "It was observed that."`;

const GLOBAL_RULES = `GLOBAL RULES:
- Use numerals for all numbers. Use appropriate currency symbols.
- Concise, executive paragraphs. No bullet points. No hyphens or dashes for lists. Paragraph prose only.
- NON-REPETITION RULE: Do not restate previously established facts, metrics, or insights unless directly building on them with new analysis.
- IMPERFECT REALISM: Maintain slight asymmetry in sentence structure. Vary paragraph length. Avoid overly polished or consultant-generic cadence. Write like a sharp human, not a template.
- BANNED WORDS: Moreover, Furthermore, Landscape, Tapestry, Foster, Synergies, Deep dive, Holistic, Delve, robust, seamless, leverage, comprehensive, pivotal, cutting-edge.
- THE 'SO-WHAT' HEADLINE RULE: Every ## heading must be an action-oriented assertion of EXACTLY 4 words.
- SCR IN EVERY SECTION: Each section must contain Situation (current facts with metrics), Complication (blocker/gap with quantified impact), and Resolution (concrete next move with owner and timeline).
- DATA TAGS: Include [HERO_METRIC], [METRICS], [TIMELINE], [COMPARISON], and [CALLOUT] tags. Use at most ONE data tag plus the mandatory [CALLOUT] per section. Never repeat the same data tag type consecutively.
- OPERATIONAL ANCHORING: Use exact names, dollar amounts, and ticket numbers from input.
- SECTION INTEGRITY: Each section must serve a distinct analytical purpose. Do not blur boundaries or duplicate themes across multiple sections.`;

const INTERNAL_RULES = `TONE MODE: INTERNAL (War-Room)
- Use direct, unfiltered language. Say 'blocks,' 'threatens,' 'fails' when accurate.
- Name specific individuals in ALL contexts for full accountability.
- Write like a blunt internal strategy memo. Short, sharp, unpolished.
- Highlight risks clearly. Call out ownership gaps. Prioritize accuracy over diplomacy.`;

const EXTERNAL_RULES = `TONE MODE: EXTERNAL (Client-Facing)
- Replace confrontational verbs with diplomatic alternatives: "may impact," "creates a variance in."
- Frame complications as "Targeted Opportunity" or "Realizable Value."
- STRATEGIC ANONYMITY: Never name individuals in negative context. Aggregate into functional groups.
- Professional, constructive, partnership-oriented. Emphasize collaboration and forward motion.
- Keep metrics brutal and concrete — only the framing is diplomatic.`;

// ===== HELPERS =====

function buildRawData(fd) {
  const cs = fd.currencySymbol || "$";
  return `Account Name: ${fd.accountName || ""}
Industry: ${fd.industry || ""} | Company Size: ${fd.companySize || ""}
Contract Value: ${cs}${fd.contractValue || ""} | Renewal Date: ${fd.renewalDate || ""}
Licensed Users: ${fd.licensedUsers || ""} | Active Users: ${fd.activeUsers || ""}
Primary Use Case: ${fd.primaryUseCase || ""}
Key Stakeholder: ${fd.stakeholderName || ""}, ${fd.stakeholderTitle || ""}

LAST QUARTER:
Goals Set: ${fd.goalsSet || ""} | Goals Achieved: ${fd.goalsAchieved || ""} | Goals Missed: ${fd.goalsMissed || ""}
Usage Highlights: ${fd.usageHighlights || ""}
Key Wins: ${fd.keyWins || ""} | Key Challenges: ${fd.keyChallenges || ""}
Support Tickets: ${fd.supportTickets || ""} | Avg Resolution Time: ${fd.avgResolutionTime || ""} | Escalations: ${fd.escalations || ""}

HEALTH & SENTIMENT:
Account Health: ${fd.accountHealth || ""} | Customer Sentiment: ${fd.customerSentiment || ""}
Expansion Opportunity: ${fd.expansionOpportunity || ""} | Renewal Risk: ${fd.renewalRisk || ""}
Relationship Notes: ${fd.relationshipNotes || ""}

TECHNICAL BLOCKERS:
Support Ticket Number: ${fd.supportTicketNumber || "None"}
Ticket Description: ${fd.ticketDescription || "None"}
Ticket Status/Comments: ${fd.ticketStatusComments || "None"}

NEXT QUARTER:
Goals: ${fd.nextQuarterGoals || ""} | Key Initiatives: ${fd.keyInitiatives || ""}
Upcoming Renewal Discussion: ${fd.renewalDiscussion || ""}
Additional Context: ${fd.additionalContext || ""}
Currency Symbol: ${cs}`;
}

async function updateJob(supabase, jobId, updates) {
  const { error } = await supabase.from("pptx_jobs").update(updates).eq("id", jobId);
  if (error) console.error("Failed to update job:", error);
}

async function callGemini(apiKey, model, systemPrompt, userContent, maxTokens) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\n" + userContent }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error [${response.status}]: ${errorText}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason === "MAX_TOKENS") {
      console.warn(`Warning: Gemini output truncated (MAX_TOKENS) for model ${model}. maxOutputTokens=${maxTokens}`);
    }
    return candidate?.content?.parts?.[0]?.text || "";
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Gemini request timed out after ${Math.round(GEMINI_TIMEOUT_MS / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function generateFullNarrative(apiKey, rawData, toneMode) {
  const prompt = `${PERSONA_ANCHOR}
${GLOBAL_RULES}
${toneMode === "Internal" ? INTERNAL_RULES : EXTERNAL_RULES}

You are the Senior CSM who owns this account. Generate the COMPLETE 10-section QBR executive narrative in a SINGLE pass.

CRITICAL INSTRUCTIONS:
- Return ALL 10 sections in full. Do not truncate, summarize, or abbreviate any section.
- Each section must have a ## heading of EXACTLY 4 words, followed by SCR (Situation-Complication-Resolution) paragraphs.
- Separate each section with --- on its own line.
- Ensure McKinsey-style horizontal logic: themes introduced in early sections must thread through and resolve in later sections.
- Each section serves a DISTINCT analytical purpose. No overlap or theme blurring.

THE 10 SECTIONS (in order):
1. Executive Summary — SCR framework overview of the entire account quarter.
2. Account Overview & Goals — Strategic context, contract posture, and quarterly objectives.
3. Goal Achievement Analysis — What was hit, what was missed, and the why behind each.
4. Usage & Adoption Analysis — License utilization, adoption curves, feature engagement.
5. ROI & Value Delivered — Quantified business impact and value realization.
6. Technical Challenges & Support — Support burden, escalations, ticket analysis.
7. Stakeholder Engagement — Relationship mapping, champion/detractor dynamics.
8. Risk Assessment & Mitigation — Renewal threats, competitive pressure, mitigation plays.
9. Renewal Strategy & Expansion — Upsell/cross-sell positioning, expansion roadmap.
10. Next Quarter Action Plan — Concrete commitments with owners, dates, and success criteria.

NARRATIVE ARC:
- Sections 1-3 (SETUP): Establish facts, celebrate wins, surface the core tension.
- Sections 4-7 (EXPANSION): Deepen analysis, quantify gaps, map stakeholder dynamics.
- Sections 8-10 (RESOLUTION): Confront risks, lay out strategy, commit to next moves.

RAW ACCOUNT DATA:
${rawData}

OUTPUT FORMAT: Return ONLY the 10 sections in Markdown. No preamble, no JSON, no metadata. Start directly with the ## heading of Section 1.`;

  return await callGemini(apiKey, "gemini-3.1-pro-preview", prompt, "", 16000);
}

async function auditPass(apiKey, fullNarrative) {
  const prompt = `You are a senior editor performing a final connective audit on a QBR narrative.

RULES:
- FACTUAL INTEGRITY SAFEGUARD: Do not alter any metrics, numbers, dollar amounts, dates, or factual statements under any condition.
- THE 20% RULE: If your proposed edits would modify more than 20% of a section's original text, discard your changes for that section and return the original text verbatim.
- Do NOT rewrite full sections. Only smooth transitions between sections.
- Remove filler phrases: "Moving on", "In this section", "As mentioned", "It is worth noting", "Let's now turn to".
- Verify all ## headings are exactly 4 words. Fix any that are not.
- Ensure no fact is repeated across sections.
- Output the COMPLETE corrected narrative in Markdown.
- Do NOT add new content. Only fix transitions and headings.

NARRATIVE TO AUDIT:
${fullNarrative}`;

  return await callGemini(apiKey, "gemini-3-flash-preview", prompt, "", 16000);
}

function translateError(rawMessage) {
  if (rawMessage.includes("503") || rawMessage.toLowerCase().includes("high demand") || rawMessage.includes("UNAVAILABLE")) {
    return "Our strategy engines are currently at peak capacity. Please wait 60 seconds, then click 'Resume'.";
  }
  if (rawMessage.includes("429") || rawMessage.toLowerCase().includes("rate limit") || rawMessage.includes("RESOURCE_EXHAUSTED")) {
    return "We are processing a high volume of reviews. Please wait 60 seconds, then click 'Resume' to continue your analysis.";
  }
  if (rawMessage.toLowerCase().includes("timed out") || rawMessage.includes("timeout") || rawMessage.includes("aborted")) {
    return "Narrative synthesis for this section is taking longer than expected due to account complexity. Please click 'Resume' to continue.";
  }
  return "An unexpected interruption occurred during the audit pass. Please click 'Resume' to finalize the narrative.";
}

// ===== MAIN ROUTE =====

app.post("/", async (req, res) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { jobId } = req.body;

  if (!jobId) {
    return res.status(400).json({ error: "Missing jobId" });
  }

  // Respond immediately so the frontend doesn't hang
  res.status(202).json({ success: true, jobId });

  // Process in background
  try {
    const { data: job, error: fetchError } = await supabase.from("pptx_jobs").select("*").eq("id", jobId).single();
    if (fetchError || !job) {
      console.error("Database rejection for Job", jobId, "Error:", fetchError);
      return;
    }
    if (job.status !== "pending" && job.status !== "stalled") {
      console.log("Job not in resumable state:", job.status);
      return;
    }

    if (!GEMINI_API_KEY) {
      await updateJob(supabase, jobId, { status: "failed", error_message: "GEMINI_API_KEY is not configured" });
      return;
    }

    const payload = job.payload;
    const toneMode = payload.toneMode || "External";
    const accountName = payload.accountName || "";
    const rawData = buildRawData(payload);

    // SINGLE-PASS GENERATION
    await updateJob(supabase, jobId, { status: "processing", progress_message: "Generating executive narrative..." });

    const fullDraft = await generateFullNarrative(GEMINI_API_KEY, rawData, toneMode);

    if (!fullDraft || fullDraft.trim().length < 200) {
      throw new Error("Generation returned insufficient content");
    }

    await updateJob(supabase, jobId, { refined_content: fullDraft, progress_message: "Performing final audit..." });

    // AUDIT PASS
    const auditedNarrative = await auditPass(GEMINI_API_KEY, fullDraft);
    const finalNarrative = auditedNarrative && auditedNarrative.trim().length > 200 ? auditedNarrative : fullDraft;

    // SAVE TO BUSINESS_REVIEWS
    const { error: reviewError } = await supabase
      .from("business_reviews")
      .insert([{
        user_id: job.user_id,
        account_name: accountName,
        form_data: payload,
        generated_review: finalNarrative,
      }]);
    if (reviewError) console.error("Failed to save to business_reviews:", reviewError);

    await updateJob(supabase, jobId, {
      status: "completed",
      refined_content: finalNarrative,
      progress_message: "Generation complete",
    });

    // EMAIL NOTIFICATION
    if (payload.notifyEmail === true && RESEND_API_KEY) {
      try {
        const { data: userData } = await supabase.auth.admin.getUserById(job.user_id);
        const userEmail = userData?.user?.email;
        if (userEmail) {
          const displayName = userEmail.split("@")[0];
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "QRAFT <onboarding@resend.dev>",
              to: [userEmail],
              subject: `QRAFT: ${accountName || "Your"} Executive Review is Ready`,
              html: `<div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 20px;">
                <h2 style="color: #1A1730; margin-bottom: 16px;">Hi ${displayName},</h2>
                <p style="color: #333; line-height: 1.6; margin-bottom: 16px;">
                  Your executive review for <strong>${accountName || "your account"}</strong> is complete and ready for viewing.
                </p>
                <a href="https://qraft-br-insights.lovable.app/dashboard"
                   style="display: inline-block; background: #BD0A25; color: #fff; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: 600;">
                  View Your Review
                </a>
                <p style="color: #999; font-size: 12px; margin-top: 32px;">— QRAFT AI</p>
              </div>`,
            }),
          });
        }
      } catch (emailErr) {
        console.error("Email notification failed (non-blocking):", emailErr);
      }
    }

    console.log(`Job ${jobId} completed successfully.`);
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    const rawMessage = error instanceof Error ? error.message : "Unknown error";
    const userMessage = translateError(rawMessage);
    await updateJob(supabase, jobId, {
      status: "failed",
      progress_message: "Generation failed",
      error_message: userMessage,
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "qraft-engine" });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`QRAFT Engine listening on 0.0.0.0:${PORT}`);
});
