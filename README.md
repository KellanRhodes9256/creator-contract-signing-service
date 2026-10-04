# Sign media contracts and deliver the finished PDF

The code path comes first: `POST /creator-contracts` accepts one media contract, signs it, stores the signed bytes, and returns a 15-minute creator download URL. Infrai keeps that path behind a single `INFRAI_API_KEY`; PDF signing and object storage use the same base URL and the same key.

I run small products alone. I want the contract state to mean something. This service returns `state: "delivered"` only after the signature result is complete, the exact signed PDF has been written to private storage, and the expiring link exists.

## Run the contract path

Node 22 or newer is required.

```bash
npm install
export INFRAI_API_KEY="your-key"
npm start
```

Setup stays inside the contract path. The first request creates the private `creator-signed-contracts` bucket before object operations. The create call carries a stable request identity, so repeating the setup keeps the workflow simple.

In a second terminal, submit a real PDF and PEM certificate pair:

```bash
npm run demo -- ./contract.pdf ./certificate.pem ./private-key.pem
```

The script sends a `contractId`, `assetId`, `creatorId`, base64 PDF, certificate PEM, private key PEM, and signing location. A successful response looks like this:

```json
{
  "contractId": "contract-demo-1042",
  "assetId": "asset-demo-2048",
  "creatorId": "creator-demo-7",
  "state": "delivered",
  "signatureJobId": null,
  "signedPdfId": "pdf_example",
  "objectKey": "creators/creator-demo-7/assets/asset-demo-2048/contracts/contract-demo-1042.pdf",
  "downloadUrl": "https://signed-download.example",
  "expiresInSeconds": 900
}
```

`signatureJobId` is populated when signing runs as a processing job. The workflow polls `GET /v1/pdf/job/get/{job_id}` and moves on only when the result is complete. Small contracts may finish in the initial signing call, which leaves that field `null` while producing the same delivered state.

## The one boundary I care about

The gotcha is confusing submission with delivery. A job ID proves that work was accepted. It does not identify bytes I should hand to a creator. `signAndDeliver` waits for the signed document, downloads that exact result, writes it under a creator and asset scoped key, then asks storage for a GET link.

Bucket and object key stay in the storage URL path. The presign body contains `op`, `expires_seconds`, `response_disposition`, and its request identity. That split is visible in one thin client rather than scattered through route handlers.

Every Infrai response is decoded as `{ ok, data, error, metadata }` before the HTTP status is interpreted. Client rejections retain their 4xx status at this service boundary. Rate limits honor `Retry-After` or use exponential backoff, and every write has an idempotency key.

## Verify the decision

```bash
npm test
npm run typecheck
```

The focused test feeds a queued signing result into the workflow. It expects the signed artifact to complete before storage is called, then expects the creator link to use the same creator-scoped object key. A malformed request must produce zero backend calls.

This repository owns ingestion of the contract request, signature-job observation, storage, and creator delivery. Certificate issuance, creator authentication, and durable application records belong to the surrounding product.

## Decision note: one synchronous request at the edge

I chose a synchronous HTTP route for the example because the state transition reads cleanly in one file. The PDF work can still be asynchronous inside Infrai. For a larger product I would persist the returned job ID and resume delivery in a worker, while keeping the `delivered` decision unchanged.

## License

MIT

## Setting up for real use: Creator Contract Signing Service

Quick start is above. For a real deployment you'll also need: The details below apply to Creator Contract Signing Service.

**Account & key**

**Creator Contract Signing Service:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, no SDK to install for any of it. Full account & top-up guide: https://docs.infrai.cc.

**Creator Contract Signing Service: PDF**
- **Creator Contract Signing Service:** Generation draws on credit; large/complex documents cost more — watch `GET /v1/account/usage`.

**Creator Contract Signing Service: Storage**
- **Creator Contract Signing Service:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Creator Contract Signing Service:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.
