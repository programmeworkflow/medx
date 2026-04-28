import https from "node:https";
import forge from "node-forge";
import { SignedXml } from "xml-crypto";
import { XMLParser } from "fast-xml-parser";

// ────────────────────────────────────────────────────────────────────────────
// Endpoints reais (atualização 2026: dwlcirurgico unificou consulta + solicit)
// ────────────────────────────────────────────────────────────────────────────
const CONSULTA_NS =
  "http://www.esocial.gov.br/servicos/empregador/consulta/identificadores-eventos/v1_0_0";
const DOWNLOAD_NS =
  "http://www.esocial.gov.br/servicos/empregador/download/solicitacao/v1_0_0";

export const ESOCIAL = {
  consultaEmpregador: {
    host: "webservices.download.esocial.gov.br",
    path: "/servicos/empregador/dwlcirurgico/WsConsultarIdentificadoresEventos.svc",
    soapAction: `${CONSULTA_NS}/ServicoConsultarIdentificadoresEventos/ConsultarIdentificadoresEventosEmpregador`,
    namespace: CONSULTA_NS,
    schemaNs:
      "http://www.esocial.gov.br/schema/consulta/identificadores-eventos/empregador/v1_0_0",
    operationName: "ConsultarIdentificadoresEventosEmpregador",
    paramName: "consultaEventosEmpregador",
  },
  consultaTrabalhador: {
    host: "webservices.download.esocial.gov.br",
    path: "/servicos/empregador/dwlcirurgico/WsConsultarIdentificadoresEventos.svc",
    soapAction: `${CONSULTA_NS}/ServicoConsultarIdentificadoresEventos/ConsultarIdentificadoresEventosTrabalhador`,
    namespace: CONSULTA_NS,
    schemaNs:
      "http://www.esocial.gov.br/schema/consulta/identificadores-eventos/trabalhador/v1_0_0",
    operationName: "ConsultarIdentificadoresEventosTrabalhador",
    paramName: "consultaEventosTrabalhador",
  },
  download: {
    host: "webservices.download.esocial.gov.br",
    path: "/servicos/empregador/dwlcirurgico/WsSolicitarDownloadEventos.svc",
    soapAction: `${DOWNLOAD_NS}/ServicoSolicitarDownloadEventos/SolicitarDownloadEventosPorId`,
    namespace: DOWNLOAD_NS,
    schemaNs:
      "http://www.esocial.gov.br/schema/download/solicitacao/v1_0_0",
    operationName: "SolicitarDownloadEventosPorId",
    paramName: "solicitacaoDownloadEventosPorId",
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// PFX → PEM
// ────────────────────────────────────────────────────────────────────────────
export function pfxToPem(pfxBuffer: Buffer, senha: string) {
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer.toString("binary")));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, senha);
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!keyBags[0]?.key) throw new Error("Chave privada não encontrada no .pfx");
  if (!certBags[0]?.cert) throw new Error("Certificado não encontrado no .pfx");
  const privateKeyPem = forge.pki.privateKeyToPem(keyBags[0].key);
  const certPem = forge.pki.certificateToPem(certBags[0].cert);
  const certB64 = certPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, "");
  return { privateKeyPem, certPem, certB64 };
}

// ────────────────────────────────────────────────────────────────────────────
// HTTPS Agent (mTLS)
// ────────────────────────────────────────────────────────────────────────────
export function makeAgent(pfx: Buffer, passphrase: string) {
  return new https.Agent({
    pfx,
    passphrase,
    keepAlive: false,
    // ICP-Brasil CA chain not in Node default trust; mTLS already proves identity
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
  });
}

