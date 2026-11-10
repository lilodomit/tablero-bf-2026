// Jala Shopify y Klaviyo directo, Meta por Windsor, para cada marca; calcula y escribe site/data.enc cifrado.
// Lo corre GitHub Actions. Solo trabaja con datos reales y no usa ningún MCP.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compute, general, mexicoNow } from "./compute.mjs";
import { open, seal } from "./crypto.mjs";
import { loadShopify } from "./shopify.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { DASHBOARD_PASSWORD: PASSWORD, WINDSOR_API_KEY: WINDSOR, GITHUB_REPOSITORY: REPO } = process.env;
if (!PASSWORD) throw new Error("Falta DASHBOARD_PASSWORD");

// Llaves de cada marca en los secrets de GitHub. Twins conserva los nombres originales.
const KEYS = {
  twins: { shopifyId: "SHOPIFY_CLIENT_ID", shopifySecret: "SHOPIFY_CLIENT_SECRET", klaviyo: "KLAVIYO_PRIVATE_KEY" },
  nook: { shopifyId: "NOOK_SHOPIFY_CLIENT_ID", shopifySecret: "NOOK_SHOPIFY_CLIENT_SECRET", klaviyo: "NOOK_KLAVIYO_PRIVATE_KEY" },
};
const keysFor = (id) => Object.fromEntries(Object.entries(KEYS[id]).map(([k, name]) => [k, process.env[name]]));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function windsor(connector, account, accountName, fields, from, to) {
  const query = (withAccount) => {
    const params = new URLSearchParams({ api_key: WINDSOR, fields: ["account_name", ...fields].join(",") });
    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);
    if (withAccount) params.set("select_accounts", `${connector}__${account}`);
    return `https://connectors.windsor.ai/${connector}?${params}`;
  };
  for (const withAccount of [true, false]) {
    const response = await fetch(query(withAccount));
    if (!response.ok) {
      if (withAccount) continue;
      throw new Error(`Windsor ${connector} respondió ${response.status}`);
    }
    const rows = ((await response.json()).data ?? []).filter((row) => row.account_name === accountName);
    if (rows.length || !withAccount) return rows;
  }
  return [];
}

