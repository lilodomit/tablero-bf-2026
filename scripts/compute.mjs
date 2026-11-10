// Convierte los datos crudos de Shopify, Meta y Klaviyo en lo que muestra el dashboard.

const TZ = "America/Mexico_City";
const CHANNEL = { "Online Store": "ecomm", TikTok: "tiktok", "Point of Sale": "isla", "Cubbo Engage": "engage" };
const n = (value) => Number(value) || 0;

export function mexicoNow(iso) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

function emptyDay() {
  return {
    total: 0, ecomm: 0, tiktok: 0, isla: 0, engage: 0, otros: 0,
    orders: { total: 0, ecomm: 0, tiktok: 0, isla: 0, engage: 0, otros: 0 },
    pieces: 0,
    fresh: { n: 0, tot: 0, tax: 0, net: 0, ship: 0, cogs: 0 },
    // Contribution margin con costos de Triple Whale, todos los canales. missing: órdenes sin costos configurados.
    tw: { rev: 0, tax: 0, costs: 0, missing: 0 },
  };
}

export function aggregateDaily(rows) {
  const days = {};
  for (const row of rows) {
    const day = (days[row.date] ??= emptyDay());
    const key = CHANNEL[row.order_sales_channel] ?? "otros";
    const amount = n(row.order_total_price_amount);
    const count = n(row.order_count);
    day.total += amount;
    day[key] += amount;
    day.orders.total += count;
    day.orders[key] += count;
    if (row.tw_costs == null) day.tw.missing += count;
    else {
      day.tw.rev += n(row.order_current_total_price);
      day.tw.tax += n(row.order_current_total_tax);
      day.tw.costs += n(row.tw_costs);
    }
    if (key === "ecomm") {
      day.pieces += n(row.order_quantity);
      if (n(row.order_customer_number_of_orders) === 1) {
        day.fresh.n += count;
        day.fresh.tot += n(row.order_current_total_price);
        day.fresh.tax += n(row.order_current_total_tax);
        day.fresh.net += n(row.order_net_sales);
        day.fresh.ship += n(row.order_current_shipping_price);
        day.fresh.cogs += n(row.order_cost_of_goods_sold);
      }
    }
  }
  return days;
}

// Receta de Sofía corregida el 9 nov: el envío ya trae IVA, así que se parte de la base sin IVA (totales − impuestos).
function contribution(f, recipe) {
  return f.tot - f.tax - f.cogs - recipe.gateway * f.tot - recipe.fixed * f.n - recipe.returns * f.net;
}

function thresholds(days, plan, today) {
  const f = { n: 0, tot: 0, tax: 0, net: 0, ship: 0, cogs: 0 };
  for (const [date, day] of Object.entries(days)) {
    if (date >= plan.promoStart && date < today) for (const key in f) f[key] += day.fresh[key];
  }
  const fallback = { ...plan.fallback, cacMax: null, source: "fallback" };
  if (!f.n) return fallback;
  const base = f.tot - f.tax;
  const contrib = contribution(f, plan.recipe);
  const piso = base / contrib;
  const target = contrib - plan.recipe.margin * f.net;
  if (piso < 1.3 || piso > 2.2 || target <= 0) return { ...fallback, source: "revisar" };
  return { piso, obj: base / target, cacMax: target / f.n, cacBreakeven: contrib / f.n, source: "promo", orders: f.n };
}

function metrics(day, spend, recipe) {
  const f = day?.fresh;
  if (!f || !spend) return { mer: null, nc: null, margin: null, cac: null };
  const base = f.tot - f.tax;
  return {
    mer: day.ecomm / spend,
    nc: base / spend,
    margin: f.net ? (contribution(f, recipe) - spend) / f.net : null,
    cac: f.n ? spend / f.n : null,
  };
}

function curveFor(date, plan) {
  const day = Number(date.slice(8));
  if (day === 13) return plan.curves.d13;
  if (day >= 14 && day <= 17) return plan.curves.bf;
  if (day >= 8 && day <= 12) return plan.curves.pre;
  return plan.curves.post;
}

function shareSoFar(curve, hour, minute) {
  const done = curve.slice(0, hour).reduce((a, b) => a + b, 0);
  return Math.min(1, done + curve[hour] * (minute / 60));
}

