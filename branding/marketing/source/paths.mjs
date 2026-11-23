// The kit folder (branding/marketing), for the scripts here.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
