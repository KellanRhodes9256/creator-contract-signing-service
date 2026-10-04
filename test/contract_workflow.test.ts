import assert from "node:assert/strict";
import test from "node:test";
import { signAndDeliver, type ContractBackend } from "../src/contract_workflow.ts";
import type { SignedPdf } from "../src/infrai_contracts.ts";

const signedPdf: SignedPdf = {
  pdf_id: "pdf_12345678901234567890",
  url: "https://download.example/signed.pdf",
  size_bytes: 512,
  page_count: 2,
  sha256: "a".repeat(64),
  created_at: "2026-09-12T09:00:00.000Z",
  signed: true,
  signer_common_name: "Example Studio LLC",
  signed_at: "2026-09-12T09:00:01.000Z",
};

test("stores and delivers only the completed signed artifact", async () => {
  const calls: string[] = [];
  const queued = { job_id: "pdf-job-42", status: "queued" as const };
  const backend: ContractBackend = {
    async ensureBucket(name) { calls.push(`bucket:${name}`); },
    async sign(_input, requestId) { calls.push(requestId); return queued; },
    async awaitSignedPdf(input) {
      assert.equal(input, queued);
      calls.push("signature:completed");
      return signedPdf;
    },
    async downloadSignedPdf(url) { calls.push(`download:${url}`); return "c2lnbmVkIHBkZg=="; },
    async putObject(_bucket, key, bytes, requestId) {
      calls.push(`${requestId}:${key}:${bytes}`);
    },
    async presignDownload(_bucket, key, requestId) {
      calls.push(`${requestId}:${key}`);
      return { url: "https://creator.example/contract" };
    },
  };

  const result = await signAndDeliver({
    contractId: "contract-1042",
    assetId: "asset-2048",
    creatorId: "creator-7",
    pdfBase64: "JVBERi0xLjQKZGVtbw==",
    certificatePem: "-----BEGIN CERTIFICATE-----\ndemo\n-----END CERTIFICATE-----",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\ndemo\n-----END PRIVATE KEY-----",
  }, backend);

  assert.equal(result.state, "delivered");
  assert.equal(result.signatureJobId, "pdf-job-42");
  assert.equal(result.downloadUrl, "https://creator.example/contract");
  assert.deepEqual(calls, [
    "bucket:creator-signed-contracts",
    "sign:contract-1042",
    "signature:completed",
    "download:https://download.example/signed.pdf",
    "store:contract-1042:creators/creator-7/assets/asset-2048/contracts/contract-1042.pdf:c2lnbmVkIHBkZg==",
    "deliver:contract-1042:creators/creator-7/assets/asset-2048/contracts/contract-1042.pdf",
  ]);
});

test("rejects an unshaped contract before any signing call", async () => {
  let calls = 0;
  const backend = new Proxy({}, {
    get() {
      return async () => { calls += 1; };
    },
  }) as ContractBackend;

  await assert.rejects(
    () => signAndDeliver({ contractId: "x", pdfBase64: "short" }, backend),
    /Invalid/,
  );
  assert.equal(calls, 0);
});
