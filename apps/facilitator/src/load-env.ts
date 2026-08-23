/**
 * Loads the monorepo's single root .env (see the "Consolidate to single root
 * .env" post-build task) rather than any per-package .env file. Kept as its
 * own module, imported first (see server.ts), so its dotenv.config() call is
 * guaranteed to run before any sibling import's top-level code -- notably
 * razorpay/client.ts and store/{db,redis}.ts, which read process.env eagerly
 * at module scope.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// This file lives at apps/facilitator/src, so the repo root is three levels up.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") });
