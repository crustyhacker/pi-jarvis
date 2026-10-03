// Used only by a temp mcp.json !command to detect accidental expansion while off.
import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], "expanded\n");
process.stdout.write("fixture-expanded");