function decide(history, obj) {
  const complete = history.filter((h) => !h.today && h.nc !== null);
  const last = complete.at(-1);
  const prior = complete.at(-2);
  if (!last) return { action: "mantener", reason: "Todavía no hay un día completo de promo para aplicar la regla." };
  const ncText = `NC-ROAS de ayer ${last.nc.toFixed(2)}x contra objetivo de ${obj.toFixed(2)}x`;
  if (prior && last.nc < obj && prior.nc < obj) {
    return { action: "bajar", reason: `Dos días seguidos abajo del objetivo (${ncText}). Regresar al nivel anterior.` };
  }
  if (last.nc >= obj && last.mer >= 5) {
    return { action: "subir", reason: `${ncText}, con MER de ${Math.round(100 / last.mer)}% (gasto ÷ venta). Subir al nivel para escalar.` };
  }
  if (last.nc < obj) {
    return { action: "mantener", reason: `${ncText}. Un segundo día abajo activa la regla de bajar.` };
  }
  return { action: "mantener", reason: `${ncText}, pero el MER (${Math.round(100 / last.mer)}% de gasto sobre la venta) está arriba del 20% que pide la regla para escalar.` };
}

function stockTable(lines, stock, elapsedDays) {
  const latest = {};
  for (const row of stock) {
    const key = `${row.line_item__title}|${row.line_item__variant_title}`;
    const inventory = row.line_item__variant_inventory_quantity;
    if (inventory === null || inventory === undefined) continue;
    if (!latest[key] || row.order_created_at > latest[key].at) latest[key] = { at: row.order_created_at, inventory: n(inventory) };
  }
  return lines
    .map((row) => {
      const key = `${row.line_item__title}|${row.line_item__variant_title}`;
      const units = n(row.line_item__quantity);
      const inventory = latest[key]?.inventory ?? null;
      const perDay = units / Math.max(elapsedDays, 0.25);
      return {
        name: `${row.line_item__title} ${row.line_item__variant_title ?? ""}`.trim(),
        units,
        inventory,
        days: inventory !== null && perDay > 0 ? Math.max(inventory, 0) / perDay : null,
      };
    })
    .sort((a, b) => b.units - a.units)
    .slice(0, 8);
}

function klaviyoFor(klaviyo, date) {
  if (!klaviyo) return null;
  const sends = klaviyo.campaigns.filter((c) => c.local === date);
  const campaigns = sends.reduce((sum, c) => sum + c.revenue, 0);
  const flows = n(klaviyo.flowsByDate[date]);
  return { campaigns, flows, total: campaigns + flows };
}

function topFlows(klaviyo, today, yesterday) {
  return (klaviyo?.flows ?? [])
    .map((f) => ({ name: f.name, today: n(f.byDate[today]), yesterday: n(f.byDate[yesterday]) }))
    .filter((f) => f.today || f.yesterday)
    .sort((a, b) => b.today - a.today || b.yesterday - a.yesterday)
    .slice(0, 6);
}

// CM = venta vigente − costos de Triple Whale (COGS, IVA, envío, pasarela, fulfillment) − gasto de Meta Ads.
// Se expresa también como % de la venta sin IVA. null si la marca no tiene costos configurados.
function contributionMargin(daysList, spendTotal) {
  if (!daysList.length || daysList.some((d) => d.tw.missing)) return null;
  const rev = daysList.reduce((s, d) => s + d.tw.rev, 0);
  const tax = daysList.reduce((s, d) => s + d.tw.tax, 0);
  const costs = daysList.reduce((s, d) => s + d.tw.costs, 0);
  const value = rev - costs - spendTotal;
  return { value, pct: rev - tax ? value / (rev - tax) : null, beforeAds: rev - costs, spend: spendTotal, base: rev - tax };
}

