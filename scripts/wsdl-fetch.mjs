import fs from "node:fs";
import https from "node:https";

const PFX_PATH =
  "/Users/user/Downloads/MED WORK CENTRO MEDICO LTDA_24763267000107 senha @Black1011 (1).pfx";
const PASS = "@Black1011";

const HOSTS = [
  ["webservices.download.esocial.gov.br", "/servicos/empregador/dwlcirurgico/WsConsultarIdentificadoresEventos.svc?wsdl"],
  ["webservices.download.esocial.gov.br", "/servicos/empregador/dwlcirurgico/WsSolicitarDownloadEventos.svc?wsdl"],
  ["webservices.envio.esocial.gov.br",     "/servicos/empregador/enviarloteeventos/WsEnviarLoteEventos.svc?wsdl"],
  ["webservices.consulta.esocial.gov.br",  "/servicos/empregador/consultarloteeventos/WsConsultarLoteEventos.svc?wsdl"],
];

const pfx = fs.readFileSync(PFX_PATH);
const agent = new https.Agent({ pfx, passphrase: PASS, keepAlive: false, rejectUnauthorized: false });

for (const [host, path] of HOSTS) {
  await new Promise((resolve) => {
    const req = https.request(
      { host, path, method: "GET", agent, timeout: 25000, headers: { "User-Agent": "MedX/1.0" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          console.log(`\n=== ${host}${path} → HTTP ${res.statusCode} ${body.length}B ===`);
          // Pull namespaces and SOAP actions out
          const tns = body.match(/targetNamespace="([^"]+)"/g)?.slice(0, 3) || [];
          const acts = body.match(/soapAction="([^"]+)"/g)?.slice(0, 8) || [];
          console.log("targetNamespaces:", tns.join("\n  "));
          console.log("soapActions:", acts.join("\n  "));
        });
      }
    );
    req.on("error", (e) => {
      console.log(`\n=== ${host}${path} → ERROR ${e.code || ""} ${e.message} ===`);
      resolve();
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("close", resolve);
    req.end();
  });
}
