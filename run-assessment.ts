```ts
/**
 * DemoMed Healthcare API assessment solution
 * Node 18+ required (global fetch).
 *
 * Run:
 *   npm install
 *   npm run start
 */

type Patient = {
  patient_id?: string;
  blood_pressure?: unknown;
  temperature?: unknown;
  age?: unknown;
};

type PatientsResponse = {
  data?: Patient[] | unknown;
  pagination?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
    hasNext?: boolean;
    hasPrevious?: boolean;
  };
};

const API_KEY = "ak_905fd1264b2c94dfe93ad35a5afc04d806139680646057df";
const BASE_URL = "https://assessment.ksensetech.com/api";
const PAGE_LIMIT = 20; // max per prompt

// -------------------- helpers --------------------

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Robust fetch with:
 * - 429 handling (Retry-After if present)
 * - intermittent 500/503 retries
 * - exponential backoff + jitter
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 6
): Promise<Response> {
  let attempt = 0;

  while (true) {
    try {
      const res = await fetch(url, options);

      if (res.status === 429 || res.status === 500 || res.status === 503) {
        if (attempt >= maxRetries) return res;

        const retryAfter = parseRetryAfterSeconds(res.headers.get("retry-after"));
        const baseDelay = retryAfter != null ? retryAfter * 1000 : 250 * 2 ** attempt;
        const jitter = Math.floor(Math.random() * 200);

        await sleep(baseDelay + jitter);
        attempt++;
        continue;
      }

      return res;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const delay = 250 * 2 ** attempt + Math.floor(Math.random() * 200);
      await sleep(delay);
      attempt++;
    }
  }
}

// -------------------- parsing & scoring --------------------

function toNumberStrict(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseBP(bp: unknown): { sys: number; dia: number } | null {
  if (bp == null) return null;
  if (typeof bp !== "string") return null;

  const s = bp.trim();
  if (!s) return null;

  const parts = s.split("/");
  if (parts.length !== 2) return null;

  const sysStr = parts[0].trim();
  const diaStr = parts[1].trim();

  // invalid examples: "150/" or "/90"
  if (!sysStr || !diaStr) return null;

  const sys = Number(sysStr);
  const dia = Number(diaStr);

  if (!Number.isFinite(sys) || !Number.isFinite(dia)) return null;
  return { sys, dia };
}

function scoreBP(bp: unknown): { score: number; valid: boolean } {
  const parsed = parseBP(bp);
  if (!parsed) return { score: 0, valid: false };

  const { sys, dia } = parsed;

  // Stage 2
  if (sys >= 140 || dia >= 90) return { score: 4, valid: true };
  // Stage 1
  if ((sys >= 130 && sys <= 139) || (dia >= 80 && dia <= 89)) return { score: 3, valid: true };
  // Elevated
  if (sys >= 120 && sys <= 129 && dia < 80) return { score: 2, valid: true };
  // Normal
  if (sys < 120 && dia < 80) return { score: 1, valid: true };

  // If numeric but odd, treat as valid and default to lowest defined risk
  return { score: 1, valid: true };
}

function scoreTemp(temp: unknown): { score: number; valid: boolean; fever: boolean } {
  const t = toNumberStrict(temp);
  if (t == null) return { score: 0, valid: false, fever: false };

  const fever = t >= 99.6;

  if (t <= 99.5) return { score: 0, valid: true, fever };
  if (t >= 99.6 && t <= 100.9) return { score: 1, valid: true, fever };
  // Interpret "High Fever" as >= 101.0°F (prompt text appears garbled)
  if (t >= 101.0) return { score: 2, valid: true, fever };

  return { score: 0, valid: true, fever };
}

function scoreAge(age: unknown): { score: number; valid: boolean } {
  const a = toNumberStrict(age);
  if (a == null) return { score: 0, valid: false };

  if (a > 65) return { score: 2, valid: true };
  // Under 40 and 40–65 both 1 point
  return { score: 1, valid: true };
}

// -------------------- API flow --------------------

async function getAllPatients(): Promise<Patient[]> {
  const all: Patient[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const url = new URL(`${BASE_URL}/patients`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(PAGE_LIMIT));

    const res = await fetchWithRetry(url.toString(), {
      method: "GET",
      headers: { "x-api-key": API_KEY },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GET /patients failed: ${res.status} ${res.statusText} ${text}`);
    }

    const json = (await res.json()) as PatientsResponse;

    if (Array.isArray(json.data)) {
      all.push(...json.data);
    }

    hasNext = Boolean(json.pagination?.hasNext);
    page++;

    // small delay to reduce 429 likelihood
    await sleep(120);
  }

  return all;
}

async function submitResults(payload: {
  high_risk_patients: string[];
  fever_patients: string[];
  data_quality_issues: string[];
}) {
  const res = await fetchWithRetry(`${BASE_URL}/submit-assessment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `POST /submit-assessment failed: ${res.status} ${res.statusText} ${JSON.stringify(json)}`
    );
  }
  return json;
}

function uniqSorted(ids: string[]) {
  return Array.from(new Set(ids)).sort();
}

// -------------------- main --------------------

async function main() {
  const patients = await getAllPatients();

  const highRisk: string[] = [];
  const feverPatients: string[] = [];
  const dataQuality: string[] = [];

  for (const p of patients) {
    const id = typeof p.patient_id === "string" ? p.patient_id : null;
    if (!id) continue;

    const bp = scoreBP(p.blood_pressure);
    const temp = scoreTemp(p.temperature);
    const age = scoreAge(p.age);

    // Data quality issues if ANY of BP, Temp, or Age is invalid/missing
    if (!bp.valid || !temp.valid || !age.valid) dataQuality.push(id);

    const totalRisk = bp.score + temp.score + age.score;

    if (totalRisk >= 4) highRisk.push(id);
    if (temp.valid && temp.fever) feverPatients.push(id);
  }

  const payload = {
    high_risk_patients: uniqSorted(highRisk),
    fever_patients: uniqSorted(feverPatients),
    data_quality_issues: uniqSorted(dataQuality),
  };

  console.log("Submitting payload sizes:", {
    high_risk_patients: payload.high_risk_patients.length,
    fever_patients: payload.fever_patients.length,
    data_quality_issues: payload.data_quality_issues.length,
  });

  const result = await submitResults(payload);
  console.log("Submission response:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```
