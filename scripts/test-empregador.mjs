// Teste eSocial Consulta Empregador (sem CPF, lista todos os S-22xx do CNPJ)
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
const tpEvt = process.argv[3] || "S-2200"; // 6 chars
const now = new Date();
const lastM = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const perApur =
  process.argv[4] ||
  `${lastM.getFullYear()}-${String(lastM.getMonth() + 1).padStart(2, "0")}`;

const ENDPOINT = {
  host: "webservices.download.esocial.gov.br",
  path: "/servicos/empregador/dwlcirurgico/WsConsultarIdentificadoresEventos.svc",
  soapAction:
    "http://www.esocial.gov.br/servicos/empregador/consulta/identificadores-eventos/v1_0_0/ServicoConsultarIdentificadoresEventos/ConsultarIdentificadoresEventosEmpregador",
  ns: "http://www.esocial.gov.br/servicos/empregador/consulta/identificadores-eventos/v1_0_0",
};

const SCHEMA_NS_EMP =
  "http://www.esocial.gov.br/schema/consulta/identificadores-eventos/empregador/v1_0_0";

const pfxBuf = fs.readFileSync(PFX_PATH);
const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuf.toString("binary")));
const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, PASS);
const keyBags = [
  ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
  ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
];
const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
const privateKeyPem = forge.pki.privateKeyToPem(keyBags[0].key);
const certPem = forge.pki.certificateToPem(certBags[0].cert);
const certB64 = certPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, "");

const eSocialXml = `<eSocial xmlns="${SCHEMA_NS_EMP}">
  <consultaIdentificadoresEvts>
    <ideEmpregador>
      <tpInsc>1</tpInsc>
      <nrInsc>${cnpj8}</nrInsc>
    </ideEmpregador>
    <consultaEvtsEmpregador>
      <tpEvt>${tpEvt}</tpEvt>
      <perApur>${perApur}</perApur>
    </consultaEvtsEmpregador>
  </consultaIdentificadoresEvts>
</eSocial>`;

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
sig.computeSignature(eSocialXml, { location: { reference: "/*", action: "append" } });
const signed = sig.getSignedXml();

const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v1="${ENDPOINT.ns}">
  <soapenv:Header/>
  <soapenv:Body>
    <v1:ConsultarIdentificadoresEventosEmpregador>
      <v1:consultaEventosEmpregador>${signed}</v1:consultaEventosEmpregador>
    </v1:ConsultarIdentificadoresEventosEmpregador>
  </soapenv:Body>
</soapenv:Envelope>`;

const agent = new https.Agent({ pfx: pfxBuf, passphrase: PASS, keepAlive: false, rejectUnauthorized: false });

console.log(`CNPJ ${cnpj14}  tpEvt ${tpEvt}  perApur ${perApur}`);

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
    },
    timeout: 45000,
  },
  (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      console.log("HTTP", res.statusCode);
      console.log(body.slice(0, 2500));
    });
  }
);
req.on("error", (e) => console.error(e.message));
req.write(envelope);
req.end();
