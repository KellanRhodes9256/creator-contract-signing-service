import { z } from "zod";
import type { SignedPdf } from "./infrai_contracts.ts";

export const contractRequestSchema = z.object({
  contractId: z.string().regex(/^[a-zA-Z0-9_-]{3,80}$/),
  assetId: z.string().regex(/^[a-zA-Z0-9_-]{3,80}$/),
  creatorId: z.string().regex(/^[a-zA-Z0-9_-]{3,80}$/),
  pdfBase64: z.string().min(16),
  certificatePem: z.string().includes("BEGIN CERTIFICATE"),
  privateKeyPem: z.string().includes("BEGIN PRIVATE KEY"),
  signingLocation: z.string().min(2).max(120).optional(),
});

export type ContractRequest = z.infer<typeof contractRequestSchema>;
export type ContractDelivery = {
  contractId: string;
  assetId: string;
  creatorId: string;
  state: "delivered";
  signatureJobId: string | null;
  signedPdfId: string;
  objectKey: string;
  downloadUrl: string;
  expiresInSeconds: 900;
};

export interface ContractBackend {
  ensureBucket(name: string): Promise<void>;
  sign(input: {
    pdf: string;
    cert_pem: string;
    key_pem: string;
    reason?: string;
    location?: string;
    retention_days?: number;
  }, requestId: string): Promise<SignedPdf | { job_id: string; status: "queued" | "running" | "completed" | "failed"; result?: SignedPdf | null; error?: string | null }>;
  awaitSignedPdf(initial: Awaited<ReturnType<ContractBackend["sign"]>>): Promise<SignedPdf>;
  downloadSignedPdf(url: string): Promise<string>;
  putObject(bucket: string, key: string, dataBase64: string, requestId: string): Promise<unknown>;
  presignDownload(bucket: string, key: string, requestId: string): Promise<{ url: string }>;
}

export const CONTRACT_BUCKET = "creator-signed-contracts";

export function signedObjectKey(input: ContractRequest): string {
  return `creators/${input.creatorId}/assets/${input.assetId}/contracts/${input.contractId}.pdf`;
}

export async function signAndDeliver(
  rawInput: unknown,
  backend: ContractBackend,
): Promise<ContractDelivery> {
  const input = contractRequestSchema.parse(rawInput);
  await backend.ensureBucket(CONTRACT_BUCKET);

  const submitted = await backend.sign({
    pdf: input.pdfBase64,
    cert_pem: input.certificatePem,
    key_pem: input.privateKeyPem,
    reason: `Creator media contract ${input.contractId}`,
    location: input.signingLocation,
    retention_days: 7,
  }, `sign:${input.contractId}`);
  const signatureJobId = "job_id" in submitted ? submitted.job_id : null;
  const signed = await backend.awaitSignedPdf(submitted);
  const bytes = await backend.downloadSignedPdf(signed.url);
  const objectKey = signedObjectKey(input);

  await backend.putObject(CONTRACT_BUCKET, objectKey, bytes, `store:${input.contractId}`);
  const delivery = await backend.presignDownload(
    CONTRACT_BUCKET,
    objectKey,
    `deliver:${input.contractId}`,
  );

  return {
    contractId: input.contractId,
    assetId: input.assetId,
    creatorId: input.creatorId,
    state: "delivered",
    signatureJobId,
    signedPdfId: signed.pdf_id,
    objectKey,
    downloadUrl: delivery.url,
    expiresInSeconds: 900,
  };
}
