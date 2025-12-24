/**
 * DemoMed Healthcare API Assessment
 * Node.js 18+ required
 * Run with: npm run start
 */

type Patient = {
  patient_id?: string;
  blood_pressure?: unknown;
  temperature?: unknown;
  age?: unknown;
};

type PatientsResponse = {
  data?: Patient[];
  pagination?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
    hasNext?: boolean;
  };
};

const API_KEY = "ak_905fd1264b2c94dfe93ad35a5afc04d806139680646057df";
const BASE_URL = "https://assessment.ksensetech.com/api";
const PAGE_LIMIT = 20;

// -------------------- Utilities --------------------

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 6
): Promise<Response> {
  let attempt = 0;

  while (true) {
    try {
      const res = await fetch(url, options);

      if ([429, 500, 503].includes(res.status) && attempt < retries) {
        const delay = 300 * Math.pow(2, attempt) + Math.random() * 200;
        await sleep(delay);
        attempt++;
        continue;
      }

      return res;
    } catch (err) {
      if (attempt >= retries) throw err;
      const delay = 300 * Math.pow(2, attempt) + Math.random() * 200;
      await sleep(delay);
      attempt++;
    }
  }
}

// -------------------- Parsing & Scoring --------------------

function toNumberStrict(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseBloodPressure(bp: unknown): { sys: number; dia: number } | null {
  if (typeof bp !== "string") return null;
  const parts = bp.split("/");
  if (parts.length !== 2) return null;

  const sys = Number(parts[0]);
  const dia = Number(parts[1]);

  if (!Number.isFinite(sys) || !Number.isFinite(dia)) return null;
  return { sys, dia };
}

function scoreBloodPressure(bp: unknown): { score: number; valid: boolean } {
  const parsed = parseBloodPressure(bp);
  if (!parsed) return { score: 0, valid: false };

  const { sys, dia } = parsed;

  if (sys >= 140 || dia >= 90) return { score: 4, valid: true };
  if ((sys >= 130 && sys <= 139) || (dia >= 80 && dia <= 89))
    return { score: 3, valid: true };
  if (sys >= 120 && sys <= 129 && dia < 80)
    return { score: 2, valid: true };
  if (sys < 120 && dia < 80) return { score: 1, valid: true };

  return { score: 1, valid: true };
}

function scoreTemperature(temp: unknown): {
  score: number;
  valid: boolean;
  fever: boolean;
} {
  const t = toNumberStrict(temp);
  if (t === null) return { score: 0, valid: false, fever: false };

  const fever = t >= 99.6;

  if (t <= 99.5) return { score: 0, valid: true, fever };
  if (t <= 100.9) return { score: 1, valid: true, fever };
  return { score: 2, valid: true, fever };
}

function scoreAge(age: unknown): { score: number; valid: boolean } {
  const a = toNumberStrict(age);
  if (a === null) return { score: 0, valid: false };
  if (a > 65) return { score: 2, valid: true };
  return { score: 1, valid: true };
}

// -------------------- API Logic --------------------

async function getAllPatients(): Promise<Patient[]> {
  const allPatients: Patient[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const url = `${BASE_URL}/patients?page=${page}&limit=${PAGE_LIMIT}`;

    const res = await fetchWithRetry(url, {
      headers: { "x-api-key": API_KEY },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch patients: ${res.status}`);
    }

    const json: PatientsResponse = await res.json();

    if (Array.isArray(json.data)) {
      allPatients.push(...json.data);
    }

    hasNext = Boolean(json.pagination?.hasNext);
    page++;

    await sleep(120);
  }

  return allPatients;
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

  const json = await res.json();
  if (!res.ok) throw new Error("Submission failed");

  return json;
}

function uniqueSorted(arr: string[]) {
  return Array.from(new Set(arr)).sort();
}

// -------------------- Main --------------------

async function main() {
  const patients = await getAllPatients();

  const highRisk: string[] = [];
  const feverPatients: string[] = [];
  const dataQualityIssues: string[] = [];

  for (const p of patients) {
    if (!p.patient_id) continue;

    const bp = scoreBloodPressure(p.blood_pressure);
    const temp = scoreTemperature(p.temperature);
    const age = scoreAge(p.age);

    if (!bp.valid || !temp.valid || !age.valid) {
      dataQualityIssues.push(p.patient_id);
    }

    const totalRisk = bp.score + temp.score + age.score;

    if (totalRisk >= 4) highRisk.push(p.patient_id);
    if (temp.valid && temp.fever) feverPatients.push(p.patient_id);
  }

  const payload = {
    high_risk_patients: uniqueSorted(highRisk),
    fever_patients: uniqueSorted(feverPatients),
    data_quality_issues: uniqueSorted(dataQualityIssues),
  };

  console.log("Submitting results:", payload);

  const result = await submitResults(payload);
  console.log("Assessment Response:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
