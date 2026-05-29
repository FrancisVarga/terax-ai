// Seed the local OTEL collector with realistic demo telemetry.
//
// POSTs OTLP/HTTP JSON to the running Terax ingest server so the Observability
// dashboard shows multi-span traces, several services, logs at every severity,
// and gauge/sum/histogram metrics. This goes through the real ingest pipeline
// (decode -> convert -> store -> event), so it doubles as an integration smoke
// test.
//
// Usage:
//   node scripts/otel-seed.mjs                 # dev port 4418, one burst
//   node scripts/otel-seed.mjs --port 4318     # release port
//   node scripts/otel-seed.mjs --traces 50     # how many traces to emit
//   node scripts/otel-seed.mjs --watch         # keep emitting every ~2s
//
// Requires Node 18+ (global fetch). No dependencies.

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

const PORT = Number(opt("port", "4418"));
const BASE = `http://localhost:${PORT}`;
const TRACES = Number(opt("traces", "20"));
const WATCH = has("watch");

const SERVICES = ["api", "web", "worker", "auth", "payments"];
const ROUTES = [
  ["GET", "/rss/feeds/:slug"],
  ["POST", "/rss/feeds/:slug/poll"],
  ["GET", "/api/users/:id"],
  ["POST", "/api/checkout"],
  ["GET", "/health"],
  ["POST", "/auth/login"],
  ["DELETE", "/api/sessions/:id"],
];
const DB_OPS = ["SELECT users", "INSERT order", "UPDATE feed", "SELECT feed_items"];
const LOG_MESSAGES = [
  ["INFO", 9, "request completed"],
  ["INFO", 9, "cache hit for feed slug"],
  ["DEBUG", 5, "acquired db connection from pool"],
  ["WARN", 13, "upstream latency above threshold"],
  ["WARN", 13, "retrying poll after 429"],
  ["ERROR", 17, "failed to poll feed: upstream 500"],
  ["ERROR", 17, "tenant quota exceeded"],
  ["FATAL", 21, "database connection pool exhausted"],
];

// ---- random helpers (seedless; this is demo data) ----
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
const hex = (bytes) =>
  Array.from({ length: bytes }, () => rnd(256).toString(16).padStart(2, "0")).join("");
const uuid = () =>
  `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`;

const nowNano = () => BigInt(Date.now()) * 1_000_000n;

const strAttr = (key, v) => ({ key, value: { stringValue: String(v) } });
const intAttr = (key, v) => ({ key, value: { intValue: String(v) } });

function resource(service) {
  return {
    attributes: [
      strAttr("service.name", service),
      strAttr("service.version", "1.4.2"),
      strAttr("deployment.environment", "local"),
    ],
  };
}

// Build one trace: a root server span with 1-4 nested child spans (db / http
// client / internal), realistic durations, ~20% error rate on the root.
function buildTrace() {
  const service = pick(SERVICES);
  const [method, route] = pick(ROUTES);
  const traceId = hex(16);
  const rootId = hex(8);
  const start = nowNano() - BigInt(rnd(60) * 1_000_000_000); // up to 60s ago
  const isError = Math.random() < 0.2;
  const rootDurMs = 40 + rnd(2400);
  const rootEnd = start + BigInt(rootDurMs * 1_000_000);

  const spans = [
    {
      traceId,
      spanId: rootId,
      name: `${method} ${route}`,
      kind: 2, // SERVER
      startTimeUnixNano: start.toString(),
      endTimeUnixNano: rootEnd.toString(),
      attributes: [
        strAttr("http.request.method", method),
        intAttr("http.response.status_code", isError ? 500 : 200),
        strAttr("http.route", route),
        strAttr("url.path", route.replace(":slug", "bbc-sport-uk").replace(":id", String(rnd(9999)))),
        strAttr("server.address", `127.0.0.1:${20000 + rnd(40000)}`),
        strAttr("tenant.id", uuid()),
      ],
      status: { code: isError ? 2 : 0, message: isError ? "internal error" : "" },
      events: isError
        ? [
            {
              timeUnixNano: (rootEnd - 5_000_000n).toString(),
              name: "exception",
              attributes: [
                strAttr("exception.type", "UpstreamError"),
                strAttr("exception.message", "feed source returned 500"),
              ],
            },
          ]
        : [],
    },
  ];

  // Child spans, sequential within the root window.
  const childCount = 1 + rnd(4);
  let cursor = start + BigInt(2 * 1_000_000);
  for (let i = 0; i < childCount; i++) {
    const remaining = rootEnd - cursor - BigInt(2 * 1_000_000);
    if (remaining <= 0n) break;
    const durMs = 1 + rnd(Math.max(1, Number(remaining / 1_000_000n)));
    const cStart = cursor;
    const cEnd = cStart + BigInt(durMs * 1_000_000);
    const isDb = Math.random() < 0.5;
    spans.push({
      traceId,
      spanId: hex(8),
      parentSpanId: rootId,
      name: isDb ? pick(DB_OPS) : `${pick(["GET", "POST"])} upstream`,
      kind: isDb ? 3 : 3, // CLIENT
      startTimeUnixNano: cStart.toString(),
      endTimeUnixNano: cEnd.toString(),
      attributes: isDb
        ? [strAttr("db.system", "postgresql"), strAttr("db.statement", pick(DB_OPS))]
        : [strAttr("http.request.method", "GET"), intAttr("http.response.status_code", 200)],
      status: { code: 0, message: "" },
      events: [],
    });
    cursor = cEnd + BigInt(rnd(3) * 1_000_000);
  }

  return { service, traceId, spans };
}

