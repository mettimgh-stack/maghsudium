const DEFAULT_BASE = "https://cdn.tsetmc.com/api";

class MarketError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function scalar(value) {
  return typeof value === "string" ? value : "";
}

function normalize(value) {
  return String(value || "")
    .replace(/ي|ى/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u200c\u200e\u200f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function instrumentId(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new MarketError(
      "UNSAFE_ID",
      "شناسه نماد بدون افت دقت قابل خواندن نیست."
    );
  }

  const id = String(value ?? "");
  if (!/^\d{1,20}$/.test(id)) {
    throw new MarketError("INVALID_ID", "شناسه نماد نامعتبر است.");
  }
  return id;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveOrNull(value) {
  const n = numberOrNull(value);
  return n !== null && n > 0 ? n : null;
}

/*
 * رشته‌های JSON دست‌نخورده می‌مانند.
 * اعداد صحیح بزرگ پیش از JSON.parse به رشته تبدیل می‌شوند.
 * در نتیجه insCode عددی، قبل از اعتبارسنجی گرد نمی‌شود.
 */
function parseLosslessJSON(text) {
  const protectedText = text.replace(
    /"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    token => {
      if (token[0] === '"') return token;

      if (/^-?\d+$/.test(token)) {
        const n = Number(token);
        if (!Number.isSafeInteger(n)) return JSON.stringify(token);
      }

      return token;
    }
  );

  return JSON.parse(protectedText);
}

function getBase() {
  const configured = process.env.TSETMC_BASE_URL || DEFAULT_BASE;
  let url;

  try {
    url = new URL(configured);
  } catch {
    throw new MarketError(
      "CONFIG_ERROR",
      "آدرس منبع در تنظیمات سرور معتبر نیست."
    );
  }

  if (url.protocol !== "https:") {
    throw new MarketError(
      "CONFIG_ERROR",
      "آدرس منبع باید HTTPS باشد."
    );
  }

  return url.toString().replace(/\/$/, "");
}

async function upstream(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(getBase() + path, {
      signal: controller.signal,
      headers: {
        Accept: "application/json"
      },
      redirect: "follow",
      cache: "no-store"
    });

    if (!response.ok) {
      throw new MarketError(
        "UPSTREAM_HTTP",
        "منبع بورس پاسخ HTTP ناموفق داده است.",
        { upstreamStatus: response.status }
      );
    }

    const text = await response.text();

    if (!text.trim()) {
      throw new MarketError(
        "EMPTY_RESPONSE",
        "پاسخ منبع بورس خالی است."
      );
    }

    try {
      return parseLosslessJSON(text);
    } catch {
      throw new MarketError(
        "INVALID_JSON",
        "پاسخ منبع JSON معتبر نیست؛ ممکن است صفحه محدودیت دسترسی باشد.",
        { contentType: response.headers.get("content-type") || null }
      );
    }
  } catch (error) {
    if (error instanceof MarketError) throw error;

    if (controller.signal.aborted) {
      throw new MarketError(
        "UPSTREAM_TIMEOUT",
        "منبع بورس در مهلت ۱۰ ثانیه پاسخ نداد."
      );
    }

    throw new MarketError(
      "UPSTREAM_NETWORK",
      "اتصال سرور Vercel به منبع بورس برقرار نشد."
    );
  } finally {
    clearTimeout(timer);
  }
}

async function search(q) {
  const normalized = normalize(q);

  const variants = [...new Set([
    normalized,
    normalized.replace(/ی/g, "ي").replace(/ک/g, "ك")
  ])];

  const results = await Promise.allSettled(
    variants.map(async variant => {
      const json = await upstream(
        "/Instrument/GetInstrumentSearch/" + encodeURIComponent(variant)
      );

      if (!Array.isArray(json.instrumentSearch)) {
        throw new MarketError(
          "SEARCH_SCHEMA",
          "ساختار پاسخ جست‌وجوی بورس با ساختار مورد انتظار متفاوت است."
        );
      }

      return json.instrumentSearch;
    })
  );

  const successful = results.filter(r => r.status === "fulfilled");

  if (!successful.length) {
    throw results[0].reason;
  }

  const map = new Map();
  let skipped = 0;

  for (const result of successful) {
    for (const row of result.value) {
      if (!row || typeof row !== "object") {
        skipped++;
        continue;
      }

      try {
        const id = instrumentId(row.insCode);
        const symbol = normalize(row.lVal18AFC);
        const name = normalize(row.lVal30);

        if (!symbol) {
          skipped++;
          continue;
        }

        if (!map.has(id)) {
          map.set(id, { id, symbol, name });
        }
      } catch {
        skipped++;
      }
    }
  }

  const rank = item => {
    if (item.symbol === normalized) return 0;
    if (item.symbol.startsWith(normalized)) return 1;
    return 2;
  };

  const items = [...map.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.symbol.localeCompare(b.symbol, "fa")
  );

  return {
    source: "TSETMC",
    retrievedAt: new Date().toISOString(),
    items,
    warnings: [
      ...(successful.length < results.length
        ? ["یکی از شکل‌های نوشتاری جست‌وجو پاسخ نگرفت."]
        : []),
      ...(skipped
        ? [`${skipped} ردیف دارای اطلاعات نامعتبر کنار گذاشته شد.`]
        : [])
    ]
  };
}