export async function loadKlaviyo(plan, generatedAt, key) {
  const klaviyoRequest = async (url, body) => {
    const response = await fetch(url.startsWith("https://") ? url : `https://a.klaviyo.com/api/${url}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: "2024-10-15", accept: "application/json", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`Klaviyo ${url.split("?")[0]} respondió ${response.status}`);
    return response.json();
  };
  const timeframe = { start: `${plan.promoStart}T06:00:00+00:00`, end: generatedAt };
  const campaignReport = await klaviyoRequest("campaign-values-reports/", {
    data: { type: "campaign-values-report", attributes: { timeframe, conversion_metric_id: plan.klaviyoPlacedOrder, statistics: ["recipients", "conversion_value"], filter: 'equals(send_channel,"email")' } },
  });
  await sleep(32000);
  // Por hora y solo ayer + hoy: el reporte diario de Klaviyo corta los días en UTC, no en hora de México.
  const today = mexicoNow(generatedAt).date;
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const flowReport = await klaviyoRequest("flow-series-reports/", {
    data: { type: "flow-series-report", attributes: { timeframe: { start: `${yesterday}T06:00:00+00:00`, end: generatedAt }, interval: "hourly", conversion_metric_id: plan.klaviyoPlacedOrder, statistics: ["conversion_value"] } },
  });
  const list = await klaviyoRequest(`campaigns/?filter=equals(messages.channel,'email'),greater-or-equal(scheduled_at,${plan.promoStart}T00:00:00Z)&fields[campaign]=name,send_time`);
  const names = Object.fromEntries(list.data.map((c) => [c.id, c.attributes]));

  const flowNames = {};
  for (let next = "flows/?fields[flow]=name"; next; ) {
    const page = await klaviyoRequest(next);
    for (const flow of page.data) flowNames[flow.id] = flow.attributes.name;
    next = page.links?.next ?? null;
  }

  const flowsByDate = {};
  const perFlow = {};
  const dates = flowReport.data.attributes.date_times.map((d) => mexicoNow(d).date);
  for (const row of flowReport.data.attributes.results) {
    const id = row.groupings.flow_id;
    perFlow[id] ??= { name: flowNames[id] ?? "Flow", byDate: {} };
    row.statistics.conversion_value.forEach((value, index) => {
      flowsByDate[dates[index]] = (flowsByDate[dates[index]] ?? 0) + value;
      perFlow[id].byDate[dates[index]] = (perFlow[id].byDate[dates[index]] ?? 0) + value;
    });
  }
  const campaigns = campaignReport.data.attributes.results.map((row) => {
    const info = names[row.groupings.campaign_id] ?? {};
    return {
      name: info.name ?? "Campaña",
      send: info.send_time ?? null,
      local: info.send_time ? mexicoNow(info.send_time).date : null,
      hour: info.send_time ? mexicoNow(info.send_time) : null,
      revenue: row.statistics.conversion_value,
      recipients: row.statistics.recipients,
    };
  });
  return { at: generatedAt, campaigns, flowsByDate, flows: Object.values(perFlow) };
}

async function previousSnapshot() {
  if (!REPO) return null;
  const [owner, repo] = REPO.split("/");
  try {
    const response = await fetch(`https://${owner}.github.io/${repo}/data.enc?ts=${Date.now()}`);
    return response.ok ? open(await response.text(), PASSWORD) : null;
  } catch {
    return null;
  }
}

async function loadRaw(plan, generatedAt, keys) {
  const today = mexicoNow(generatedAt).date;
  const ads = (fields, from, to) => windsor("facebook", plan.metaAccount, plan.metaAccountName, fields, from, to);

  const [shopify, meta, adRows, metaCampaigns] = await Promise.all([
    loadShopify(plan, generatedAt, { clientId: keys.shopifyId, clientSecret: keys.shopifySecret }),
    ads(["date", "spend", "cpm", "frequency"], "2026-11-01", today),
    ads(["ad_name", "spend", "actions_omni_purchase", "purchase_roas_omni_purchase"], today, today),
    // Por campaña, para separar el gasto en clientes existentes del de nuevos. Si falla, el NC-ROAS usa el gasto total.
    ads(["date", "campaign", "spend"], "2026-11-01", today).catch(() => []),
  ]);
  return { ...shopify, meta, ads: adRows, metaCampaigns };
}

// El tablero de antes era de una sola marca (Twins): se lee como tal.
function previousBrand(previous, id) {
  if (!previous) return null;
  if (previous.brands) return previous.brands[id] ?? null;
  return id === "twins" ? previous : null;
}

async function runBrand(plan, generatedAt, previous) {
  const keys = keysFor(plan.id);
  if (!keys.shopifyId || !keys.shopifySecret) throw new Error("faltan las llaves de Shopify");
  const raw = { generatedAt, ...(await loadRaw(plan, generatedAt, keys)) };
  // Sin gasto real la regla de Meta diría algo falso: mejor falla y queda el último dato bueno.
  if (!raw.meta.length) throw new Error("Windsor no regresó datos de Meta");
  const minute = new Date(generatedAt).getUTCMinutes();
  raw.klaviyo = previous?.rawKlaviyo ?? null;
  if (keys.klaviyo && (minute % 30 < 5 || !raw.klaviyo)) {
    try {
      raw.klaviyo = await loadKlaviyo(plan, generatedAt, keys.klaviyo);
    } catch (error) {
      console.warn(`${plan.id}: Klaviyo no respondió, se conserva el dato anterior (${error.message})`);
    }
  }
  const spend = raw.meta.find((row) => row.date === raw.today)?.spend ?? 0;
  const last = previous?.meta?.track;
  raw.metaTrack = last && last.spend === spend && last.date === raw.today ? last : { spend, date: raw.today, changedAt: generatedAt };
  const output = { ...compute(raw, plan), rawKlaviyo: raw.klaviyo };
  // El registro de Actions es público: aquí nunca van montos.
  console.log(`OK ${plan.id} ${output.today} ${output.now.hour}:${output.now.minute} · Meta ${raw.meta.length} días · anuncios ${raw.ads.length} · campañas ${raw.metaCampaigns.length} · Klaviyo ${raw.klaviyo ? "sí" : "no"}`);
  return output;
}

export async function main() {
  const generatedAt = new Date().toISOString();
  const plan = await open(await readFile(path.join(ROOT, "plan.enc"), "utf8"), PASSWORD);
  if (!WINDSOR) throw new Error("Falta WINDSOR_API_KEY");
  const previous = await previousSnapshot();

  const results = await Promise.all(plan.brands.map(async (brandPlan) => {
    const before = previousBrand(previous, brandPlan.id);
    try {
      return await runBrand(brandPlan, generatedAt, before);
    } catch (error) {
      // Una marca que falla no tumba a la otra: se queda con su último dato bueno, marcado como atrasado.
      console.warn(`${brandPlan.id}: no se actualizó (${error.message})`);
      return before ? { ...before, stale: true } : { id: brandPlan.id, name: brandPlan.name, error: true };
    }
  }));
  if (results.every((r) => r.error || r.stale)) throw new Error("Ninguna marca se pudo actualizar");

  const brands = Object.fromEntries(results.map((r) => [r.id, r]));
  const output = {
    generatedAt,
    order: plan.brands.map((b) => b.id),
    brands,
    general: general(results.filter((r) => !r.error), generatedAt),
  };
  await writeFile(path.join(ROOT, "site", "data.enc"), await seal(output, PASSWORD));
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
