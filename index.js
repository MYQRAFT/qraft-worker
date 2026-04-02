const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

// Initialize Express App
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Environment validation
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const apiKey = process.env.CLAUDE_API_KEY;
const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

if (!supabaseUrl || !supabaseKey || !apiKey) {
  throw new Error("Missing required environment variables.");
}

// Supabase Setup
const supabase = createClient(supabaseUrl, supabaseKey);

// Claude Setup
const client = new Anthropic({ apiKey });

// Main Webhook Route
app.post('/', async (req, res) => {
  const { jobId } = req.body;

  if (!jobId) {
    return res.status(400).json({ error: "No jobId provided" });
  }

  // Immediate response
  res.status(200).json({ message: "Job received, engine starting." });

  try {
    console.log(`🚀 Starting job: ${jobId}`);

    // --- RETRY FETCH LOGIC (SAFE) ---
    let jobData = null;
    let retries = 3;

    while (retries > 0 && !jobData) {
      const { data, error } = await supabase
        .from('pptx_jobs')
        .select('*')
        .eq('id', jobId)
        .maybeSingle(); // FIXED

      if (data) {
        jobData = data;
        console.log(`✅ Job data retrieved for ${jobId}`);
      } else {
        console.log(`⚠️ Job not found yet. Retrying in 2s... (${retries} left)`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        retries--;
      }
    }

    if (!jobData) {
      throw new Error(`Job not found after retries. ID: ${jobId}`);
    }
    // --- END FETCH LOGIC ---

    // Ensure status is processing (safety)
    await supabase
      .from('pptx_jobs')
      .update({ status: 'processing' })
      .eq('id', jobId);

    const accountDataPayload = jobData.account_data || jobData.payload;

    if (!accountDataPayload) {
      throw new Error("No account data payload found in job.");
    }

    console.log(`🧠 Building context for Claude with prompt caching...`);

    // Prepare system prompt with cache control
    const systemPrompt = `You are a Senior Customer Success Manager with 10+ years of enterprise SaaS experience, trained in McKinsey-style executive communication.

Write in a boardroom-ready tone:
- Insight-driven, not descriptive
- Hypothesis-led thinking
- Highlight risks, drivers, and business implications
- Avoid generic statements

Style:
- Concise, sharp, and structured
- No fluff, no filler, no repetition
- Each section should feel like a slide narrative

Output:
- Strict markdown
- No introductions or conclusions
- No meta commentary`;

    const accountDataText = `ACCOUNT DATA:\n${JSON.stringify(accountDataPayload)}`;

    // Timeout protection (3 minutes)
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("AI generation timeout")), 180000)
    );

    console.log("⚡ Firing parallel generation workers with Claude...");

    const generationPromise = Promise.allSettled([
      client.messages.create({
        model: model,
        max_tokens: 8192,
        temperature: 0.7,
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" }
          },
          {
            type: "text",
            text: accountDataText,
            cache_control: { type: "ephemeral" }
          }
        ],
        messages: [
          {
            role: "user",
            content: "You are generating part 1 of a 10-slide narrative. Write Sections 1, 2, and 3. Maintain consistency in tone and insight. Output ONLY markdown."
          }
        ]
      }),
      client.messages.create({
        model: model,
        max_tokens: 8192,
        temperature: 0.7,
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" }
          },
          {
            type: "text",
            text: accountDataText,
            cache_control: { type: "ephemeral" }
          }
        ],
        messages: [
          {
            role: "user",
            content: "You are generating part 2 of a 10-slide narrative. Write Sections 4, 5, 6, and 7. Maintain consistency with earlier sections. Output ONLY markdown."
          }
        ]
      }),
      client.messages.create({
        model: model,
        max_tokens: 8192,
        temperature: 0.7,
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" }
          },
          {
            type: "text",
            text: accountDataText,
            cache_control: { type: "ephemeral" }
          }
        ],
        messages: [
          {
            role: "user",
            content: "You are generating part 3 of a 10-slide narrative. Write Sections 8, 9, and 10. Maintain consistency with earlier sections. Output ONLY markdown."
          }
        ]
      })
    ]);

    const results = await Promise.race([
      generationPromise,
      timeoutPromise
    ]);

    console.log("🧩 Generation complete. Processing outputs...");

    // Process responses
    const responses = results.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value.content[0].text;
      } else {
        console.error(`❌ Section group ${index + 1} failed:`, result.reason);
        return `## Section Group ${index + 1}\nGeneration failed.\n`;
      }
    });

    const finalNarrative = responses.join("\n\n");

    // Save result
    const { error: updateError } = await supabase
      .from('pptx_jobs')
      .update({
        status: 'completed',
        refined_content: finalNarrative,
      })
      .eq('id', jobId);

    if (updateError) {
      throw new Error(`Failed to save results: ${updateError.message}`);
    }

    console.log(`🎉 Job ${jobId} completed successfully`);

  } catch (error) {
    console.error(`🔥 Engine failure for job ${jobId}:`, {
      message: error.message,
      stack: error.stack,
    });

    await supabase
      .from('pptx_jobs')
      .update({
        status: 'failed',
        error_message: error.message,
      })
      .eq('id', jobId);
  }
});

// Start server
const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Qraft Railway Engine running on port ${port}`);
});
