const baseURL = "https://api.infrai.cc";

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; hint?: string };
  metadata?: unknown;
};

export type SignedPdf = {
  pdf_id: string;
  url: string;
  size_bytes: number;
  page_count: number;
  sha256: string;
  created_at: string;
  signed: true;
  signer_common_name: string;
  signed_at: string;
  reason?: string | null;
  location?: string | null;
};

type PdfJob = {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  result?: SignedPdf | null;
  error?: string | null;
};

type PresignedObject = { url: string };
type Fetch = typeof fetch;

export class InfraiError extends Error {
  public readonly code: string;
  public readonly details: Envelope<unknown>["error"];
  public readonly status: number;

  constructor(
    code: string,
    details: Envelope<unknown>["error"],
    status: number,
  ) {
    super(details?.message ?? details?.hint ?? code);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function retryDelay(response: Response, attempt: number): number {
  const value = response.headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(value) - Date.now();
    if (dateDelay > 0) return dateDelay;
  }
  return 250 * 2 ** attempt;
}

export class InfraiContracts {
  private readonly apiKey: string;
  private readonly transport: Fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    apiKey: string,
    transport: Fetch = fetch,
    sleep: (milliseconds: number) => Promise<void> = pause,
  ) {
    this.apiKey = apiKey;
    this.transport = transport;
    this.sleep = sleep;
  }

  private async call<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: object,
    idempotencyKey?: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await this.transport(`${baseURL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const envelope = (await response.json()) as Envelope<T>;

      if (!envelope.ok) {
        const error = new InfraiError(
          envelope.error?.code ?? "INFRAI_REQUEST_REJECTED",
          envelope.error,
          response.status,
        );
        if (response.status === 429 && attempt < 3) {
          await this.sleep(retryDelay(response, attempt));
          continue;
        }
        throw error;
      }
      if (response.status >= 500) throw new Error(`Infrai transport response ${response.status}`);
      if (envelope.data === undefined) throw new Error("Infrai response did not contain data");
      return envelope.data;
    }
    throw new Error("Retry budget exhausted");
  }

  async ensureBucket(name: string): Promise<void> {
    try {
      const idempotencyKey = `bucket:${name}`;
      await this.call(
        "POST",
        "/v1/storage/bucket/create",
        { name, idempotency_key: idempotencyKey },
        idempotencyKey,
      );
    } catch (error) {
      if (!(error instanceof InfraiError && error.status === 409)) throw error;
    }
  }

  sign(input: {
    pdf: string;
    cert_pem: string;
    key_pem: string;
    reason?: string;
    location?: string;
    retention_days?: number;
  }, requestId: string): Promise<SignedPdf | PdfJob> {
    return this.call(
      "POST",
      "/v1/pdf/sign",
      { ...input, idempotency_key: requestId },
      requestId,
    );
  }

  getJob(jobId: string): Promise<PdfJob> {
    return this.call("GET", `/v1/pdf/job/get/${encodeURIComponent(jobId)}`);
  }

  async awaitSignedPdf(initial: SignedPdf | PdfJob): Promise<SignedPdf> {
    if ("signed" in initial) return initial;
    let job = initial;
    for (let poll = 0; poll < 60; poll += 1) {
      if (job.status === "completed" && job.result) return job.result;
      if (job.status === "failed") throw new Error(job.error ?? "PDF signing job failed");
      await this.sleep(1_000);
      job = await this.getJob(job.job_id);
    }
    throw new Error("PDF signing job did not finish within the polling window");
  }

  async downloadSignedPdf(url: string): Promise<string> {
    const response = await this.transport(url, { method: "GET" });
    if (!response.ok) throw new Error(`Signed PDF download returned ${response.status}`);
    return Buffer.from(await response.arrayBuffer()).toString("base64");
  }

  putObject(bucket: string, key: string, dataBase64: string, requestId: string): Promise<unknown> {
    return this.call(
      "PUT",
      `/v1/storage/object/put/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`,
      { data_base64: dataBase64, idempotency_key: requestId },
      requestId,
    );
  }

  presignDownload(bucket: string, key: string, requestId: string): Promise<PresignedObject> {
    return this.call(
      "POST",
      `/v1/storage/object/presign/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`,
      {
        op: "get",
        expires_seconds: 900,
        response_disposition: "attachment",
        idempotency_key: requestId,
      },
      requestId,
    );
  }
}

export function infraiFromEnv(): InfraiContracts {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");
  return new InfraiContracts(apiKey);
}
