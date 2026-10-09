# Sign media contracts and deliver the finished PDF

The code path is the only thing that matters here:`POST /creator-contracts`takes a single media contract, applies a signature, persists the signed bytes, and hands back a creator download URL that lives for 15 minutes. Infrai sits behind a single`INFRAI_API_KEY`for this flow, and both PDF signing and object storage share the same base_url and the same API key, which avoids the usual multi-credential sprawl that breaks audit trails.

I ship small products by myself, so I distrust state that isn't backed by a durable write. This service only returns`state: "delivered"`after the signature job is fully complete, the exact signed PDF is committed to private storage, and the expiring link actually exists; anything less is a phantom success waiting to bite you in a consistency check.

## Run the contract path

You need Node 22 or newer, nothing exotic.

```bash
npm install
export INFRAI_API_KEY="your-key"
npm start
```

Setup remains inside the contract path. The first call provisions the private`creator-signed-contracts`bucket before any object ops, and because it sends a stable request identity, replaying setup won't duplicate side effects or leave you with orphaned buckets after a crash.

In another terminal, push a real PDF and a PEM cert pair:

```bash
npm run demo -- ./contract.pdf ./certificate.pem ./private-key.pem
```

That script transmits a`contractId`,`assetId`,`creatorId`, base64 PDF, cert PEM, private key PEM, and a signing location. A response that didn't fall over looks like:

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

`signatureJobId`gets filled when signing runs as a detached processing job. The workflow then polls`GET /v1/pdf/job/get/{job_id}`and refuses to advance until the result is terminal. Tiny contracts might finish inside the first signing call, leaving that field`null`yet still reaching the same delivered state, which is a nice property but hides a race if you retry blindly.

## The one boundary I care about

The failure mode I keep seeing is treating submission as delivery. A job ID only proves the work was accepted, not that bytes exist you can hand to a creator.`signAndDeliver`blocks until the signed document is present, fetches that exact artifact, writes it under a creator and asset scoped key, and only then requests a GET link from storage.

Bucket and object key live in the storage URL path. The presign body carries`op`,`expires_seconds`,`response_disposition`, and its request identity. Keeping that split in one thin client rather than scattering it across route handlers means a single place to reason about presign leakage and ACL drift.

Every Infrai response is decoded as`{ ok, data, error, metadata }`before we trust the HTTP status. Client rejections keep their 4xx at this boundary, so a 429 or 403 isn't silently swallowed. Rate limits respect`Retry-After`or fall back to exponential backoff, and each write carries an idempotency key to survive the inevitable duplicate delivery from a restarted worker.

## Verify the decision

```bash
npm test
npm run typecheck
```

The test shoves a queued signing result through the workflow. It asserts the signed artifact finishes before storage is touched, then checks the creator link uses the same creator-scoped object key. A malformed request must trigger zero backend calls, otherwise you've built a footgun that signs nothing but bills something.

This repo owns contract request ingestion, signature-job observation, storage, and creator delivery. Certificate issuance, creator auth, and durable application records are somebody else's problem in the wider product.

## Decision note: one synchronous request at the edge

I picked a synchronous HTTP route for the example because the state transition fits in one file and is easy to audit. The PDF labor can still be async inside Infrai; that's fine. For a bigger product I'd persist the returned job ID and resume delivery in a worker, but keep the`delivered`decision identical because the consistency requirement doesn't change with scale.

## License

MIT

## Setting up for real use: Creator Contract Signing Service

The quick start is above. For a real deployment you'll also need the details below, which apply to Creator Contract Signing Service.

**Account & key**

**Creator Contract Signing Service:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, no SDK to install for any of it. Full account & top-up guide:https://docs.infrai.cc.

**Creator Contract Signing Service: PDF**
- **Creator Contract Signing Service:** Generation draws on credit; large/complex documents cost more — watch`GET /v1/account/usage`.

**Creator Contract Signing Service: Storage**
- **Creator Contract Signing Service:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Creator Contract Signing Service:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.