// Junta los planes de cada marca en plan.json y lo cifra a plan.enc para el repositorio público.
// Uso: DASHBOARD_PASSWORD='...' node tools/seal-plan.mjs
import { readFile, writeFile } from "node:fs/promises";
import { seal } from "../scripts/crypto.mjs";

const BRANDS = ["twins", "nook"];
const password = process.env.DASHBOARD_PASSWORD;
if (!password) throw new Error("Falta DASHBOARD_PASSWORD");
const brands = [];
for (const id of BRANDS) brands.push(JSON.parse(await readFile(new URL(`../plan-${id}.json`, import.meta.url), "utf8")));
const plan = { brands };
await writeFile(new URL("../plan.json", import.meta.url), JSON.stringify(plan));
await writeFile(new URL("../plan.enc", import.meta.url), await seal(plan, password));
console.log(`plan.enc listo · ${brands.map((b) => b.name).join(" + ")}`);
