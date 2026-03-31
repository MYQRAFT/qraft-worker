import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log("Worker started...");

setInterval(async () => {
  console.log("Checking for jobs...");

  const { data: jobs } = await supabase
    .from("pptx_jobs")
    .select("*")
    .eq("status", "pending")
    .limit(1);

  if (jobs && jobs.length > 0) {
    const job = jobs[0];
    console.log("Processing job:", job.id);

    await supabase
      .from("pptx_jobs")
      .update({ status: "completed" })
      .eq("id", job.id);
  }
}, 5000);