async function quote(id) {
  const [infoResult, priceResult] = await Promise.allSettled([
    upstream("/Instrument/GetInstrumentInfo/" + id),
    upstream("/ClosingPrice/GetClosingPriceInfo/" + id)
  ]);

  if (priceResult.status !== "fulfilled") {
    throw priceResult.reason;
  }

  const price = priceResult.value.closingPriceInfo;

  if (
    !price ||
    typeof price !== "object" ||
    Array.isArray(price) ||
    !Object.prototype.hasOwnProperty.call(price, "pClosing") ||
    !Object.prototype.hasOwnProperty.call(price, "pDrCotVal") ||
    !Object.prototype.hasOwnProperty.call(price, "priceYesterday")
  ) {
    throw new MarketError(
      "QUOTE_SCHEMA",
      "ساختار پاسخ قیمت بورس قابل تأیید نیست."
    );
  }

  const info =
    infoResult.status === "fulfilled"
      ? infoResult.value.instrumentInfo
      : null;

  const warnings = [];

  if (!info || typeof info !== "object") {
    warnings.push("مشخصات شرکت دریافت نشد؛ قیمت جداگانه دریافت شده است.");
  }

  // اگر منبع شناسه را برگرداند، تطابق آن بررسی می‌شود.
  for (const row of [info, price]) {
    if (row && row.insCode != null) {
      if (instrumentId(row.insCode) !== id) {
        throw new MarketError(
          "ID_MISMATCH",
          "شناسه پاسخ منبع با نماد درخواستی مطابقت ندارد."
        );
      }
    }
  }

  const last = positiveOrNull(price.pDrCotVal);
  const close = positiveOrNull(price.pClosing);
  const previousClose = positiveOrNull(price.priceYesterday);

  const percent = value =>
    value !== null && previousClose !== null
      ? (value / previousClose - 1) * 100
      : null;

  if (last === null && close === null) {
    warnings.push("قیمت مثبت و قابل استفاده در پاسخ موجود نیست.");
  }

  if (price.dEven == null) {
    warnings.push("تاریخ معامله در پاسخ موجود نیست؛ تازگی قیمت قابل تأیید نیست.");
  }

  return {
    source: "TSETMC",
    retrievedAt: new Date().toISOString(),
    id,
    symbol: normalize(info?.lVal18AFC),
    name: normalize(info?.lVal30),
    currency: "IRR",
    adjusted: false,
    last,
    close,
    previousClose,
    lastChangePercent: percent(last),
    closeChangePercent: percent(close),
    volume: numberOrNull(price.qTotTran5),
    tradeCount: numberOrNull(price.zTotTran),
    tradeValue: numberOrNull(price.qTotCap),
    sourceDate: price.dEven == null ? null : String(price.dEven),
    sourceTime: price.hEven == null ? null : String(price.hEven),
    warnings
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "فقط GET مجاز است.",
      code: "METHOD_NOT_ALLOWED"
    });
  }

  const op = scalar(req.query.op);

  try {
    if (op === "health") {
      return res.status(200).json({
        ok: true,
        service: "Maghsudium",
        version: "1.0.0",
        serverTime: new Date().toISOString(),
        note: "این پاسخ فقط اجرای API را تأیید می‌کند، نه اتصال به بورس."
      });
    }

    if (op === "search") {
      const q = normalize(scalar(req.query.q));

      if (!q || q.length > 80) {
        return res.status(400).json({
          error: "عبارت جست‌وجو باید بین ۱ تا ۸۰ نویسه باشد.",
          code: "INVALID_QUERY"
        });
      }

      return res.status(200).json(await search(q));
    }

    if (op === "quote") {
      const rawId = scalar(req.query.id);

      if (!/^\d{1,20}$/.test(rawId)) {
        return res.status(400).json({
          error: "شناسه نماد نامعتبر است.",
          code: "INVALID_ID"
        });
      }

      return res.status(200).json(await quote(instrumentId(rawId)));
    }

    return res.status(400).json({
      error: "نوع درخواست معتبر نیست.",
      code: "INVALID_OPERATION"
    });
  } catch (error) {
    const known = error instanceof MarketError;
    const code = known ? error.code : "INTERNAL_ERROR";
    const message = known
      ? error.message
      : "خطای داخلی در پردازش اطلاعات رخ داد.";

    console.error("market:", {
      code,
      message: error.message,
      details: error.details || {}
    });

    return res.status(
      code === "UPSTREAM_TIMEOUT" ? 504 : known ? 502 : 500
    ).json({
      error: message,
      code,
      ...(known ? error.details : {}),
      retrievedAt: new Date().toISOString()
    });
  }
};
