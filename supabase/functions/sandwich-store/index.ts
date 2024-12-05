// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_ANON_KEY")!
);

Deno.serve(async (req) => {
  const { data } = await req.json()
  if (!data || data.length === 0) {
    return new Response(
      JSON.stringify({ msg: "No data provided" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  let successCount = 0;
  const results = await Promise.all(data.map(async (item: any) => {
    const { error } = await supabase.from("sandwich").insert([{
      slot_number: item.slot_number,
      block_time: item.block_time,
      blockhash: item.blockhash,
      frontrun_tx: item.frontrun_tx,
      victim_tx: item.victim_tx,
      backrun_tx: item.backrun_tx,
      attacker: item.attacker
    }]);
    if (!error) {
      return true;
    } else {
      console.error(error);
      return false;
    }
  }));

  successCount = results.filter(Boolean).length;
  console.log(`${successCount}/${data.length} sandwiches stored`);
  return new Response(
    JSON.stringify({ msg: "success" }),
    { headers: { "Content-Type": "application/json" } },
  );
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/sandwich-store' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
