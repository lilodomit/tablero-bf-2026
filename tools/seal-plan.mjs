// Cifra plan.json a plan.enc para poder guardar las metas en un repositorio público.
// Uso: DASHBOARD_PASSWORD='...' node tools/seal-plan.mjs
import { readFile, writeFile } from "node:fs/promises";
import { seal } from "../scripts/crypto.mjs";

const password = process.env.DASHBOARD_PASSWORD;
if (!password) throw new Error("Falta DASHBOARD_PASSWORD");
const plan = JSON.parse(await readFile(new URL("../plan.json", import.meta.url), "utf8"));
await writeFile(new URL("../plan.enc", import.meta.url), await seal(plan, password));
console.log("plan.enc listo");