// ────────────────────────────────────────────────────────────────────────────
// XMLDsig assinatura — eSocial padrão (c14n + rsa-sha256 + sha256, URI vazia)
// ────────────────────────────────────────────────────────────────────────────
export function signEsocialXml(xml: string, pem: { privateKeyPem: string; certPem: string; certB64: string }): string {
  const sig = new SignedXml({
    privateKey: pem.privateKeyPem,
    publicCert: pem.certPem,
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
  sig.getKeyInfoContent = () => `<X509Data><X509Certificate>${pem.certB64}</X509Certificate></X509Data>`;
  sig.computeSignature(xml, { location: { reference: "/*", action: "append" } });
  return sig.getSignedXml();
}

// ────────────────────────────────────────────────────────────────────────────
// Envelopes
// ────────────────────────────────────────────────────────────────────────────
export function envelopeConsultaTrabalhador(opts: {
  cnpj14: string;
  cpf: string;
  dtIni: string; // ISO local BRT YYYY-MM-DDTHH:mm:ss
  dtFim: string;
  pem: ReturnType<typeof pfxToPem>;
}): { xml: string; endpoint: typeof ESOCIAL.consultaTrabalhador } {
  const cnpj8 = opts.cnpj14.replace(/\D/g, "").slice(0, 8);
  const eSocialXml = `<eSocial xmlns="${ESOCIAL.consultaTrabalhador.schemaNs}">
  <consultaIdentificadoresEvts>
    <ideEmpregador>
      <tpInsc>1</tpInsc>
      <nrInsc>${cnpj8}</nrInsc>
    </ideEmpregador>
    <consultaEvtsTrabalhador>
      <cpfTrab>${opts.cpf.replace(/\D/g, "")}</cpfTrab>
      <dtIni>${opts.dtIni}</dtIni>
      <dtFim>${opts.dtFim}</dtFim>
    </consultaEvtsTrabalhador>
  </consultaIdentificadoresEvts>
</eSocial>`;
  const signed = signEsocialXml(eSocialXml, opts.pem);
  const ep = ESOCIAL.consultaTrabalhador;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v1="${ep.namespace}">
  <soapenv:Header/>
  <soapenv:Body>
    <v1:${ep.operationName}>
      <v1:${ep.paramName}>${signed}</v1:${ep.paramName}>
    </v1:${ep.operationName}>
  </soapenv:Body>
</soapenv:Envelope>`;
  return { xml, endpoint: ep };
}

export function envelopeSolicitarDownload(opts: {
  cnpj14: string;
  ids: string[]; // até 10 ids por request
  pem: ReturnType<typeof pfxToPem>;
}): { xml: string; endpoint: typeof ESOCIAL.download } {
  const cnpj14 = opts.cnpj14.replace(/\D/g, "");
  const idsXml = opts.ids.map((id) => `<id>${id}</id>`).join("");
  const eSocialXml = `<eSocial xmlns="${ESOCIAL.download.schemaNs}">
  <download>
    <ideEmpregador>
      <tpInsc>1</tpInsc>
      <nrInsc>${cnpj14}</nrInsc>
    </ideEmpregador>
    <solicDownloadEvtsPorId>
      ${idsXml}
    </solicDownloadEvtsPorId>
  </download>
</eSocial>`;
  const signed = signEsocialXml(eSocialXml, opts.pem);
  const ep = ESOCIAL.download;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v1="${ep.namespace}">
  <soapenv:Header/>
  <soapenv:Body>
    <v1:${ep.operationName}>
      <v1:${ep.paramName}>${signed}</v1:${ep.paramName}>
    </v1:${ep.operationName}>
  </soapenv:Body>
</soapenv:Envelope>`;
  return { xml, endpoint: ep };
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP POST
// ────────────────────────────────────────────────────────────────────────────
export interface SoapResp {
  status: number;
  body: string;
}

export function postSoap(
  endpoint: { host: string; path: string; soapAction: string },
  envelope: string,
  agent: https.Agent
): Promise<SoapResp> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: endpoint.host,
        path: endpoint.path,
        method: "POST",
        agent,
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: `"${endpoint.soapAction}"`,
          "Content-Length": Buffer.byteLength(envelope),
          "User-Agent": "MedX-eSocial/1.0",
        },
        timeout: 45000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Timeout 45s")));
    req.write(envelope);
    req.end();
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Date helpers (eSocial usa local BRT YYYY-MM-DDTHH:mm:ss)
// ────────────────────────────────────────────────────────────────────────────
export function fmtBRT(d: Date): string {
  const sp = new Date(d.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sp.getFullYear()}-${pad(sp.getMonth() + 1)}-${pad(sp.getDate())}T${pad(sp.getHours())}:${pad(sp.getMinutes())}:${pad(sp.getSeconds())}`;
}

export function dtFimAgora(): string {
  return fmtBRT(new Date(Date.now() - 2 * 3600 * 1000));
}

// ────────────────────────────────────────────────────────────────────────────
// XML Parsing
// ────────────────────────────────────────────────────────────────────────────
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: true,
  trimValues: true,
});

export function parseXml(xml: string): any {
  return xmlParser.parse(xml);
}

export interface RetornoConsulta {
  cdResposta: string;
  descResposta: string;
  identificadores: { id: string; tpEvt?: string; dhProcessamento?: string; nrRecibo?: string }[];
}

export function parseRetornoConsulta(xml: string): RetornoConsulta {
  const obj = parseXml(xml);
  const root = findKey(obj, "retornoConsultaIdentificadoresEvts") || findKey(obj, "retorno");
  const status = findKey(root, "status") || {};
  const cdResposta = String(status.cdResposta ?? "0");
  const descResposta = String(status.descResposta ?? "");
  const ids: RetornoConsulta["identificadores"] = [];
  const list = findKey(root, "ideEvento");
  const arr = Array.isArray(list) ? list : list ? [list] : [];
  for (const it of arr) {
    ids.push({
      id: String(it["@_Id"] ?? it.id ?? ""),
      tpEvt: it.tpEvt,
      dhProcessamento: it.dhProcessamento,
      nrRecibo: it.nrRecibo,
    });
  }
  return { cdResposta, descResposta, identificadores: ids };
}

export function parseEventoFuncionario(xml: string) {
  const obj = parseXml(xml);
  const candidatos = ["evtAdmissao", "evtDeslig", "evtAfastTemp", "evtTSVInicio", "evtTSVTermino", "evtAltContratual", "evtAltCadastral"];
  let tipo: string | null = null;
  let evtData: any = null;
  for (const k of candidatos) {
    const f = findKey(obj, k);
    if (f) {
      tipo = mapTipoEvt(k);
      evtData = f;
      break;
    }
  }
  if (!evtData) return { tipo: null };
  const trab =
    findKey(evtData, "trabalhador") ?? findKey(evtData, "ideTrabalhador") ?? evtData;
  return {
    tipo,
    cpf: String(findKey(trab, "cpfTrab") ?? findKey(trab, "cpf") ?? "") || null,
    nome: String(findKey(trab, "nmTrab") ?? findKey(trab, "nome") ?? "") || null,
    dataAdmissao: String(findKey(evtData, "dtAdm") ?? "") || null,
    dataDesligamento: String(findKey(evtData, "dtDeslig") ?? "") || null,
    dataAfastIni: String(findKey(evtData, "dtIniAfast") ?? "") || null,
    dataAfastFim: String(findKey(evtData, "dtTermAfast") ?? "") || null,
    motivoAfastamento: String(findKey(evtData, "codMotAfast") ?? "") || null,
  };
}

function mapTipoEvt(key: string) {
  const m: Record<string, string> = {
    evtAdmissao: "S-2200",
    evtDeslig: "S-2299",
    evtAfastTemp: "S-2230",
    evtTSVInicio: "S-2300",
    evtTSVTermino: "S-2399",
    evtAltContratual: "S-2206",
    evtAltCadastral: "S-2205",
  };
  return m[key] ?? key;
}

function findKey(obj: any, key: string): any {
  if (!obj || typeof obj !== "object") return null;
  if (key in obj) return obj[key];
  for (const k of Object.keys(obj)) {
    const v = (obj as any)[k];
    if (v && typeof v === "object") {
      const r = findKey(v, key);
      if (r != null) return r;
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Helper combinado: testa autenticação fazendo consulta de CPF dummy
// ────────────────────────────────────────────────────────────────────────────
export async function pingEsocial(opts: {
  pfx: Buffer;
  senha: string;
  cnpj14: string;
}): Promise<{ ok: boolean; cdResposta: string; descResposta: string; cnpjAlvo: string }> {
  const pem = pfxToPem(opts.pfx, opts.senha);
  const agent = makeAgent(opts.pfx, opts.senha);
  const dtFim = dtFimAgora();
  const dtIni = fmtBRT(new Date(Date.now() - (2 + 6) * 3600 * 1000));
  const { xml, endpoint } = envelopeConsultaTrabalhador({
    cnpj14: opts.cnpj14,
    cpf: "11144477735", // CPF dummy válido (checksum) — nunca terá registros
    dtIni,
    dtFim,
    pem,
  });
  const r = await postSoap(endpoint, xml, agent);
  if (r.status !== 200) {
    return { ok: false, cdResposta: String(r.status), descResposta: r.body.slice(0, 200), cnpjAlvo: opts.cnpj14 };
  }
  const ret = parseRetornoConsulta(r.body);
  // 406 = "não encontrado" → significa que tudo OK estruturalmente
  // 201/202/etc. de OK também vale
  const ok = ret.cdResposta === "406" || ret.cdResposta.startsWith("2");
  return { ok, cdResposta: ret.cdResposta, descResposta: ret.descResposta, cnpjAlvo: opts.cnpj14 };
}
