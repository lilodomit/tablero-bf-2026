// Lee las órdenes directo de la API de Shopify, con la app de la tienda de Twins.
// No depende de ningún MCP ni de Windsor: la tienda queda fija en plan.shop.
import { mexicoNow } from "./compute.mjs";

const API_VERSION = "2026-07";
const MAX_RETRIES = 6;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const money = (set) => Number(set?.shopMoney?.amount ?? 0);

const ORDERS_QUERY = `query($cursor: String, $filter: String!) {
  orders(first: 250, after: $cursor, sortKey: CREATED_AT, query: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes {
      name createdAt cancelledAt
      app { name }
      channelInformation { channelDefinition { channelName } }
      totalPriceSet { shopMoney { amount } }
      currentTotalPriceSet { shopMoney { amount } }
      currentTotalTaxSet { shopMoney { amount } }
      currentShippingPriceSet { shopMoney { amount } }
      currentSubtotalPriceSet { shopMoney { amount } }
      shippingLines(first: 5) { nodes { taxLines { priceSet { shopMoney { amount } } } } }
      customerJourneySummary { customerOrderIndex }
      lineItems(first: 50) {
        nodes {
          title variantTitle quantity currentQuantity
          variant { inventoryQuantity inventoryItem { unitCost { amount } } }
        }
      }
    }
  }
}`;

async function accessToken(shop, clientId, clientSecret) {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) throw new Error(`Shopify no dio acceso: ${response.status}`);
  return (await response.json()).access_token;
}

async function graphql(shop, token, variables) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query: ORDERS_QUERY, variables }),
    });
    if (response.status === 429 || response.status >= 500) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!response.ok) throw new Error(`Shopify respondió ${response.status}`);
    const body = await response.json();
    if (body.errors?.some((error) => error.extensions?.code === "THROTTLED")) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (body.errors) throw new Error(`Shopify: ${body.errors[0].message}`);
    return body.data.orders;
  }
  throw new Error("Shopify siguió saturado después de varios intentos");
}

async function allOrders(shop, token, from) {
  const filter = `created_at:>='${from}T00:00:00-06:00'`;
  const orders = [];
  let cursor = null;
  do {
    const page = await graphql(shop, token, { cursor, filter });
    orders.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return orders;
}

function toRow(order) {
  const local = mexicoNow(order.createdAt);
  const lines = order.lineItems.nodes;
  const shippingTax = order.shippingLines.nodes.flatMap((line) => line.taxLines).reduce((sum, tax) => sum + money(tax.priceSet), 0);
  return {
    date: local.date,
    stamp: `${local.date}T${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}:00-0600`,
    channel: order.channelInformation?.channelDefinition?.channelName ?? order.app?.name ?? "Otro",
    // Cubbo Engage no trae canal, solo app. El índice tarda minutos en llegar; mientras, la orden no cuenta como nueva.
    customerIndex: order.customerJourneySummary?.customerOrderIndex ?? null,
    total: money(order.totalPriceSet),
    currentTotal: money(order.currentTotalPriceSet),
    tax: money(order.currentTotalTaxSet),
    net: money(order.currentSubtotalPriceSet) - money(order.currentTotalTaxSet) + shippingTax,
    shipping: money(order.currentShippingPriceSet),
    cogs: lines.reduce((sum, line) => sum + line.currentQuantity * Number(line.variant?.inventoryItem?.unitCost?.amount ?? 0), 0),
    quantity: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
}

export async function loadShopify(plan, generatedAt, { clientId, clientSecret }) {
  const token = await accessToken(plan.shop, clientId, clientSecret);
  const today = mexicoNow(generatedAt).date;
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  // Las canceladas no son venta.
  const orders = (await allOrders(plan.shop, token, "2026-11-01")).filter((order) => !order.cancelledAt);

  const daily = [];
  const recent = [];
  const units = {};
  const stock = {};
  for (const order of orders) {
    const row = toRow(order);
    daily.push({
      date: row.date,
      order_sales_channel: row.channel,
      order_customer_number_of_orders: row.customerIndex,
      order_count: 1,
      order_total_price_amount: row.total,
      order_current_total_price: row.currentTotal,
      order_current_total_tax: row.tax,
      order_net_sales: row.net,
      order_current_shipping_price: row.shipping,
      order_cost_of_goods_sold: row.cogs,
      order_quantity: row.quantity,
    });
    if (row.date >= yesterday) {
      recent.push({ order_id: order.name, order_created_at: row.stamp, order_sales_channel: row.channel, order_quantity: row.quantity, order_total_price_amount: row.total });
    }
    if (row.date < plan.promoStart) continue;
    for (const line of order.lineItems.nodes) {
      const key = `${line.title}|${line.variantTitle}`;
      units[key] ??= { line_item__title: line.title, line_item__variant_title: line.variantTitle, line_item__quantity: 0 };
      units[key].line_item__quantity += line.quantity;
      if (line.variant) {
        stock[key] = { order_id: order.name, order_created_at: generatedAt, line_item__title: line.title, line_item__variant_title: line.variantTitle, line_item__variant_inventory_quantity: line.variant.inventoryQuantity };
      }
    }
  }
  return { daily, orders: recent, lines: Object.values(units), stock: Object.values(stock), today };
}
