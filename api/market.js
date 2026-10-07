const BASE = "https://cdn.tsetmc.com/api";

function instrumentId(value) {
  // شناسه عددی بزرگ نباید با گردشدگی جاوااسکریپت پذیرفته شود.
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("شناسه نامعتبر");
  }

  const id = String(value ?? "");
  if (!/^\d{1,20}$/.test(id)) {
    throw new Error("شناسه نامعتبر");
  }
  return id;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function upstream(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(BASE + path, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      redirect: "error"
    });

    if (!response.ok) throw new Error("پاسخ ناموفق منبع");
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "فقط درخواست GET مجاز است." });
  }

  const op = String(req.query.op || "");

  try {
    if (op === "search") {
      const q = String(req.query.q || "").trim();

      if (!q || q.length > 80) {
        return res.status(400).json({ error: "عبارت جست‌وجو نامعتبر است." });
      }

      const json = await upstream(
        "/Instrument/GetInstrumentSearch/" + encodeURIComponent(q)
      );

      if (!Array.isArray(json.instrumentSearch)) {
        throw new Error("قالب پاسخ جست‌وجو تغییر کرده است");
      }

      const seen = new Set();
      const items = [];

      for (const item of json.instrumentSearch) {
        const id = instrumentId(item.insCode);
        const symbol = String(item.lVal18AFC || "").trim();
        const name = String(item.lVal30 || "").trim();

        if (!symbol || seen.has(id)) continue;
        seen.add(id);
        items.push({ id, symbol, name });
      }

      return res.status(200).json({
        source: "TSETMC",
        retrievedAt: new Date().toISOString(),
        items
      });
    }

    if (op === "quote") {
      const rawId = String(req.query.id || "");

      if (!/^\d{1,20}$/.test(rawId)) {
        return res.status(400).json({ error: "شناسه نماد نامعتبر است." });
      }

      const id = instrumentId(rawId);

      const [infoJson, quoteJson] = await Promise.all([
        upstream("/Instrument/GetInstrumentInfo/" + id),
        upstream("/ClosingPrice/GetClosingPriceInfo/" + id)
      ]);

      const info = infoJson.instrumentInfo;
      const quote = quoteJson.closingPriceInfo;

      if (
        !info || !quote ||
        typeof quote !== "object" ||
        !Object.prototype.hasOwnProperty.call(quote, "pClosing") ||
        !Object.prototype.hasOwnProperty.call(quote, "pDrCotVal") ||
        !Object.prototype.hasOwnProperty.call(quote, "priceYesterday")
      ) {
        throw new Error("قالب پاسخ قیمت قابل تأیید نیست");
      }

      const last = numberOrNull(quote.pDrCotVal);
      const close = numberOrNull(quote.pClosing);
      const previousClose = numberOrNull(quote.priceYesterday);

      const percent = price =>
        price !== null && price > 0 &&
        previousClose !== null && previousClose > 0
          ? (price / previousClose - 1) * 100
          : null;

      return res.status(200).json({
        source: "TSETMC",
        retrievedAt: new Date().toISOString(),
        id,
        symbol: String(info.lVal18AFC || "").trim(),
        name: String(info.lVal30 || "").trim(),
        currency: "IRR",
        last: last > 0 ? last : null,
        close: close > 0 ? close : null,
        previousClose: previousClose > 0 ? previousClose : null,
        lastChangePercent: percent(last),
        closeChangePercent: percent(close),
        volume: numberOrNull(quote.qTotTran5),
        tradeCount: numberOrNull(quote.zTotTran),
        tradeValue: numberOrNull(quote.qTotCap),
        sourceDate: quote.dEven == null ? null : String(quote.dEven),
        sourceTime: quote.hEven == null ? null : String(quote.hEven)
      });
    }

    return res.status(400).json({ error: "نوع درخواست نامعتبر است." });
  } catch (error) {
    console.error("market:", error.message);

    return res.status(502).json({
      error:
        "دریافت اطلاعات معتبر از TSETMC ناموفق بود. دسترسی منبع یا قالب پاسخ باید بررسی شود."
    });
  }
};
