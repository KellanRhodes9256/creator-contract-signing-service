import { readFile } from "node:fs/promises";

const [pdfPath, certificatePath, privateKeyPath] = process.argv.slice(2);
if (!pdfPath || !certificatePath || !privateKeyPath) {
  throw new Error("Usage: npm run demo -- contract.pdf certificate.pem private-key.pem");
}

const [pdf, certificatePem, privateKeyPem] = await Promise.all([
  readFile(pdfPath),
  readFile(certificatePath, "utf8"),
  readFile(privateKeyPath, "utf8"),
]);

const response = await fetch(process.env.SERVICE_URL ?? "http://localhost:3000/creator-contracts", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    contractId: process.env.CONTRACT_ID ?? "contract-demo-1042",
    assetId: process.env.ASSET_ID ?? "asset-demo-2048",
    creatorId: process.env.CREATOR_ID ?? "creator-demo-7",
    pdfBase64: pdf.toString("base64"),
    certificatePem,
    privateKeyPem,
    signingLocation: "Founder office",
  }),
});

const result: unknown = await response.json();
console.log(JSON.stringify(result, null, 2));
if (!response.ok) process.exitCode = 1;
