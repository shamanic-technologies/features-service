import { writeFileSync } from "node:fs";
import { openApiDocument } from "../src/lib/openapi.js";

writeFileSync("openapi.json", JSON.stringify(openApiDocument, null, 2) + "\n");
console.log("Generated openapi.json");