function tracePayload(traces) {
  // Group spans by service into resourceSpans entries.
  const byService = new Map();
  for (const t of traces) {
    const arr = byService.get(t.service) ?? [];
    arr.push(...t.spans);
    byService.set(t.service, arr);
  }
  return {
    resourceSpans: Array.from(byService.entries()).map(([service, spans]) => ({
      resource: resource(service),
      scopeSpans: [{ scope: { name: "terax.seed", version: "1.0.0" }, spans }],
    })),
  };
}

function logsPayload(count) {
  const records = Array.from({ length: count }, () => {
    const [text, sev, msg] = pick(LOG_MESSAGES);
    return {
      timeUnixNano: (nowNano() - BigInt(rnd(60) * 1_000_000_000)).toString(),
      observedTimeUnixNano: nowNano().toString(),
      severityNumber: sev,
      severityText: text,
      body: { stringValue: `${msg} (${uuid().slice(0, 8)})` },
      attributes: [strAttr("log.origin", pick(["stdout", "stderr"])), strAttr("tenant.id", uuid())],
      traceId: Math.random() < 0.5 ? hex(16) : "",
    };
  });
  return {
    resourceLogs: [
      {
        resource: resource(pick(SERVICES)),
        scopeLogs: [{ scope: { name: "terax.seed" }, logRecords: records }],
      },
    ],
  };
}

function metricsPayload() {
  const t = nowNano().toString();
  const dp = (value, attrs = []) => ({
    attributes: attrs,
    timeUnixNano: t,
    startTimeUnixNano: t,
    ...value,
  });
  return {
    resourceMetrics: [
      {
        resource: resource("api"),
        scopeMetrics: [
          {
            scope: { name: "terax.seed" },
            metrics: [
              {
                name: "system.cpu.utilization",
                description: "CPU utilization",
                unit: "1",
                gauge: { dataPoints: [dp({ asDouble: Math.random() })] },
              },
              {
                name: "system.memory.usage",
                description: "Memory in use",
                unit: "By",
                gauge: { dataPoints: [dp({ asInt: String(200_000_000 + rnd(800_000_000)) })] },
              },
              {
                name: "http.server.request.count",
                description: "Total requests",
                unit: "1",
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    dp({ asInt: String(1000 + rnd(50000)) }, [strAttr("http.response.status_code", "200")]),
                    dp({ asInt: String(rnd(500)) }, [strAttr("http.response.status_code", "500")]),
                  ],
                },
              },
              {
                name: "http.server.request.duration",
                description: "Request duration histogram",
                unit: "ms",
                histogram: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    {
                      attributes: [],
                      timeUnixNano: t,
                      startTimeUnixNano: t,
                      count: String(500 + rnd(2000)),
                      sum: 12000 + rnd(50000),
                      bucketCounts: ["50", "120", "200", "80", "30", "10"].map(String),
                      explicitBounds: [5, 10, 25, 50, 100],
                      min: 1.2,
                      max: 980.5,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
}

async function burst() {
  const traces = Array.from({ length: TRACES }, buildTrace);
  await post("/v1/traces", tracePayload(traces));
  await post("/v1/logs", logsPayload(TRACES + rnd(20)));
  await post("/v1/metrics", metricsPayload());
  const spanCount = traces.reduce((n, t) => n + t.spans.length, 0);
  console.log(`seeded ${traces.length} traces (${spanCount} spans), logs, metrics -> ${BASE}`);
}

async function main() {
  try {
    await burst();
  } catch (e) {
    console.error(`seed failed: ${e.message}`);
    console.error(`is Terax running and listening on ${BASE}? (dev port 4418, release 4318)`);
    process.exit(1);
  }
  if (WATCH) {
    console.log("watch mode: emitting every ~2s, Ctrl-C to stop");
    setInterval(() => burst().catch((e) => console.error(e.message)), 2000);
  }
}

main();
