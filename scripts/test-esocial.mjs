// Teste eSocial WS-Consulta com mTLS + XMLDsig
import fs from "node:fs";
import https from "node:https";
import forge from "node-forge";
import { SignedXml } from "xml-crypto";
import { XMLParser } from "fast-xml-parser";

const PFX_PATH =
  "/Users/user/Downloads/MED WORK CENTRO MEDICO LTDA_24763267000107 senha @Black1011 (1).pfx";
const PASS = "@Black1011";

const cnpj14 = (process.argv[2] || "24763267000107").replace(/\D/g, "");
const cnpj8 = cnpj14.slice(0, 8);
const cpf = (process.argv[3] || "").replace(/\D/g, "");

const now = new Date();
// eSocial server compares with São Paulo local time. Subtract 2h for safety.
const dtFimDate = new Date(now.getTime() - 2 * 3600 * 1000);
// Convert to São Paulo local without "Z" (UTC) suffix
function fmtBRT(d) {
  const sp = new Date(d.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const pad = (n) => String(n).padStart(2, "0");
  return `${sp.getFullYear()}-${pad(sp.getMonth() + 1)}-${pad(sp.getDate())}T${pad(sp.getHours())}:${pad(sp.getMinutes())}:${pad(sp.getSeconds())}`;
}
const dtFim = process.argv[4] || fmtBRT(dtFimDate);
const dtIniDate = new Date(dtFimDate.getTime() - 30 * 24 * 3600 * 1000);
const dtIni = fmtBRT(dtIniDate);

const ENDPOINT = {
  host: "webservices.download.esocial.gov.br",
  path: "/servicos/empregador/dwlcirurgico/WsConsultarIdentificadoresEventos.svc",
  soapAction:
    "http://www.esocial.gov.br/servicos/empregador/consulta/identificadores-eventos/v1_0_0/ServicoConsultarIdentificadoresEventos/ConsultarIdentificadoresEventosTrabalhador",
  ns: "http://www.esocial.gov.br/servicos/empregador/consulta/identificadores-eventos/v1_0_0",
};

const SCHEMA_NS_TRAB =
  "http://www.esocial.gov.br/schema/consulta/identificadores-eventos/trabalhador/v1_0_0";

// Extract PEM key/cert from .pfx
const pfxBuf = fs.readFileSync(PFX_PATH);
const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuf.toString("binary")));
const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, PASS);

function bagsOfType(p12, oid) {
  const bags = p12.getBags({ bagType: oid })[oid] || [];
  return bags;
}
const keyBags = [
  ...bagsOfType(p12, forge.pki.oids.pkcs8ShroudedKeyBag),
  ...bagsOfType(p12, forge.pki.oids.keyBag),
];
const certBags = bagsOfType(p12, forge.pki.oids.certBag);
if (!keyBags[0]) throw new Error("PrivateKey não encontrada no .pfx");
if (!certBags[0]) throw new Error("Cert não encontrado no .pfx");

const privateKeyPem = forge.pki.privateKeyToPem(keyBags[0].key);
const certPem = forge.pki.certificateToPem(certBags[0].cert);
const certB64 = certPem
  .replace(/-----BEGIN CERTIFICATE-----/, "")
  .replace(/-----END CERTIFICATE-----/, "")
  .replace(/\s+/g, "");

if (!cpf || cpf.length !== 11) {
  console.error("Uso: node scripts/test-esocial.mjs <CNPJ14> <CPF11> [dtFim YYYY-MM-DD]");
  process.exit(1);
}
// Build eSocial XML payload — Trabalhador
const eSocialXml = `<eSocial xmlns="${SCHEMA_NS_TRAB}">
  <consultaIdentificadoresEvts>
    <ideEmpregador>
      <tpInsc>1</tpInsc>
      <nrInsc>${cnpj8}</nrInsc>
    </ideEmpregador>
    <consultaEvtsTrabalhador>
      <cpfTrab>${cpf}</cpfTrab>
      <dtIni>${dtIni}</dtIni>
      <dtFim>${dtFim}</dtFim>
    </consultaEvtsTrabalhador>
  </consultaIdentificadoresEvts>
</eSocial>`;

// Sign with XMLDsig (Reference URI="" enveloped + c14n + sha256)
const sig = new SignedXml({
  privateKey: privateKeyPem,
  publicCert: certPem,
  signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
});
sig.addReference({
  xpath: "/*",
  uri: "",
  isEmptyUri: true,
  digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  transforms: [
    "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
    "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  ],
});
sig.getKeyInfoContent = () => `<X509Data><X509Certificate>${certB64}</X509Certificate></X509Data>`;
sig.computeSignature(eSocialXml, {
  location: { reference: "/*", action: "append" },
});
const signedESocial = sig.getSignedXml();

const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v1="${ENDPOINT.ns}">
  <soapenv:Header/>
  <soapenv:Body>
    <v1:ConsultarIdentificadoresEventosTrabalhador>
      <v1:consultaEventosTrabalhador>${signedESocial}</v1:consultaEventosTrabalhador>
    </v1:ConsultarIdentificadoresEventosTrabalhador>
  </soapenv:Body>
</soapenv:Envelope>`;

const agent = new https.Agent({ pfx: pfxBuf, passphrase: PASS, keepAlive: false, rejectUnauthorized: false });

console.log("=== eSocial WS-Consulta test ===");
console.log("CNPJ:", cnpj14, "(8 first:", cnpj8 + ")");
console.log("CPF:", cpf, "  Período:", dtIni, "→", dtFim);
console.log("Signed eSocial XML length:", signedESocial.length);
if (process.env.DEBUG) console.log("\n--- SIGNED XML ---\n" + signedESocial + "\n--- END ---\n");
console.log();

const req = https.request(
  {
    host: ENDPOINT.host,
    path: ENDPOINT.path,
    method: "POST",
    agent,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `"${ENDPOINT.soapAction}"`,
      "Content-Length": Buffer.byteLength(envelope),
      "User-Agent": "MedX-eSocial/1.0",
    },
    timeout: 45000,
  },
  (res) => {
    console.log("HTTP", res.statusCode, res.headers["content-type"]);
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      console.log("\n=== RAW (first 3000 chars) ===");
      console.log(body.slice(0, 3000));
      try {
        const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
        const obj = parser.parse(body);
        console.log("\n=== Parsed ===");
        console.log(JSON.stringify(obj?.Envelope?.Body ?? obj, null, 2).slice(0, 3500));
      } catch (e) {
        console.log("Parse error:", e.message);
      }
    });
  }
);
req.on("error", (e) => console.error("Request error:", e.message, e.code));
req.on("timeout", () => req.destroy(new Error("timeout")));
req.write(envelope);
req.end();
