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

// Supabase Setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Google AI Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const cacheManager = new GoogleAICacheManager(process.env.GEMINI_API_KEY);

// Main Webhook Route
app.post('/', async (req, res) => {
  const { jobId } = req.body;

  if (!jobId) {
    return res.status(400).json({ error: "No jobId provided" });
  }

  // Immediate response to prevent timeout
  res.status(200).json({ message: "Job received, engine starting." });

  let cache;

  try {
    console.log(`🚀 Starting job: ${jobId}`);

    // Fetch job data
    const { data: jobData, error: fetchError } = await supabase
      .from('pptx_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (fetchError || !jobData) {
      throw new Error(`Failed to fetch job data: ${fetchError?.message}`);
    }

    const accountDataPayload = jobData.account_data || jobData.payload;

    console.log(`🧠 Building Context Cache for Job: ${jobId}`);

    // Create Cache
    cache = await cacheManager.create({
      model: 'models/gemini-1.5-pro',
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

    console.log(`✅ Cache created: ${cache.name} (TTL: 600s)`);

    // Bind model to cache (FIXED)
    const cachedModel = genAI.getGenerativeModelFromCachedContent({
      cachedContent: cache.name,
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 8192,
      },
    });

    console.log("⚡ Firing parallel generation workers...");

    // Parallel execution with safety
    const results = await Promise.allSettled([
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

    console.log("🧩 Parallel execution complete. Processing outputs...");

    // Safely extract responses
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
    console.error(`🔥 Engine failure for job ${jobId}:`, error);

    await supabase
      .from('pptx_jobs')
      .update({
        status: 'failed',
        error_message: error.message,
      })
      .eq('id', jobId);

  } finally {
    // Cleanup cache to stop billing
    if (cache && cache.name) {
      console.log(`🧹 Deleting cache: ${cache.name}`);
      await cacheManager.delete(cache.name)
        .catch(e => console.error("Failed to delete cache:", e));
    }
  }
});

// Start server
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`🚀 Qraft Railway Engine running on port ${port}`);
});
