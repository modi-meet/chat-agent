// Puts the sample conversations into memory. Run it again any time.

import "dotenv/config";
import { seed } from "../src/seed.ts";

seed(console.log);
