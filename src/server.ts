// Starts the server. Vercel picks this file up as its entry point too.

import http from "node:http";
import { handle } from "./routes.ts";
import { formatDayTime, now } from "./clock.ts";

const PORT = Number(process.env.PORT ?? 3000);

http.createServer(handle).listen(PORT, () => {
  console.log(`chat agent on http://localhost:${PORT}  (it's ${formatDayTime(now())})`);
  if (!process.env.GEMINI_API_KEY) console.warn("GEMINI_API_KEY is not set. Copy .env.example to .env and add it.");
});
