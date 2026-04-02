const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAICacheManager } = require('@google/generative-ai/server');

// Initialize Express App
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Environment validation
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const apiKey = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseKey || !apiKey) {
  throw new Error("Missing required environment variables.");
}

// Supabase Setup
const supabase = createClient(supabaseUrl, supabaseKey);

// Google AI Setup
const genAI = new GoogleGenerativeAI(apiKey);
const cacheManager = new GoogleAICacheManager(apiKey);

// Main Webhook Route
app.post('/', async (req, res) => {
  const { jobId } = req.body;

  if (!jobId) {
    return res.status(400).json({ error: "No jobId provided" });
  }

  // Immediate response
  res.status(200).json({ message: "Job received, engine starting." });

  let cache;

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

    console.log(`🧠 Building Context Cache for Job: ${jobId}`);

    // Create Cache
    cache = await cacheManager.create({
      model: 'models/gemini-1.5-pro-002',
      displayName: `qraft-job-${jobId}`,
      systemInstruction: `
You are a Senior Customer Success Manager with 10+ years of enterprise SaaS experience, trained in McKinsey-style executive communication.

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
- No meta commentary
`,
      ttlSeconds: 600,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `ACCOUNT DATA:\n${JSON.stringify(accountDataPayload)}`
            }
          ],
        },
      ],
    });

    console.log(`✅ Cache created: ${cache.name}`);

    // Bind model to cache
    const cachedModel = genAI.getGenerativeModelFromCachedContent({
      cachedContent: cache.name,
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 8192,
      },
    });

    console.log("⚡ Firing parallel generation workers...");

    // Timeout protection (3 minutes)
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("AI generation timeout")), 180000)
    );

    const generationPromise = Promise.allSettled([
      cachedModel.generateContent(
        "You are generating part 1 of a 10-slide narrative. Write Sections 1, 2, and 3. Maintain consistency in tone and insight. Output ONLY markdown."
      ),
      cachedModel.generateContent(
        "You are generating part 2 of a 10-slide narrative. Write Sections 4, 5, 6, and 7. Maintain consistency with earlier sections. Output ONLY markdown."
      ),
      cachedModel.generateContent(
        "You are generating part 3 of a 10-slide narrative. Write Sections 8, 9, and 10. Maintain consistency with earlier sections. Output ONLY markdown."
      )
    ]);

    const results = await Promise.race([
      generationPromise,
      timeoutPromise
    ]);

    console.log("🧩 Generation complete. Processing outputs...");

    // Process responses
    const responses = results.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value.response.text();
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

  } finally {
    // Cleanup cache
    if (cache && cache.name) {
      console.log(`🧹 Deleting cache: ${cache.name}`);
      await cacheManager.delete(cache.name)
        .catch(e => console.error("Failed to delete cache:", e));
    }
  }
});

// Start server
const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Qraft Railway Engine running on port ${port}`);
});