export function compute(raw, plan) {
  const now = mexicoNow(raw.generatedAt);
  const today = now.date;
  const planByDay = Object.fromEntries(plan.days.map((d) => [d.d, d]));
  const days = aggregateDaily(raw.daily);
  const spend = Object.fromEntries(raw.meta.map((m) => [m.date, m]));
  const blank = emptyDay();

  const todayPlan = planByDay[today] ?? null;
  const todayDay = days[today] ?? blank;
  const curve = curveFor(today, plan);
  const frac = shareSoFar(curve, now.hour, now.minute);
  const yesterdayDate = new Date(`${today}T12:00:00Z`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);
  const yDay = days[yesterday] ?? blank;
  const yPlan = planByDay[yesterday] ?? null;

  const limits = thresholds(days, plan, today);

  const history = plan.days
    .filter((d) => d.d <= today && d.d >= plan.promoStart)
    .map((d) => {
      const m = spend[d.d];
      return {
        date: d.d, dow: d.dow, today: d.d === today,
        spend: n(m?.spend), plan15: d.meta15, plan20: d.meta20, ly: d.lyMeta,
        ...metrics(days[d.d], n(m?.spend), plan.recipe),
      };
    });
  const decision = decide(history, limits.obj);

  const hasCosts = Boolean(plan.costs);
  const promoDays = Object.entries(days).filter(([date]) => date >= plan.promoStart && date <= today).map(([, day]) => day);
  const cm = hasCosts ? {
    today: contributionMargin([todayDay], n(spend[today]?.spend)),
    yesterday: contributionMargin([yDay], n(spend[yesterday]?.spend)),
    promo: contributionMargin(promoDays, history.reduce((sum, h) => sum + h.spend, 0)),
  } : null;

  let mtd = 0;
  let before = 0;
  let promoReal = 0;
  for (const [date, day] of Object.entries(days)) {
    if (date > today || !date.startsWith("2026-11")) continue;
    mtd += day.total;
    if (date < plan.promoStart) before += day.total;
    else promoReal += day.total;
  }
  const completePlan = plan.days.filter((d) => d.d < today).reduce((sum, d) => sum + d.total, 0);
  const futurePlan = plan.days.filter((d) => d.d > today).reduce((sum, d) => sum + d.total, 0);
  const todayExpected = (todayPlan?.total ?? 0) * frac;
  const expectedPromo = completePlan + todayExpected;
  const ratio = expectedPromo > 0 ? Math.min(1.5, Math.max(0.5, promoReal / expectedPromo)) : 1;
  const remaining = futurePlan + (todayPlan?.total ?? 0) - todayExpected;
  const projection = mtd + remaining * ratio;

  const phase = plan.phases.find((p) => p.key === todayPlan?.phase) ?? null;
  const phaseKeys = plan.days.filter((d) => d.phase === todayPlan?.phase).map((d) => d.d);
  const phaseReal = phaseKeys.reduce((sum, d) => sum + (d <= today ? days[d]?.total ?? 0 : 0), 0);
  const phaseEcomm = phaseKeys.reduce((sum, d) => sum + (d <= today ? days[d]?.ecomm ?? 0 : 0), 0);

  const realHours = Array(24).fill(0);
  const onlineToday = {};
  const onlineYesterday = {};
  for (const order of raw.orders) {
    const stamp = order.order_created_at ?? "";
    const date = stamp.slice(0, 10);
    const hour = Number(stamp.slice(11, 13));
    const amount = n(order.order_total_price_amount);
    if (date === today && hour >= 0 && hour < 24) realHours[hour] += amount;
    if (order.order_sales_channel === "Online Store") {
      const bucket = date === today ? onlineToday : date === yesterday ? onlineYesterday : null;
      if (bucket) bucket[order.order_id] = Math.max(bucket[order.order_id] ?? 0, n(order.order_quantity));
    }
  }
  const kitShare = (bucket) => {
    const values = Object.values(bucket);
    return { orders: values.filter((q) => q >= 3).length, share: values.length ? values.filter((q) => q >= 3).length / values.length : null };
  };
  const md = today.slice(5);
  const lyHours = plan.lyHours[md] ?? null;
  const lySoFar = lyHours
    ? lyHours.slice(0, now.hour).reduce((a, b) => a + b, 0) + lyHours[now.hour] * (now.minute / 60)
    : null;

  const promoSpend = history.reduce((sum, h) => sum + h.spend, 0);
  const planTotal15 = plan.days.reduce((sum, d) => sum + d.meta15, 0);
  const todayMeta = spend[today];
  // Meta reporta el mismo anuncio en varias filas (una por conjunto): se suman por nombre.
  const adsByName = {};
  for (const row of raw.ads) {
    const ad = (adsByName[row.ad_name] ??= { name: row.ad_name, spend: 0, purchases: 0, revenue: 0 });
    ad.spend += n(row.spend);
    ad.purchases += n(row.actions_omni_purchase);
    ad.revenue += n(row.spend) * n(row.purchase_roas_omni_purchase);
  }
  const adsToday = Object.values(adsByName)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 5)
    .map((ad) => ({
      name: ad.name,
      spend: ad.spend,
      roas: ad.revenue && ad.spend ? ad.revenue / ad.spend : null,
      cpa: ad.purchases ? ad.spend / ad.purchases : null,
    }));

  const elapsedDays = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${plan.promoStart}T12:00:00Z`)) / 86400000 + (now.hour + now.minute / 60) / 24;
  const stock = stockTable(raw.lines, raw.stock, elapsedDays);
  const engage = { today: { revenue: todayDay.engage, orders: todayDay.orders.engage }, yesterday: { revenue: yDay.engage, orders: yDay.orders.engage }, event: { revenue: 0, orders: 0 } };
  for (const [date, day] of Object.entries(days)) {
    if (date >= plan.promoStart && date <= today) {
      engage.event.revenue += day.engage;
      engage.event.orders += day.orders.engage;
    }
  }

  const alerts = [];
  const paceDay = todayExpected > 0 ? todayDay.total / todayExpected : null;
  if (paceDay !== null && paceDay < 0.95) {
    alerts.push({ level: "warn", tag: `Pacing ${Math.round(paceDay * 100)}%`, text: `Hoy vamos $${Math.round((todayExpected - todayDay.total) / 1000)}k abajo de donde deberíamos a esta hora` });
  }
  for (const item of stock.filter((s) => s.days !== null && s.days < 3).slice(0, 3)) {
    alerts.push({ level: "bad", tag: "Inventario", text: `${item.name}: quedan ${item.days.toFixed(1)} días` });
  }
  if (todayMeta && n(todayMeta.cpm) > plan.oct.cpm * 1.3) {
    alerts.push({ level: "warn", tag: `CPM +${Math.round((n(todayMeta.cpm) / plan.oct.cpm - 1) * 100)}%`, text: `$${Math.round(n(todayMeta.cpm))} contra $${Math.round(plan.oct.cpm)} promedio de octubre` });
  }
  const lastDone = history.filter((h) => !h.today).at(-1);
  if (lastDone && lastDone.nc !== null && lastDone.nc < limits.obj) {
    alerts.push({ level: "warn", tag: "NC-ROAS", text: `Ayer cerró en ${lastDone.nc.toFixed(2)}x, abajo del objetivo de ${limits.obj.toFixed(2)}x` });
  }

  const paceLabelFor = (value, goal) => (goal ? value / goal : null);
  const channel = (key, label) => ({
    key, label, value: todayDay[key], goal: todayPlan?.[key] ?? 0,
    share: todayDay.total ? todayDay[key] / todayDay.total : 0,
  });

  return {
    id: plan.id, name: plan.name,
    generatedAt: raw.generatedAt,
    now, today, yesterday, frac,
    goal: plan.goal,
    cm,
    channelList: plan.channels,
    alerts,
    limits,
    decision,
    month: { mtd, before, expected: before + expectedPromo, projection, ratio, faltan: plan.goal - mtd },
    day: {
      plan: todayPlan, real: todayDay.total, expected: todayExpected,
      // Cierre del día al ritmo actual, según la curva por hora. Antes del 10% del día es puro ruido.
      projection: frac >= 0.1 ? todayDay.total / frac : null,
      lySoFar, lyTotal: todayPlan?.lyTotal ?? null,
      pace: paceDay,
    },
    phase: phase ? { ...phase, real: phaseReal, ecommReal: phaseEcomm } : null,
    phases: plan.phases.map((p) => {
      const keys = plan.days.filter((d) => d.phase === p.key).map((d) => d.d);
      const started = keys[0] <= today;
      return { ...p, started, active: p.key === todayPlan?.phase, real: started ? keys.reduce((s, d) => s + (d <= today ? days[d]?.total ?? 0 : 0), 0) : null };
    }),
    meta: {
      history,
      today: {
        spend: n(todayMeta?.spend), plan15: todayPlan?.meta15 ?? 0, plan20: todayPlan?.meta20 ?? 0,
        cpm: n(todayMeta?.cpm), frequency: n(todayMeta?.frequency),
        ...metrics(todayDay, n(todayMeta?.spend), plan.recipe),
      },
      cumulative: { spend: promoSpend, plan15: planTotal15, cap: plan.capMeta },
      oct: plan.oct,
      ads: adsToday,
      track: raw.metaTrack,
    },
    hours: { goal: curve.map((c) => (todayPlan?.total ?? 0) * c), real: realHours, ly: lyHours, nowHour: now.hour },
    channels: plan.channels.map((c) => channel(c.key, c.label)),
    customers: {
      fresh: todayDay.fresh.tot, returning: todayDay.ecomm - todayDay.fresh.tot,
      ordersOnline: todayDay.orders.ecomm,
    },
    ticket: {
      aov: todayDay.orders.ecomm ? todayDay.ecomm / todayDay.orders.ecomm : null,
      base: plan.aovBase,
      pieces: todayDay.orders.ecomm ? todayDay.pieces / todayDay.orders.ecomm : null,
      kit: kitShare(onlineToday),
    },
    engage,
    klaviyo: raw.klaviyo ? {
      at: raw.klaviyo.at,
      today: klaviyoFor(raw.klaviyo, today),
      yesterday: klaviyoFor(raw.klaviyo, yesterday),
      sends: raw.klaviyo.campaigns.filter((c) => c.local >= yesterday).sort((a, b) => (a.send < b.send ? 1 : -1)).slice(0, 6),
      flows: topFlows(raw.klaviyo, today, yesterday),
    } : null,
    stock,
    calendar: plan.days.map((d) => ({ date: d.d, goal: d.total, real: d.d <= today ? days[d.d]?.total ?? 0 : null, today: d.d === today })),
    close: yPlan ? {
      date: yesterday, dow: yPlan.dow,
      plan: yPlan,
      day: { total: yDay.total, ecomm: yDay.ecomm, tiktok: yDay.tiktok, isla: yDay.isla, engage: yDay.engage },
      channels: plan.channels.map((c) => ({ label: c.label, value: yDay[c.key], goal: yPlan[c.key] ?? 0 })),
      meta: history.find((h) => h.date === yesterday) ?? null,
      orders: yDay.orders.ecomm,
      aov: yDay.orders.ecomm ? yDay.ecomm / yDay.orders.ecomm : null,
      pieces: yDay.orders.ecomm ? yDay.pieces / yDay.orders.ecomm : null,
      kit: kitShare(onlineYesterday),
      freshShare: yDay.ecomm ? yDay.fresh.tot / yDay.ecomm : null,
      paceYear: paceLabelFor(yDay.total, yPlan.lyTotal),
      mtdExpected: before + plan.days.filter((d) => d.d <= yesterday).reduce((s, d) => s + d.total, 0),
      mtd: mtd - todayDay.total,
    } : null,
    todayPlanCard: todayPlan,
  };
}

// Vista General: suma las marcas. Si una marca no trae costos, su margen queda fuera y se avisa.
export function general(outputs, generatedAt) {
  const list = outputs.filter(Boolean);
  const sum = (fn) => list.reduce((s, b) => s + (fn(b) ?? 0), 0);
  const cmSum = (pick) => {
    const parts = list.map((b) => b.cm?.[pick]).filter(Boolean);
    if (!parts.length) return null;
    const value = parts.reduce((s, p) => s + p.value, 0);
    const base = parts.reduce((s, p) => s + p.base, 0);
    return { value, pct: base ? value / base : null, partial: parts.length < list.length };
  };
  const projections = list.map((b) => b.day.projection);
  return {
    generatedAt,
    now: list[0]?.now, today: list[0]?.today, yesterdayDate: list[0]?.yesterday,
    goal: sum((b) => b.goal),
    day: {
      real: sum((b) => b.day.real), goal: sum((b) => b.day.plan?.total), expected: sum((b) => b.day.expected),
      projection: projections.every((p) => p != null) ? projections.reduce((a, b) => a + b, 0) : null,
    },
    month: { mtd: sum((b) => b.month.mtd), expected: sum((b) => b.month.expected), projection: sum((b) => b.month.projection) },
    yesterday: { real: sum((b) => b.close?.day.total), goal: sum((b) => b.close?.plan.total) },
    spend: { today: sum((b) => b.meta.today.spend), yesterday: sum((b) => b.close?.meta?.spend) },
    cm: { today: cmSum("today"), yesterday: cmSum("yesterday"), promo: cmSum("promo") },
    brands: list.map((b) => ({
      id: b.id, name: b.name, goal: b.goal,
      day: { real: b.day.real, goal: b.day.plan?.total ?? 0, expected: b.day.expected, projection: b.day.projection, pace: b.day.pace },
      month: { mtd: b.month.mtd, expected: b.month.expected, projection: b.month.projection },
      yesterday: { real: b.close?.day.total ?? 0, goal: b.close?.plan.total ?? 0 },
      channels: b.channels.concat([{ key: "engage", label: "Cubbo Engage", value: b.engage.today.revenue, goal: 0 }]),
      channelsYesterday: (b.close?.channels ?? []).concat([{ label: "Cubbo Engage", value: b.engage.yesterday.revenue, goal: 0 }]),
      spend: b.meta.today.spend,
      cm: b.cm,
    })),
  };
}
